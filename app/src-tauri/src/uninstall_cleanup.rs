use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::Path;

pub const COMMAND_LINE_FLAG: &str = "--dmeloper-uninstall-delete-user-data";
pub const EXIT_SUCCESS: i32 = 0;
pub const EXIT_OFFICIAL_APP_RUNNING: i32 = 20;
pub const EXIT_DATA_CLEANUP_FAILED: i32 = 21;
pub const EXIT_INVALID_REQUEST: i32 = 22;

pub(crate) fn is_channel_uninstaller_parent(
    app_image: &Path,
    registered_install_root: &Path,
    parent_image: &Path,
) -> bool {
    let expected_app_name = format!("{}.exe", env!("CARGO_PKG_NAME"));
    if !app_image
        .file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case(&expected_app_name))
    {
        return false;
    }
    let (Some(install_root), Some(app_root)) = (
        canonical_windows_path(registered_install_root),
        app_image.parent().and_then(canonical_windows_path),
    ) else {
        return false;
    };
    if !install_root.eq_ignore_ascii_case(&app_root) {
        return false;
    }

    let expected_parent = registered_install_root.join("uninstall.exe");
    let (Some(expected), Some(actual)) = (
        canonical_windows_path(&expected_parent),
        canonical_windows_path(parent_image),
    ) else {
        return false;
    };
    expected.eq_ignore_ascii_case(&actual) || same_bounded_file_bytes(&expected_parent, parent_image)
}

const MAX_UNINSTALLER_BYTES: u64 = 4 * 1024 * 1024;

/// NSIS runs its uninstaller from a temporary copy unless it was launched with
/// `_?=`. Its normal copy must match the installed sibling byte-for-byte.
fn same_bounded_file_bytes(expected: &Path, actual: &Path) -> bool {
    fn read(path: &Path) -> Option<Vec<u8>> {
        let mut file = std::fs::File::open(path).ok()?;
        let size = file.metadata().ok()?.len();
        if size == 0 || size > MAX_UNINSTALLER_BYTES {
            return None;
        }
        let mut bytes = Vec::with_capacity(size as usize);
        file.take(MAX_UNINSTALLER_BYTES + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        (bytes.len() as u64 == size).then_some(bytes)
    }

    read(expected).zip(read(actual)).is_some_and(|(left, right)| left == right)
}

fn canonical_windows_path(path: &Path) -> Option<String> {
    let path = std::fs::canonicalize(path).ok()?;
    let path = path.to_string_lossy().replace('/', "\\");
    Some(path.strip_prefix("\\\\?\\").unwrap_or(&path).to_owned())
}

fn request_shape(args: &[OsString]) -> Option<bool> {
    if !args.iter().any(|arg| arg == OsStr::new(COMMAND_LINE_FLAG)) {
        return None;
    }
    Some(args.len() == 1)
}

/// Exit before Tauri starts so the cleanup child cannot load or rewrite data.
pub fn exit_if_requested() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let Some(valid) = request_shape(&args) else {
        return;
    };
    let code = if !valid {
        EXIT_INVALID_REQUEST
    } else {
        match crate::bootstrap::remove_user_data_for_uninstall() {
            Ok(()) => EXIT_SUCCESS,
            Err("UNINSTALL_OFFICIAL_APP_RUNNING") => EXIT_OFFICIAL_APP_RUNNING,
            Err("UNINSTALL_CLEANUP_CALLER_INVALID") => EXIT_INVALID_REQUEST,
            Err(_) => EXIT_DATA_CLEANUP_FAILED,
        }
    };
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn only_the_exact_internal_switch_enters_cleanup_mode() {
        assert_eq!(request_shape(&[]), None);
        assert_eq!(request_shape(&[OsString::from("--help")]), None);
        assert_eq!(
            request_shape(&[OsString::from(COMMAND_LINE_FLAG)]),
            Some(true)
        );
        assert_eq!(
            request_shape(&[
                OsString::from(COMMAND_LINE_FLAG),
                OsString::from("unexpected")
            ]),
            Some(false)
        );
    }

    #[test]
    fn only_the_sibling_uninstaller_can_be_the_cleanup_parent() {
        let directory = tempdir().unwrap();
        let install = directory.path().join("install");
        fs::create_dir(&install).unwrap();
        let app = install.join(format!("{}.exe", env!("CARGO_PKG_NAME")));
        let uninstaller = install.join("uninstall.exe");
        fs::write(&app, b"app").unwrap();
        fs::write(&uninstaller, b"exact NSIS uninstaller bytes").unwrap();

        assert!(is_channel_uninstaller_parent(&app, &install, &uninstaller));

        let nsis_copy = directory.path().join("nsis-temporary-copy.exe");
        fs::write(&nsis_copy, fs::read(&uninstaller).unwrap()).unwrap();
        assert!(is_channel_uninstaller_parent(&app, &install, &nsis_copy));

        let renamed_other = directory.path().join("uninstall.exe");
        fs::write(&renamed_other, b"unrelated executable").unwrap();
        assert!(!is_channel_uninstaller_parent(&app, &install, &renamed_other));
        assert!(!is_channel_uninstaller_parent(&app, &install, &app));

        let copied_install = directory.path().join("copied-install");
        fs::create_dir(&copied_install).unwrap();
        let copied_app = copied_install.join(app.file_name().unwrap());
        let copied_uninstaller = copied_install.join("uninstall.exe");
        fs::write(&copied_app, fs::read(&app).unwrap()).unwrap();
        fs::write(&copied_uninstaller, fs::read(&uninstaller).unwrap()).unwrap();
        assert!(!is_channel_uninstaller_parent(
            &copied_app,
            &install,
            &copied_uninstaller,
        ));
    }

    #[cfg(windows)]
    #[test]
    fn cleanup_caller_identity_resolves_a_live_older_parent() {
        let parent = crate::windows_process::parent_process()
            .expect("current parent process should be queryable");
        let parent_image =
            crate::windows_process::executable(parent.0).expect("parent image should be queryable");
        let parent_created = crate::windows_process::creation_time(parent.0)
            .expect("parent creation time should exist");
        let current_created = crate::windows_process::creation_time(unsafe {
            windows_sys::Win32::System::Threading::GetCurrentProcess()
        })
        .expect("current creation time should exist");

        assert!(parent_image.is_file());
        assert!(parent_created < current_created);
    }
}

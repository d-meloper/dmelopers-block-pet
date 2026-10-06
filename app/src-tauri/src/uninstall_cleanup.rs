use std::ffi::{OsStr, OsString};

pub const COMMAND_LINE_FLAG: &str = "--dmeloper-uninstall-delete-user-data";
pub const EXIT_SUCCESS: i32 = 0;
pub const EXIT_OFFICIAL_APP_RUNNING: i32 = 20;
pub const EXIT_DATA_CLEANUP_FAILED: i32 = 21;
pub const EXIT_INVALID_REQUEST: i32 = 22;

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

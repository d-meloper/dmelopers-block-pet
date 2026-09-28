//! This runs before Tauri, Pinia, OBS, logs, or WebView can initialize data.
use crate::{
    data_paths::DataRoots,
    windows_process::{Handle, wide},
};
use windows_sys::Win32::{
    Foundation::{ERROR_ALREADY_EXISTS, GetLastError, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT},
    Globalization::GetUserDefaultUILanguage,
    System::Threading::{CreateEventW, CreateMutexW, ReleaseMutex, SetEvent, WaitForSingleObject},
    UI::{
        Controls::{
            TASKDIALOG_BUTTON, TASKDIALOGCONFIG, TDF_ALLOW_DIALOG_CANCELLATION,
            TDF_SIZE_TO_CONTENT, TaskDialogIndirect,
        },
        Shell::ShellExecuteW,
        WindowsAndMessaging::{MB_ICONERROR, MessageBoxW},
    },
};

pub struct LifetimeLock {
    mutex: Handle,
    event: std::sync::Arc<Handle>,
    installation: Option<Handle>,
}
impl Drop for LifetimeLock {
    fn drop(&mut self) {
        unsafe {
            ReleaseMutex(self.mutex.0);
        }
    }
}

impl LifetimeLock {
    fn acquire(identity: &str) -> Result<Option<Self>, String> {
        let sid = crate::windows_process::current_sid()?;
        let name = format!("Global\\DMeloper.BlockPet.{identity}.{sid}");
        let event_name = wide(&format!("{name}.activate"));
        let event = unsafe { CreateEventW(std::ptr::null(), 0, 0, event_name.as_ptr()) };
        if event.is_null() {
            return Err("INSTANCE_EVENT_UNAVAILABLE".into());
        }
        let event = std::sync::Arc::new(Handle(event));
        let mutex = unsafe { CreateMutexW(std::ptr::null(), 1, wide(&name).as_ptr()) };
        if mutex.is_null() {
            return Err("INSTANCE_LOCK_UNAVAILABLE".into());
        }
        let existed = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        let mutex = Handle(mutex);
        if existed {
            match unsafe { WaitForSingleObject(mutex.0, 0) } {
                WAIT_OBJECT_0 | WAIT_ABANDONED => {}
                WAIT_TIMEOUT => {
                    if unsafe { SetEvent(event.0) } == 0 {
                        return Err("INSTANCE_SIGNAL_FAILED".into());
                    }
                    return Ok(None);
                }
                _ => return Err("INSTANCE_LOCK_UNAVAILABLE".into()),
            }
        }
        Ok(Some(Self {
            mutex,
            event,
            installation: None,
        }))
    }
    fn protect_installation(&mut self) -> Result<(), String> {
        if tauri::is_dev() {
            return Ok(());
        }
        let name = match crate::distribution::channel() {
            crate::distribution::Channel::Github => "Local\\DMeloper.BlockPet.Installer",
            crate::distribution::Channel::Test => "Local\\DMeloper.BlockPet.Test.Installer",
            _ => return Ok(()),
        };
        // The pinned NSIS template holds this existence gate during payload replacement.
        // Both sides close their new handle and refuse when the object already exists.
        let mutex = unsafe { CreateMutexW(std::ptr::null(), 0, wide(name).as_ptr()) };
        if mutex.is_null() {
            return Err("INSTALLATION_LOCK_UNAVAILABLE".into());
        }
        let exists = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        let handle = Handle(mutex);
        if exists {
            return Err(localized("설치가 진행 중입니다. 설치를 완료하거나 설치 프로그램을 닫은 다음 앱을 다시 실행하세요.", "An installation is in progress. Finish or close the installer, then open the app again.").into());
        }
        self.installation = Some(handle);
        Ok(())
    }
    pub fn listen(&self, app: tauri::AppHandle) {
        let event = self.event.clone();
        std::thread::spawn(move || {
            loop {
                match unsafe { WaitForSingleObject(event.0, 1000) } {
                    WAIT_OBJECT_0 => tauri_plugin_custom_window::show_preference_window(&app),
                    WAIT_TIMEOUT => {}
                    _ => break,
                }
            }
        });
    }
}

pub fn error(message: &str) {
    let message = format!(
        "{}\n\n{message}",
        localized(
            "앱을 안전하게 시작할 수 없습니다.",
            "The app could not start safely."
        )
    );
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            wide(&message).as_ptr(),
            wide("DMeloper's Block Pet").as_ptr(),
            MB_ICONERROR,
        );
    }
}
fn localized<'a>(korean: &'a str, english: &'a str) -> &'a str {
    if unsafe { GetUserDefaultUILanguage() } & 0x3ff == 0x12 {
        korean
    } else {
        english
    }
}
const OPEN: i32 = 101;
const RECHECK: i32 = 102;
const EXIT: i32 = 103;
fn prompt(instruction: &str, content: &str, recheck: bool) -> i32 {
    let title = wide("DMeloper's Block Pet");
    let instruction = wide(instruction);
    let content = wide(content);
    let labels = [
        wide(localized("공식 페이지 열기", "Open official page")),
        wide(localized("다시 확인", "Recheck")),
        wide(localized("종료", "Exit")),
    ];
    let mut buttons = vec![TASKDIALOG_BUTTON {
        nButtonID: OPEN,
        pszButtonText: labels[0].as_ptr(),
    }];
    if recheck {
        buttons.push(TASKDIALOG_BUTTON {
            nButtonID: RECHECK,
            pszButtonText: labels[1].as_ptr(),
        });
    }
    buttons.push(TASKDIALOG_BUTTON {
        nButtonID: EXIT,
        pszButtonText: labels[2].as_ptr(),
    });
    let config = TASKDIALOGCONFIG {
        cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
        dwFlags: TDF_ALLOW_DIALOG_CANCELLATION | TDF_SIZE_TO_CONTENT,
        pszWindowTitle: title.as_ptr(),
        pszMainInstruction: instruction.as_ptr(),
        pszContent: content.as_ptr(),
        cButtons: buttons.len() as u32,
        pButtons: buttons.as_ptr(),
        nDefaultButton: EXIT,
        ..Default::default()
    };
    let mut selected = EXIT;
    let result = unsafe {
        TaskDialogIndirect(
            &config,
            &mut selected,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if result < 0 {
        error(localized(
            "시작 안내 창을 열 수 없습니다. Windows와 WebView2 설치 상태를 확인하세요.",
            "The startup dialog could not be displayed. Check Windows and WebView2 installation.",
        ));
        return EXIT;
    }
    selected
}
fn open_url(url: &str) {
    unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            wide("open").as_ptr(),
            wide(url).as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        );
    }
}
fn webview_supported(version: &str) -> bool {
    let mut parts = version.split('.');
    matches!(parts.next().and_then(|part| part.parse::<u32>().ok()), Some(major) if major >= 120)
}
fn webview_preflight() -> bool {
    loop {
        if tauri::webview_version().is_ok_and(|version| webview_supported(&version)) {
            return true;
        }
        let choice = prompt(
            localized(
                "WebView2 Runtime 설치가 필요합니다",
                "WebView2 Runtime required",
            ),
            localized(
                "Microsoft Edge WebView2 Runtime 120 이상이 필요합니다. Microsoft 공식 페이지에서 설치한 후 다시 확인하세요.",
                "Microsoft Edge WebView2 Runtime 120 or later is required. Install it from Microsoft's official page, then recheck.",
            ),
            true,
        );
        match choice {
            OPEN => open_url("https://developer.microsoft.com/microsoft-edge/webview2/"),
            RECHECK => {}
            _ => return false,
        }
    }
}
#[repr(C)]
struct OsVersion {
    size: u32,
    major: u32,
    minor: u32,
    build: u32,
    platform: u32,
    service_pack: [u16; 128],
}
#[link(name = "ntdll")]
unsafe extern "system" {
    fn RtlGetVersion(version: *mut OsVersion) -> i32;
}
fn platform_preflight() -> Result<(), String> {
    let mut version = OsVersion {
        size: std::mem::size_of::<OsVersion>() as u32,
        major: 0,
        minor: 0,
        build: 0,
        platform: 0,
        service_pack: [0; 128],
    };
    if unsafe { RtlGetVersion(&mut version) } < 0 || version.major < 10 || version.build < 26100 {
        return Err(localized(
            "Windows 11 24H2 이상(x64)이 필요합니다.",
            "Windows 11 version 24H2 or later (x64) is required.",
        )
        .into());
    }
    Ok(())
}
pub fn prepare() -> Result<Option<(LifetimeLock, DataRoots)>, String> {
    crate::core::restart::wait_for_parent()?;
    platform_preflight()?;
    store_identity_preflight()?;
    let Some(mut lock) = LifetimeLock::acquire(crate::distribution::channel().lock_identity())?
    else {
        return Ok(None);
    };
    lock.protect_installation()?;
    let exe = std::env::current_exe().map_err(|_| "INSTALLATION_UNAVAILABLE")?;
    let marker = exe
        .parent()
        .ok_or("INSTALLATION_UNAVAILABLE")?
        .join(".block-pet-installing");
    if marker
        .try_exists()
        .map_err(|_| "INSTALLATION_UNAVAILABLE")?
    {
        return Err(localized("설치가 중단되었습니다. 앱을 닫고 동일한 설치 프로그램을 다시 실행해 설치를 복구하세요. 공유 펫 데이터는 유지됩니다.", "Installation was interrupted. Close this app and run the same installer again to repair this installation. Your shared pet data will be preserved.").into());
    }
    if !webview_preflight() {
        return Ok(None);
    }
    let roots = DataRoots::resolve()?;
    if let Err(code) = roots.initialize() {
        if matches!(
            code.as_str(),
            "DATA_SCHEMA_UNSUPPORTED" | "DATA_METADATA_INVALID" | "DATA_METADATA_MISSING"
        ) {
            let (title, message) = if code == "DATA_SCHEMA_UNSUPPORTED" {
                (
                    localized("업데이트가 필요합니다", "Update required"),
                    localized(
                        "공유 펫 데이터에 더 최신 버전이 필요합니다. 설정은 변경되지 않았습니다. 이 설치본의 공식 업데이트 페이지를 여세요.",
                        "This shared pet data requires a newer version. No settings have been changed. Open the official update page for this installation.",
                    ),
                )
            } else {
                (
                    localized(
                        "공유 데이터 호환성을 확인할 수 없습니다",
                        "Shared data compatibility is unknown",
                    ),
                    localized(
                        "공유 데이터의 호환성 정보를 해석할 수 없습니다. 기존 파일은 그대로 유지됩니다. 이 설치본의 공식 페이지에서 업데이트 또는 도움말을 확인하세요.",
                        "The shared data compatibility information cannot be interpreted. Existing files are preserved. Open this installation's official page for updates or help.",
                    ),
                )
            };
            let choice = prompt(title, message, false);
            if choice == OPEN {
                open_url(&crate::distribution::channel().update_url());
            }
            return Ok(None);
        }
        return Err(format!(
            "{} ({code})",
            localized(
                "공유 펫 데이터를 열 수 없습니다. 대체 데이터 폴더는 생성하지 않았습니다.",
                "Shared pet data could not be opened. No fallback data folder was created."
            )
        ));
    }
    Ok(Some((lock, roots)))
}

fn store_identity_preflight() -> Result<(), String> {
    if crate::distribution::channel() != crate::distribution::Channel::Store {
        return Ok(());
    }
    let expected_name = option_env!("DMELOPER_STORE_IDENTITY_NAME")
        .filter(|value| !value.is_empty())
        .ok_or("STORE_IDENTITY_NOT_CONFIGURED")?;
    let expected_publisher = option_env!("DMELOPER_STORE_PUBLISHER")
        .filter(|value| !value.is_empty())
        .ok_or("STORE_IDENTITY_NOT_CONFIGURED")?;
    let package = windows::ApplicationModel::Package::Current()
        .map_err(|_| "STORE_PACKAGE_IDENTITY_REQUIRED")?;
    let id = package
        .Id()
        .map_err(|_| "STORE_PACKAGE_IDENTITY_REQUIRED")?;
    if id.Name().map_err(|_| "STORE_PACKAGE_IDENTITY_REQUIRED")? != expected_name
        || id
            .Publisher()
            .map_err(|_| "STORE_PACKAGE_IDENTITY_REQUIRED")?
            != expected_publisher
    {
        return Err("STORE_PACKAGE_IDENTITY_MISMATCH".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn webview_version_gate_rejects_old_and_invalid_versions() {
        assert!(webview_supported("120.0.0.0"));
        assert!(webview_supported("140.0.100.4"));
        assert!(!webview_supported("119.999.999.999"));
        assert!(!webview_supported("unknown"));
    }
    #[test]
    fn kernel_mutex_releases_when_owner_exits_and_second_process_only_signals() {
        // A separate thread is essential: Windows mutex recursion is per thread.
        let name = format!("Test.{}", std::process::id());
        let lock = LifetimeLock::acquire(&name).unwrap().unwrap();
        let other = name.clone();
        assert!(
            std::thread::spawn(move || LifetimeLock::acquire(&other).unwrap().is_none())
                .join()
                .unwrap()
        );
        assert_eq!(
            unsafe { WaitForSingleObject(lock.event.0, 0) },
            WAIT_OBJECT_0
        );
        drop(lock);
        assert!(LifetimeLock::acquire(&name).unwrap().is_some());
    }
}

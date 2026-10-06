//! This runs before Tauri, Pinia, OBS, logs, or WebView can initialize data.
use crate::{
    data_paths::DataRoots,
    windows_process::{Handle, wide, windows_revision},
};
#[cfg(any(feature = "wix-local-test", feature = "wix-github"))]
use windows_sys::Win32::System::Threading::GetCurrentProcess;
use windows_sys::Win32::{
    Foundation::{
        ERROR_ALREADY_EXISTS, GetLastError, WAIT_ABANDONED, WAIT_FAILED, WAIT_OBJECT_0,
        WAIT_TIMEOUT,
    },
    Globalization::GetUserDefaultUILanguage,
    System::Threading::{
        CreateEventW, CreateMutexW, INFINITE, ReleaseMutex, SetEvent, WaitForSingleObject,
    },
    UI::{
        Controls::{
            TASKDIALOG_BUTTON, TASKDIALOGCONFIG, TDF_ALLOW_DIALOG_CANCELLATION,
            TDF_SIZE_TO_CONTENT, TaskDialogIndirect,
        },
        Shell::ShellExecuteW,
        WindowsAndMessaging::{MB_ICONERROR, MB_ICONWARNING, MessageBoxW},
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
    fn acquire(identity: &str, signal_existing: bool) -> Result<Option<Self>, String> {
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
                    if signal_existing && unsafe { SetEvent(event.0) } == 0 {
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
            crate::distribution::Channel::Test if cfg!(feature = "wix-local-test") => "Local\\DMeloper.BlockPet.WixLocal.Installer",
            crate::distribution::Channel::Test => "Local\\DMeloper.BlockPet.Test.Installer",
            _ => return Ok(()),
        };
        // The Burn bootstrapper holds this existence gate during payload replacement.
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
                let result = wait_for_activation(&event);
                if !handle_activation_wait(
                    result,
                    || unsafe { GetLastError() },
                    || tauri_plugin_custom_window::show_preference_window(&app),
                    |code| crate::diagnostics::warn("instance.activation_listener", code),
                ) {
                    break;
                }
            }
        });
    }
}

/// Called only by the registered channel uninstaller after explicit data consent.
#[cfg(any(feature = "wix-local-test", feature = "wix-github"))]
pub fn remove_user_data_for_uninstall() -> Result<(), &'static str> {
    let channel = crate::distribution::channel();
    if !matches!(channel, crate::distribution::Channel::Github | crate::distribution::Channel::Test) {
        return Err("UNINSTALL_CLEANUP_CALLER_INVALID");
    }
    if !channel_uninstaller_is_caller()? {
        return Err("UNINSTALL_CLEANUP_CALLER_INVALID");
    }
    let Some(_lifetime) = LifetimeLock::acquire(channel.lock_identity(), false)
        .map_err(|_| "UNINSTALL_CLEANUP_LOCK_UNAVAILABLE")?
    else {
        return Err("UNINSTALL_OFFICIAL_APP_RUNNING");
    };
    let roots = DataRoots::resolve().map_err(|_| "UNINSTALL_DATA_UNAVAILABLE")?;
    match channel {
        crate::distribution::Channel::Github => crate::data_paths::remove_github_user_data(&roots),
        #[cfg(feature = "test-repository")]
        crate::distribution::Channel::Test => crate::data_paths::remove_test_user_data(&roots),
        _ => Err("UNINSTALL_CLEANUP_CALLER_INVALID"),
    }
}

#[cfg(any(feature = "wix-local-test", feature = "wix-github"))]
fn channel_uninstaller_is_caller() -> Result<bool, &'static str> {
    let parent =
        crate::windows_process::parent_process().map_err(|_| "UNINSTALL_CLEANUP_CALLER_INVALID")?;
    let parent_sid = crate::windows_process::user_sid(parent.0)
        .map_err(|_| "UNINSTALL_CLEANUP_CALLER_INVALID")?;
    let current_sid =
        crate::windows_process::current_sid().map_err(|_| "UNINSTALL_CLEANUP_CALLER_INVALID")?;
    if parent_sid != current_sid {
        return Ok(false);
    }

    let parent_created = crate::windows_process::creation_time(parent.0)
        .map_err(|_| "UNINSTALL_CLEANUP_CALLER_INVALID")?;
    let current_created = crate::windows_process::creation_time(unsafe { GetCurrentProcess() })
        .map_err(|_| "UNINSTALL_CLEANUP_CALLER_INVALID")?;
    if parent_created >= current_created {
        return Ok(false);
    }

    let parent_image = crate::windows_process::executable(parent.0)
        .map_err(|_| "UNINSTALL_CLEANUP_CALLER_INVALID")?;
    let current_image = std::env::current_exe().map_err(|_| "UNINSTALL_CLEANUP_CALLER_INVALID")?;
    let registered_install_root = crate::windows_process::registered_install_root()
        .map_err(|_| "UNINSTALL_CLEANUP_CALLER_INVALID")?;
    Ok(crate::wix_local::cleanup_caller(&current_image, &registered_install_root, &parent_image))
}

fn wait_for_activation(event: &Handle) -> u32 {
    // Activation has no periodic work. The listener owns the handle until process
    // exit, and an auto-reset signal wakes this wait without a polling delay.
    unsafe { WaitForSingleObject(event.0, INFINITE) }
}

fn handle_activation_wait(
    result: u32,
    last_error: impl FnOnce() -> u32,
    activate: impl FnOnce(),
    mut report: impl FnMut(&str),
) -> bool {
    match result {
        WAIT_OBJECT_0 => {
            activate();
            true
        }
        WAIT_TIMEOUT => true,
        WAIT_FAILED => {
            report(&format!("WIN32_{}", last_error()));
            false
        }
        _ => {
            report("UNEXPECTED_WAIT_RESULT");
            false
        }
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
fn prompt(instruction: &str, content: &str, recheck: bool, open_label: &str) -> i32 {
    let title = wide("DMeloper's Block Pet");
    let instruction = wide(instruction);
    let content = wide(content);
    let labels = [
        wide(open_label),
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
const WEBVIEW_GUIDE: &str = "https://app.notion.com/p/aismash/WebView2-Runtime-3f02dc0bb4ae80cf87f8e8a02efe0adb?source=copy_link";
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
            &format!(
                "{}\n\n{WEBVIEW_GUIDE}",
                localized(
                    "3D 렌더링을 위해 Microsoft WebView2 Runtime 프로그램이 필요합니다. 다음 링크에서 수동으로 설치한 뒤 다시 실행해 주세요.",
                    "Microsoft WebView2 Runtime is needed for 3D rendering. Follow this link to install it manually, then try again.",
                )
            ),
            true,
            localized("설치 안내 열기", "Open installation guide"),
        );
        match choice {
            OPEN => open_url(WEBVIEW_GUIDE),
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
fn minimum_windows_version(status: i32, major: u32, build: u32, revision: Option<u32>) -> bool {
    if status < 0 || major < 10 {
        return false;
    }
    // Windows 11 21H2 has a higher build than Windows 10 22H2, but does not
    // meet the RAM sampler's minimum. Check each supported servicing branch.
    match build {
        19045 => revision.is_some_and(|revision| revision >= 3448),
        22621 => revision.is_some_and(|revision| revision >= 2283),
        _ => build > 22621,
    }
}
fn platform_preflight() {
    let mut version = OsVersion {
        size: std::mem::size_of::<OsVersion>() as u32,
        major: 0,
        minor: 0,
        build: 0,
        platform: 0,
        service_pack: [0; 128],
    };
    let status = unsafe { RtlGetVersion(&mut version) };
    if !minimum_windows_version(status, version.major, version.build, windows_revision()) {
        // Platform advice does not prevent the normal startup checks from running.
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                wide(localized(
                    "최소 사양은 Windows 10 22H2(빌드 19045.3448) 또는 Windows 11 22H2(빌드 22621.2283) 이상의 x64 환경입니다. 2023년 9월 또는 이후 누적 업데이트가 필요합니다. 현재 Windows가 최소 사양에 미달하거나 업데이트 상태를 확인할 수 없습니다. 계속 실행할 수 있지만 일부 기능이 올바르게 작동하지 않을 수 있습니다.",
                    "The minimum is Windows 10 22H2 (build 19045.3448) or Windows 11 22H2 (build 22621.2283) or later, x64, with the September 2023 or a later cumulative update. This Windows version is below the minimum or its update revision could not be checked. You can continue, but some features may not work correctly.",
                )).as_ptr(),
                wide("DMeloper's Block Pet").as_ptr(),
                MB_ICONWARNING,
            );
        }
    }
}
pub fn prepare() -> Result<Option<(LifetimeLock, DataRoots)>, String> {
    crate::core::restart::wait_for_parent()?;
    platform_preflight();
    store_identity_preflight()?;
    let Some(mut lock) =
        LifetimeLock::acquire(crate::distribution::channel().lock_identity(), true)?
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
            let choice = prompt(
                title,
                message,
                false,
                localized("공식 페이지 열기", "Open official page"),
            );
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
    fn windows_minimum_checks_the_cumulative_update_on_each_servicing_branch() {
        assert!(!minimum_windows_version(0, 10, 19044, Some(9999)));
        assert!(!minimum_windows_version(0, 10, 19045, Some(3447)));
        assert!(minimum_windows_version(0, 10, 19045, Some(3448)));
        assert!(minimum_windows_version(0, 10, 19045, Some(9999)));
        assert!(!minimum_windows_version(0, 10, 19045, None));

        // A Windows 11 21H2 build must not pass merely because it is newer
        // than the Windows 10 branch. The 22H2 CU has a separate boundary.
        assert!(!minimum_windows_version(0, 10, 22000, Some(9999)));
        assert!(!minimum_windows_version(0, 10, 22621, Some(2282)));
        assert!(minimum_windows_version(0, 10, 22621, Some(2283)));
        assert!(minimum_windows_version(0, 10, 22621, Some(9999)));
        assert!(!minimum_windows_version(0, 10, 22621, None));
    }

    #[test]
    fn later_windows_builds_do_not_require_the_boundary_revision() {
        for build in [22631, 26100, 26200] {
            assert!(minimum_windows_version(0, 10, build, None));
            assert!(minimum_windows_version(0, 10, build, Some(1)));
        }
        assert!(minimum_windows_version(0, 11, 26200, None));
        assert!(!minimum_windows_version(0, 6, 9600, Some(9999)));
        assert!(!minimum_windows_version(-1, 10, 26100, Some(9999)));
    }

    #[test]
    fn windows_minimum_is_advice_and_webview_remains_required() {
        // A supported Windows 10 does not need to meet the Windows 11
        // recommendation. Unsupported versions still receive advice only.
        assert!(minimum_windows_version(0, 10, 19045, Some(3448)));
        assert!(webview_supported("120.0.2210.91"));
        assert!(!webview_supported("119.0.0.0"));
        assert!(!webview_supported(""));
    }

    #[test]
    fn activation_wait_stays_blocked_until_each_auto_reset_signal() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
            mpsc,
        };
        use std::time::Duration;

        struct StopWait {
            event: Arc<Handle>,
            stopped: Arc<AtomicBool>,
        }
        impl Drop for StopWait {
            fn drop(&mut self) {
                self.stopped.store(true, Ordering::SeqCst);
                unsafe {
                    SetEvent(self.event.0);
                }
            }
        }

        let handle = unsafe { CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()) };
        assert!(!handle.is_null());
        let event = Arc::new(Handle(handle));
        let stopped = Arc::new(AtomicBool::new(false));
        let (ready, started) = mpsc::channel();
        let (completion, completed) = mpsc::channel();

        std::thread::scope(|scope| {
            let waiting_event = Arc::clone(&event);
            let waiting_stopped = Arc::clone(&stopped);
            scope.spawn(move || {
                ready.send(()).unwrap();
                while !waiting_stopped.load(Ordering::SeqCst) {
                    let result = wait_for_activation(&waiting_event);
                    if completion.send(result).is_err() || result != WAIT_OBJECT_0 {
                        break;
                    }
                }
            });
            // Always release the actual native wait, including after an assertion
            // fails, before the scope joins its listener thread.
            let _stop = StopWait {
                event: Arc::clone(&event),
                stopped,
            };
            started.recv_timeout(Duration::from_secs(2)).unwrap();

            // This crosses the removed one-second timeout. Silence proves that
            // there is no timeout return to handle, not merely no activation.
            assert_eq!(
                completed.recv_timeout(Duration::from_millis(1_250)),
                Err(mpsc::RecvTimeoutError::Timeout)
            );
            for _ in 0..3 {
                assert_ne!(unsafe { SetEvent(event.0) }, 0);
                assert_eq!(
                    completed.recv_timeout(Duration::from_secs(2)).unwrap(),
                    WAIT_OBJECT_0
                );
                assert_eq!(unsafe { WaitForSingleObject(event.0, 0) }, WAIT_TIMEOUT);
                assert_eq!(completed.try_recv(), Err(mpsc::TryRecvError::Empty));
            }
        });
    }

    #[test]
    fn activation_listener_reports_only_wait_failures() {
        let mut activations = 0;
        let mut reports = Vec::new();
        assert!(handle_activation_wait(
            WAIT_OBJECT_0,
            || panic!("a signaled event has no last error"),
            || activations += 1,
            |code| reports.push(code.to_owned()),
        ));
        assert_eq!(activations, 1);
        assert!(reports.is_empty());

        assert!(handle_activation_wait(
            WAIT_TIMEOUT,
            || panic!("a timeout has no last error"),
            || activations += 1,
            |code| reports.push(code.to_owned()),
        ));
        assert_eq!(activations, 1);
        assert!(reports.is_empty());

        assert!(!handle_activation_wait(
            WAIT_FAILED,
            || 6,
            || activations += 1,
            |code| reports.push(code.to_owned()),
        ));
        assert_eq!(reports, ["WIN32_6"]);

        assert!(!handle_activation_wait(
            WAIT_ABANDONED,
            || panic!("unexpected wait results do not use last error"),
            || activations += 1,
            |code| reports.push(code.to_owned()),
        ));
        assert_eq!(reports, ["WIN32_6", "UNEXPECTED_WAIT_RESULT"]);
        assert_eq!(activations, 1);
    }

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
        let name = format!("Test.signal.{}", std::process::id());
        let lock = LifetimeLock::acquire(&name, true).unwrap().unwrap();
        let other = name.clone();
        assert!(
            std::thread::spawn(move || LifetimeLock::acquire(&other, true).unwrap().is_none())
                .join()
                .unwrap()
        );
        assert_eq!(
            unsafe { WaitForSingleObject(lock.event.0, 0) },
            WAIT_OBJECT_0
        );
        drop(lock);
        assert!(LifetimeLock::acquire(&name, true).unwrap().is_some());
    }

    #[test]
    fn cleanup_lock_refuses_running_app_without_signaling_it() {
        let name = format!("Test.no-activate.{}", std::process::id());
        let lock = LifetimeLock::acquire(&name, true).unwrap().unwrap();
        let other = name.clone();
        assert!(
            std::thread::spawn(move || LifetimeLock::acquire(&other, false).unwrap().is_none())
                .join()
                .unwrap()
        );
        assert_eq!(
            unsafe { WaitForSingleObject(lock.event.0, 0) },
            WAIT_TIMEOUT
        );
    }
}

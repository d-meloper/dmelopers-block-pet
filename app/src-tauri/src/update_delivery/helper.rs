//! Application paths and native notices are adapters around the UI-free protocol.
use super::{UpdateError, fail, feed::Feed};
pub use block_pet_update_core::helper::{
    CommitOutcome, cancel_prepared, commit, require_no_other_account_process,
    require_plain_directory,
};
use std::path::Path;
use tauri::Manager;

#[path = "../../../crates/update-core/src/native_notice.rs"]
mod native_notice;

pub fn prepare(
    app: &tauri::AppHandle,
    staging: &Path,
    request_id: &str,
    feed: &Feed,
    cancelled: impl Fn() -> bool,
) -> Result<(), UpdateError> {
    let expected_worker: block_pet_update_core::helper::WorkerIdentity = serde_json::from_str(
        include_str!(concat!(env!("OUT_DIR"), "/update-worker-identity.json")),
    )
    .map_err(|_| fail("PACKAGED_WORKER_REQUIRED"))?;
    let data_root = app
        .path()
        .app_data_dir()
        .map_err(|_| fail("STORAGE_UNAVAILABLE"))?;
    block_pet_update_core::helper::prepare(
        &data_root,
        &app.package_info().version.to_string(),
        &expected_worker,
        staging,
        request_id,
        feed,
        cancelled,
    )
}

pub fn guard_boot(app: &tauri::AppHandle) -> Result<(), String> {
    let data_root = app.path().app_data_dir().map_err(|_| "RECOVERY_REQUIRED")?;
    let result = block_pet_update_core::helper::guard_boot(&data_root);
    if result
        .as_ref()
        .is_err_and(|reason| reason == "PROGRAM_RECOVERY_PENDING")
    {
        app.exit(0);
    }
    result
}

pub fn cleanup_verified_operations(app: &tauri::AppHandle) -> bool {
    let Ok(local_root) = app.path().app_local_data_dir() else {
        return false;
    };
    let Ok(data_root) = app.path().app_data_dir() else {
        return false;
    };
    block_pet_update_core::helper::cleanup_verified_operations(
        &local_root.join("update-delivery"),
        &data_root,
    )
}

pub fn run_from_args() -> bool {
    let first = std::env::args_os().nth(1);
    let role = block_pet_update_core::helper::invocation_role(first.as_deref());
    match dispatch_application_entry(
        role,
        block_pet_update_core::helper::install_guard_exit_code,
        || native_notice::show("PACKAGED_WORKER_REQUIRED"),
    ) {
        Some(code) => std::process::exit(code),
        None => false,
    }
}

fn dispatch_application_entry(
    role: block_pet_update_core::helper::InvocationRole,
    guard: impl FnOnce() -> i32,
    rejected_worker: impl FnOnce(),
) -> Option<i32> {
    use block_pet_update_core::helper::InvocationRole;
    match role {
        InvocationRole::Application => None,
        InvocationRole::InstallGuard => Some(guard()),
        InvocationRole::Worker => {
            rejected_worker();
            Some(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use block_pet_update_core::helper::invocation_role;
    use std::cell::Cell;

    #[test]
    fn application_entry_preserves_health_boot_and_never_dispatches_worker_transactions() {
        for argument in [
            None,
            Some("--update-request-id"),
            Some("--update-recovery"),
            Some("--expected-version"),
        ] {
            let role = invocation_role(argument.map(std::ffi::OsStr::new));
            assert_eq!(
                dispatch_application_entry(role, || panic!("guard"), || panic!("notice")),
                None
            );
        }
        let guard_calls = Cell::new(0);
        assert_eq!(
            dispatch_application_entry(
                invocation_role(Some(std::ffi::OsStr::new("--update-install-guard"))),
                || {
                    guard_calls.set(guard_calls.get() + 1);
                    1618
                },
                || panic!("notice")
            ),
            Some(1618)
        );
        assert_eq!(guard_calls.get(), 1);
        for flag in [
            "--update-helper",
            "--resume-update-helper",
            "--resume-elevated-helper",
        ] {
            let rejected = Cell::new(false);
            assert_eq!(
                dispatch_application_entry(
                    invocation_role(Some(std::ffi::OsStr::new(flag))),
                    || panic!("worker commands cannot query the install guard"),
                    || rejected.set(true)
                ),
                Some(1)
            );
            assert!(rejected.get());
        }
    }
}

//! Durable, request-bound failure notifications. Dismissal never changes recovery.
use super::{OperationState, integrity::Result, operation_root, read_state, write_json};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path, sync::Mutex};
use tauri::{Emitter, Manager};

static NOTIFICATION: Mutex<Option<Saved>> = Mutex::new(None);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Failure {
    pub notification_id: String,
    pub request_id: Option<String>,
    pub reason: String,
    pub outcome: String,
    pub source_version: Option<String>,
    pub target_version: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    failure: Failure,
    dismissed: bool,
}

fn read(root: &Path) -> Result<Option<Saved>> {
    let path = root.join("failure-notification.json");
    super::check_path(&path)?;
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| "CORRUPT_NOTIFICATION".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("READ_FAILED".into()),
    }
}

fn safe_reason(reason: &str) -> String {
    if !reason.is_empty()
        && reason.len() <= 128
        && reason
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_' || b == b':')
    {
        reason.into()
    } else {
        "RECOVERY_REQUIRED".into()
    }
}

fn make_failure(
    request_id: Option<String>,
    reason: &str,
    outcome: &str,
    source_version: Option<String>,
    target_version: Option<String>,
) -> Failure {
    let reason = safe_reason(reason);
    let identity = serde_json::to_vec(&(
        &request_id,
        &reason,
        outcome,
        &source_version,
        &target_version,
    ))
    .expect("notification identity contains only strings");
    Failure {
        notification_id: super::integrity::digest(&identity),
        request_id,
        reason,
        outcome: outcome.into(),
        source_version,
        target_version,
    }
}

fn store(root: &Path, failure: &Failure) -> Result<bool> {
    if read(root)?.is_some_and(|saved| saved.failure == *failure) {
        return Ok(false);
    }
    write_json(
        &root.join("failure-notification.json"),
        &Saved {
            failure: failure.clone(),
            dismissed: false,
        },
    )?;
    Ok(true)
}

pub(super) fn operation_changed(app: &tauri::AppHandle, operation: &OperationState) {
    if matches!(operation.phase.as_str(), "verified" | "rolledBack") {
        clear_pending_notice(app, &operation.request_id);
    }
    let Some(reason) = operation
        .failure_reason
        .as_deref()
        .or(operation.error.as_deref())
    else {
        return;
    };
    if reason == "CANCELLED_BEFORE_INSTALL" {
        return;
    }
    let outcome = match operation.phase.as_str() {
        "rollbackPending" | "rollingBack" | "awaitingRollbackHealth" => "recovering",
        "rolledBack" if operation.rollback_attempted && operation.rendered => "rolledBack",
        "rolledBack" if !operation.rollback_attempted => "unchanged",
        "failed" => "failed",
        _ => "unknown",
    };
    report(
        app,
        Some(operation.request_id.clone()),
        reason,
        outcome,
        Some(operation.source_version.clone()),
        Some(operation.expected_version.clone()),
    );
}

fn clear_pending_notice(app: &tauri::AppHandle, request_id: &str) {
    let mut latest = NOTIFICATION
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let Ok(root) = operation_root(app) else {
        return;
    };
    let saved = latest.clone().or_else(|| read(&root).ok().flatten());
    if let Some(mut saved) = saved {
        if saved.failure.request_id.as_deref() == Some(request_id)
            && matches!(
                saved.failure.reason.as_str(),
                "HEALTH_CHECK_PENDING" | "PROGRAM_COMMIT_PENDING"
            )
        {
            saved.dismissed = true;
            let _ = write_json(&root.join("failure-notification.json"), &saved);
            *latest = Some(saved);
            if let Some(window) = app.get_webview_window("update-failure") {
                let _ = window.hide();
            }
        }
    }
}

pub fn report(
    app: &tauri::AppHandle,
    request_id: Option<String>,
    reason: &str,
    outcome: &str,
    source_version: Option<String>,
    target_version: Option<String>,
) {
    let failure = make_failure(request_id, reason, outcome, source_version, target_version);
    // Serialize publication and window visibility with dismissal. A stale
    // delayed show cannot reopen a notification already dismissed by its owner.
    let mut latest = NOTIFICATION
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let result = operation_root(app).and_then(|root| store(&root, &failure));
    match result {
        Ok(true) => {
            *latest = Some(Saved {
                failure: failure.clone(),
                dismissed: false,
            });
            let _ = app.emit("update-failure", &failure);
            crate::update_delivery::open_recovery_window(app);
        }
        Ok(false) => {
            if let Ok(Some(saved)) = operation_root(app).and_then(|root| read(&root)) {
                *latest = Some(saved);
            }
        }
        Err(_) => {
            // Storage failure must still reach the current UI without replacing
            // any existing durable recovery record or retrying data restoration.
            log::warn!("Unable to persist update failure notification.");
            *latest = Some(Saved {
                failure: failure.clone(),
                dismissed: false,
            });
            let _ = app.emit("update-failure", &failure);
            crate::update_delivery::open_recovery_window(app);
        }
    }
}

pub fn restore(app: &tauri::AppHandle) {
    if let Ok(root) = operation_root(app) {
        if let Ok(Some(operation)) = read_state(&root) {
            operation_changed(app, &operation);
        }
        if read(&root)
            .ok()
            .flatten()
            .is_some_and(|saved| !saved.dismissed)
        {
            crate::update_delivery::open_recovery_window(app);
        }
    }
}

#[tauri::command]
pub fn get_update_failure(app: tauri::AppHandle) -> Result<Option<Failure>> {
    let latest = NOTIFICATION.lock().map_err(|_| "OPERATION_BUSY")?;
    let saved = match latest.as_ref() {
        Some(saved) => Some(saved.clone()),
        None => read(&operation_root(&app)?)?,
    };
    Ok(saved
        .filter(|saved| !saved.dismissed)
        .map(|saved| saved.failure))
}

fn dismiss(root: &Path, notification_id: &str) -> Result<()> {
    let mut saved = read(root)?.ok_or("NOTIFICATION_NOT_SAVED")?;
    if saved.failure.notification_id != notification_id {
        return Err("INVALID_REQUEST".into());
    }
    saved.dismissed = true;
    write_json(&root.join("failure-notification.json"), &saved)
}

#[tauri::command]
pub fn dismiss_update_failure(app: tauri::AppHandle, notification_id: String) -> Result<()> {
    let mut latest = NOTIFICATION.lock().map_err(|_| "OPERATION_BUSY")?;
    if latest
        .as_ref()
        .is_some_and(|saved| saved.failure.notification_id != notification_id)
    {
        return Err("INVALID_REQUEST".into());
    }
    let result = operation_root(&app).and_then(|root| dismiss(&root, &notification_id));
    if result
        .as_ref()
        .is_err_and(|error| error == "INVALID_REQUEST")
    {
        return result;
    }
    if let Some(saved) = latest.as_mut() {
        // A failed disk must not make the failure modal impossible to dismiss.
        // This in-memory acknowledgement lasts only for the current process.
        saved.dismissed = true;
        if result.is_err() {
            log::warn!("Update failure dismissal could not be saved.");
        }
    } else {
        result?;
    }
    if let Some(window) = app.get_webview_window("update-failure") {
        window.hide().map_err(|_| "WINDOW_UNAVAILABLE")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dismissal_is_durable_and_an_old_modal_cannot_dismiss_a_new_outcome() {
        let temp = tempfile::tempdir().unwrap();
        let first = make_failure(
            Some("request".into()),
            "RENDER_FAILED",
            "recovering",
            Some("0.9.0".into()),
            Some("1.0.0".into()),
        );
        assert!(store(temp.path(), &first).unwrap());
        dismiss(temp.path(), &first.notification_id).unwrap();
        assert!(!store(temp.path(), &first).unwrap());
        assert!(read(temp.path()).unwrap().unwrap().dismissed);
        let mut final_result = make_failure(
            first.request_id.clone(),
            "RENDER_FAILED",
            "rolledBack",
            first.source_version.clone(),
            first.target_version.clone(),
        );
        assert_ne!(first.notification_id, final_result.notification_id);
        assert!(store(temp.path(), &final_result).unwrap());
        assert_eq!(
            dismiss(temp.path(), &first.notification_id).unwrap_err(),
            "INVALID_REQUEST"
        );
        assert!(!read(temp.path()).unwrap().unwrap().dismissed);
        final_result.reason = "unchanged original cause".into();
        assert_eq!(
            read(temp.path()).unwrap().unwrap().failure.reason,
            "RENDER_FAILED"
        );
    }

    #[test]
    fn notification_cannot_expose_paths_or_untrusted_error_text() {
        assert_eq!(safe_reason("IO_ERROR"), "IO_ERROR");
        assert_eq!(
            safe_reason("failed at C:\\Fixture\\private"),
            "RECOVERY_REQUIRED"
        );
    }
}

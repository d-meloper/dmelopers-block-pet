use serde::Serialize;
#[cfg(not(feature = "channel-store"))]
#[path = "autostart_github.rs"]
mod github;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartStatus {
    enabled: bool,
    state: &'static str,
    can_enable: bool,
    can_disable: bool,
}

#[cfg(feature = "channel-store")]
fn status(state: windows::ApplicationModel::StartupTaskState) -> Result<AutostartStatus, String> {
    use windows::ApplicationModel::StartupTaskState as S;
    Ok(match state {
        S::Enabled => AutostartStatus {
            enabled: true,
            state: "enabled",
            can_enable: true,
            can_disable: true,
        },
        S::DisabledByUser => AutostartStatus {
            enabled: false,
            state: "disabledByUser",
            can_enable: false,
            can_disable: false,
        },
        S::DisabledByPolicy => AutostartStatus {
            enabled: false,
            state: "disabledByPolicy",
            can_enable: false,
            can_disable: false,
        },
        S::EnabledByPolicy => AutostartStatus {
            enabled: true,
            state: "enabledByPolicy",
            can_enable: false,
            can_disable: false,
        },
        S::Disabled => AutostartStatus {
            enabled: false,
            state: "disabled",
            can_enable: true,
            can_disable: true,
        },
        _ => return Err("AUTOSTART_STATE_UNKNOWN".into()),
    })
}
#[tauri::command]
pub async fn autostart_status(app: tauri::AppHandle) -> Result<AutostartStatus, String> {
    #[cfg(feature = "channel-store")]
    {
        let _ = app;
        let task = windows::ApplicationModel::StartupTask::GetAsync(&windows::core::HSTRING::from(
            "BlockPetStartup",
        ))
        .map_err(|_| "AUTOSTART_UNAVAILABLE")?
        .await
        .map_err(|_| "AUTOSTART_UNAVAILABLE")?;
        status(task.State().map_err(|_| "AUTOSTART_UNAVAILABLE")?)
    }
    #[cfg(not(feature = "channel-store"))]
    {
        let _ = app;
        github::status()
    }
}
#[tauri::command]
pub async fn set_autostart_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<AutostartStatus, String> {
    #[cfg(feature = "channel-store")]
    {
        let _ = app;
        let task = windows::ApplicationModel::StartupTask::GetAsync(&windows::core::HSTRING::from(
            "BlockPetStartup",
        ))
        .map_err(|_| "AUTOSTART_UNAVAILABLE")?
        .await
        .map_err(|_| "AUTOSTART_UNAVAILABLE")?;
        let before = status(task.State().map_err(|_| "AUTOSTART_UNAVAILABLE")?)?;
        if (enabled && !before.can_enable) || (!enabled && !before.can_disable) {
            return Ok(before);
        }
        if enabled {
            status(
                task.RequestEnableAsync()
                    .map_err(|_| "AUTOSTART_UNAVAILABLE")?
                    .await
                    .map_err(|_| "AUTOSTART_UNAVAILABLE")?,
            )
        } else {
            task.Disable().map_err(|_| "AUTOSTART_UNAVAILABLE")?;
            status(task.State().map_err(|_| "AUTOSTART_UNAVAILABLE")?)
        }
    }
    #[cfg(not(feature = "channel-store"))]
    {
        let _ = app;
        github::set(enabled)
    }
}

#[cfg(all(test, feature = "channel-store"))]
mod tests {
    use super::*;
    #[test]
    fn user_and_policy_blocks_are_never_overridden() {
        use windows::ApplicationModel::StartupTaskState as S;
        for state in [S::DisabledByUser, S::DisabledByPolicy, S::EnabledByPolicy] {
            let status = status(state).unwrap();
            assert!(!status.can_enable);
            assert!(!status.can_disable);
        }
        assert!(status(S::Disabled).unwrap().can_enable);
        assert!(status(S::Enabled).unwrap().can_disable);
    }
}

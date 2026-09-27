// A supervised development session waits for all build cleanup before restarting.
const DEVELOPMENT_RESTART_EXIT_CODE: i32 = 75;
const DEVELOPMENT_RESTART_PROTOCOL: &str = "DMELOPER_DEV_RESTART_PROTOCOL";

fn restart_session(
    development: bool,
    supervised: bool,
    exit: impl FnOnce(i32),
    restart: impl FnOnce(),
) -> Result<(), String> {
    if development {
        if !supervised {
            return Err(
                "Development restart requires a supervised application session."
                    .into(),
            );
        }
        exit(DEVELOPMENT_RESTART_EXIT_CODE);
    } else {
        restart();
    }
    Ok(())
}

#[tauri::command]
pub fn restart_application(app: tauri::AppHandle) -> Result<(), String> {
    let result: Result<(), String> = (|| {
        restart_session(
            tauri::is_dev(),
            std::env::var(DEVELOPMENT_RESTART_PROTOCOL).as_deref() == Ok("1"),
            |code| app.exit(code),
            || app.request_restart(),
        )
    })();
    if result.is_err() {
        crate::diagnostics::warn("app.restart", "DEVELOPMENT_SUPERVISOR_REQUIRED");
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn development_exits_the_entire_app_for_its_launcher() {
        let exit_code = Cell::new(None);
        restart_session(
            true,
            true,
            |code| exit_code.set(Some(code)),
            || panic!("relaunching a dev executable would lose its frontend server"),
        )
        .unwrap();
        assert_eq!(exit_code.get(), Some(75));
    }

    #[test]
    fn unmanaged_development_keeps_the_app_alive_and_reports_the_required_launcher() {
        let result = restart_session(
            true,
            false,
            |_| panic!("must not exit without a launcher that can restart the session"),
            || panic!("must not relaunch without preserving the frontend server"),
        );
        assert!(result.unwrap_err().contains("supervised application session"));
    }

    #[test]
    fn packaged_apps_restart_natively_regardless_of_development_environment() {
        for supervised in [false, true] {
            let restarted = Cell::new(false);
            restart_session(
                false,
                supervised,
                |_| panic!("packaged applications must not depend on the dev launcher"),
                || restarted.set(true),
            )
            .unwrap();
            assert!(restarted.get());
        }
    }
}

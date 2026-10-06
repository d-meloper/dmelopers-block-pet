//! Restart is an authenticated parent/child handoff, never Tauri's early relaunch.
use crate::windows_process::{Handle, wide};
use windows_sys::Win32::{
    Foundation::WAIT_OBJECT_0,
    System::Threading::{
        CreateEventW, EVENT_MODIFY_STATE, GetCurrentProcess, OpenEventW, OpenProcess,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, SetEvent, WaitForSingleObject,
    },
};
const RESTART_ARGUMENT: &str = "--block-pet-restart-parent";
const DEVELOPMENT_RESTART_EXIT_CODE: i32 = 75;
const DEVELOPMENT_RESTART_PROTOCOL: &str = "DMELOPER_DEV_RESTART_PROTOCOL";

fn handoff_fields(value: &str) -> Result<(u32, u64, &str), String> {
    let fields: Vec<_> = value.split(':').collect();
    if fields.len() != 3 {
        return Err("RESTART_HANDOFF_INVALID".into());
    }
    let pid = fields[0]
        .parse::<u32>()
        .map_err(|_| "RESTART_HANDOFF_INVALID")?;
    let created = fields[1]
        .parse::<u64>()
        .map_err(|_| "RESTART_HANDOFF_INVALID")?;
    if pid == 0
        || created == 0
        || fields[2].len() != 64
        || !fields[2].bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("RESTART_HANDOFF_INVALID".into());
    }
    Ok((pid, created, fields[2]))
}
fn event_name(pid: u32, nonce: &str) -> String {
    format!("Local\\DMeloper.BlockPet.Restart.{pid}.{nonce}")
}

pub(crate) fn wait_for_parent() -> Result<(), String> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let Some(index) = args.iter().position(|arg| arg == RESTART_ARGUMENT) else {
        return Ok(());
    };
    if args.len() != 2 || index != 0 {
        return Err("RESTART_HANDOFF_INVALID".into());
    }
    let value = args[1].to_str().ok_or("RESTART_HANDOFF_INVALID")?;
    let (pid, created, nonce) = handoff_fields(value)?;
    if pid == std::process::id() {
        return Err("RESTART_HANDOFF_INVALID".into());
    }
    let parent = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if parent.is_null() {
        return Err("RESTART_PARENT_UNAVAILABLE".into());
    }
    let parent = Handle(parent);
    // Holding this exact process handle prevents PID reuse between validation and wait.
    if crate::windows_process::creation_time(parent.0)? != created
        || crate::windows_process::user_sid(parent.0)? != crate::windows_process::current_sid()?
    {
        return Err("RESTART_PARENT_MISMATCH".into());
    }
    let expected =
        std::fs::canonicalize(std::env::current_exe().map_err(|_| "RESTART_IMAGE_UNAVAILABLE")?)
            .map_err(|_| "RESTART_IMAGE_UNAVAILABLE")?;
    let actual = std::fs::canonicalize(crate::windows_process::executable(parent.0)?)
        .map_err(|_| "RESTART_IMAGE_UNAVAILABLE")?;
    if expected != actual {
        return Err("RESTART_PARENT_MISMATCH".into());
    }
    let event = unsafe {
        OpenEventW(
            EVENT_MODIFY_STATE,
            0,
            wide(&event_name(pid, nonce)).as_ptr(),
        )
    };
    if event.is_null() {
        return Err("RESTART_HANDOFF_UNAVAILABLE".into());
    }
    let event = Handle(event);
    if unsafe { SetEvent(event.0) } == 0 {
        return Err("RESTART_HANDOFF_UNAVAILABLE".into());
    }
    if unsafe { WaitForSingleObject(parent.0, 30_000) } != WAIT_OBJECT_0 {
        return Err("RESTART_PARENT_TIMEOUT".into());
    }
    Ok(())
}

fn spawn_successor() -> Result<(), String> {
    let pid = std::process::id();
    let created = crate::windows_process::creation_time(unsafe { GetCurrentProcess() })?;
    let mut random = [0u8; 32];
    getrandom::fill(&mut random).map_err(|_| "RESTART_ENTROPY_UNAVAILABLE")?;
    let nonce: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let event = unsafe {
        CreateEventW(
            std::ptr::null(),
            0,
            0,
            wide(&event_name(pid, &nonce)).as_ptr(),
        )
    };
    if event.is_null() {
        return Err("RESTART_HANDOFF_UNAVAILABLE".into());
    }
    let event = Handle(event);
    let exe = std::env::current_exe().map_err(|_| "RESTART_IMAGE_UNAVAILABLE")?;
    let mut child = std::process::Command::new(exe)
        .arg(RESTART_ARGUMENT)
        .arg(format!("{pid}:{created}:{nonce}"))
        .spawn()
        .map_err(|_| "RESTART_SPAWN_FAILED")?;
    if unsafe { WaitForSingleObject(event.0, 5000) } != WAIT_OBJECT_0 {
        // Only the child just created by this operation is terminated; the parent remains alive.
        let _ = child.kill();
        let _ = child.wait();
        return Err("RESTART_CHILD_NOT_READY".into());
    }
    Ok(())
}

fn prepare_restart(
    development: bool,
    supervised: impl FnOnce() -> bool,
    spawn: impl FnOnce() -> Result<(), String>,
) -> Result<i32, String> {
    if development {
        if !supervised() {
            return Err("Development restart requires a supervised application session.".into());
        }
        Ok(DEVELOPMENT_RESTART_EXIT_CODE)
    } else {
        spawn()?;
        Ok(0)
    }
}

#[tauri::command]
pub async fn restart_application(
    app: tauri::AppHandle,
    window: tauri::Window,
    request_id: String,
) -> Result<(), String> {
    let lease = crate::native_operation::try_acquire("restart")?;
    crate::state_safety::verify_state_quiescence(app.clone(), window, request_id)?;
    let code = tauri::async_runtime::spawn_blocking(|| {
        prepare_restart(
            tauri::is_dev(),
            || std::env::var(DEVELOPMENT_RESTART_PROTOCOL).as_deref() == Ok("1"),
            spawn_successor,
        )
    })
    .await
    .map_err(|_| "RESTART_HANDOFF_FAILED")??;
    lease.commit_exit();
    app.exit(code);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restart_protocol_requires_pid_creation_time_and_exact_nonce() {
        let nonce = "a".repeat(64);
        assert!(handoff_fields(&format!("12:1234:{nonce}")).is_ok());
        for value in ["12", "12:0:abc", "0:123:a", "abc:123:abc"] {
            assert!(handoff_fields(value).is_err());
        }
        assert!(handoff_fields(&format!("12:1234:{nonce}:extra")).is_err());
    }
    #[test]
    fn current_process_identity_can_be_validated_without_launching() {
        let process = unsafe { GetCurrentProcess() };
        assert!(crate::windows_process::creation_time(process).unwrap() > 0);
        assert!(
            crate::windows_process::user_sid(process)
                .unwrap()
                .starts_with("S-1-")
        );
        assert_eq!(
            std::fs::canonicalize(crate::windows_process::executable(process).unwrap()).unwrap(),
            std::fs::canonicalize(std::env::current_exe().unwrap()).unwrap()
        );
    }
    #[test]
    fn failed_spawn_never_authorizes_parent_exit() {
        assert_eq!(
            prepare_restart(false, || false, || Err("RESTART_SPAWN_FAILED".into())).unwrap_err(),
            "RESTART_SPAWN_FAILED"
        );
    }
    #[test]
    fn packaged_restart_never_reads_the_development_supervisor() {
        let spawned = std::cell::Cell::new(false);
        assert_eq!(
            prepare_restart(
                false,
                || panic!("packaged restart must not read development configuration"),
                || { spawned.set(true); Ok(()) },
            ).unwrap(),
            0
        );
        assert!(spawned.get());
    }
    #[test]
    fn supervised_development_exits_75_without_spawning() {
        assert_eq!(
            prepare_restart(true, || true, || panic!("development must use its supervisor")).unwrap(),
            75
        );
        assert!(
            prepare_restart(true, || false, || panic!("must not spawn unsupervised dev")).is_err()
        );
    }
}

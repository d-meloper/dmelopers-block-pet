//! Run only the standalone test-built worker's no-operation CLI path. No app,
//! installer, user data, registration or recovery transaction is started.
use std::{fs, os::windows::process::CommandExt, process::Command};

#[test]
fn unrecognized_or_missing_command_exits_without_creating_app_state() {
    let root = tempfile::tempdir().unwrap();
    let sentinel = root.path().join("existing-record.json");
    fs::write(&sentinel, b"retained state").unwrap();
    for arguments in [Vec::<&str>::new(), vec!["--not-an-update-command"]] {
        let output = Command::new(env!("CARGO_BIN_EXE_block-pet-update-worker"))
            .args(arguments)
            .current_dir(root.path())
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        assert!(output.stderr.is_empty());
        assert_eq!(fs::read(&sentinel).unwrap(), b"retained state");
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }
}

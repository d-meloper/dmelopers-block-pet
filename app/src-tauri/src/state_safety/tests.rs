use super::*;
use serde_json::json;

#[test]
fn a_save_barrier_requires_both_windows_and_rejects_later_changes() {
    let original: Stores = [(
        "cat".into(),
        json!({"presetCollection":{"activeId":"mine"}}),
    )]
    .into();
    let mut lease = Quiescence::default();
    assert_eq!(lease.verify(&original).unwrap_err(), "QUIESCE_REQUIRED");
    assert_eq!(
        lease.acknowledge("untrusted", &original).unwrap_err(),
        "INVALID_PARTICIPANT"
    );
    lease.acknowledge("main", &original).unwrap();
    assert_eq!(
        lease.acknowledge("main", &original).unwrap_err(),
        "DUPLICATE_PARTICIPANT"
    );
    assert_eq!(lease.verify(&original).unwrap_err(), "QUIESCE_REQUIRED");
    lease.acknowledge("preference", &original).unwrap();
    lease.verify(&original).unwrap();
    let changed: Stores = [(
        "cat".into(),
        json!({"presetCollection":{"activeId":"different"}}),
    )]
    .into();
    assert_eq!(lease.verify(&changed).unwrap_err(), "QUIESCE_STATE_CHANGED");
}

#[test]
fn a_live_save_lease_blocks_library_writes_but_keeps_import_reads_available() {
    // Other tests use no global state. No actual application/user directory exists.
    let normal = guard_write().unwrap();
    drop(normal);
    *QUIESCENCE.lock().unwrap() = Some(Quiescence {
        request_id: "owned".into(),
        ..Default::default()
    });
    QUIESCENCE_ACTIVE.store(true, Ordering::SeqCst);
    assert!(writes_locked());
    assert_eq!(guard_write().unwrap_err(), "OPERATION_LOCKED");
    drop(guard_read().unwrap());
    *QUIESCENCE.lock().unwrap() = None;
    QUIESCENCE_ACTIVE.store(false, Ordering::SeqCst);
    drop(guard_write().unwrap());
    assert!(!writes_locked());
}

#[test]
fn unicode_and_space_paths_are_allowed_but_junction_ancestors_are_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let normal = temp.path().join("설정 with spaces");
    fs::create_dir(&normal).unwrap();
    let bytes = b"owned preset bytes";
    fs::write(normal.join("preset.json"), bytes).unwrap();
    check_path(&normal.join("preset.json")).unwrap();
    check_path(&normal.join("new/entry.json")).unwrap();
    let junction = temp.path().join("junction");
    let output = std::process::Command::new("cmd")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(&junction)
        .arg(&normal)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "a directory junction fixture must be created without elevation"
    );
    assert_eq!(
        check_path(&junction.join("preset.json")).unwrap_err(),
        "UNSAFE_STORAGE_PATH"
    );
    assert_eq!(
        check_path(&junction.join("missing/entry.json")).unwrap_err(),
        "UNSAFE_STORAGE_PATH"
    );
    fs::remove_dir(&junction).unwrap();
    assert_eq!(fs::read(normal.join("preset.json")).unwrap(), bytes);
}

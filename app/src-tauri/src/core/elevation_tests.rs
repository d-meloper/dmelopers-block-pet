//! No test launches an application, shows UAC or changes account/service state.
use super::*;
use std::cell::{Cell, RefCell};

#[test]
fn remembered_launch_preference_accepts_only_an_explicit_boolean_and_keeps_legacy_defaults() {
    for value in [
        "{}",
        r#"{"app":{}}"#,
        r#"{"app":{"alwaysRunAsAdministrator":false}}"#,
    ] {
        assert!(!decode_preference(value.as_bytes()).unwrap());
    }
    assert!(
        decode_preference(br#"{"app":{"alwaysRunAsAdministrator":true,"future":{"keep":1}}}"#)
            .unwrap()
    );
    for value in [
        "null",
        "[]",
        r#"{"app":null}"#,
        r#"{"app":{"alwaysRunAsAdministrator":"true"}}"#,
        "{",
    ] {
        assert!(decode_preference(value.as_bytes()).is_err());
    }
    assert!(
        decode_preference_field(
            br#"{"app":{"administratorReminderDismissed":true}}"#,
            "administratorReminderDismissed"
        )
        .unwrap()
    );
    assert!(!decode_preference(br#"{"app":{"administratorReminderDismissed":true}}"#).unwrap());
}

#[test]
fn startup_reader_uses_the_exact_pinia_profile_and_never_rewrites_settings() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join("설정 😶");
    fs::create_dir(&directory).unwrap();
    let packaged = br#"{"app":{"alwaysRunAsAdministrator":true},"unrelated":[1,2,3]}"#;
    let development = br#"{"app":{"alwaysRunAsAdministrator":false}}"#;
    fs::write(directory.join("general.json"), packaged).unwrap();
    fs::write(directory.join("general.dev.json"), development).unwrap();
    assert!(read_preference_file(&directory, false, "alwaysRunAsAdministrator").unwrap());
    assert!(!read_preference_file(&directory, true, "alwaysRunAsAdministrator").unwrap());
    assert_eq!(fs::read(directory.join("general.json")).unwrap(), packaged);
    assert_eq!(
        fs::read(directory.join("general.dev.json")).unwrap(),
        development
    );
    fs::remove_file(directory.join("general.dev.json")).unwrap();
    assert!(!read_preference_file(&directory, true, "alwaysRunAsAdministrator").unwrap());
    fs::write(directory.join("general.dev.json"), b"{").unwrap();
    assert!(read_preference_file(&directory, true, "alwaysRunAsAdministrator").is_err());
    assert_eq!(fs::read(directory.join("general.dev.json")).unwrap(), b"{");
    fs::write(
        directory.join("general.dev.json"),
        vec![b' '; 4 * 1024 * 1024 + 1],
    )
    .unwrap();
    assert!(read_preference_file(&directory, true, "alwaysRunAsAdministrator").is_err());
}

#[test]
fn automatic_launch_skips_unsupported_already_elevated_and_unselected_sessions() {
    for (supported, elevated) in [(false, false), (false, true), (true, true)] {
        assert_eq!(
            startup_attempt_with::<u8>(
                supported,
                elevated,
                || panic!("must not read a choice for an ineligible session"),
                || panic!("must not launch"),
                |_| panic!("must not commit")
            )
            .unwrap(),
            StartupAttempt::NotAttempted
        );
    }
    assert_eq!(
        startup_attempt_with::<u8>(
            true,
            false,
            || Ok(false),
            || panic!("default off must not launch"),
            |_| panic!("must not commit")
        )
        .unwrap(),
        StartupAttempt::NotAttempted
    );
}

#[test]
fn automatic_launch_cancellation_and_failures_never_commit_or_change_the_saved_choice() {
    let preferred = Cell::new(true);
    let result = startup_attempt_with::<u8>(
        true,
        false,
        || Ok(preferred.get()),
        || Ok(None),
        |_| panic!("cancelled child cannot commit"),
    );
    assert_eq!(result.unwrap(), StartupAttempt::Cancelled);
    assert!(preferred.get());
    assert!(
        startup_attempt_with::<u8>(
            true,
            false,
            || Err("unreadable".into()),
            || panic!("unreadable choice cannot launch"),
            |_| panic!("must not commit")
        )
        .is_err()
    );
    assert!(
        startup_attempt_with::<u8>(
            true,
            false,
            || Ok(true),
            || Err("spawn failed".into()),
            |_| panic!("failed launch cannot commit")
        )
        .is_err()
    );
    assert!(preferred.get());
}

#[test]
fn automatic_launch_commits_only_after_preparation_and_propagates_final_refusal() {
    let stages = RefCell::new(Vec::new());
    let result = startup_attempt_with(
        true,
        false,
        || {
            stages.borrow_mut().push("read");
            Ok(true)
        },
        || {
            stages.borrow_mut().push("prepare");
            Ok(Some(7))
        },
        |child| {
            assert_eq!(child, 7);
            stages.borrow_mut().push("commit");
            Err("changed choice".into())
        },
    );
    assert_eq!(result.unwrap_err(), "changed choice");
    assert_eq!(*stages.borrow(), ["read", "prepare", "commit"]);
}

fn parent_identity() -> Identity {
    Identity {
        pid: 120,
        created: 1_000,
        sid: "S-1-5-21-111-222-333-1001".into(),
        session: 1,
        elevated: false,
        image: PathBuf::from(r"C:\펫 😶\Block Pet.exe"),
    }
}

fn child_identity() -> Identity {
    Identity {
        pid: 121,
        created: 2_000,
        elevated: true,
        ..parent_identity()
    }
}

#[test]
fn elevation_requires_packaged_channels_or_an_independent_development_frontend() {
    use crate::distribution::Channel::*;
    for channel in [Github, Store, Test, Development] {
        assert!(!supported(true, channel, false));
    }
    for marker in [false, true] {
        assert!(supported(false, Github, marker));
        assert!(supported(false, Test, marker));
        assert!(!supported(false, Store, marker));
        assert!(!supported(false, Development, marker));
    }
    assert!(supported(true, Github, true));
    assert!(supported(true, Test, true));
    assert!(supported(true, Development, true));
    assert!(!supported(true, Store, true));
}

#[test]
fn elevation_arguments_require_exact_pid_creation_time_and_crypto_nonce() {
    let nonce = "a9".repeat(32);
    assert_eq!(
        handoff_fields(&format!("120:1000:{nonce}")).unwrap(),
        (120, 1_000, nonce.as_str())
    );
    for invalid in [
        "".into(),
        "120:1000".into(),
        format!("0:1000:{nonce}"),
        format!("120:0:{nonce}"),
        format!("-1:1000:{nonce}"),
        format!("120:1000:{nonce}:extra"),
        format!("120:1000:{}", "z".repeat(64)),
        format!("120:1000:{}", "a".repeat(63)),
    ] {
        assert!(
            handoff_fields(&invalid).is_err(),
            "accepted malformed handoff"
        );
    }
}

#[test]
fn elevation_rejects_different_admin_profile_session_image_or_process_lifetime() {
    let parent = parent_identity();
    let child = child_identity();
    assert!(same_account_successor(&parent, &child));
    let mismatches = [
        Identity {
            sid: "S-1-5-21-111-222-333-1002".into(),
            ..child.clone()
        },
        Identity {
            session: 2,
            ..child.clone()
        },
        Identity {
            image: PathBuf::from(r"C:\other\Block Pet.exe"),
            ..child.clone()
        },
        Identity {
            elevated: false,
            ..child.clone()
        },
        Identity {
            pid: parent.pid,
            ..child.clone()
        },
        Identity {
            created: parent.created,
            ..child.clone()
        },
        Identity {
            created: parent.created - 1,
            ..child.clone()
        },
    ];
    for mismatch in mismatches {
        assert!(!same_account_successor(&parent, &mismatch));
    }
    assert!(!same_account_successor(
        &Identity {
            elevated: true,
            ..parent
        },
        &child
    ));
}

#[test]
fn prepared_child_requires_commit_and_parent_exit_and_cancellation_wins() {
    for exited in [false, true] {
        for committed in [false, true] {
            for cancelled in [false, true] {
                assert_eq!(
                    child_may_start(exited, committed, cancelled),
                    (exited, committed, cancelled) == (true, true, false)
                );
            }
        }
    }
}

#[test]
fn roots_digest_preserves_unicode_and_path_boundaries_without_writing() {
    let roots = DataRoots {
        durable: PathBuf::from(r"C:\BlockPetFixtures\펫 😶\Saved Games\Block Pet"),
        local: PathBuf::from(r"C:\BlockPetFixtures\펫 😶\AppData\Local\Block Pet"),
    };
    let digest = roots_digest(&roots);
    assert!(valid_ticket(&digest));
    assert_eq!(digest, roots_digest(&roots.clone()));
    assert_ne!(
        digest,
        roots_digest(&DataRoots {
            durable: roots.local.clone(),
            local: roots.durable.clone()
        })
    );
    assert_ne!(
        digest,
        roots_digest(&DataRoots {
            durable: PathBuf::from(r"C:\BlockPetFixtures\펫\Saved Games\Block Pet"),
            ..roots
        })
    );
    let split_a = DataRoots {
        durable: PathBuf::from("ab"),
        local: PathBuf::from("c"),
    };
    let split_b = DataRoots {
        durable: PathBuf::from("a"),
        local: PathBuf::from("bc"),
    };
    assert_ne!(roots_digest(&split_a), roots_digest(&split_b));
}

#[test]
fn uac_cancel_and_failed_launch_never_produce_a_prepared_child() {
    assert_eq!(
        launch_result::<u8>(false, ERROR_CANCELLED, None).unwrap(),
        None
    );
    assert_eq!(
        launch_result::<u8>(false, 5, None).unwrap_err(),
        "ELEVATION_SPAWN_FAILED"
    );
    assert_eq!(
        launch_result::<u8>(true, 0, None).unwrap_err(),
        "ELEVATION_CHILD_UNAVAILABLE"
    );
    assert_eq!(launch_result(true, 0, Some(7)).unwrap(), Some(7));
}

#[test]
fn expired_or_dead_child_cannot_reach_barrier_or_commit() {
    assert_eq!(
        commit_sequence(
            || false,
            || panic!("barrier must not run"),
            || panic!("commit must not run")
        )
        .unwrap_err(),
        "ELEVATION_TICKET_EXPIRED"
    );
}

#[test]
fn released_or_failed_save_barrier_never_signals_commit() {
    let signalled = Cell::new(false);
    let result = commit_sequence(
        || true,
        || Err("STATE_SAFETY_NOT_QUIESCED".into()),
        || {
            signalled.set(true);
            Ok(())
        },
    );
    assert_eq!(result.unwrap_err(), "STATE_SAFETY_NOT_QUIESCED");
    assert!(!signalled.get());
}

#[test]
fn commit_signal_failure_does_not_authorize_parent_exit() {
    let stages = RefCell::new(Vec::new());
    let result = commit_sequence(
        || true,
        || {
            stages.borrow_mut().push("verify");
            Ok(())
        },
        || {
            stages.borrow_mut().push("signal");
            Err("ELEVATION_COMMIT_FAILED".into())
        },
    );
    assert_eq!(result.unwrap_err(), "ELEVATION_COMMIT_FAILED");
    assert_eq!(*stages.borrow(), ["verify", "signal"]);
}

#[test]
fn save_barrier_is_revalidated_immediately_before_commit() {
    let stages = RefCell::new(Vec::new());
    commit_sequence(
        || true,
        || {
            stages.borrow_mut().push("verify");
            Ok(())
        },
        || {
            stages.borrow_mut().push("signal");
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(*stages.borrow(), ["verify", "signal"]);
}

#[test]
fn child_exit_or_expiry_during_save_verification_cannot_signal_commit() {
    let ready = Cell::new(true);
    let result = commit_sequence(
        || ready.get(),
        || {
            ready.set(false);
            Ok(())
        },
        || panic!("a child lost during verification must not commit"),
    );
    assert_eq!(result.unwrap_err(), "ELEVATION_TICKET_EXPIRED");
}

#[test]
fn read_only_current_token_identity_is_consistent() {
    let current = identity(unsafe { GetCurrentProcess() }).unwrap();
    assert_eq!(current.pid, std::process::id());
    assert!(current.created > 0);
    assert!(current.sid.starts_with("S-1-"));
    assert_eq!(
        token_fields(unsafe { GetCurrentProcess() }).unwrap(),
        (current.elevated, current.session)
    );
    assert_eq!(
        current.image,
        std::fs::canonicalize(std::env::current_exe().unwrap()).unwrap()
    );
}

fn fixture_pipe() -> (Handle, String) {
    let mut random = [0u8; 32];
    getrandom::fill(&mut random).unwrap();
    let nonce: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let name = pipe_name(std::process::id(), &nonce);
    let security = UserSecurity::new(&crate::windows_process::current_sid().unwrap()).unwrap();
    let attributes = security.attributes();
    let raw = unsafe {
        CreateNamedPipeW(
            wide(&name).as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            512,
            512,
            HANDSHAKE_MS,
            &attributes,
        )
    };
    assert_ne!(raw, INVALID_HANDLE_VALUE);
    (Handle(raw), name)
}

/// The fixture is an ordinary worker thread of this test process. It never
/// creates a child process or application and retains its pipe until readback.
fn fixture_exchange(payload: Vec<u8>, capacity: usize) -> (Result<u32, String>, Vec<u8>) {
    let (server, name) = fixture_pipe();
    let (opened_tx, opened_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let raw = unsafe {
            CreateFileW(
                wide(&name).as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                std::ptr::null_mut(),
            )
        };
        assert_ne!(raw, INVALID_HANDLE_VALUE);
        let client = Handle(raw);
        let mut server_pid = 0;
        assert_ne!(
            unsafe { GetNamedPipeServerProcessId(client.0, &mut server_pid) },
            0
        );
        assert_eq!(server_pid, std::process::id());
        opened_tx.send(()).unwrap();
        let written = pipe_io(
            client.0,
            unsafe { GetCurrentProcess() },
            false,
            |overlapped| unsafe {
                WriteFile(
                    client.0,
                    payload.as_ptr(),
                    payload.len() as u32,
                    std::ptr::null_mut(),
                    overlapped,
                )
            },
        )
        .unwrap();
        assert_eq!(written as usize, payload.len());
        release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        // Keep the client open even when it finished writing before server connect.
        drop(client);
    });
    opened_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    pipe_io(
        server.0,
        unsafe { GetCurrentProcess() },
        true,
        |overlapped| unsafe { ConnectNamedPipe(server.0, overlapped) },
    )
    .unwrap();
    let mut client_pid = 0;
    assert_ne!(
        unsafe { GetNamedPipeClientProcessId(server.0, &mut client_pid) },
        0
    );
    assert_eq!(client_pid, std::process::id());
    let mut received = vec![0u8; capacity];
    let read = pipe_io(
        server.0,
        unsafe { GetCurrentProcess() },
        false,
        |overlapped| unsafe {
            ReadFile(
                server.0,
                received.as_mut_ptr(),
                received.len() as u32,
                std::ptr::null_mut(),
                overlapped,
            )
        },
    );
    release_tx.send(()).unwrap();
    worker.join().unwrap();
    (read, received)
}

#[test]
fn named_pipe_roundtrip_authenticates_kernel_peer_and_ready_bytes() {
    let roots = DataRoots {
        durable: PathBuf::from(r"C:\fixture\펫 😶\durable"),
        local: PathBuf::from(r"C:\fixture\펫 😶\local"),
    };
    let expected = ready_message(&"a9".repeat(32), &roots);
    let (read, received) = fixture_exchange(expected.clone(), expected.len());
    assert_eq!(read.unwrap() as usize, expected.len());
    assert_eq!(received, expected);
}

#[test]
fn named_pipe_ready_readback_rejects_short_and_oversized_messages() {
    let expected = b"READY:fixture".to_vec();
    let mut short = expected.clone();
    short.pop();
    let (read, _) = fixture_exchange(short, expected.len());
    assert_ne!(read.unwrap() as usize, expected.len());
    let mut oversized = expected.clone();
    oversized.push(b'!');
    let (read, _) = fixture_exchange(oversized, expected.len());
    assert_eq!(read.unwrap_err(), "ELEVATION_CHILD_NOT_READY");
}

#[test]
fn pending_pipe_connection_is_cancelled_and_drained_when_peer_exits() {
    let (server, _) = fixture_pipe();
    // A signalled wait handle models peer exit without terminating a process.
    let raw = unsafe { CreateEventW(std::ptr::null(), 1, 1, std::ptr::null()) };
    assert!(!raw.is_null());
    let peer_exited = Handle(raw);
    let started = Instant::now();
    let result = pipe_io(server.0, peer_exited.0, true, |overlapped| unsafe {
        ConnectNamedPipe(server.0, overlapped)
    });
    assert_eq!(result.unwrap_err(), "ELEVATION_CHILD_NOT_READY");
    assert!(started.elapsed() < Duration::from_secs(3));
}

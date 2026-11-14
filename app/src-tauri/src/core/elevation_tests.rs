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
fn input_worker_accepts_another_administrator_but_rejects_wrong_session_image_or_lifetime() {
    let parent = parent_identity();
    let child = child_identity();
    let parent_metadata = ProcessIdentity::from(&parent);
    assert!(worker_identity_allowed(&parent_metadata, &child));
    let other_administrator = Identity {
        sid: "S-1-5-21-111-222-333-1002".into(),
        ..child.clone()
    };
    assert!(worker_identity_allowed(
        &parent_metadata,
        &other_administrator
    ));
    for mismatch in [
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
    ] {
        assert!(!worker_identity_allowed(&parent_metadata, &mismatch));
    }
}

#[test]
fn prepared_input_worker_requires_live_parent_and_commit_and_cancellation_wins() {
    for parent_alive in [false, true] {
        for committed in [false, true] {
            for cancelled in [false, true] {
                assert_eq!(
                    child_may_start(parent_alive, committed, cancelled),
                    parent_alive && committed && !cancelled
                );
            }
        }
    }
}

#[test]
fn worker_entry_is_exact_and_retired_handoffs_never_open_a_profile() {
    let nonce = "a9".repeat(32);
    let value = format!("120:1000:{nonce}");
    let args = |values: &[&str]| {
        values
            .iter()
            .map(|value| std::ffi::OsString::from(*value))
            .collect::<Vec<_>>()
    };
    assert_eq!(invocation(&[]), Invocation::Ordinary);
    assert_eq!(
        invocation(&args(&[ARGUMENT, &value])),
        Invocation::Worker(value.clone())
    );
    for values in [
        vec![RETIRED_ARGUMENT, value.as_str()],
        vec!["ordinary", RETIRED_ARGUMENT],
        vec![ARGUMENT],
        vec![ARGUMENT, "invalid"],
        vec!["ordinary", ARGUMENT, value.as_str()],
        vec![ARGUMENT, value.as_str(), "extra"],
    ] {
        assert_eq!(invocation(&args(&values)), Invocation::Rejected);
    }
}

#[test]
fn worker_rendezvous_acl_only_names_originating_user_and_administrators() {
    let sid = "S-1-5-21-111-222-333-1002";
    assert_eq!(
        security_descriptor(sid),
        format!("D:P(A;;GA;;;{sid})(A;;GA;;;BA)")
    );
    for broad in [";;;WD)", ";;;AU)", ";;;BU)"] {
        assert!(!security_descriptor(sid).contains(broad));
    }
}

#[test]
fn ready_and_active_acknowledgements_bind_protocol_nonce_and_phase() {
    let nonce = "a9".repeat(32);
    let ready = ready_message(&nonce);
    let encoded = serde_json::to_vec(&ready).unwrap();
    assert_eq!(
        serde_json::from_slice::<Handshake>(&encoded).unwrap(),
        ready
    );
    assert_ne!(active_message(&nonce), ready);
    assert_ne!(ready_message(&"b1".repeat(32)), ready);
    assert!(
        serde_json::from_str::<Handshake>(
            r#"{"phase":"ready","protocol":1,"nonce":"n","path":"C:\\other"}"#
        )
        .is_err()
    );
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
fn commit_signal_failure_does_not_authorize_worker_activation() {
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
    let expected = serde_json::to_vec(&ready_message(&"a9".repeat(32))).unwrap();
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

/// In-process peers exercise the same native IPC without UAC, storage, or app
/// startup. Each owns a real process wait handle and the shared cancel event.
pub(crate) fn transport_pair() -> (Transport, Transport) {
    let (server, name) = fixture_pipe();
    let cancel = Handle(unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) });
    assert!(!cancel.0.is_null());
    let client_cancel = clone_handle(cancel.0).unwrap();
    let client_peer = clone_handle(unsafe { GetCurrentProcess() }).unwrap();
    let server_peer = clone_handle(unsafe { GetCurrentProcess() }).unwrap();
    assert_eq!(
        unsafe { WaitForSingleObject(server_peer.0, 0) },
        WAIT_TIMEOUT
    );
    let (sender, receiver) = std::sync::mpsc::channel();
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
        sender
            .send(Transport::new(Handle(raw), client_peer, client_cancel).unwrap())
            .unwrap();
    });
    pipe_io(server.0, server_peer.0, true, |overlapped| unsafe {
        ConnectNamedPipe(server.0, overlapped)
    })
    .unwrap();
    let transport = Transport::new(server, server_peer, cancel).unwrap();
    let client = receiver.recv_timeout(Duration::from_secs(3)).unwrap();
    worker.join().unwrap();
    (transport, client)
}

#[test]
fn administrator_transport_is_duplex_and_preserves_frame_boundaries() {
    let (server, client) = transport_pair();
    client.send(&ready_message("first")).unwrap();
    client.send(&ready_message("second")).unwrap();
    assert_eq!(
        server.receive::<Handshake>().unwrap(),
        ready_message("first")
    );
    assert_eq!(
        server.receive::<Handshake>().unwrap(),
        ready_message("second")
    );
    server.send(&active_message("reply")).unwrap();
    assert_eq!(
        client.receive::<Handshake>().unwrap(),
        active_message("reply")
    );
    assert!(server.alive());
    client.cancel();
    assert!(!server.alive());
}

#[test]
fn administrator_transport_cancel_interrupts_and_drains_a_pending_read() {
    let (server, client) = transport_pair();
    let (done, received) = std::sync::mpsc::channel();
    let waiting = server.clone();
    let worker =
        std::thread::spawn(move || done.send(waiting.receive_for::<Handshake>(5_000)).unwrap());
    client.cancel();
    assert!(
        received
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .is_err()
    );
    worker.join().unwrap();
    assert!(!server.alive());
    assert!(server.send(&ready_message("late")).is_err());
}

#[test]
fn administrator_transport_rejects_unexpected_rpc_and_cancels_both_peers() {
    let (server, client) = transport_pair();
    client
        .send(&serde_json::json!({"program": "cmd.exe", "arguments": ["arbitrary"]}))
        .unwrap();
    assert!(server.receive::<Handshake>().is_err());
    assert!(!client.alive());
}

#[test]
fn input_disable_requires_saved_false_and_preserves_readback_and_shutdown_failures() {
    let called = Cell::new(false);
    assert_eq!(
        disable_after_saved_choice(
            || Ok(true),
            || {
                called.set(true);
                Ok(())
            }
        ),
        Err("ELEVATION_PREFERENCE_CHANGED".into())
    );
    assert!(!called.get());
    assert_eq!(
        disable_after_saved_choice(
            || Err("ELEVATION_PREFERENCE_UNAVAILABLE".into()),
            || {
                called.set(true);
                Ok(())
            }
        ),
        Err("ELEVATION_PREFERENCE_UNAVAILABLE".into())
    );
    assert!(!called.get());
    assert_eq!(
        disable_after_saved_choice(
            || Ok(false),
            || {
                called.set(true);
                Err("ELEVATION_CHILD_NOT_READY".into())
            }
        ),
        Err("ELEVATION_CHILD_NOT_READY".into())
    );
    assert!(called.get());
    let order = RefCell::new(Vec::new());
    disable_after_saved_choice(
        || {
            order.borrow_mut().push("readback");
            Ok(false)
        },
        || {
            order.borrow_mut().push("disable");
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(*order.borrow(), ["readback", "disable"]);
}

#[test]
fn cancelling_a_transport_does_not_prove_the_peer_process_exited() {
    let (server, client) = transport_pair();
    assert_eq!(
        server.wait_for_peer_exit(0),
        Err("ELEVATION_CHILD_NOT_READY".into())
    );
    client.cancel();
    assert!(!server.alive());
    // Both fixture endpoints belong to this still-live test process. The real
    // process wait must not mistake the cancellation event for process exit.
    assert_eq!(
        server.wait_for_peer_exit(0),
        Err("ELEVATION_CHILD_NOT_READY".into())
    );
}

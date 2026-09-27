use super::*;
use crate::core::device::SemanticInputEvent;
use base64::{Engine as _, engine::general_purpose};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{Message, client::IntoClientRequest},
};

fn scene() -> BroadcastScene {
    serde_json::from_str(r##"{
        "schemaVersion":1, "modelId":"dmeloper", "skinModel":"wide", "mirror":false,
        "opacity":100, "eyebrowAnimationEnabled":true,
        "performance":{"maxFPS":60,"shadowsEnabled":true,"shadowQuality":"medium","renderScalePercent":100,"idlePowerSavingEnabled":false,"antialiasEnabled":true},
        "preset":{
            "windowScalePercent":100,"showDisplayArea":false,"autoViewportEnabled":true,"autoViewportPaddingPixels":16,
            "viewportModeRevision":0,"manualViewportRect":{"x":0,"y":0,"width":500,"height":422},
            "sceneRotationOffsetDegrees":0,"cameraHorizontalOffset":0,"cameraVerticalOffset":0,"cameraZoomPercent":100,
            "petRotationDegrees":0,"petDeskOffset":0,"mouseEnabled":true,"mouseBaseXOffset":0,"mouseBaseZOffset":0,
            "mouseScalePercent":100,"keyboardBaseXOffset":0,"keyboardBaseZOffset":0,"keyboardScalePercent":100,
            "keyboardLegendLanguage":"en","dmeloperPalmColor":"#ffffff",
            "petRightArmBendPercent":100,"petRightArmSpreadDegrees":0,"petLeftArmBendPercent":100,"petLeftArmSpreadDegrees":0,
            "keyboardColor":"#ffffff","keyboardKeycapColor":"#ffffff","keyboardLegendColor":"#ffffff","keyboardPressedColor":"#ffffff","mouseColor":"#ffffff","mousePressedColor":"#ffffff",
            "dmeloperEyebrows":{"enabled":true,"color":"#4a2818","centerOffsetPixels":0,"heightOffsetPixels":0,"spacingPixels":1.5,"widthPixels":2,"thicknessPixels":0.5}
        }
    }"##).unwrap()
}

#[test]
fn high_shadow_quality_round_trips_and_unknown_quality_is_rejected() {
    for quality in ["high", "medium", "low", "ultra"] {
        let mut value = serde_json::to_value(scene()).unwrap();
        value["performance"]["shadowQuality"] = json!(quality);
        let restored: BroadcastScene = serde_json::from_value(value).unwrap();
        assert_eq!(restored.validate(None).is_ok(), quality != "ultra");
        assert_eq!(serde_json::to_value(restored).unwrap()["performance"]["shadowQuality"], quality);
    }
}

#[test]
fn pixel_filter_is_additive_and_round_trips_with_msaa() {
    let mut value = serde_json::to_value(scene()).unwrap();
    assert_eq!(value["performance"]["pixelFilterEnabled"], false);
    value["performance"].as_object_mut().unwrap().remove("pixelFilterEnabled");
    let legacy: BroadcastScene = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(legacy).unwrap()["performance"]["pixelFilterEnabled"], false);
    for antialias in [false, true] {
        for filter in [false, true] {
            value["performance"]["antialiasEnabled"] = json!(antialias);
            value["performance"]["pixelFilterEnabled"] = json!(filter);
            let restored: BroadcastScene = serde_json::from_value(value.clone()).unwrap();
            restored.validate(None).unwrap();
            let serialized = serde_json::to_value(restored).unwrap();
            assert_eq!(serialized["performance"]["antialiasEnabled"], antialias);
            assert_eq!(serialized["performance"]["pixelFilterEnabled"], filter);
        }
    }
}

fn make_service() -> (
    tempfile::TempDir,
    Arc<Service>,
    Arc<Mutex<Vec<Option<bool>>>>,
) {
    let root = tempfile::tempdir().unwrap();
    let identity_root = root.path().to_owned();
    let demands = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&demands);
    let service = Service::new(
        Arc::new(move |expected| identity::load_known(&identity_root, expected)),
        Arc::new(|_| {}),
        Arc::new(move |demand| {
            observed.lock().unwrap().push(demand);
            Ok(())
        }),
    );
    (root, service, demands)
}

type Socket = WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(service: &Service) -> Socket {
    let identity = service.identity.get().unwrap();
    let mut request = format!("ws://{}/{}/ws", identity.host(), identity.token)
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Origin", identity.origin().parse().unwrap());
    tokio_tungstenite::connect_async(request).await.unwrap().0
}

async fn next_type(socket: &mut Socket, expected: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            match socket.next().await.unwrap().unwrap() {
                Message::Text(text) => {
                    let value: Value = serde_json::from_str(&text).unwrap();
                    if value["type"] == expected {
                        return value;
                    }
                }
                Message::Ping(data) => socket.send(Message::Pong(data)).await.unwrap(),
                _ => {}
            }
        }
    })
    .await
    .unwrap()
}

async fn acknowledge(socket: &mut Socket, revision: u64) {
    socket
        .send(Message::Text(
            json!({"type":"ready","revision":revision})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
}

async fn wait_status(service: &Service, clients: usize, error: Option<&str>) {
    tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            // Client counts change before the asynchronous input callback finishes.
            // Observe only a completed configure/ready/remove transaction.
            let status = {
                let _control = service.control.lock().await;
                service.status()
            };
            if status.clients == clients && status.error.as_deref() == error {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("unexpected status: {:?}", service.status()));
}

#[tokio::test]
async fn browser_diagnostics_do_not_change_readiness_scene_or_input_demand() {
    let (_root, service, demands) = make_service();
    service.configure(true, Some(scene())).await.unwrap();
    let mut socket = connect(&service).await;
    let initial = next_type(&mut socket, "scene").await;
    let original_demands = demands.lock().unwrap().clone();
    socket.send(Message::Text(json!({"type":"diagnostic", "code":"context_lost"}).to_string().into())).await.unwrap();
    // A ping after the diagnostic provides a transport-order barrier without
    // acknowledging a rendered scene or touching native input ownership.
    socket.send(Message::Ping(vec![17].into())).await.unwrap();
    tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            match socket.next().await.unwrap().unwrap() {
                Message::Pong(payload) if payload.as_ref() == [17] => break,
                Message::Ping(payload) => socket.send(Message::Pong(payload)).await.unwrap(),
                _ => {}
            }
        }
    }).await.unwrap();
    assert_eq!(service.status().clients, 0);
    assert_eq!(service.status().error, None);
    assert_eq!(*demands.lock().unwrap(), original_demands);
    assert_eq!(service.scenes.borrow().as_ref().unwrap().revision, initial["revision"].as_u64().unwrap());
    acknowledge(&mut socket, initial["revision"].as_u64().unwrap()).await;
    wait_status(&service, 1, None).await;
    socket.close(None).await.unwrap();
    service.configure(false, None).await.unwrap();
}

#[test]
fn projection_rejects_extra_private_fields_and_invalid_values_or_skin() {
    let valid = scene();
    assert_eq!(valid.preset.as_object().unwrap().len(), 32);
    valid.validate(None).unwrap();
    let mut private = valid.clone();
    private.preset["username"] = json!("must never leave the app");
    assert!(private.validate(None).is_err());
    let mut invalid = serde_json::to_value(&valid).unwrap();
    invalid["skinPngBase64"] = json!(general_purpose::STANDARD.encode(b"not a PNG"));
    assert!(
        serde_json::from_value::<BroadcastScene>(invalid)
            .unwrap()
            .validate(None)
            .is_err()
    );
    let mut with_skin = serde_json::to_value(&valid).unwrap();
    with_skin["skinPngBase64"] = json!(
        general_purpose::STANDARD
            .encode(include_bytes!("../../assets/models/dmeloper/default.png"))
    );
    serde_json::from_value::<BroadcastScene>(with_skin)
        .unwrap()
        .validate(None)
        .unwrap();
    let mut extreme = valid.clone();
    extreme.preset["cameraZoomPercent"] = json!(-1);
    assert!(extreme.validate(None).is_err());
    assert!(require_preference("main").is_err());
    assert!(require_preference("broadcast").is_err());
    require_preference("preference").unwrap();
}

#[tokio::test]
async fn client_close_receives_reply_and_releases_input() {
    let (_root, service, demands) = make_service();
    service.configure(true, Some(scene())).await.unwrap();
    let mut socket = connect(&service).await;
    let initial = next_type(&mut socket, "scene").await;
    acknowledge(&mut socket, initial["revision"].as_u64().unwrap()).await;
    wait_status(&service, 1, None).await;

    socket.close(None).await.unwrap();
    tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            match socket.next().await {
                Some(Ok(Message::Close(_))) => break,
                Some(Ok(_)) => continue,
                result => panic!("missing close reply: {result:?}"),
            }
        }
    })
    .await
    .unwrap();
    wait_status(&service, 0, None).await;
    assert_eq!(demands.lock().unwrap().last(), Some(&None));
    service.configure(false, None).await.unwrap();
}

#[tokio::test]
async fn disabled_default_port_conflict_and_stable_reactivation() {
    let (_root, service, demands) = make_service();
    let original = service.status();
    assert!(!original.enabled && original.clients == 0);
    let identity = service.identity.get().unwrap();
    let occupied =
        std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, identity.port)).unwrap();
    let status = service.configure(true, Some(scene())).await.unwrap();
    assert_eq!(status.error.as_deref(), Some("port_in_use"));
    assert_eq!(status.url, original.url);
    assert_eq!(status.clients, 0);
    drop(occupied);
    assert!(service.configure(true, None).await.unwrap().error.is_none());
    let off = service.configure(false, None).await.unwrap();
    assert!(!off.enabled);
    assert_eq!(off.url, original.url);
    assert_eq!(demands.lock().unwrap().last(), Some(&None));
    assert!(service.configure(true, None).await.unwrap().error.is_none());
    service.configure(false, None).await.unwrap();
}

#[tokio::test]
async fn real_http_allows_only_authenticated_fixed_assets_and_its_own_origin() {
    let (_root, service, _) = make_service();
    service.configure(true, Some(scene())).await.unwrap();
    let identity = service.identity.get().unwrap();
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    for (path, content_type) in [
        ("", "text/html"),
        ("broadcast.js", "text/javascript"),
        ("model.glb", "model/gltf-binary"),
        ("default.png", "image/png"),
    ] {
        let response = client
            .get(format!("{}{path}", identity.url()))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert!(
            response.headers()["content-type"]
                .to_str()
                .unwrap()
                .starts_with(content_type)
        );
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(response.headers()["referrer-policy"], "no-referrer");
        let csp = response.headers()["content-security-policy"]
            .to_str()
            .unwrap();
        assert!(csp.contains("connect-src 'self' data: ws://127.0.0.1:"));
        assert!(!csp.contains("ipc:") && !csp.contains("unsafe-eval"));
        assert!(!response.bytes().await.unwrap().is_empty());
    }
    for url in [
        format!("{}/", identity.origin()),
        format!("{}../../Cargo.toml", identity.url()),
        format!("{}%2e%2e/Cargo.toml", identity.url()),
        format!("{}index.html", identity.url()),
        format!("{}default.png?path=../", identity.url()),
    ] {
        assert_eq!(client.get(url).send().await.unwrap().status(), 404);
    }
    assert_eq!(
        client
            .get(identity.url())
            .header("Host", "example.test")
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert_eq!(
        client
            .get(identity.url())
            .header("Origin", "https://example.test")
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert_eq!(
        client
            .get(identity.url())
            .header("Sec-Fetch-Site", "cross-site")
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert_eq!(
        client.post(identity.url()).send().await.unwrap().status(),
        404
    );
    let mut request = format!("ws://{}/{}/ws", identity.host(), identity.token)
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Origin", "https://example.test".parse().unwrap());
    assert!(tokio_tungstenite::connect_async(request).await.is_err());
    service.configure(false, None).await.unwrap();
}

#[tokio::test]
async fn multiple_sources_reconnect_and_atomic_scene_updates_keep_input_leases() {
    let (_root, service, demands) = make_service();
    service.configure(true, Some(scene())).await.unwrap();
    let mut first = connect(&service).await;
    let initial = next_type(&mut first, "scene").await;
    let revision = initial["revision"].as_u64().unwrap();
    assert_eq!(service.status().clients, 0);
    acknowledge(&mut first, revision).await;
    wait_status(&service, 1, None).await;
    let mut second = connect(&service).await;
    next_type(&mut second, "scene").await;
    acknowledge(&mut second, revision).await;
    wait_status(&service, 2, None).await;
    service.publish_input(SemanticInputEvent::MousePrimary { active: true });
    for socket in [&mut first, &mut second] {
        assert_eq!(
            next_type(socket, "input").await["event"],
            json!({"kind":"mouse_primary", "active":true})
        );
    }
    let mut changed = scene();
    changed.preset["cameraZoomPercent"] = json!(120);
    service
        .configure(true, Some(changed.clone()))
        .await
        .unwrap();
    let latest = next_type(&mut first, "scene").await["revision"]
        .as_u64()
        .unwrap();
    assert!(latest > revision);
    assert_eq!(service.status().clients, 2);
    first
        .send(Message::Text(
            json!({"type":"render_error","revision":latest})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    wait_status(&service, 2, Some("render_failed")).await;
    acknowledge(&mut first, revision).await;
    assert_eq!(service.status().clients, 2);
    service
        .configure(true, Some(changed.clone()))
        .await
        .unwrap();
    let retried = next_type(&mut first, "scene").await["revision"]
        .as_u64()
        .unwrap();
    assert!(retried > latest);
    acknowledge(&mut first, retried).await;
    wait_status(&service, 2, None).await;
    let mut invalid = changed.clone();
    invalid.preset["mouseEnabled"] = json!("invalid");
    assert!(service.configure(true, Some(invalid)).await.is_err());
    assert_eq!(service.scenes.borrow().as_ref().unwrap().revision, retried);
    changed.preset["mouseEnabled"] = json!(false);
    service.configure(true, Some(changed)).await.unwrap();
    assert_eq!(demands.lock().unwrap().last(), Some(&Some(false)));
    first.close(None).await.unwrap();
    wait_status(&service, 1, None).await;
    second.close(None).await.unwrap();
    wait_status(&service, 0, None).await;
    assert_eq!(demands.lock().unwrap().last(), Some(&None));
    let mut replacement = connect(&service).await;
    let restored = next_type(&mut replacement, "scene").await;
    assert_eq!(restored["scene"]["preset"]["mouseEnabled"], false);
    acknowledge(&mut replacement, restored["revision"].as_u64().unwrap()).await;
    wait_status(&service, 1, None).await;
    service.configure(false, None).await.unwrap();
    assert_eq!(service.status().clients, 0);
    assert_eq!(demands.lock().unwrap().last(), Some(&None));
}

#[tokio::test]
async fn initial_stale_ready_and_unrecognized_client_commands_never_capture_input() {
    let (_root, service, demands) = make_service();
    service.configure(true, Some(scene())).await.unwrap();
    let mut socket = connect(&service).await;
    let initial = next_type(&mut socket, "scene").await;
    let revision = initial["revision"].as_u64().unwrap();
    let mut changed = scene();
    changed.preset["cameraZoomPercent"] = json!(90);
    service.configure(true, Some(changed)).await.unwrap();
    next_type(&mut socket, "scene").await;
    acknowledge(&mut socket, revision).await;
    socket
        .send(Message::Text(
            json!({"type":"invoke","command":"read_file"})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(4), async {
        while let Some(message) = socket.next().await {
            if matches!(message, Ok(Message::Close(_)) | Err(_)) {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(service.status().clients, 0);
    assert!(demands.lock().unwrap().iter().all(Option::is_none));
    service.configure(false, None).await.unwrap();
}

/// Native, isolated HTTP/CSP fixture for the browser QA harness. No AppHandle,
/// user settings or global input hooks are created. The URL file must be new.
#[tokio::test]
#[ignore = "requires PET_BROADCAST_TEST_URL_FILE and an external browser QA client"]
async fn browser_fixture() {
    use std::io::Write;
    let path = std::path::PathBuf::from(
        std::env::var_os("PET_BROADCAST_TEST_URL_FILE").expect("set a new URL output path"),
    );
    let stop_path = std::path::PathBuf::from(format!("{}.stop", path.to_string_lossy()));
    let (_root, service, _) = make_service();
    let mut value = serde_json::to_value(scene()).unwrap();
    value["skinPngBase64"] = json!(
        general_purpose::STANDARD
            .encode(include_bytes!("../../assets/models/dmeloper/default.png"))
    );
    let status = service
        .configure(true, Some(serde_json::from_value(value).unwrap()))
        .await
        .unwrap();
    assert!(status.error.is_none());
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .unwrap();
    output.write_all(status.url.unwrap().as_bytes()).unwrap();
    output.sync_all().unwrap();
    drop(output);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    while tokio::time::Instant::now() < deadline && !stop_path.exists() {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    service.configure(false, None).await.unwrap();
}

#[test]
fn head_size_accepts_legacy_scenes_and_enforces_limits() {
    let mut candidate = scene();
    assert!(candidate.validate(None).is_ok());
    for value in [25, 100, 200] {
        candidate.preset["petHeadScalePercent"] = json!(value);
        assert!(candidate.validate(None).is_ok());
    }
    for value in [24, 201] {
        candidate.preset["petHeadScalePercent"] = json!(value);
        assert!(candidate.validate(None).is_err());
    }
}

#[test]
fn eyebrow_depth_is_additive_and_validated_for_obs() {
    let mut value = serde_json::to_value(scene()).unwrap();
    value["preset"]["dmeloperEyebrows"].as_object_mut().unwrap().remove("depthPercent");
    let legacy: BroadcastScene = serde_json::from_value(value.clone()).unwrap();
    legacy.validate(None).unwrap();
    assert_eq!(serde_json::to_value(legacy).unwrap()["preset"]["dmeloperEyebrows"]["depthPercent"], 100);
    for depth in [0, 100, 200] {
        value["preset"]["dmeloperEyebrows"]["depthPercent"] = json!(depth);
        let parsed: BroadcastScene = serde_json::from_value(value.clone()).unwrap();
        parsed.validate(None).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap()["preset"]["dmeloperEyebrows"]["depthPercent"], depth);
    }
    for invalid in [json!(-1), json!(201), json!(null), json!("0"), json!(false)] {
        value["preset"]["dmeloperEyebrows"]["depthPercent"] = invalid;
        let parsed: BroadcastScene = serde_json::from_value(value.clone()).unwrap();
        assert!(parsed.validate(None).is_err());
    }
    value["preset"]["dmeloperEyebrows"]["depthPercent"] = json!(0);
    value["preset"]["dmeloperEyebrows"]["unknownDepth"] = json!(0);
    assert!(serde_json::from_value::<BroadcastScene>(value).unwrap().validate(None).is_err());
}


#[tokio::test]
async fn retry_reloads_failed_endpoint_storage_without_replacing_a_live_address() {
    let root = tempfile::tempdir().unwrap();
    let storage = root.path().join("initially-unavailable");
    std::fs::write(&storage, b"not a directory").unwrap();
    let owned = storage.clone();
    let service = Service::new(Arc::new(move |expected| identity::load_known(&owned, expected)),
        Arc::new(|_| {}), Arc::new(|_| Ok(())));
    assert_eq!(service.status().error.as_deref(), Some("endpoint_unavailable"));
    assert!(service.status().url.is_none());
    std::fs::remove_file(&storage).unwrap();
    let ready = service.configure(true, Some(scene())).await.unwrap();
    assert!(ready.error.is_none());
    let url = ready.url.unwrap();
    assert_eq!(reqwest::get(&url).await.unwrap().status(), 200);
    service.configure(false, None).await.unwrap();
    assert_eq!(service.configure(true, Some(scene())).await.unwrap().url.as_deref(), Some(url.as_str()));
    service.configure(false, None).await.unwrap();
}

#[tokio::test]
async fn backup_warning_does_not_hide_a_working_connection_and_retry_clears_it() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = tempfile::tempdir().unwrap();
    let original = identity::load_or_create(root.path()).unwrap();
    let held = std::fs::OpenOptions::new().read(true).share_mode(0)
        .open(root.path().join("broadcast-endpoint.backup.json")).unwrap();
    let owned = root.path().to_owned();
    let service = Service::new(Arc::new(move |expected| identity::load_known(&owned, expected)),
        Arc::new(|_| {}), Arc::new(|_| Ok(())));
    let status = service.configure(true, Some(scene())).await.unwrap();
    assert_eq!(status.warning.as_deref(), Some("endpoint_backup_unavailable"));
    assert!(status.error.is_none());
    assert_eq!(status.url, Some(original.url()));
    drop(held);
    let status = service.configure(true, Some(scene())).await.unwrap();
    assert!(status.warning.is_none());
    assert!(status.error.is_none());
    assert_eq!(status.url, Some(original.url()));
    service.configure(false, None).await.unwrap();
}


#[tokio::test]
async fn live_retry_preserves_disk_identity_after_both_copies_disappear_and_reports_conflicts() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = tempfile::tempdir().unwrap();
    let original = identity::load_or_create(root.path()).unwrap();
    let primary = root.path().join("broadcast-endpoint.json");
    let backup = root.path().join("broadcast-endpoint.backup.json");
    let held = std::fs::OpenOptions::new().read(true).share_mode(0).open(&backup).unwrap();
    let owned = root.path().to_owned();
    let service = Service::new(Arc::new(move |expected| identity::load_known(&owned, expected)),
        Arc::new(|_| {}), Arc::new(|_| Ok(())));
    service.configure(true, Some(scene())).await.unwrap();
    drop(held);
    std::fs::remove_file(&primary).unwrap();
    std::fs::remove_file(&backup).unwrap();
    let status = service.configure(true, Some(scene())).await.unwrap();
    assert_eq!(status.url, Some(original.url()));
    assert!(status.error.is_none());
    assert_eq!(identity::load_or_create(root.path()).unwrap(), original);

    // A live connection keeps the known URL and exposes a conflict before any
    // repair writes. A subsequent valid repair is retryable without restarting.
    let held = std::fs::OpenOptions::new().read(true).share_mode(0).open(&backup).unwrap();
    service.inner.lock().unwrap().endpoint_warning = Some("endpoint_backup_unavailable".into());
    service.configure(true, Some(scene())).await.unwrap();
    drop(held);
    let mut other = serde_json::to_value(&original).unwrap();
    other["token"] = json!("f".repeat(64));
    let other_bytes = serde_json::to_vec(&other).unwrap();
    std::fs::write(&backup, &other_bytes).unwrap();
    let status = service.configure(true, Some(scene())).await.unwrap();
    assert_eq!(status.url, Some(original.url()));
    assert_eq!(status.error.as_deref(), Some("endpoint_conflict"));
    assert_eq!(std::fs::read(&backup).unwrap(), other_bytes);
    assert_eq!(serde_json::from_slice::<serde_json::Value>(&std::fs::read(&primary).unwrap()).unwrap(), serde_json::to_value(&original).unwrap());
    std::fs::write(&backup, serde_json::to_vec(&original).unwrap()).unwrap();
    let status = service.configure(true, Some(scene())).await.unwrap();
    assert!(status.error.is_none());
    assert!(status.warning.is_none());
    service.configure(false, None).await.unwrap();
}

#[test]
fn desk_broadcast_settings_accept_legacy_and_partial_scenes_but_reject_malformed_values() {
    let mut candidate = scene();
    candidate.validate(None).unwrap();
    candidate.preset["deskTransparent"] = json!(false);
    candidate.validate(None).unwrap();
    candidate.preset["deskColor"] = json!("#123aBC");
    for height in [-1.0, 0.0, 1.0] {
        candidate.preset["deskHeightOffset"] = json!(height);
        candidate.validate(None).unwrap();
        let restored: BroadcastScene = serde_json::from_value(serde_json::to_value(&candidate).unwrap()).unwrap();
        assert_eq!(restored, candidate);
    }
    for (key, values) in [
        ("deskTransparent", vec![json!(null), json!(1), json!("false")]),
        ("deskColor", vec![json!(null), json!(true), json!("red"), json!("#12345"), json!("#GGGGGG")]),
        ("deskHeightOffset", vec![json!(null), json!(false), json!("0"), json!(-1.01), json!(1.01)]),
        ("deskEnabled", vec![json!(true)]),
    ] {
        for value in values {
            let mut invalid = candidate.clone();
            invalid.preset[key] = value;
            assert!(invalid.validate(None).is_err(), "{key}");
        }
    }
}

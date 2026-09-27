mod application_context;

use tauri::test::{MockRuntime, mock_builder};
use tauri_plugin_updater::UpdaterExt;

#[test]
fn builder_pubkey_cannot_initialize_an_absent_plugin_config() {
    let context: tauri::Context<MockRuntime> = tauri::generate_context!();
    assert!(!context.config().plugins.0.contains_key("updater"));
    let app = mock_builder().build(context).unwrap();
    let result = app.handle().plugin(
        tauri_plugin_updater::Builder::new()
            .pubkey(application_context::updater_public_key())
            .build(),
    );
    match result {
        Err(tauri::Error::PluginInitialization(name, detail)) => {
            assert_eq!(name, "updater");
            assert!(detail.contains("Error deserializing 'plugins.updater'"));
        }
        other => panic!("expected the original startup configuration failure: {other:?}"),
    }
}

#[test]
fn application_context_initializes_the_real_updater_with_test_trust() {
    let context = application_context::generate::<MockRuntime>();
    let config: tauri_plugin_updater::Config =
        serde_json::from_value(context.config().plugins.0["updater"].clone()).unwrap();
    assert_eq!(config.pubkey, application_context::updater_public_key());
    assert!(config.endpoints.is_empty());
    assert!(!config.dangerous_insecure_transport_protocol);
    assert!(!config.dangerous_accept_invalid_certs);
    assert!(!config.dangerous_accept_invalid_hostnames);
    let app = mock_builder().build(context).unwrap();
    application_context::initialize_updater(app.handle()).unwrap();
    // Construct a client from the real registered SDK state. This fixture URL
    // is never requested; no windows, downloads or installers are run.
    app.updater_builder()
        .endpoints(vec!["https://example.invalid/update.json".parse().unwrap()])
        .unwrap()
        .build()
        .unwrap();
}

#[tokio::test]
async fn pinned_updater_bounds_wire_metadata_before_json_even_without_content_length() {
    use std::io::{Read, Write};
    for chunked in [false, true] {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request);
            let body = vec![b' '; 65537];
            let response = if chunked {
                format!(
                    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n",
                    body.len()
                )
            } else {
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
            };
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.write_all(&body);
            if chunked {
                let _ = stream.write_all(b"\r\n0\r\n\r\n");
            }
        });
        let mut context = application_context::generate::<MockRuntime>();
        // Loopback fixture only. Production context forbids insecure transport.
        context.config_mut().plugins.0.get_mut("updater").unwrap()["dangerousInsecureTransportProtocol"] =
            true.into();
        let app = mock_builder().build(context).unwrap();
        application_context::initialize_updater(app.handle()).unwrap();
        let updater = app
            .updater_builder()
            .endpoints(vec![
                format!("http://{address}/update.json").parse().unwrap(),
            ])
            .unwrap()
            .timeout(std::time::Duration::from_secs(5))
            .no_proxy()
            .build()
            .unwrap();
        let error = updater
            .check()
            .await
            .err()
            .expect("oversized metadata must fail");
        assert!(
            error.to_string().contains("64 KiB"),
            "must reject size before JSON: {error}"
        );
        server.join().unwrap();
    }
}

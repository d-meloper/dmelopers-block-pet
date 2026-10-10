// The integration target receives the existing Common-Controls manifest.
// Exercise the actual generated IPC handler without launching the application.
#![allow(dead_code)]

mod performance;
mod diagnostics {
    pub fn warn(_operation: &'static str, _code: &str) {}
    pub fn error(_operation: &'static str, _code: &str) {}
}

use std::{sync::mpsc, thread, time::Duration};
use tauri::{
    Manager,
    test::{get_ipc_response, mock_builder, mock_context, noop_assets},
};

fn assert_dispatch_is_not_blocked(command: &'static str) -> serde_json::Value {
    let (dispatched, dispatch) = mpsc::channel();
    let handler: Box<dyn Fn(tauri::ipc::Invoke<tauri::test::MockRuntime>) -> bool + Send + Sync> =
        Box::new(tauri::generate_handler![
            performance::sample_app_performance,
            performance::prime_app_performance_sampler
        ]);
    let app = mock_builder()
        .manage(performance::PerformanceMonitorState::new())
        .invoke_handler(move |invoke| {
            let handled = handler(invoke);
            let _ = dispatched.send(handled);
            handled
        })
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let state = app.state::<performance::PerformanceMonitorState>();
    let (response, returned_before_unlock) = state.while_monitor_locked(|| {
        let response = thread::spawn(move || {
            get_ipc_response(
                &webview,
                tauri::webview::InvokeRequest {
                    cmd: command.into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "http://tauri.localhost".parse().unwrap(),
                    body: tauri::ipc::InvokeBody::default(),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.to_owned(),
                },
            )
            .unwrap()
            .deserialize::<serde_json::Value>()
            .unwrap()
        });
        // Keep the native sampler unavailable until after testing dispatch.
        // Release before joining even for the unfixed synchronous handler.
        let returned = dispatch.recv_timeout(Duration::from_millis(500));
        (response, returned)
    });
    let response = response.join().expect("IPC response thread");
    assert_eq!(
        returned_before_unlock.ok(),
        Some(true),
        "{command} blocked the IPC callback on native sampling"
    );
    response
}

#[test]
fn sampling_dispatch_returns_before_a_delayed_native_sampler() {
    let response = assert_dispatch_is_not_blocked("sample_app_performance");
    for key in ["cpuPercent", "gpuPercent", "ramBytes", "available"] {
        assert!(
            response.get(key).is_some(),
            "missing preserved field: {key}"
        );
    }
}

#[test]
fn priming_dispatch_returns_before_a_delayed_native_sampler() {
    assert!(assert_dispatch_is_not_blocked("prime_app_performance_sampler").is_null());
}

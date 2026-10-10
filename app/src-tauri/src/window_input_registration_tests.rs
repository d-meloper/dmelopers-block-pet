use tauri::{
    Context, WebviewWindow, WebviewWindowBuilder,
    ipc::{CallbackFn, InvokeBody, Origin},
    test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder},
    webview::InvokeRequest,
};

fn request(window: &WebviewWindow<MockRuntime>, command: &str, body: serde_json::Value) -> serde_json::Value {
    get_ipc_response(window, InvokeRequest {
        cmd: format!("plugin:custom-window|{command}"),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: "http://tauri.localhost".parse().unwrap(),
        body: InvokeBody::Json(body),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.into(),
    }).expect_err("these boundary fixtures must fail before native UI work")
}

#[test]
fn generated_context_grants_input_commands_only_to_local_app_windows() {
    let mut context: Context<MockRuntime> = tauri::generate_context!();
    let authority = context.runtime_authority_mut();
    for command in ["set_pet_cursor_events", "popup_pet_menu"] {
        let command = format!("plugin:custom-window|{command}");
        for label in ["main", "preference"] {
            assert!(authority.resolve_access(&command, label, label, &Origin::Local).is_some());
            assert!(authority.resolve_access(&command, label, label, &Origin::Remote {
                url: "https://example.invalid".parse().unwrap(),
            }).is_none());
        }
        assert!(authority.resolve_access(&command, "untrusted", "untrusted", &Origin::Local).is_none());
    }
}

#[test]
fn registered_plugin_enforces_caller_and_resource_boundaries_before_native_work() {
    let context: Context<MockRuntime> = tauri::generate_context!();
    let app = mock_builder().plugin(tauri_plugin_custom_window::init()).build(context).unwrap();
    let preference = WebviewWindowBuilder::new(&app, "preference", Default::default()).build().unwrap();
    assert_eq!(request(&preference, "set_pet_cursor_events", serde_json::json!({ "ignore": true })),
        "Only the pet window can change its cursor events.");
    assert_eq!(request(&preference, "popup_pet_menu", serde_json::json!({ "rid": u32::MAX })),
        "Only the pet window can open its context menu.");
    let main = WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
    let error = request(&main, "popup_pet_menu", serde_json::json!({ "rid": u32::MAX }));
    assert_eq!(error.as_str().unwrap(), tauri::Error::BadResourceId(u32::MAX).to_string());
}

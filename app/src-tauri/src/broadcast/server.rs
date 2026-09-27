use super::{Service, identity::Identity};
use axum::{
    Router,
    body::Body,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::SinkExt;
use serde::Deserialize;
use std::{sync::Arc, time::Duration};
use tokio::time::{Instant, timeout};

const PAGE: &[u8] = include_bytes!("../../broadcast-dist/index.html");
const SCRIPT: &[u8] = include_bytes!("../../broadcast-dist/broadcast.js");
const MODEL: &[u8] = include_bytes!("../../assets/models/dmeloper/dmeloper.glb");
const DEFAULT_SKIN: &[u8] = include_bytes!("../../assets/models/dmeloper/default.png");
const HEARTBEAT: &str = "{\"type\":\"heartbeat\"}";
const RESET: &str = "{\"type\":\"reset\"}";

pub(super) fn router(service: Arc<Service>) -> Router {
    Router::new()
        .fallback(get(asset))
        .route(
            &format!("/{}/ws", service.identity.get().unwrap().token),
            get(upgrade),
        )
        .layer(middleware::from_fn_with_state(
            Arc::clone(&service),
            authenticate,
        ))
        .with_state(service)
}

fn authorized(identity: &Identity, method: &Method, uri: &Uri, headers: &HeaderMap) -> bool {
    if method != Method::GET || uri.query().is_some() {
        return false;
    }
    if headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        != Some(identity.host().as_str())
    {
        return false;
    }
    if headers
        .get(header::ORIGIN)
        .is_some_and(|origin| origin != identity.origin().as_str())
    {
        return false;
    }
    if headers
        .get("sec-fetch-site")
        .is_some_and(|site| site == "cross-site")
    {
        return false;
    }
    let prefix = format!("/{}/", identity.token);
    matches!(
        uri.path().strip_prefix(&prefix),
        Some("" | "broadcast.js" | "model.glb" | "default.png" | "ws")
    )
}

async fn authenticate(
    State(service): State<Arc<Service>>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let identity = service.identity.get().unwrap();
    if !authorized(identity, request.method(), request.uri(), request.headers()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    if !service
        .inner
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .enabled
    {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_str(&format!(
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' data: ws://{}; worker-src blob:; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", identity.host()
    )).unwrap());
    response
}

async fn asset(State(service): State<Arc<Service>>, uri: Uri) -> Response {
    let prefix = format!("/{}/", service.identity.get().unwrap().token);
    let (bytes, content_type) = match uri.path().strip_prefix(&prefix) {
        Some("") => (PAGE, "text/html; charset=utf-8"),
        Some("broadcast.js") => (SCRIPT, "text/javascript; charset=utf-8"),
        Some("model.glb") => (MODEL, "model/gltf-binary"),
        Some("default.png") => (DEFAULT_SKIN, "image/png"),
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    ([(header::CONTENT_TYPE, content_type)], Body::from(bytes)).into_response()
}

async fn upgrade(
    State(service): State<Arc<Service>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        != Some(service.identity.get().unwrap().origin().as_str())
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    ws.max_message_size(1024)
        .max_frame_size(1024)
        .write_buffer_size(0)
        .on_upgrade(move |socket| socket_session(service, socket))
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum ClientMessage {
    Ready { revision: u64 },
    RenderError { revision: u64 },
    Diagnostic { code: BrowserDiagnosticCode },
}

// Fixed codes carry no browser-controlled text and do not alter scene, source
// readiness or input demand. Global native diagnostics also rate-limit writes.
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum BrowserDiagnosticCode {
    RendererWarning,
    RendererError,
    ContextLost,
    ShaderCompileFailed,
    SkinReadFailed,
    SkinDecodeFailed,
    ModelLoadFailed,
    ViewportMeasurementFailed,
    RigContractMissing,
    ViewportFallback,
    ScriptError,
    UnhandledRejection,
    ServerMessageInvalid,
    HeartbeatTimeout,
}

impl BrowserDiagnosticCode {
    fn record(self) {
        let (is_error, code) = match self {
            Self::RendererWarning => (false, "renderer_warning"),
            Self::RendererError => (true, "renderer_error"),
            Self::ContextLost => (false, "context_lost"),
            Self::ShaderCompileFailed => (true, "shader_compile_failed"),
            Self::SkinReadFailed => (false, "skin_read_failed"),
            Self::SkinDecodeFailed => (false, "skin_decode_failed"),
            Self::ModelLoadFailed => (true, "model_load_failed"),
            Self::ViewportMeasurementFailed => (false, "viewport_measurement_failed"),
            Self::RigContractMissing => (false, "rig_contract_missing"),
            Self::ViewportFallback => (false, "viewport_fallback"),
            Self::ScriptError => (true, "script_error"),
            Self::UnhandledRejection => (true, "unhandled_rejection"),
            Self::ServerMessageInvalid => (false, "server_message_invalid"),
            Self::HeartbeatTimeout => (false, "heartbeat_timeout"),
        };
        if is_error {
            crate::diagnostics::error("broadcast.browser", code);
        } else {
            crate::diagnostics::warn("broadcast.browser", code);
        }
    }
}

async fn send(socket: &mut WebSocket, json: &str) -> bool {
    match timeout(
            Duration::from_secs(2),
            socket.send(Message::Text(json.to_owned().into()))
        )
        .await {
        Ok(Ok(())) => true,
        // A peer may close while a frame is pending; ordinary closes stay silent.
        Ok(Err(_)) => false,
        Err(_) => {
            crate::diagnostics::warn("broadcast.socket_send", "timeout");
            false
        }
    }
}

async fn socket_session(service: Arc<Service>, mut socket: WebSocket) {
    let Some((id, mut shutdown)) = service.register_client() else {
        let _ = timeout(Duration::from_millis(250), socket.close()).await;
        return;
    };
    let mut scenes = service.scenes.subscribe();
    let mut inputs = service.inputs.subscribe();
    let first = scenes.borrow_and_update().clone();
    let mut ready = false;
    let mut last_activity = Instant::now();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(2));
    let started = if let Some(packet) = first {
        send(&mut socket, &packet.json).await
    } else {
        false
    };
    if started {
        loop {
            if *shutdown.borrow() {
                break;
            }
            tokio::select! {
                biased;
                _ = shutdown.changed() => break,
                result = scenes.changed() => {
                    if result.is_err() { break; }
                    let packet = scenes.borrow_and_update().clone();
                    if let Some(packet) = packet { if !send(&mut socket, &packet.json).await { break; } }
                }
                received = socket.recv() => match received {
                    Some(Ok(Message::Text(text))) => {
                        last_activity = Instant::now();
                        match serde_json::from_str::<ClientMessage>(&text) {
                            Ok(ClientMessage::Ready { revision }) => {
                                tokio::select! {
                                    result = service.ready(id, revision) => { ready |= result; },
                                    _ = shutdown.changed() => break,
                                }
                            },
                            Ok(ClientMessage::RenderError { revision }) => {
                                tokio::select! {
                                    _ = service.render_error(id, revision) => {},
                                    _ = shutdown.changed() => break,
                                }
                            },
                            Err(_) => {
                                crate::diagnostics::warn("broadcast.client_message", "invalid_message");
                                break;
                            },
                            Ok(ClientMessage::Diagnostic { code }) => code.record(),
                        }
                    },
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => { last_activity = Instant::now(); },
                    _ => break,
                },
                event = inputs.recv() => {
                    if !ready { continue; }
                    match event {
                        Ok(json) => if !send(&mut socket, &json).await { break; },
                        // Dropped press/release events must not leave contacts held.
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            crate::diagnostics::warn("broadcast.input_queue", "lagged_reset");
                            if !send(&mut socket, RESET).await { break; }
                        },
                        Err(_) => break,
                    }
                }
                _ = heartbeat.tick() => {
                    if last_activity.elapsed() > Duration::from_secs(12) {
                        crate::diagnostics::warn("broadcast.socket_heartbeat", "timeout");
                        break;
                    }
                    if !send(&mut socket, HEARTBEAT).await { break; }
                    match timeout(Duration::from_secs(2), socket.send(Message::Ping(Vec::new().into()))).await {
                        Err(_) => {
                            crate::diagnostics::warn("broadcast.socket_ping", "timeout");
                            break;
                        }
                        Ok(Err(_)) => break,
                        Ok(Ok(())) => {}
                    }
                }
            }
        }
    }
    // Flush the automatic reply when the peer already sent Close; sending a new
    // Close message in that state fails before the queued reply reaches the peer.
    let _ = timeout(Duration::from_millis(250), socket.close()).await;
    service.remove_client(id).await;
}

#[cfg(test)]
mod diagnostic_tests {
    use super::ClientMessage;

    #[test]
    fn only_bounded_failure_codes_are_accepted() {
        for code in [
            "renderer_warning", "renderer_error", "context_lost", "shader_compile_failed",
            "skin_read_failed", "skin_decode_failed", "model_load_failed", "viewport_measurement_failed",
            "rig_contract_missing", "viewport_fallback", "script_error", "unhandled_rejection",
            "server_message_invalid", "heartbeat_timeout",
        ] {
            let message = serde_json::json!({"type":"diagnostic", "code":code});
            assert!(matches!(serde_json::from_value::<ClientMessage>(message), Ok(ClientMessage::Diagnostic { .. })));
        }
        for message in [
            serde_json::json!({"type":"diagnostic", "code":"ready"}),
            serde_json::json!({"type":"diagnostic", "code":"info"}),
            serde_json::json!({"type":"diagnostic", "code":"http://127.0.0.1/private-token"}),
            serde_json::json!({"type":"diagnostic", "code":"renderer_error", "message":"private payload"}),
            serde_json::json!({"type":"diagnostic", "code":{"error":"private payload"}}),
        ] {
            assert!(serde_json::from_value::<ClientMessage>(message).is_err());
        }
    }
}

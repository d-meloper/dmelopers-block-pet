// Dedicated integration executable retains the Common-Controls manifest and
// compiles the actual collector/semantic owner without starting the application.
#![allow(dead_code)]

#[path = "core/device.rs"]
mod device;
mod diagnostics {
    pub fn warn(_operation: &'static str, _code: &str) {}
    pub fn error(_operation: &'static str, _code: &str) {}
}
mod broadcast {
    pub struct BroadcastState;
    impl BroadcastState {
        pub fn publish_input(&self, _event: super::device::SemanticInputEvent) {}
    }
}

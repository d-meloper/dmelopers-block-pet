//! Shared authenticated update and recovery operations.
//! This crate has no application, WebView, input, broadcast or HTTP client dependency.
pub mod data_recovery;
mod execution;
pub mod feed;
pub mod geometry;
pub mod helper;
pub mod integrity;
pub mod journal;
pub mod process;
mod reentry;

#[derive(Clone, Debug, serde::Serialize)]
pub struct UpdateError {
    pub code: String,
}

pub fn fail(code: &str) -> UpdateError {
    UpdateError {
        code: code.to_owned(),
    }
}
impl From<std::io::Error> for UpdateError {
    fn from(_: std::io::Error) -> Self {
        fail("IO_ERROR")
    }
}

pub fn new_request_id() -> Result<String, UpdateError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| fail("IO_ERROR"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub fn require_same_feed(expected: &feed::Feed, fresh: &feed::Feed) -> Result<(), UpdateError> {
    if serde_json::to_vec(expected).ok() != serde_json::to_vec(fresh).ok() {
        return Err(fail("CHECK_REQUIRED"));
    }
    Ok(())
}

#[cfg(test)]
mod tests;

//! Compile the same authored data that the frontend bundles; no runtime file reads.
use serde::de::DeserializeOwned;
use serde_json::Value;

const DEFAULTS_JSON: &str = include_str!("../../src/config/defaultSettings.json");

pub(crate) fn section<T: DeserializeOwned>(name: &str) -> Result<T, serde_json::Error> {
    let mut defaults: Value = serde_json::from_str(DEFAULTS_JSON)?;
    serde_json::from_value(defaults[name].take())
}

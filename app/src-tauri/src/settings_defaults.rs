//! Compile the same authored data that the frontend bundles; no runtime file reads.
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::sync::OnceLock;

const DEFAULTS_JSON: &str = include_str!("../../src/config/defaultSettings.json");
const RANGES_JSON: &str = include_str!("../../src/config/presetRanges.json");

/// Authored bounds shared with the renderer and preference controls.
pub(crate) fn numeric_range<'a>(group: &str, key: &'a str) -> (&'a str, f64, f64) {
    static RANGES: OnceLock<Value> = OnceLock::new();
    let ranges =
        RANGES.get_or_init(|| serde_json::from_str(RANGES_JSON).expect("authored preset ranges"));
    let bounds = &ranges[group][key];
    (
        key,
        bounds["min"].as_f64().expect("range minimum"),
        bounds["max"].as_f64().expect("range maximum"),
    )
}

pub(crate) fn in_numeric_range(value: &Value, group: &str, key: &str) -> bool {
    let (_, min, max) = numeric_range(group, key);
    value
        .as_f64()
        .is_some_and(|number| number.is_finite() && number >= min && number <= max)
}

pub(crate) fn section<T: DeserializeOwned>(name: &str) -> Result<T, serde_json::Error> {
    let mut defaults: Value = serde_json::from_str(DEFAULTS_JSON)?;
    serde_json::from_value(defaults[name].take())
}

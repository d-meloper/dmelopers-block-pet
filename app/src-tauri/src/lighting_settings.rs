//! Lighting contract shared by portable presets and local OBS scene validation.
use serde_json::Value;
use std::sync::OnceLock;

fn defaults() -> &'static Value {
    static DEFAULTS: OnceLock<Value> = OnceLock::new();
    DEFAULTS.get_or_init(|| {
        let mut preset: Value = crate::settings_defaults::section("preset")
            .expect("authored preset defaults must be valid JSON");
        preset["lighting"].take()
    })
}

fn fill_missing(value: &mut Value, default: &Value) {
    if let (Some(actual), Some(expected)) = (value.as_object_mut(), default.as_object()) {
        for (key, fallback) in expected {
            if let Some(item) = actual.get_mut(key) {
                fill_missing(item, fallback);
            } else {
                actual.insert(key.clone(), fallback.clone());
            }
        }
    }
}

/// Retired controls are discarded; invalid supported values remain for rejection.
pub(crate) fn migrate_preset(preset: &mut Value) {
    if let Some(preset) = preset.as_object_mut() {
        if let Some(lighting) = preset.get_mut("lighting") {
            if let Some(object) = lighting.as_object_mut() {
                for key in ["brightnessPercent", "exposurePercent", "toneMapping", "referenceFrame",
                    "fill", "rim", "ambient", "hemisphere", "shadow"] {
                    object.remove(key);
                }
                if let Some(key) = object.get_mut("key").and_then(Value::as_object_mut) {
                    key.remove("enabled");
                    key.remove("intensityPercent");
                    if !key.contains_key("strengthPercent") {
                        if key.get("color").and_then(Value::as_str).is_some_and(|c| c.eq_ignore_ascii_case("#fff4e8")) {
                            key.insert("color".into(), defaults()["key"]["color"].clone());
                        }
                        for (name, previous) in [("azimuthDegrees", -38.99099404250548), ("elevationDegrees", 43.89945474962074)] {
                            if key.get(name).and_then(Value::as_f64) == Some(previous) {
                                key.insert(name.into(), defaults()["key"][name].clone());
                            }
                        }
                    }
                }
            }
            fill_missing(lighting, defaults());
        } else {
            preset.insert("lighting".into(), defaults().clone());
        }
    }
}

pub(crate) fn is_valid(value: &Value) -> bool {
    fn valid(value: &Value, default: &Value, key: &str) -> bool {
        if let Some(expected) = default.as_object() {
            return value.as_object().is_some_and(|actual| {
                actual.len() == expected.len()
                    && expected.iter().all(|(child, fallback)| {
                        actual.get(child).is_some_and(|item| valid(item, fallback, child))
                    })
            });
        }
        if default.is_number() {
            let (min, max) = match key {
                "azimuthDegrees" => (-180.0, 180.0),
                "elevationDegrees" => (-90.0, 90.0),
                "strengthPercent" => (25.0, 200.0),
                _ => return false,
            };
            return value.as_f64().is_some_and(|n| n.is_finite() && n >= min && n <= max);
        }
        value.as_str().is_some_and(|s| s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit()))
    }
    valid(value, defaults(), "")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lighting_migrates_missing_only_and_rejects_invalid_members() {
        let mut preset = json!({"lighting": {"toneMapping":"none","fill":{"enabled":true},
            "key": {"enabled":false,"intensityPercent":0,"color":"#123456","azimuthDegrees":0}}});
        migrate_preset(&mut preset);
        assert!(is_valid(&preset["lighting"]));
        assert_eq!(preset["lighting"]["key"]["color"], "#123456");
        assert_eq!(preset["lighting"]["key"]["azimuthDegrees"], 0);
        assert_eq!(preset["lighting"].as_object().unwrap().len(), 1);
        assert_eq!(preset["lighting"]["key"].as_object().unwrap().len(), 4);
        assert_eq!(preset["lighting"]["key"]["strengthPercent"], 100);
        let previous = preset.clone();
        migrate_preset(&mut preset);
        assert_eq!(preset, previous);
        for (path, invalid) in [
            ("/lighting", Value::Null),
            ("/lighting/key/color", json!("red")),
            ("/lighting/key", Value::Null),
            ("/lighting/key/azimuthDegrees", json!(181)),
            ("/lighting/key/elevationDegrees", json!(91)),
            ("/lighting/key/strengthPercent", json!(24)),
            ("/lighting/key/strengthPercent", json!(201)),
        ] {
            let mut bad = previous.clone();
            *bad.pointer_mut(path).unwrap() = invalid.clone();
            migrate_preset(&mut bad);
            assert_eq!(bad.pointer(path).unwrap(), &invalid);
            assert!(!is_valid(&bad["lighting"]), "{path}");
        }
        let mut unknown = defaults().clone();
        unknown["key"]["script"] = json!("ignored?");
        assert!(!is_valid(&unknown));
        let mut legacy = json!({});
        migrate_preset(&mut legacy);
        assert!(is_valid(&legacy["lighting"]));
    }

    #[test]
    fn upgrades_authored_defaults_once_and_preserves_relative_strength() {
        let mut legacy = json!({"lighting":{"key":{"color":"#FFF4E8",
            "azimuthDegrees":-38.99099404250548,"elevationDegrees":43.89945474962074}}});
        migrate_preset(&mut legacy);
        assert_eq!(legacy["lighting"], *defaults());
        assert_eq!(legacy["lighting"]["key"]["azimuthDegrees"], -39);
        assert_eq!(legacy["lighting"]["key"]["elevationDegrees"], 44);
        assert_eq!(legacy["lighting"]["key"]["color"], "#ffffff");
        for strength in [25, 75, 100, 125, 200] {
            let mut current = json!({"lighting":{"key":{"color":"#fff4e8",
                "azimuthDegrees":-38.99099404250548,"elevationDegrees":20,"strengthPercent":strength}}});
            let previous = current.clone();
            migrate_preset(&mut current);
            assert_eq!(current, previous);
            assert!(is_valid(&current["lighting"]));
        }
    }
}

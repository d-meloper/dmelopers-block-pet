use base64::{Engine as _, engine::general_purpose};
use image::GenericImageView;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const PNG_LIMIT: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BroadcastScene {
    schema_version: u8,
    model_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    skin_png_base64: Option<String>,
    skin_model: String,
    #[serde(deserialize_with = "deserialize_preset")]
    pub(super) preset: Value,
    mirror: bool,
    opacity: f64,
    eyebrow_animation_enabled: bool,
    performance: Performance,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Performance {
    #[serde(rename = "maxFPS")]
    max_fps: f64,
    shadows_enabled: bool,
    shadow_quality: String,
    render_scale_percent: f64,
    idle_power_saving_enabled: bool,
    antialias_enabled: bool,
    #[serde(default)]
    pixel_filter_enabled: bool,
}

impl BroadcastScene {
    pub(super) fn mouse_enabled(&self) -> bool {
        self.preset["mouseEnabled"] == true
    }

    pub(super) fn validate(&self, previous: Option<&Self>) -> Result<(), String> {
        if self.schema_version != 1
            || self.model_id != "dmeloper"
            || !matches!(self.skin_model.as_str(), "wide" | "slim")
            || !bounded(self.opacity, 0.0, 100.0)
            || !bounded(self.performance.max_fps, 1.0, 240.0)
            || !bounded(self.performance.render_scale_percent, 25.0, 200.0)
            || !matches!(self.performance.shadow_quality.as_str(), "low" | "medium" | "high")
        {
            return Err("scene_invalid".into());
        }
        validate_preset(&self.preset)?;
        if let Some(encoded) = &self.skin_png_base64 {
            // Reusing the validated immutable PNG must not decode it on every
            // slider change or arm-width toggle.
            if previous.and_then(|scene| scene.skin_png_base64.as_ref()) != Some(encoded) {
                validate_skin(encoded)?;
            }
        }
        Ok(())
    }
}

fn deserialize_preset<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Value, D::Error> {
    let mut preset = Value::deserialize(deserializer)?;
    if let Some(brows) = preset.get_mut("dmeloperEyebrows").and_then(Value::as_object_mut) {
        brows.entry("depthPercent").or_insert(Value::from(100));
    }
    crate::lighting_settings::migrate_preset(&mut preset);
    Ok(preset)
}

fn bounded(value: f64, min: f64, max: f64) -> bool {
    value.is_finite() && (min..=max).contains(&value)
}

fn color(value: &Value) -> bool {
    value.as_str().is_some_and(|value| {
        value.len() == 7
            && value.starts_with('#')
            && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn number(value: &Value, min: f64, max: f64) -> bool {
    value.as_f64().is_some_and(|value| bounded(value, min, max))
}

fn validate_preset(preset: &Value) -> Result<(), String> {
    let object = preset.as_object().ok_or("scene_invalid")?;
    let optional = ["petHeadScalePercent", "deskTransparent", "deskHeightOffset", "deskWidthOffset", "deskDepthOffset", "deskColor", "lighting"];
    if object.len() != 32 + optional.iter().filter(|key| object.contains_key(**key)).count() {
        return Err("scene_invalid".into());
    }
    for (key, value) in object {
        let valid = match key.as_str() {
            "lighting" => crate::lighting_settings::is_valid(value),
            "showDisplayArea" | "autoViewportEnabled" | "mouseEnabled" | "deskTransparent" => value.is_boolean(),
            "deskColor"
            | "keyboardColor"
            | "keyboardKeycapColor"
            | "keyboardLegendColor"
            | "keyboardPressedColor"
            | "mouseColor"
            | "mousePressedColor"
            | "dmeloperPalmColor" => color(value),
            "keyboardLegendLanguage" => matches!(value.as_str(), Some("ko" | "en")),
            "windowScalePercent"
            | "mouseScalePercent"
            | "keyboardScalePercent"
            | "cameraZoomPercent" => number(value, 1.0, 1000.0),
            "autoViewportPaddingPixels" => number(value, 0.0, 16.0),
            "viewportModeRevision" => number(value, 0.0, 9_007_199_254_740_991.0),
            "petHeadScalePercent" => number(value, 25.0, 200.0),
            "deskHeightOffset" | "deskWidthOffset" | "deskDepthOffset" => number(value, -1.0, 1.0),
            "petRightArmBendPercent" | "petLeftArmBendPercent" => number(value, 0.0, 400.0),
            "petRightArmSpreadDegrees" | "petLeftArmSpreadDegrees" => number(value, -45.0, 45.0),
            "sceneRotationOffsetDegrees" => number(value, -360.0, 360.0),
            "petRotationDegrees" => crate::settings_defaults::in_numeric_range(value, "preset", key),
            "cameraHorizontalOffset" | "cameraVerticalOffset" => number(value, -100_000.0, 100_000.0),
            "petDeskOffset"
            | "mouseBaseXOffset"
            | "mouseBaseZOffset"
            | "keyboardBaseXOffset"
            | "keyboardBaseZOffset" => crate::settings_defaults::in_numeric_range(value, "preset", key),
            "manualViewportRect" => value.as_object().is_some_and(|rect| {
                rect.len() == 4
                    && rect.iter().all(|(key, value)| match key.as_str() {
                        "x" | "y" => number(value, -100_000.0, 100_000.0),
                        "width" | "height" => number(value, 1.0, 100_000.0),
                        _ => false,
                    })
            }),
            "dmeloperEyebrows" => value.as_object().is_some_and(|eyebrows| {
                eyebrows.len() == 8
                    && eyebrows.iter().all(|(key, value)| match key.as_str() {
                        "enabled" => value.is_boolean(),
                        "color" => color(value),
                        "centerOffsetPixels" => number(value, -1.5, 1.5),
                        "heightOffsetPixels" => number(value, -3.0, 3.0),
                        "spacingPixels" => crate::settings_defaults::in_numeric_range(value, "eyebrows", key),
                        "widthPixels" => crate::settings_defaults::in_numeric_range(value, "eyebrows", key),
                        "thicknessPixels" => crate::settings_defaults::in_numeric_range(value, "eyebrows", key),
                        "depthPercent" => number(value, 0.0, 200.0),
                        _ => false,
                    })
            }),
            _ => false,
        };
        if !valid {
            return Err("scene_invalid".into());
        }
    }
    Ok(())
}

fn validate_skin(encoded: &str) -> Result<(), String> {
    if encoded.len() > PNG_LIMIT.div_ceil(3) * 4 {
        return Err("skin_too_large".into());
    }
    let bytes = general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "skin_invalid")?;
    if bytes.len() > PNG_LIMIT
        || bytes.len() < 24
        || &bytes[..8] != b"\x89PNG\r\n\x1a\n"
        || bytes[8..12] != 13_u32.to_be_bytes()
        || &bytes[12..16] != b"IHDR"
    {
        return Err("skin_invalid".into());
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if width != 64 || !matches!(height, 32 | 64) {
        return Err("skin_invalid".into());
    }
    let decoded = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .map_err(|_| "skin_invalid")?;
    if decoded.dimensions() != (width, height) {
        return Err("skin_invalid".into());
    }
    Ok(())
}

#[cfg(test)]
mod lighting_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn shared_ranges_validate_actual_fractional_obs_values() {
        let ranges: Value = serde_json::from_str(include_str!("../../../src/config/presetRanges.json")).unwrap();
        for group in ["preset", "eyebrows"] {
            for (key, bounds) in ranges[group].as_object().unwrap() {
                let min = bounds["min"].as_f64().unwrap();
                let max = bounds["max"].as_f64().unwrap();
                for number in [min, max, min + (max - min) * 0.37, min - 0.0001, max + 0.0001] {
                    let mut preset: Value = crate::settings_defaults::section("preset").unwrap();
                    let target = if group == "preset" { &mut preset } else { &mut preset["dmeloperEyebrows"] };
                    target[key] = json!(number);
                    assert_eq!(validate_preset(&preset).is_ok(), number >= min && number <= max, "{group}.{key}: {number}");
                    let round_trip: Value = serde_json::from_str(&serde_json::to_string(&preset).unwrap()).unwrap();
                    let restored_target = if group == "preset" { &round_trip }
                        else { &round_trip["dmeloperEyebrows"] };
                    // Preserve fractional settings across JSON, allowing only
                    // the parser's binary floating-point rounding error.
                    assert!((restored_target[key].as_f64().unwrap() - number).abs()
                        <= f64::EPSILON * number.abs().max(1.0));
                    assert_eq!(validate_preset(&round_trip).is_ok(), number >= min && number <= max);
                }
            }
        }
    }

    #[test]
    fn lighting_survives_obs_round_trip_and_rejects_explicit_invalid_values() {
        let preset: Value = crate::settings_defaults::section("preset").unwrap();
        let mut value = json!({
            "schemaVersion": 1, "modelId": "dmeloper", "skinModel": "wide",
            "mirror": false, "opacity": 100, "eyebrowAnimationEnabled": true,
            "performance": {"maxFPS":60,"shadowsEnabled":false,"shadowQuality":"high",
                "renderScalePercent":100,"idlePowerSavingEnabled":true,"antialiasEnabled":true},
            "preset": preset
        });
        value["preset"].as_object_mut().unwrap().remove("lighting");
        let legacy: BroadcastScene = serde_json::from_value(value.clone()).unwrap();
        legacy.validate(None).unwrap();
        assert!(crate::lighting_settings::is_valid(&legacy.preset["lighting"]));
        value["preset"]["lighting"] = json!({"toneMapping":"none","fill":{"enabled":true},
            "key":{"color":"#123456","azimuthDegrees":45,"elevationDegrees":20,"strengthPercent":200}});
        let restored: BroadcastScene = serde_json::from_value(value.clone()).unwrap();
        restored.validate(None).unwrap();
        let round_trip: BroadcastScene = serde_json::from_value(serde_json::to_value(&restored).unwrap()).unwrap();
        assert_eq!(restored, round_trip);
        assert_eq!(round_trip.preset["lighting"]["key"]["color"], "#123456");
        assert_eq!(round_trip.preset["lighting"]["key"]["strengthPercent"], 200);
        assert_eq!(round_trip.preset["lighting"].as_object().unwrap().len(), 1);
        assert!(!round_trip.performance.shadows_enabled);
        for strength in [25, 75, 100, 125, 200] {
            value["preset"]["lighting"]["key"]["strengthPercent"] = json!(strength);
            let restored: BroadcastScene = serde_json::from_value(value.clone()).unwrap();
            restored.validate(None).unwrap();
            let round_trip: BroadcastScene = serde_json::from_value(serde_json::to_value(&restored).unwrap()).unwrap();
            assert_eq!(round_trip.preset["lighting"]["key"]["strengthPercent"], strength);
        }
        for invalid in [Value::Null, json!({"key":{"azimuthDegrees":181}}),
            json!({"key":{"elevationDegrees":91}}), json!({"key":{"color":"red"}}),
            json!({"key":{"strengthPercent":24}}), json!({"key":{"strengthPercent":201}}),
            json!({"key":{"unknown":true}}), json!({"privatePath":"hidden"})] {
            value["preset"]["lighting"] = invalid;
            let rejected: BroadcastScene = serde_json::from_value(value.clone()).unwrap();
            assert!(rejected.validate(None).is_err());
        }
    }
}

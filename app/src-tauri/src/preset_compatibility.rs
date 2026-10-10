//! Inert preset sources and executable projections use the same authored contract as Vue.
use serde_json::{Map, Value};
use std::collections::BTreeSet;
use std::sync::OnceLock;

pub(crate) fn contract() -> &'static Value {
    static CONTRACT: OnceLock<Value> = OnceLock::new();
    CONTRACT.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/config/presetCompatibility.json"))
            .expect("preset support contract")
    })
}

pub(crate) fn valid_source(value: &Value) -> bool {
    fn bounded(value: &Value, depth: usize) -> bool {
        depth <= 64
            && match value {
                Value::Array(items) => items.iter().all(|v| bounded(v, depth + 1)),
                Value::Object(items) => items.values().all(|v| bounded(v, depth + 1)),
                _ => true,
            }
    }
    value.is_object()
        && bounded(value, 0)
        && serde_json::to_vec(value).is_ok_and(|bytes| bytes.len() <= 4 * 1024 * 1024)
}

pub(crate) fn migrate(source: &Value) -> Value {
    migrate_with(source, contract())
}

fn migrate_with(source: &Value, support: &Value) -> Value {
    let supported = |id: &str| {
        support["migrations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == id)
    };
    let mut result = source.clone();
    if let Some(preset) = result.get_mut("preset").and_then(Value::as_object_mut) {
        if let Some(brows) = preset
            .get_mut("dmeloperEyebrows")
            .and_then(Value::as_object_mut)
        {
            if supported("eyebrow-depth-v1") {
                brows.entry("depthPercent").or_insert(Value::from(100));
            }
        }
        let defaults: Map<String, Value> =
            crate::settings_defaults::section("preset").expect("preset defaults");
        for key in [
            "deskTransparent",
            "deskHeightOffset",
            "deskWidthOffset",
            "deskDepthOffset",
            "deskColor",
        ] {
            if supported("legacy-desk-v1") {
                preset.entry(key).or_insert_with(|| {
                    if key == "deskWidthOffset" {
                        Value::from(-1)
                    } else {
                        defaults[key].clone()
                    }
                });
            }
        }
    }
    if let Some(preset) = result.get_mut("preset").filter(|p| p.is_object()) {
        if supported("lighting-v1") {
            crate::lighting_settings::migrate_preset(preset);
        }
    }
    result
}

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct Issue {
    pub path: Vec<String>,
    pub reason: &'static str,
}

pub(crate) fn inspect_with(source: &Value, support: &Value) -> Vec<Issue> {
    fn walk(value: Option<&Value>, path: Vec<String>, fields: &[Value], issues: &mut Vec<Issue>) {
        if let Some(field) = fields.iter().find(|field| {
            field["path"].as_array().is_some_and(|p| {
                p.len() == path.len() && p.iter().zip(&path).all(|(a, b)| a.as_str() == Some(b))
            })
        }) {
            let reason = match value {
                None => Some("missing"),
                Some(value) => match field["type"].as_str().unwrap() {
                    "number" => match value.as_f64().filter(|n| n.is_finite()) {
                        None => Some("type"),
                        Some(n) => {
                            let (min, max) = if let Some(reference) = field["rangeRef"].as_array() {
                                let (_, min, max) = crate::settings_defaults::numeric_range(
                                    reference[0].as_str().unwrap(),
                                    reference[1].as_str().unwrap(),
                                );
                                (min, max)
                            } else {
                                (
                                    field["min"].as_f64().unwrap(),
                                    field["max"].as_f64().unwrap(),
                                )
                            };
                            if n < min || n > max {
                                Some("range")
                            } else if field["integer"] == true && n.fract() != 0.0 {
                                Some("integer")
                            } else {
                                None
                            }
                        }
                    },
                    "boolean" => (!value.is_boolean()).then_some("type"),
                    "enum" => {
                        if !value.is_string() {
                            Some("type")
                        } else {
                            (!field["values"].as_array().unwrap().contains(value))
                                .then_some("choice")
                        }
                    }
                    "color" => match value.as_str() {
                        None => Some("type"),
                        Some(s) => (!(s.len() == 7
                            && s.starts_with('#')
                            && s[1..].bytes().all(|b| b.is_ascii_hexdigit())))
                        .then_some("color"),
                    },
                    _ => Some("structure"),
                },
            };
            if let Some(reason) = reason {
                issues.push(Issue { path, reason });
            }
            return;
        }
        let Some(object) = value.and_then(Value::as_object) else {
            issues.push(Issue {
                path,
                reason: if value.is_none() {
                    "missing"
                } else {
                    "structure"
                },
            });
            return;
        };
        let children: BTreeSet<String> = fields
            .iter()
            .filter_map(|f| {
                let parts = f["path"].as_array()?;
                (parts.len() > path.len()
                    && parts.iter().zip(&path).all(|(a, b)| a.as_str() == Some(b)))
                .then(|| parts[path.len()].as_str().unwrap().to_owned())
            })
            .collect();
        for child in &children {
            let mut next = path.clone();
            next.push(child.clone());
            walk(object.get(child), next, fields, issues);
        }
        for key in object.keys().filter(|key| !children.contains(*key)) {
            let mut next = path.clone();
            next.push(key.clone());
            issues.push(Issue {
                path: next,
                reason: "unknown",
            });
        }
    }
    let mut issues = Vec::new();
    walk(
        Some(&migrate_with(source, support)),
        Vec::new(),
        support["fields"].as_array().unwrap(),
        &mut issues,
    );
    issues
}

pub(crate) fn valid_executable(source: &Value) -> bool {
    valid_source(source) && inspect_with(source, contract()).is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn values_follow_the_reader_contract_not_the_producer_version() {
        let original: Value = serde_json::from_str(include_str!(
            "../../src/features/presets/fixtures/portable-v1.json"
        ))
        .unwrap();
        let mut old = contract().clone();
        for field in old["fields"].as_array_mut().unwrap() {
            if field["path"] == json!(["preset", "autoViewportPaddingPixels"]) {
                field["max"] = json!(16);
            }
        }
        for (value, old_ok, current_ok) in [(12, true, true), (30, false, true), (31, false, false)]
        {
            let mut source = original["settings"].clone();
            source["preset"]["autoViewportPaddingPixels"] = json!(value);
            assert_eq!(inspect_with(&source, &old).is_empty(), old_ok);
            assert_eq!(valid_executable(&source), current_ok);
            assert!(valid_source(&source));
        }
    }

    #[test]
    fn shared_frontend_native_cases_have_identical_issues() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../src/features/presets/fixtures/compatibility-cases.json"
        ))
        .unwrap();
        for case in cases.as_array().unwrap() {
            let mut actual =
                serde_json::to_value(inspect_with(&case["settings"], contract())).unwrap();
            actual
                .as_array_mut()
                .unwrap()
                .sort_by_key(|v| v["path"].to_string());
            let mut expected = case["issues"].clone();
            expected
                .as_array_mut()
                .unwrap()
                .sort_by_key(|v| v["path"].to_string());
            assert_eq!(actual, expected, "{}", case["name"]);
        }
    }

    #[test]
    fn migrations_belong_to_the_reader_contract() {
        let original: Value = serde_json::from_str(include_str!(
            "../../src/features/presets/fixtures/portable-v1.json"
        ))
        .unwrap();
        let mut source = migrate(&original["settings"]);
        source["preset"].as_object_mut().unwrap().remove("lighting");
        let mut reader = contract().clone();
        reader["fields"]
            .as_array_mut()
            .unwrap()
            .retain(|field| field["path"][1] != "lighting");
        reader["migrations"]
            .as_array_mut()
            .unwrap()
            .retain(|id| id != "lighting-v1");
        assert!(inspect_with(&source, &reader).is_empty());
        assert!(valid_executable(&source));
    }

    #[test]
    fn literal_dotted_names_are_unknown_not_supported_path_aliases() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../src/features/presets/fixtures/compatibility-cases.json"
        ))
        .unwrap();
        for (path, value) in [
            (vec!["preset", "lighting.key.color"], json!("#123456")),
            (vec!["preset", "manualViewportRect.x"], json!(123)),
            (
                vec!["preset.lighting"],
                json!({"key": {"color": "#123456"}}),
            ),
        ] {
            let mut source = cases[0]["settings"].clone();
            let mut target = &mut source;
            for key in &path[..path.len() - 1] {
                target = &mut target[*key];
            }
            target[path[path.len() - 1]] = value;
            assert_eq!(
                inspect_with(&source, contract()),
                vec![Issue {
                    path: path.into_iter().map(str::to_owned).collect(),
                    reason: "unknown",
                }]
            );
            assert!(!valid_executable(&source));
        }
    }
}

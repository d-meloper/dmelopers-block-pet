//! Compare saved user settings across an update, excluding derived runtime fields.
use super::integrity::Result;
use super::shortcuts::KEYS as SHORTCUTS;
use serde_json::{Value, json};
use std::collections::BTreeMap;
pub const STORE_IDS: [&str; 4] = ["app", "cat", "general", "shortcut"];
const PERFORMANCE: &[&str] = &[
    "maxFPS",
    "shadowsEnabled",
    "renderScalePercent",
    "idlePowerSavingEnabled",
    "shadowQuality",
    "antialiasEnabled",
    "pixelFilterEnabled",
];
const BEHAVIOR: &[&str] = &[
    "mouseMirror",
    "motionSound",
    "behavior",
    "autoReleaseDelay",
    "ignoreMouse",
];
const WINDOW: &[&str] = &[
    "visible",
    "passThrough",
    "alwaysOnTop",
    "scale",
    "hideOnHover",
    "hideOnHoverDelay",
    "keepInScreen",
];
pub type Stores = BTreeMap<String, Value>;
pub fn semantic_state(stores: &Stores) -> Result<Value> {
    let cat = &stores["cat"];
    let general = &stores["general"];
    // Compare user settings independently of derived theme and native geometry.
    let settings = json!({"preferences":{"app":select(&general["app"],&["taskbarVisible","trayVisible","autoUpdateCheck"]),"appearance":select(&general["appearance"],&["theme","language"]),"behavior":select(&cat["model"],BEHAVIOR)},"performance":select(&cat["model"],PERFORMANCE),"window":{"options":select(&cat["window"],WINDOW)},"shortcuts":select(&stores["shortcut"],SHORTCUTS)});
    let collection = &cat["presetCollection"];
    let active = collection["entries"]
        .as_array()
        .ok_or("MISSING_PRESETS")?
        .iter()
        .find(|e| e["id"] == collection["activeId"])
        .ok_or("MISSING_PRESETS")?;
    let keys = active["snapshot"]["preset"]
        .as_object()
        .ok_or("INVALID_PRESET")?
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>();
    let mut state = json!({"settings":settings,"presets":select(collection,&["schemaVersion","activeId","entries"]),"active":{"preset":select(&cat["customization3d"]["preset"],&keys),"appearance":select(&cat["customization3d"],&["selectedModelId","dmeloperSkinDataUrl","minecraftSkinUsername","activeSkinLibraryEntryId","dmeloperSkinModel","useDefaultDmeloperSkin"]),"mirror":cat["model"]["mirror"],"opacity":cat["window"]["opacity"],"eyebrowAnimationEnabled":cat["model"]["eyebrowAnimationEnabled"]}});
    fn clear_optional(value: &mut Value) {
        if let Value::Object(map) = value {
            for key in [
                "minecraftSkinUsername",
                "activeSkinLibraryEntryId",
                "dmeloperSkinDataUrl",
            ] {
                if map.get(key).is_some_and(Value::is_null) {
                    map.remove(key);
                }
            }
            for v in map.values_mut() {
                clear_optional(v);
            }
        } else if let Value::Array(values) = value {
            for v in values {
                clear_optional(v);
            }
        }
    }
    clear_optional(&mut state);
    Ok(state)
}
fn select(value: &Value, keys: &[&str]) -> Value {
    Value::Object(
        keys.iter()
            .filter_map(|key| value.get(*key).map(|v| ((*key).to_owned(), v.clone())))
            .collect(),
    )
}

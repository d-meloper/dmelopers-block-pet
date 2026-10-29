//! Build-time projection of the shared source registry and native-only messages.
use serde_json::Value;
use std::{collections::BTreeMap, fs, path::Path};

fn read_json(path: &Path) -> Value {
    let metadata = fs::symlink_metadata(path).expect("locale source is missing");
    assert!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "locale source must be an ordinary file"
    );
    serde_json::from_slice(&fs::read(path).expect("locale source could not be read"))
        .expect("locale source must be JSON")
}

fn name(value: &str) -> bool {
    if value.len() > 85 {
        return false;
    }
    let mut parts = value.split('-');
    let Some(first) = parts.next() else {
        return false;
    };
    (2..=8).contains(&first.len())
        && first.bytes().all(|byte| byte.is_ascii_alphabetic())
        && parts.all(|part| {
            (1..=8).contains(&part.len()) && part.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
}

fn flatten(value: &Value, prefix: &str, output: &mut BTreeMap<String, String>) {
    if let Some(object) = value.as_object() {
        for (key, child) in object {
            assert!(
                !key.is_empty() && !key.contains('.'),
                "native message key is invalid"
            );
            let path = if prefix.is_empty() {
                key.to_owned()
            } else {
                format!("{prefix}.{key}")
            };
            flatten(child, &path, output);
        }
    } else {
        let text = value
            .as_str()
            .filter(|text| !text.trim().is_empty())
            .expect("native messages must be nonempty strings");
        assert!(
            !text.contains('\0'),
            "native messages must not contain a NUL character"
        );
        assert!(output.insert(prefix.to_owned(), text.to_owned()).is_none());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let cache = Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/locale-projection-tests");
        fs::create_dir_all(&cache).unwrap();
        let directory = tempfile::tempdir_in(cache).unwrap();
        let root = directory.path().join("project/src-tauri");
        let out = directory.path().join("output");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(root.join("../src/locales")).unwrap();
        fs::create_dir_all(&out).unwrap();
        fs::write(
            root.join("../src/locales/registry.json"),
            serde_json::to_vec(&json!({
                "version": 1, "sourceLocale":"ko-KR", "fallbackLocale":"en-US", "locales": {
                    "ko-KR":{"status":"ready","direction":"ltr","matches":["ko","ko-*"]},
                    "en-US":{"status":"ready","direction":"ltr","matches":["en","en-*"]},
                    "ar":{"status":"draft","direction":"rtl","matches":["ar-*"]}
                }
            }))
            .unwrap(),
        )
        .unwrap();
        for (code, message) in [("ko-KR", "시작"), ("en-US", "Start")] {
            fs::write(
                root.join(format!("../src/locales/{code}.json")),
                serde_json::to_vec(&json!({
                    "pages":{"mustNotShip":"full-app-catalog-sentinel"},
                    "startup":{"native":{"start":message},"web":{"mustNotShip":"web-only-sentinel"}}
                }))
                .unwrap(),
            )
            .unwrap();
        }
        (directory, root, out)
    }

    #[test]
    fn projection_is_deterministic_and_omits_draft_and_non_native_messages() {
        let (_directory, root, out) = fixture();
        generate(&root, &out);
        let before = fs::read(out.join("native_locales.rs")).unwrap();
        generate(&root, &out);
        assert_eq!(fs::read(out.join("native_locales.rs")).unwrap(), before);
        let text = String::from_utf8(before).unwrap();
        assert!(text.contains("시작") && text.contains("Start"));
        assert!(!text.contains("ar-*"));
        assert!(!text.contains("mustNotShip") && !text.contains("sentinel"));
    }

    #[test]
    fn projection_refuses_missing_or_empty_ready_native_translations() {
        let (_directory, root, out) = fixture();
        let catalog = root.join("../src/locales/en-US.json");
        for invalid in [
            json!({"startup":{"native":{"other":"Different key"}}}),
            json!({"startup":{"native":{"start":""}}}),
            json!({"startup":{"native":{"start":"unsafe\u{0}text"}}}),
        ] {
            fs::write(&catalog, serde_json::to_vec(&invalid).unwrap()).unwrap();
            assert!(std::panic::catch_unwind(|| generate(&root, &out)).is_err());
        }
    }

    #[test]
    fn projection_refuses_locale_codes_that_could_escape_the_catalog_directory() {
        let (_directory, root, out) = fixture();
        let path = root.join("../src/locales/registry.json");
        let mut registry = read_json(&path);
        registry["locales"]["../escape"] = json!({"status":"draft","direction":"ltr","matches":[]});
        fs::write(path, serde_json::to_vec(&registry).unwrap()).unwrap();
        assert!(std::panic::catch_unwind(|| generate(&root, &out)).is_err());
    }
}

pub fn generate(root: &Path, out: &Path) {
    let directory = root.join("../src/locales");
    let registry_path = directory.join("registry.json");
    println!("cargo:rerun-if-changed={}", registry_path.display());
    let registry = read_json(&registry_path);
    assert_eq!(
        registry["version"], 1,
        "unsupported locale registry version"
    );
    let locales = registry["locales"]
        .as_object()
        .expect("locale registry must have locales");
    let fallback = registry["fallbackLocale"]
        .as_str()
        .expect("fallback locale is required");
    let source = registry["sourceLocale"]
        .as_str()
        .expect("source locale is required");
    assert_eq!(fallback, "en-US", "English is the approved hard fallback");
    assert_eq!(source, "ko-KR", "Korean is the approved source locale");
    let mut generated = format!(
        "const FALLBACK_LOCALE: &str = {fallback:?};\nconst EMBEDDED_LOCALES: &[EmbeddedLocale<'static>] = &[\n"
    );
    let mut required_keys = None;
    let mut ready = 0;
    for (code, entry) in locales {
        assert!(name(code), "locale code cannot name a source file");
        let status = entry["status"].as_str().expect("locale status is required");
        assert!(
            matches!(status, "draft" | "ready"),
            "locale status is invalid"
        );
        if status != "ready" {
            continue;
        }
        ready += 1;
        let direction = entry["direction"]
            .as_str()
            .expect("locale direction is required");
        assert!(
            matches!(direction, "ltr" | "rtl"),
            "locale direction is invalid"
        );
        let matches = entry["matches"]
            .as_array()
            .expect("explicit locale matching rules are required");
        let mut rules = Vec::new();
        for value in matches {
            let rule = value
                .as_str()
                .expect("locale matching rules must be strings");
            assert!(
                name(rule.strip_suffix("-*").unwrap_or(rule)),
                "locale matching rule is invalid"
            );
            rules.push(format!("{rule:?}"));
        }
        let catalog_path = directory.join(format!("{code}.json"));
        println!("cargo:rerun-if-changed={}", catalog_path.display());
        let catalog = read_json(&catalog_path);
        let mut messages = BTreeMap::new();
        let native = catalog
            .pointer("/startup/native")
            .expect("ready locale needs native startup messages");
        assert!(
            native.is_object(),
            "native startup messages must be an object"
        );
        flatten(native, "", &mut messages);
        assert!(
            !messages.is_empty(),
            "native startup catalog cannot be empty"
        );
        let keys = messages.keys().cloned().collect::<Vec<_>>();
        if let Some(required) = &required_keys {
            assert_eq!(&keys, required, "ready native locale key sets differ")
        } else {
            required_keys = Some(keys);
        }
        generated.push_str(&format!("EmbeddedLocale {{ code: {code:?}, direction: {direction:?}, matches: &[{}], messages: &[\n", rules.join(", ")));
        for (key, value) in messages {
            generated.push_str(&format!("({key:?}, {value:?}),\n"));
        }
        generated.push_str("] },\n");
    }
    assert!(ready > 0);
    for required in [fallback, source] {
        assert_eq!(
            locales[required]["status"], "ready",
            "source/fallback locale must be ready"
        );
    }
    generated.push_str("];\n");
    let target = out.join("native_locales.rs");
    if fs::read_to_string(&target).ok().as_deref() != Some(&generated) {
        fs::write(target, generated).expect("native locale projection could not be written");
    }
}

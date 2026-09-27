//! Version-resource validation, also testable without linking the Windows app.

pub fn pack_component_version(version: &str) -> u64 {
    let parts: Vec<u16> = version
        .split('.')
        .map(|part| {
            assert!(
                !part.is_empty()
                    && part.bytes().all(|b| b.is_ascii_digit())
                    && (part == "0" || !part.starts_with('0')),
                "canonical component version"
            );
            part.parse().expect("numeric component version")
        })
        .collect();
    assert_eq!(parts.len(), 3, "canonical component version");
    (u64::from(parts[0]) << 48) | (u64::from(parts[1]) << 32) | (u64::from(parts[2]) << 16)
}

pub fn check_private_qa_version(app_version: &str, fixture_version: Option<&str>) {
    pack_component_version(app_version);
    assert_eq!(fixture_version, Some(app_version), "private QA app version");
    assert!(
        app_version.starts_with("0.9."),
        "private QA baseline version"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn component_version_and_private_app_baseline_are_independent() {
        assert_eq!(pack_component_version("1.0.0"), 1_u64 << 48);
        check_private_qa_version("0.9.1", Some("0.9.1"));
        assert_eq!(pack_component_version("1.0.0"), 1_u64 << 48);
    }

    #[test]
    fn rejects_invalid_windows_resource_versions() {
        for value in [
            "01.0.0",
            "+1.0.0",
            "1.0",
            "1.0.0.0",
            "1.0.0-beta",
            "65536.0.0",
            "-1.0.0",
        ] {
            assert!(std::panic::catch_unwind(|| pack_component_version(value)).is_err());
        }
    }

    #[test]
    fn private_qa_cannot_use_component_or_release_version_as_baseline() {
        for (app, fixture) in [
            ("0.9.0", Some("1.0.0")),
            ("0.9.0", None),
            ("1.0.1", Some("1.0.1")),
        ] {
            assert!(std::panic::catch_unwind(|| check_private_qa_version(app, fixture)).is_err());
        }
    }
}

//! Native-only build projection; it never opens settings or translation files.
struct EmbeddedLocale<'a> {
    code: &'a str,
    direction: &'a str,
    matches: &'a [&'a str],
    messages: &'a [(&'a str, &'a str)],
}
include!(concat!(env!("OUT_DIR"), "/native_locales.rs"));

fn matches_rule(locale: &str, rule: &str) -> bool {
    if let Some(prefix) = rule.strip_suffix("-*") {
        locale
            .get(..prefix.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
            && locale.as_bytes().get(prefix.len()) == Some(&b'-')
            && locale.len() > prefix.len() + 1
    } else {
        locale.eq_ignore_ascii_case(rule)
    }
}

fn valid_name(locale: &str) -> bool {
    if locale.len() > 85 {
        return false;
    }
    let mut parts = locale.split('-');
    let Some(language) = parts.next() else {
        return false;
    };
    (2..=8).contains(&language.len())
        && language.bytes().all(|byte| byte.is_ascii_alphabetic())
        && parts.all(|part| {
            (1..=8).contains(&part.len()) && part.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
}

fn resolve_in<'a>(
    locales: &'a [EmbeddedLocale<'a>],
    fallback: &str,
    raw: &str,
) -> &'a EmbeddedLocale<'a> {
    let default = locales
        .iter()
        .find(|entry| entry.code == fallback)
        .expect("compiled English fallback is present");
    if !valid_name(raw) {
        return default;
    }
    locales
        .iter()
        .find(|entry| entry.code.eq_ignore_ascii_case(raw))
        .or_else(|| {
            locales
                .iter()
                .find(|entry| entry.matches.iter().any(|rule| matches_rule(raw, rule)))
        })
        .unwrap_or(default)
}

fn selected() -> &'static EmbeddedLocale<'static> {
    resolve_in(
        EMBEDDED_LOCALES,
        FALLBACK_LOCALE,
        crate::system_language::ui_locale().unwrap_or(FALLBACK_LOCALE),
    )
}

pub(crate) fn is_rtl() -> bool {
    selected().direction == "rtl"
}

pub(crate) fn text(key: &str) -> &'static str {
    selected()
        .message(key)
        .or_else(|| {
            EMBEDDED_LOCALES
                .iter()
                .find(|locale| locale.code == FALLBACK_LOCALE)
                .and_then(|locale| locale.message(key))
        })
        .unwrap_or("The app could not start safely.")
}

impl<'a> EmbeddedLocale<'a> {
    fn message(&self, key: &str) -> Option<&'a str> {
        self.messages
            .iter()
            .find(|(name, _)| *name == key)
            .map(|(_, value)| *value)
    }
}

#[cfg(test)]
#[path = "../build_locales.rs"]
mod build_projection;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_resolver_fixture_matches_typescript_in_both_script_branches() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../src/locales/fixtures/resolution.json"))
                .unwrap();
        let ready = fixture["registry"]["locales"]
            .as_object()
            .unwrap()
            .iter()
            .filter(|(_, entry)| entry["status"] == "ready")
            .collect::<Vec<_>>();
        let rules = ready
            .iter()
            .map(|(_, entry)| {
                entry["matches"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|rule| rule.as_str().unwrap())
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        let locales = ready
            .iter()
            .zip(&rules)
            .map(|((code, entry), rules)| EmbeddedLocale {
                code,
                direction: entry["direction"].as_str().unwrap(),
                matches: rules,
                messages: &[],
            })
            .collect::<Vec<_>>();
        let fallback = fixture["registry"]["fallbackLocale"].as_str().unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let input = case["input"].as_str().unwrap_or("");
            assert_eq!(
                resolve_in(&locales, fallback, input).code,
                case["expected"].as_str().unwrap(),
                "{case}"
            );
        }
        assert_eq!(
            resolve_in(&locales, fallback, &format!("ko-{}", "aa-".repeat(30))).code,
            fallback
        );
    }

    #[test]
    fn compiled_native_catalog_has_only_ready_messages_and_an_english_fallback() {
        let registry: serde_json::Value =
            serde_json::from_str(include_str!("../../src/locales/registry.json")).unwrap();
        let ready = registry["locales"]
            .as_object()
            .unwrap()
            .iter()
            .filter(|(_, locale)| locale["status"] == "ready")
            .count();
        assert_eq!(EMBEDDED_LOCALES.len(), ready);
        let english = resolve_in(EMBEDDED_LOCALES, FALLBACK_LOCALE, "unsupported");
        assert_eq!(english.code, "en-US");
        assert!(english.messages.len() >= 16);
        assert_eq!(
            english
                .messages
                .iter()
                .find(|(key, _)| *key == "couldNotStart")
                .unwrap()
                .1,
            "The app could not start safely."
        );
        for locale in EMBEDDED_LOCALES {
            assert_eq!(registry["locales"][locale.code]["status"], "ready");
            assert!(!locale.code.starts_with("qps") && !["en-XA", "ar-XB"].contains(&locale.code));
            assert!(
                locale
                    .messages
                    .iter()
                    .all(|(key, value)| !key.starts_with("pages.") && !value.is_empty())
            );
        }
    }

    #[test]
    fn native_matching_uses_exact_codes_then_explicit_rules_without_script_guessing() {
        let locales = [
            EmbeddedLocale {
                code: "en-US",
                direction: "ltr",
                matches: &["en", "en-*"],
                messages: &[],
            },
            EmbeddedLocale {
                code: "ko-KR",
                direction: "ltr",
                matches: &["ko", "ko-*"],
                messages: &[],
            },
            EmbeddedLocale {
                code: "en-GB",
                direction: "ltr",
                matches: &[],
                messages: &[],
            },
            EmbeddedLocale {
                code: "zh-Hans",
                direction: "ltr",
                matches: &["zh-CN", "zh-SG", "zh-Hans-*"],
                messages: &[],
            },
            EmbeddedLocale {
                code: "zh-Hant",
                direction: "ltr",
                matches: &["zh-TW", "zh-HK", "zh-Hant-*"],
                messages: &[],
            },
            EmbeddedLocale {
                code: "ar",
                direction: "rtl",
                matches: &["ar-*"],
                messages: &[],
            },
        ];
        for (raw, expected) in [
            ("en-GB", "en-GB"),
            ("en-AU", "en-US"),
            ("KO-kp", "ko-KR"),
            ("zh-CN", "zh-Hans"),
            ("zh-TW", "zh-Hant"),
            ("zh-Hant-MO", "zh-Hant"),
            ("zh", "en-US"),
            ("ja-JP", "en-US"),
            ("ar-SA", "ar"),
            ("ko_KR", "en-US"),
            ("ko-", "en-US"),
            ("../../ko-KR", "en-US"),
            ("", "en-US"),
        ] {
            assert_eq!(resolve_in(&locales, "en-US", raw).code, expected, "{raw}");
        }
        assert_eq!(resolve_in(&locales, "en-US", "ar-SA").direction, "rtl");
    }
}

//! One read-only Windows display-language observation shared by both webviews.
use std::sync::OnceLock;

type LanguageResult = Result<&'static str, &'static str>;
static SYSTEM_UI_LANGUAGE: OnceLock<LanguageResult> = OnceLock::new();

fn resolve_ui_language(language_id: u16) -> LanguageResult {
    if language_id == 0 {
        Err("SYSTEM_UI_LANGUAGE_UNAVAILABLE")
    } else if language_id & 0x3ff == 0x12 {
        Ok("ko-KR")
    } else {
        Ok("en-US")
    }
}

fn read_ui_language() -> LanguageResult {
    resolve_ui_language(unsafe {
        windows_sys::Win32::Globalization::GetUserDefaultUILanguage()
    })
}

fn snapshot(
    cache: &OnceLock<LanguageResult>,
    read: impl FnOnce() -> LanguageResult,
) -> LanguageResult {
    *cache.get_or_init(read)
}

pub(crate) fn is_korean() -> bool {
    snapshot(&SYSTEM_UI_LANGUAGE, read_ui_language) == Ok("ko-KR")
}

fn authorize_window(label: &str) -> Result<(), &'static str> {
    if matches!(label, "main" | "preference") {
        Ok(())
    } else {
        Err("SYSTEM_UI_LANGUAGE_FORBIDDEN")
    }
}

#[tauri::command]
pub fn get_system_ui_language(window: tauri::WebviewWindow) -> LanguageResult {
    authorize_window(window.label())?;
    snapshot(&SYSTEM_UI_LANGUAGE, read_ui_language)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn korean_ui_language_uses_korean_and_all_other_languages_use_english() {
        for language_id in [0x0412, 0x0812] {
            assert_eq!(resolve_ui_language(language_id), Ok("ko-KR"));
        }
        for language_id in [0x0409, 0x0809, 0x0411, 0x0404, 0x0407] {
            assert_eq!(resolve_ui_language(language_id), Ok("en-US"));
        }
        assert_eq!(resolve_ui_language(0), Err("SYSTEM_UI_LANGUAGE_UNAVAILABLE"));
    }

    #[test]
    fn both_windows_share_one_observation_including_a_failed_read() {
        for observed in [Ok("ko-KR"), Err("SYSTEM_UI_LANGUAGE_UNAVAILABLE")] {
            let cache = OnceLock::new();
            let reads = Cell::new(0);
            for label in ["main", "preference", "main"] {
                authorize_window(label).unwrap();
                assert_eq!(snapshot(&cache, || {
                    reads.set(reads.get() + 1);
                    observed
                }), observed);
            }
            assert_eq!(reads.get(), 1);
            assert_eq!(snapshot(&cache, || Ok("en-US")), observed);
        }
    }

    #[test]
    fn only_application_windows_can_read_the_system_language() {
        for label in ["main", "preference"] {
            assert_eq!(authorize_window(label), Ok(()));
        }
        for label in ["broadcast", "", "other"] {
            assert_eq!(authorize_window(label), Err("SYSTEM_UI_LANGUAGE_FORBIDDEN"));
        }
    }
}

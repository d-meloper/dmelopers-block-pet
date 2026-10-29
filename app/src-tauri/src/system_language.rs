//! One read-only Windows display-language observation shared by all app consumers.
use std::sync::OnceLock;
use windows_sys::Win32::Globalization::{
    GetUserDefaultUILanguage, GetUserPreferredUILanguages, LCIDToLocaleName, MUI_LANGUAGE_NAME,
};

type LanguageResult = Result<&'static str, &'static str>;
type LocaleResult = Result<String, &'static str>;

#[derive(Debug, PartialEq)]
struct UiLanguageObservation {
    legacy: LanguageResult,
    locale: LocaleResult,
}

static SYSTEM_UI_LANGUAGE: OnceLock<UiLanguageObservation> = OnceLock::new();

// Preserve the legacy command's ko/en mapping, including a failed LANGID read.
fn resolve_ui_language(language_id: u16) -> LanguageResult {
    if language_id == 0 {
        Err("SYSTEM_UI_LANGUAGE_UNAVAILABLE")
    } else if language_id & 0x3ff == 0x12 {
        Ok("ko-KR")
    } else {
        Ok("en-US")
    }
}

fn valid_locale_name(name: &str) -> bool {
    if name.len() > 85 {
        return false;
    }
    let mut parts = name.split('-');
    let Some(language) = parts.next() else {
        return false;
    };
    (2..=8).contains(&language.len())
        && language.bytes().all(|byte| byte.is_ascii_alphabetic())
        && parts.all(|part| {
            (1..=8).contains(&part.len()) && part.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
}

fn first_preferred_name(buffer: &[u16], language_count: u32) -> LocaleResult {
    if language_count == 0 || buffer.len() < 2 || !buffer.ends_with(&[0, 0]) {
        return Err("SYSTEM_UI_LANGUAGE_UNAVAILABLE");
    }
    let end = buffer
        .iter()
        .position(|value| *value == 0)
        .ok_or("SYSTEM_UI_LANGUAGE_UNAVAILABLE")?;
    let name = String::from_utf16(&buffer[..end]).map_err(|_| "SYSTEM_UI_LANGUAGE_UNAVAILABLE")?;
    if !valid_locale_name(&name) {
        return Err("SYSTEM_UI_LANGUAGE_UNAVAILABLE");
    }
    Ok(name)
}

fn preferred_ui_locale() -> LocaleResult {
    let mut language_count = 0;
    let mut length = 0;
    if unsafe {
        GetUserPreferredUILanguages(
            MUI_LANGUAGE_NAME,
            &mut language_count,
            std::ptr::null_mut(),
            &mut length,
        )
    } == 0
        || !(2..=8192).contains(&length)
    {
        return Err("SYSTEM_UI_LANGUAGE_UNAVAILABLE");
    }
    let mut buffer = vec![0u16; length as usize];
    if unsafe {
        GetUserPreferredUILanguages(
            MUI_LANGUAGE_NAME,
            &mut language_count,
            buffer.as_mut_ptr(),
            &mut length,
        )
    } == 0
        || length as usize > buffer.len()
    {
        return Err("SYSTEM_UI_LANGUAGE_UNAVAILABLE");
    }
    first_preferred_name(&buffer[..length as usize], language_count)
}

fn locale_from_id(language_id: u16) -> LocaleResult {
    // Supplemental UI LANGIDs cannot name their actual language. The preferred
    // name API above is authoritative for those installations.
    if language_id == 0 || language_id == 0x1400 {
        return Err("SYSTEM_UI_LANGUAGE_UNAVAILABLE");
    }
    let mut buffer = [0u16; 128];
    let length = unsafe {
        LCIDToLocaleName(
            language_id as u32,
            buffer.as_mut_ptr(),
            buffer.len() as i32,
            0,
        )
    };
    if length <= 1 || length as usize > buffer.len() {
        return Err("SYSTEM_UI_LANGUAGE_UNAVAILABLE");
    }
    let name = String::from_utf16(&buffer[..length as usize - 1])
        .map_err(|_| "SYSTEM_UI_LANGUAGE_UNAVAILABLE")?;
    if !valid_locale_name(&name) {
        return Err("SYSTEM_UI_LANGUAGE_UNAVAILABLE");
    }
    Ok(name)
}

fn read_ui_language() -> UiLanguageObservation {
    let language_id = unsafe { GetUserDefaultUILanguage() };
    UiLanguageObservation {
        legacy: resolve_ui_language(language_id),
        locale: preferred_ui_locale().or_else(|_| locale_from_id(language_id)),
    }
}

fn snapshot(
    cache: &OnceLock<UiLanguageObservation>,
    read: impl FnOnce() -> UiLanguageObservation,
) -> &UiLanguageObservation {
    cache.get_or_init(read)
}

pub(crate) fn ui_locale() -> Result<&'static str, &'static str> {
    snapshot(&SYSTEM_UI_LANGUAGE, read_ui_language)
        .locale
        .as_deref()
        .map_err(|error| *error)
}

pub(crate) fn is_korean() -> bool {
    snapshot(&SYSTEM_UI_LANGUAGE, read_ui_language).legacy == Ok("ko-KR")
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
    snapshot(&SYSTEM_UI_LANGUAGE, read_ui_language).legacy
}

#[tauri::command]
pub fn get_system_ui_locale(window: tauri::WebviewWindow) -> LocaleResult {
    authorize_window(window.label())?;
    ui_locale().map(str::to_owned)
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
        assert_eq!(
            resolve_ui_language(0),
            Err("SYSTEM_UI_LANGUAGE_UNAVAILABLE")
        );
    }

    #[test]
    fn both_commands_and_native_consumers_share_success_or_failure_once() {
        for observed in [
            UiLanguageObservation {
                legacy: Ok("ko-KR"),
                locale: Ok("ko-KR".into()),
            },
            UiLanguageObservation {
                legacy: Ok("en-US"),
                locale: Ok("ja-JP".into()),
            },
            UiLanguageObservation {
                legacy: Err("SYSTEM_UI_LANGUAGE_UNAVAILABLE"),
                locale: Err("SYSTEM_UI_LANGUAGE_UNAVAILABLE"),
            },
        ] {
            let cache = OnceLock::new();
            let reads = Cell::new(0);
            for label in ["main", "preference", "main"] {
                authorize_window(label).unwrap();
                let result = snapshot(&cache, || {
                    reads.set(reads.get() + 1);
                    UiLanguageObservation {
                        legacy: observed.legacy,
                        locale: observed.locale.clone(),
                    }
                });
                assert_eq!(result, &observed);
            }
            assert_eq!(reads.get(), 1);
            assert_eq!(
                snapshot(&cache, || panic!("snapshot must not retry")),
                &observed
            );
        }
    }

    #[test]
    fn preferred_name_is_the_first_display_language_and_never_the_input_locale() {
        let names: Vec<u16> = "zh-Hant-TW\0en-US\0\0".encode_utf16().collect();
        assert_eq!(first_preferred_name(&names, 2).unwrap(), "zh-Hant-TW");
        for invalid in ["\0\0", "ko_KR\0\0", "ja-JP\0", "../../en-US\0\0"] {
            assert!(first_preferred_name(&invalid.encode_utf16().collect::<Vec<_>>(), 1).is_err());
        }
        assert!(first_preferred_name(&names, 0).is_err());
        assert!(locale_from_id(0).is_err());
        assert!(locale_from_id(0x1400).is_err());
    }

    #[test]
    fn only_application_windows_can_read_either_system_language_command() {
        for label in ["main", "preference"] {
            assert_eq!(authorize_window(label), Ok(()));
        }
        for label in ["broadcast", "update-failure", "", "other"] {
            assert_eq!(authorize_window(label), Err("SYSTEM_UI_LANGUAGE_FORBIDDEN"));
        }
    }
}

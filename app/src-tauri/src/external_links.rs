//! Shared source-owned destinations; pre-webview help uses the Windows UI language.
use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Links {
    webview_guide: String,
}

#[derive(Deserialize)]
struct Registry {
    korean: Links,
    global: Links,
}

pub fn webview_guide(korean: bool) -> &'static str {
    static LINKS: OnceLock<Registry> = OnceLock::new();
    let links = LINKS.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/config/externalLinks.json"))
            .expect("source-owned external links must be valid")
    });
    if korean {
        &links.korean.webview_guide
    } else {
        &links.global.webview_guide
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_help_uses_the_requested_audience_without_a_network_lookup() {
        assert!(webview_guide(true).contains("3f02dc0bb4ae80cf87f8e8a02efe0adb"));
        assert!(webview_guide(false).contains("3f32dc0bb4ae8067b55aed03f603d811"));
        assert_ne!(webview_guide(true), webview_guide(false));
    }
}

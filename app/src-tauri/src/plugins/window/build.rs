const COMMANDS: &[&str] = &[
    "show_window",
    "hide_window",
    "drag_main_window",
    "set_memory_active",
    "set_always_on_top",
    "set_color_picker_open",
    "set_taskbar_visibility",
    "set_preference_caption_color",
];

fn main() {
    assert_eq!(
        std::env::var("CARGO_CFG_TARGET_OS").as_deref(),
        Ok("windows"),
        "DMeloper's Block Pet currently supports Windows only."
    );
    tauri_plugin::Builder::new(COMMANDS).build();
}

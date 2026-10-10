use tauri::{
    Runtime, generate_handler,
    plugin::{Builder, TauriPlugin},
};

mod commands;

pub use commands::*;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("custom-window")
        .invoke_handler(generate_handler![
            commands::show_window,
            commands::hide_window,
            commands::drag_main_window,
            commands::set_memory_active,
            commands::set_always_on_top,
            commands::set_pet_cursor_events,
            commands::popup_pet_menu,
            commands::set_color_picker_open,
            commands::set_taskbar_visibility,
            commands::set_preference_caption_color,
        ])
        .build()
}

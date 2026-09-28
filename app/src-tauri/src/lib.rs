mod application_context;
mod autostart;
mod bootstrap;
mod data_paths;
mod distribution;
mod native_operation;
mod windows_process;
mod asset_scope;
mod broadcast;
mod core;
mod diagnostics;
mod in_app_update;
mod latest_version;
mod minecraft_skin;
mod performance;
mod settings_defaults;
mod skin_library;
mod state_safety;

const RELEASE_MODE_MARKER: &str = "DMELoper_CHANNEL_BOUND_SHARED_DATA_V1";

/// Configured windows must wait until normal native state has been installed.
struct StartupReady(tokio::sync::watch::Sender<bool>);
impl StartupReady {
    fn new() -> Self {
        Self(tokio::sync::watch::channel(false).0)
    }
    fn complete(&self) {
        self.0.send_replace(true);
    }
    async fn wait(&self) -> Result<(), String> {
        self.0
            .subscribe()
            .wait_for(|ready| *ready)
            .await
            .map(|_| ())
            .map_err(|_| "STARTUP_UNAVAILABLE".into())
    }
}
#[tauri::command]
async fn await_native_startup(state: tauri::State<'_, StartupReady>) -> Result<(), String> {
    state.wait().await
}

use broadcast::{BroadcastState, configure_broadcast, get_broadcast_status};
use core::{
    device::{
        set_device_input_active, set_device_mouse_enabled, start_device_listening,
        stop_device_listening,
    },
    eyedropper::{cancel_screen_color_pick, pick_screen_color},
    prevent_default,
    restart::restart_application,
    setup,
};
use latest_version::{LatestVersionState, check_latest_version, latest_version_releases_url};
use minecraft_skin::{MinecraftSkinState, fetch_minecraft_skin};
use performance::{PerformanceMonitorState, prime_app_performance_sampler, sample_app_performance};
use skin_library::{
    SkinLibraryState, cleanup_skin_library, clear_skin_library, delete_skin_library_entries, list_skin_library,
    read_local_skin_file, read_skin_library_entry, rename_skin_library_entry,
    store_skin_library_entry,
};
use tauri::{Emitter, Manager, WindowEvent, generate_handler};
use tauri_plugin_custom_window::{
    MAIN_WINDOW_LABEL, PREFERENCE_WINDOW_LABEL, set_webview_memory_active,
};

pub fn run() {
    std::hint::black_box(RELEASE_MODE_MARKER);
    let (lifetime_lock, roots) = match bootstrap::prepare() {
        Ok(Some(ready)) => ready,
        Ok(None) => return,
        Err(message) => { bootstrap::error(&message); return; }
    };
    let pinia_root = roots.durable.join("tauri-plugin-pinia");
    let app = tauri::Builder::default()
        .manage(roots)
        .plugin(data_paths::storage_guard())
        .plugin(diagnostics::init())
        // Retain the existing log IPC permissions; the sole file writer is diagnostics.
        .plugin(tauri_plugin_log::Builder::new().skip_logger().build())
        .plugin(asset_scope::init())
        .manage(PerformanceMonitorState::new())
        // Configured webviews can invoke commands while setup is still running.
        .manage(StartupReady::new())
        .setup(|app| {
            data_paths::assert_store_root(app.handle())?;
            state_safety::initialize_general_defaults(app.handle()).map_err(|code| {
                diagnostics::error("settings.initialize_defaults", code);
                // Setup failure terminates the app; never leave hidden webviews waiting
                // or let a corrupt stored file become a new frontend default snapshot.
                std::io::Error::other(code)
            })?;
            app.manage(MinecraftSkinState::new(app.handle()));
            app.manage(SkinLibraryState::new(app.handle()));
            app.manage(BroadcastState::new(app.handle()));
            app.manage(LatestVersionState::new(app.handle()));
            #[cfg(any(feature = "channel-github", feature = "test-repository"))]
            in_app_update::enabled_profile::initialize(app.handle()).map_err(|error| {
                diagnostics::error("updater.initialize", "UPDATE_PLUGIN_INITIALIZATION_FAILED");
                error
            })?;
            let app_handle = app.handle();

            let main_window = app.get_webview_window(MAIN_WINDOW_LABEL).unwrap();

            let preference_window = app.get_webview_window(PREFERENCE_WINDOW_LABEL).unwrap();

            setup::default(app_handle, main_window.clone(), preference_window.clone());
            set_webview_memory_active(&preference_window, false).ok();
            app.state::<StartupReady>().complete();
            Ok(())
        })
        .invoke_handler(generate_handler![
            pick_screen_color,
            cancel_screen_color_pick,
            configure_broadcast,
            get_broadcast_status,
            check_latest_version,
            latest_version_releases_url,
            in_app_update::in_app_updater_enabled,
            in_app_update::check_app_update,
            in_app_update::download_app_update,
            in_app_update::install_app_update,
            in_app_update::cancel_app_update,
            in_app_update::begin_app_update_save,
            in_app_update::abort_app_update,
            distribution::distribution_info,
            autostart::autostart_status,
            autostart::set_autostart_enabled,
            start_device_listening,
            set_device_input_active,
            set_device_mouse_enabled,
            stop_device_listening,
            restart_application,
            prime_app_performance_sampler,
            sample_app_performance,
            fetch_minecraft_skin,
            list_skin_library,
            store_skin_library_entry,
            read_skin_library_entry,
            read_local_skin_file,
            rename_skin_library_entry,
            delete_skin_library_entries,
            cleanup_skin_library,
            clear_skin_library,
            skin_library::preset_transfer::export_pet_preset,
            skin_library::preset_transfer::read_pet_preset,
            skin_library::preset_transfer::prepare_preset_import,
            skin_library::preset_transfer::read_preset_import,
            skin_library::preset_transfer::finish_preset_import,
            state_safety::initialize_shortcut_defaults,
            state_safety::begin_state_quiescence,
            state_safety::acknowledge_state_quiescence,
            state_safety::verify_state_quiescence,
            state_safety::release_state_quiescence,
            await_native_startup
        ])
        .plugin(tauri_plugin_custom_window::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_pinia::Builder::new().path(pinia_root).build())
        .plugin(prevent_default::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_locale::init())
        .on_window_event(|window, event| {
            tauri_plugin_custom_window::handle_preference_focus(
                window.app_handle(),
                window.label(),
                event,
            );
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.hide().is_err() {
                    diagnostics::warn("window.close_hide", "WINDOW_HIDE_FAILED");
                } else if window.label() == PREFERENCE_WINDOW_LABEL {
                    if window.emit("preference-visibility-changed", false).is_err() {
                        diagnostics::warn("window.close_notify", "WINDOW_EVENT_FAILED");
                    }
                }
                if let Some(webview_window) = window.app_handle().get_webview_window(window.label())
                {
                    let keep_awake = state_safety::writes_locked()
                        && matches!(window.label(), "main" | "preference");
                    let _ = set_webview_memory_active(&webview_window, keep_awake);
                }
                if window.label() == MAIN_WINDOW_LABEL {
                    if window.emit("hide-window", MAIN_WINDOW_LABEL).is_err() {
                        diagnostics::warn("window.close_notify", "WINDOW_EVENT_FAILED");
                    }
                }

                api.prevent_close();
            }
        })
        .build(application_context::generate());
    let app = match app {
        Ok(app) => app,
        Err(error) => {
            bootstrap::error(&format!("The application could not initialize safely.\n{error}"));
            return;
        }
    };

    lifetime_lock.listen(app.handle().clone());
    app.run(|app_handle, event| match event {
        tauri::RunEvent::Exit => {
            app_handle.state::<BroadcastState>().shutdown();
            let _ = core::device::stop_listening();
        }
        _ => {
            let _ = app_handle;
        }
    });
}

#[cfg(test)]
mod startup_tests {
    use super::StartupReady;
    use std::task::Poll;
    #[tokio::test]
    async fn both_windows_wait_for_native_state_before_creating_writers() {
        let state = StartupReady::new();
        let main = state.wait();
        let preference = state.wait();
        tokio::pin!(main, preference);
        assert!(matches!(futures_util::poll!(&mut main), Poll::Pending));
        assert!(matches!(
            futures_util::poll!(&mut preference),
            Poll::Pending
        ));
        state.complete();
        assert!(main.await.is_ok());
        assert!(preference.await.is_ok());
        assert!(state.wait().await.is_ok());
    }
}

#[cfg(test)]
mod capability_tests {
    use tauri::{ipc::Origin, test::MockRuntime};

    #[test]
    fn renderer_cannot_bypass_native_restart_or_shared_storage_policy() {
        let mut context: tauri::Context<MockRuntime> = tauri::generate_context!();
        let authority = context.runtime_authority_mut();
        for command in ["plugin:process|restart", "plugin:pinia|set_store_collection_path", "plugin:autostart|enable", "plugin:autostart|disable"] {
            for label in ["main", "preference"] {
                assert!(authority.resolve_access(command, label, label, &Origin::Local).is_none(), "{command} cannot bypass native policy");
            }
        }
    }

    #[test]
    fn removed_update_failure_window_has_no_store_permissions() {
        let mut context: tauri::Context<MockRuntime> = tauri::generate_context!();
        let authority = context.runtime_authority_mut();
        assert!(
            authority
                .resolve_access(
                    "plugin:pinia|get_store_state",
                    "update-failure",
                    "update-failure",
                    &Origin::Local
                )
                .is_none()
        );
        for command in [
            "patch",
            "save",
            "save_now",
            "save_all_now",
            "allow_save",
            "set_store_options",
            "set_store_collection_path",
        ] {
            assert!(
                authority
                    .resolve_access(
                        &format!("plugin:pinia|{command}"),
                        "update-failure",
                        "update-failure",
                        &Origin::Local
                    )
                    .is_none()
            );
        }
        assert!(
            authority
                .resolve_access(
                    "plugin:pinia|get_store_state",
                    "update-failure",
                    "update-failure",
                    &Origin::Remote {
                        url: "https://example.invalid".parse().unwrap()
                    }
                )
                .is_none()
        );
    }

    #[test]
    fn user_archive_file_dialogs_are_not_available() {
        let mut context: tauri::Context<MockRuntime> = tauri::generate_context!();
        let authority = context.runtime_authority_mut();
        for command in ["plugin:dialog|open", "plugin:dialog|save"] {
            assert!(
                authority
                    .resolve_access(command, "preference", "preference", &Origin::Local)
                    .is_none()
            );
            for label in ["main", "recovery", "untrusted"] {
                assert!(
                    authority
                        .resolve_access(command, label, label, &Origin::Local)
                        .is_none()
                );
            }
            assert!(
                authority
                    .resolve_access(
                        command,
                        "preference",
                        "preference",
                        &Origin::Remote {
                            url: "https://example.invalid".parse().unwrap()
                        }
                    )
                    .is_none()
            );
        }
    }

    #[test]
    fn program_reset_can_center_the_preference_window() {
        let mut context: tauri::Context<MockRuntime> = tauri::generate_context!();
        let authority = context.runtime_authority_mut();
        let command = "plugin:window|center";
        assert!(
            authority
                .resolve_access(command, "preference", "preference", &Origin::Local)
                .is_some(),
            "whole-program reset must be allowed to center the preference window"
        );
        assert!(
            authority
                .resolve_access(command, "untrusted", "untrusted", &Origin::Local)
                .is_none()
        );
        assert!(
            authority
                .resolve_access(
                    command,
                    "preference",
                    "preference",
                    &Origin::Remote {
                        url: "https://example.invalid".parse().unwrap()
                    },
                )
                .is_none()
        );
    }

    #[test]
    fn developer_link_command_is_authorized_only_for_local_app_windows() {
        // Use the application's generated ACL; mock_context() has an empty ACL.
        let mut context: tauri::Context<MockRuntime> = tauri::generate_context!();
        let authority = context.runtime_authority_mut();
        let command = "plugin:opener|open_url";
        assert!(
            authority
                .resolve_access(command, "preference", "preference", &Origin::Local)
                .is_some(),
            "the developer link needs the open_url command grant as well as a URL scope"
        );
        assert!(
            authority
                .resolve_access(command, "untrusted", "untrusted", &Origin::Local)
                .is_none()
        );
        assert!(
            authority
                .resolve_access(
                    command,
                    "preference",
                    "preference",
                    &Origin::Remote {
                        url: "https://example.invalid".parse().unwrap()
                    },
                )
                .is_none()
        );
    }
}

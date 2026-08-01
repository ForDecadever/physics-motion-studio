mod desktop;

use desktop::DesktopState;
use std::ffi::OsString;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let queued = desktop::queue_arguments(
                &app.state::<DesktopState>(),
                args.into_iter().skip(1).map(OsString::from),
            );
            if queued {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                let _ = app.emit("desktop-open-requested", ());
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(DesktopState::default())
        .setup(|app| {
            desktop::initialize(app.handle(), std::env::args_os().skip(1));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop::desktop_open_scene,
            desktop::desktop_take_pending_scene,
            desktop::desktop_confirm_scene_opened,
            desktop::desktop_save_scene,
            desktop::desktop_list_recent_scenes,
            desktop::desktop_open_recent_scene,
            desktop::desktop_remove_recent_scene,
            desktop::desktop_clear_recent_scenes,
        ])
        .run(tauri::generate_context!())
        .expect("Motion Studio failed to start");
}

mod config;
mod health;
mod tray;

use tauri::Manager;

use config::DesktopConfig;

/// Boot the Drydock menu-bar shell: a window wrapping the local dashboard plus a
/// tray that mirrors live job counts and offers pause/drain toggles. The tray
/// drives all server interaction over HTTP from Rust, so the wrapped dashboard
/// page stays an ordinary, untouched web app.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config = DesktopConfig::from_env();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let handle = app.handle().clone();
            let handles = tray::build(&handle, config.clone())?;
            app.manage(handles);

            // Background poll loop keeps the tray counts and toggle marks in sync
            // with the dashboard.
            let poll_handle = handle.clone();
            let poll_config = config.clone();
            tauri::async_runtime::spawn(async move {
                tray::poll_loop(poll_handle, poll_config).await;
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Drydock desktop shell");
}

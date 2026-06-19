use tauri::menu::{CheckMenuItem, MenuBuilder, MenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_opener::OpenerExt;

use crate::config::DesktopConfig;
use crate::health::{self, Snapshot};

/// Long-lived handles the background poll loop and menu events use to mutate the
/// tray after it is built. Managed in Tauri state so any `AppHandle` can reach
/// them without threading clones through every call site.
pub struct TrayHandles {
    tray: TrayIcon<Wry>,
    pause: CheckMenuItem<Wry>,
    drain: CheckMenuItem<Wry>,
}

/// Which toggle a menu click is requesting, with the desired target value.
enum Toggle {
    Pause(bool),
    Drain(bool),
}

/// Build the tray icon and its menu, returning the handles for later updates.
/// The menu carries: show/open-in-browser, the two automation toggles, and quit.
pub fn build(app: &AppHandle, config: DesktopConfig) -> tauri::Result<TrayHandles> {
    let show = MenuItem::with_id(app, "show", "Show Dashboard", true, None::<&str>)?;
    let browser = MenuItem::with_id(app, "browser", "Open in Browser", true, None::<&str>)?;
    let pause = CheckMenuItem::with_id(app, "pause", "Pause automation", true, false, None::<&str>)?;
    let drain = CheckMenuItem::with_id(app, "drain", "Drain mode", true, false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Drydock", true, None::<&str>)?;

    let menu = MenuBuilder::new(app)
        .item(&show)
        .item(&browser)
        .separator()
        .item(&pause)
        .item(&drain)
        .separator()
        .item(&quit)
        .build()?;

    let cfg = config.clone();
    let tray = TrayIconBuilder::with_id("drydock")
        .icon(app.default_window_icon().expect("bundled window icon").clone())
        .menu(&menu)
        .show_menu_on_left_click(true)
        .title("⚓ …")
        .tooltip("Drydock")
        .on_menu_event(move |app, event| handle_menu_event(app, event.id().as_ref(), &cfg))
        .build(app)?;

    Ok(TrayHandles { tray, pause, drain })
}

fn handle_menu_event(app: &AppHandle, id: &str, cfg: &DesktopConfig) {
    match id {
        "show" => show_dashboard(app),
        "browser" => {
            let _ = app.opener().open_url(cfg.base_url.clone(), None::<&str>);
        }
        // The native check item toggles its own mark on click, so `is_checked`
        // already reflects the desired state. Send it; the next poll reconciles
        // (and corrects the mark) if the server rejects the request.
        "pause" => {
            if let Some(desired) = checked(app, |h| &h.pause) {
                spawn_toggle(app.clone(), cfg.clone(), Toggle::Pause(desired));
            }
        }
        "drain" => {
            if let Some(desired) = checked(app, |h| &h.drain) {
                spawn_toggle(app.clone(), cfg.clone(), Toggle::Drain(desired));
            }
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

fn show_dashboard(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Read a check item's current mark from managed state.
fn checked(app: &AppHandle, pick: impl Fn(&TrayHandles) -> &CheckMenuItem<Wry>) -> Option<bool> {
    let handles = app.try_state::<TrayHandles>()?;
    pick(&handles).is_checked().ok()
}

/// POST a toggle to the control API, then refresh once so the menu reflects the
/// server even when the request was rejected. Runs on the async runtime.
fn spawn_toggle(app: AppHandle, cfg: DesktopConfig, toggle: Toggle) {
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::new();
        let (url, body) = match toggle {
            Toggle::Pause(value) => (cfg.pause_url(), serde_json::json!({ "paused": value })),
            Toggle::Drain(value) => (cfg.drain_url(), serde_json::json!({ "draining": value })),
        };
        let mut request = client.post(&url).header("x-drydock-control", "1").json(&body);
        if let Some(token) = &cfg.control_token {
            request = request.header("x-drydock-control-token", token.clone());
        }
        let _ = request.send().await;

        let snapshot = health::fetch(&client, &cfg.health_url()).await;
        apply(&app, &snapshot);
    });
}

/// Push a snapshot onto the tray: title, tooltip, and the two toggle marks.
pub fn apply(app: &AppHandle, snapshot: &Snapshot) {
    let Some(handles) = app.try_state::<TrayHandles>() else {
        return;
    };
    let _ = handles.tray.set_title(Some(snapshot.tray_title()));
    let _ = handles.tray.set_tooltip(Some(snapshot.tooltip()));
    let _ = handles.pause.set_checked(snapshot.paused);
    let _ = handles.drain.set_checked(snapshot.draining);
}

/// Poll `/api/health` forever, applying each snapshot to the tray. A single
/// reused client keeps connections warm; failures fold into an `unreachable`
/// snapshot inside {@link health::fetch}, so the loop itself never errors out.
pub async fn poll_loop(app: AppHandle, cfg: DesktopConfig) {
    let client = reqwest::Client::new();
    loop {
        let snapshot = health::fetch(&client, &cfg.health_url()).await;
        apply(&app, &snapshot);
        tokio::time::sleep(cfg.poll_interval).await;
    }
}

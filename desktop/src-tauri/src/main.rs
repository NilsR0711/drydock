// Prevents an extra console window from opening alongside the app on Windows in
// release builds. macOS (the supported target today) is unaffected.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    drydock_desktop_lib::run()
}

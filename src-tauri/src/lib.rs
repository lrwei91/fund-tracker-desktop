mod api;
mod config;
mod windows;

use config::ConfigStore;
use serde_json::{Map, Value};
use tauri::{Manager, RunEvent};

#[tauri::command]
fn config_storage_load(store: tauri::State<ConfigStore>) -> Value {
    store.load()
}

#[tauri::command]
fn config_storage_patch(
    store: tauri::State<ConfigStore>,
    changes: Map<String, Value>,
) -> Result<Value, String> {
    store.patch(changes)
}

#[tauri::command]
fn config_storage_path(store: tauri::State<ConfigStore>) -> String {
    store.path()
}

fn is_allowed_external_url(url: &str) -> bool {
    if matches!(
        url,
        "https://github.com/lrwei91" | "https://github.com/lrwei91/fund-tracker-desktop"
    ) {
        return true;
    }
    url::Url::parse(url).is_ok_and(|parsed| {
        parsed.scheme() == "https"
            && matches!(
                parsed.host_str(),
                Some("disc.static.szse.cn" | "pdf.dfcfw.com")
            )
    })
}

#[tauri::command]
fn open_external_url(url: String) -> Value {
    match is_allowed_external_url(&url) {
        true => match open::that(&url) {
            Ok(_) => serde_json::json!({"ok": true}),
            Err(error) => serde_json::json!({"ok": false, "error": error.to_string()}),
        },
        false => serde_json::json!({"ok": false, "error": "URL not allowed"}),
    }
}

pub fn run() {
    #[cfg(windows)]
    if !windows::ensure_webview2_runtime() {
        return;
    }
    let store = ConfigStore::new(ConfigStore::product_path());
    let builder = tauri::Builder::default();
    #[cfg(windows)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(
        |app, _args, _working_directory| {
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.unminimize();
                let _ = main.show();
                let _ = main.set_focus();
            }
        },
    ));
    let app = builder
        .manage(store)
        .manage(api::ApiState::new())
        .setup(|app| {
            windows::create_auxiliary_windows(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config_storage_load,
            config_storage_patch,
            config_storage_path,
            open_external_url,
            api::diagnostics_snapshot,
            api::diagnostics_clear,
            windows::open_holding_window,
            windows::minimize_holding_window,
            windows::maximize_holding_window,
            windows::close_holding_window,
            windows::holding_widget_sync,
            windows::show_stock_alert,
            api::fetch_data,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Tauri application");

    app.run(|handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. }) {
            if let Some(alert) = handle.get_webview_window("alert") {
                let _ = alert.close();
            }
            if let Some(holding) = handle.get_webview_window("holding") {
                let _ = holding.close();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::is_allowed_external_url;

    #[test]
    fn external_links_use_exact_https_allowlist() {
        assert!(is_allowed_external_url("https://pdf.dfcfw.com/a.pdf"));
        assert!(is_allowed_external_url("https://disc.static.szse.cn/x"));
        assert!(is_allowed_external_url(
            "https://github.com/lrwei91/fund-tracker-desktop"
        ));
        assert!(is_allowed_external_url("https://github.com/lrwei91"));
        assert!(!is_allowed_external_url("https://github.com/lrwei91/other"));
        assert!(!is_allowed_external_url(
            "https://github.com/lrwei91/fund-tracker-desktop/issues"
        ));
        assert!(!is_allowed_external_url(
            "https://github.com/lrwei91/fund-tracker-desktop/"
        ));
        assert!(!is_allowed_external_url("http://pdf.dfcfw.com/a.pdf"));
        assert!(!is_allowed_external_url(
            "https://pdf.dfcfw.com.example.com/a"
        ));
        assert!(!is_allowed_external_url("javascript:alert(1)"));
    }
}

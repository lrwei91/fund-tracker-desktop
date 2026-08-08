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
    let store = ConfigStore::new(ConfigStore::product_path());
    let app = tauri::Builder::default()
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
            windows::open_holding_window,
            windows::minimize_holding_window,
            windows::maximize_holding_window,
            windows::close_holding_window,
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
        assert!(!is_allowed_external_url("http://pdf.dfcfw.com/a.pdf"));
        assert!(!is_allowed_external_url(
            "https://pdf.dfcfw.com.example.com/a"
        ));
        assert!(!is_allowed_external_url("javascript:alert(1)"));
    }
}

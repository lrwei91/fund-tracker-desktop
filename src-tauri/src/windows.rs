use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use tauri::{Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[cfg(windows)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(windows)]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
#[cfg(windows)]
use winreg::{
    enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE},
    RegKey,
};

#[cfg(windows)]
static RESTORE_HOLDING: AtomicBool = AtomicBool::new(false);

const HOLDING_W: f64 = 320.0;
const HOLDING_H: f64 = 58.0;
const ALERT_W: f64 = 420.0;
const ALERT_H: f64 = 116.0;

#[cfg(windows)]
const WEBVIEW2_DOWNLOAD_URL: &str =
    "https://developer.microsoft.com/microsoft-edge/webview2/#download-section";

#[cfg(windows)]
pub fn ensure_webview2_runtime() -> bool {
    if webview2_runtime_available() {
        return true;
    }
    let title: Vec<u16> = "恭喜发财需要 Microsoft Edge WebView2"
        .encode_utf16()
        .chain([0])
        .collect();
    let message: Vec<u16> = format!(
        "未检测到 WebView2 Runtime，无法启动桌面窗口。\n\n请安装后重新启动：\n{WEBVIEW2_DOWNLOAD_URL}"
    )
    .encode_utf16()
    .chain([0])
    .collect();
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            windows_sys::Win32::UI::WindowsAndMessaging::MB_OK
                | windows_sys::Win32::UI::WindowsAndMessaging::MB_ICONERROR,
        );
    }
    let _ = open::that(WEBVIEW2_DOWNLOAD_URL);
    false
}

#[cfg(windows)]
fn webview2_runtime_available() -> bool {
    if std::env::var_os("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER").is_some() {
        return true;
    }
    const CLIENT: &str =
        r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    const WOW_CLIENT: &str =
        r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE]
        .into_iter()
        .any(|root| {
            let key = RegKey::predef(root);
            [CLIENT, WOW_CLIENT].into_iter().any(|path| {
                key.open_subkey(path)
                    .ok()
                    .and_then(|client| client.get_value::<String, _>("pv").ok())
                    .is_some_and(|version| !version.trim().is_empty() && version != "0.0.0.0")
            })
        })
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StockAlert {
    code: Option<String>,
    name: Option<String>,
    price: f64,
    change_pct: f64,
    open_price: Option<f64>,
    base_price: Option<f64>,
    base_label: Option<String>,
    threshold: Option<f64>,
    time: Option<String>,
    opacity: Option<f64>,
    sound_enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HoldingWidgetSync {
    #[serde(default)]
    quotes: HashMap<String, Value>,
    status: Option<String>,
    updated_at: Option<String>,
}

fn sanitize_holding_quote(code: &str, value: Value) -> Option<Value> {
    if !code.chars().all(|ch| ch.is_ascii_digit()) || code.len() != 6 {
        return None;
    }
    let mut object = value.as_object()?.clone();
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("自选股")
        .chars()
        .take(80)
        .collect::<String>();
    let price = object
        .get("price")
        .and_then(Value::as_str)
        .unwrap_or("--")
        .chars()
        .take(24)
        .collect::<String>();
    let price_value = object
        .get("priceValue")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0);
    let change_percent = object
        .get("changePercent")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite());
    let change = object
        .get("change")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite());
    object.clear();
    object.insert("code".into(), Value::String(code.to_string()));
    object.insert("name".into(), Value::String(name));
    object.insert("price".into(), Value::String(price));
    if let Some(value) = price_value {
        object.insert("priceValue".into(), json!(value));
    }
    if let Some(value) = change_percent {
        object.insert("changePercent".into(), json!(value));
    }
    if let Some(value) = change {
        object.insert("change".into(), json!(value));
    }
    Some(Value::Object(object))
}

fn screen_position(
    window: &WebviewWindow,
    width: f64,
    height: f64,
    top: bool,
) -> PhysicalPosition<i32> {
    let monitor = window.primary_monitor().ok().flatten();
    let (x, y) = monitor
        .map(|m| {
            let scale = m.scale_factor();
            let work = m.work_area();
            let pos = work.position;
            let size = work.size;
            let logical_w = size.width as f64 / scale;
            let logical_h = size.height as f64 / scale;
            let lx = pos.x as f64 / scale
                + if top {
                    (logical_w - width) / 2.0
                } else {
                    logical_w - width - 20.0
                };
            let ly = pos.y as f64 / scale + if top { 24.0 } else { logical_h - height - 20.0 };
            ((lx * scale) as i32, (ly * scale) as i32)
        })
        .unwrap_or((20, 20));
    PhysicalPosition::new(x, y)
}

pub fn create_auxiliary_windows(app: &tauri::AppHandle) -> tauri::Result<()> {
    let holding = WebviewWindowBuilder::new(
        app,
        "holding",
        WebviewUrl::App("renderer/holding-widget.html".into()),
    )
    .title("持仓库")
    .inner_size(HOLDING_W, HOLDING_H)
    .min_inner_size(HOLDING_W, HOLDING_H)
    .max_inner_size(HOLDING_W, HOLDING_H)
    .decorations(false)
    .transparent(!cfg!(windows))
    .shadow(cfg!(windows))
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .visible(false)
    .build()?;
    let _ = holding.set_background_color(Some(if cfg!(windows) {
        tauri::webview::Color(255, 255, 255, 255)
    } else {
        tauri::webview::Color(0, 0, 0, 0)
    }));

    let alert = WebviewWindowBuilder::new(
        app,
        "alert",
        WebviewUrl::App("renderer/alert-popup.html".into()),
    )
    .title("自选股涨跌提醒")
    .inner_size(ALERT_W, ALERT_H)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .focused(false)
    .visible(false)
    .build()?;
    alert.set_ignore_cursor_events(true)?;
    create_windows_tray(app)?;
    Ok(())
}

#[cfg(not(windows))]
fn create_windows_tray(_app: &tauri::AppHandle) -> tauri::Result<()> {
    Ok(())
}

#[cfg(windows)]
fn create_windows_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let clear = MenuItem::with_id(app, "clear", "清除数据并退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &clear])?;
    let mut tray = TrayIconBuilder::with_id("main-tray")
        .tooltip("恭喜发财")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => restore_from_tray(app),
            "clear" => {
                if let Err(error) = app.state::<crate::config::ConfigStore>().clear() {
                    eprintln!("failed to clear config: {error}");
                    return;
                }
                if let Err(error) = app.state::<crate::api::ApiState>().clear_diagnostics() {
                    eprintln!("failed to clear diagnostics: {error}");
                }
                for window in app.webview_windows().values() {
                    let _ = window.clear_all_browsing_data();
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                restore_from_tray(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg(windows)]
fn restore_from_tray(app: &tauri::AppHandle) {
    let label = if RESTORE_HOLDING.swap(false, Ordering::Relaxed) {
        "holding"
    } else {
        "main"
    };
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub fn open_holding_window(app: tauri::AppHandle) -> Value {
    #[cfg(windows)]
    RESTORE_HOLDING.store(false, Ordering::Relaxed);
    if let (Some(main), Some(holding)) = (
        app.get_webview_window("main"),
        app.get_webview_window("holding"),
    ) {
        let _ = holding.set_position(screen_position(&main, HOLDING_W, HOLDING_H, false));
        let _ = holding.emit("holding-widget-refresh", ());
        let _ = holding.show();
        if !cfg!(windows) {
            let _ = holding.set_focus();
        }
        let _ = main.hide();
    }
    json!({"ok": true})
}

#[tauri::command]
pub fn minimize_holding_window(app: tauri::AppHandle) -> Value {
    #[cfg(windows)]
    RESTORE_HOLDING.store(true, Ordering::Relaxed);
    if let Some(window) = app.get_webview_window("holding") {
        let _ = window.hide();
    }
    json!({"ok": true})
}

#[tauri::command]
pub fn maximize_holding_window(app: tauri::AppHandle) -> Value {
    #[cfg(windows)]
    RESTORE_HOLDING.store(false, Ordering::Relaxed);
    if let Some(holding) = app.get_webview_window("holding") {
        let _ = holding.hide();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
    json!({"ok": true})
}

#[tauri::command]
pub fn close_holding_window(app: tauri::AppHandle) -> Value {
    #[cfg(windows)]
    RESTORE_HOLDING.store(false, Ordering::Relaxed);
    if let Some(window) = app.get_webview_window("holding") {
        let _ = window.hide();
    }
    json!({"ok": true})
}

#[tauri::command]
pub fn holding_widget_sync(app: tauri::AppHandle, state: HoldingWidgetSync) -> Value {
    let Some(window) = app.get_webview_window("holding") else {
        return json!({"ok": false, "error": "Holding window unavailable"});
    };
    let mut quotes = Map::new();
    for (code, quote) in state.quotes.into_iter().take(50) {
        if let Some(value) = sanitize_holding_quote(&code, quote) {
            quotes.insert(code, value);
        }
    }
    let status = match state.status.as_deref() {
        Some("fresh") | Some("stale") | Some("unavailable") => {
            state.status.unwrap_or_else(|| "unavailable".into())
        }
        _ => "unavailable".into(),
    };
    let updated_at = state
        .updated_at
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339())
        .chars()
        .take(64)
        .collect::<String>();
    let payload = json!({
        "quotes": quotes,
        "status": status,
        "updatedAt": updated_at,
    });
    let count = payload["quotes"].as_object().map_or(0, Map::len);
    let _ = window.emit("holding-widget-state", payload);
    json!({"ok": true, "count": count})
}

#[tauri::command]
pub async fn show_stock_alert(app: tauri::AppHandle, alert: StockAlert) -> Value {
    if !alert.price.is_finite() || alert.price <= 0.0 || !alert.change_pct.is_finite() {
        return json!({"ok": false, "error": "Invalid alert payload"});
    }
    let Some(window) = app.get_webview_window("alert") else {
        return json!({"ok": false, "error": "Alert window unavailable"});
    };
    let payload = json!({
        "code": alert.code.unwrap_or_default().chars().take(32).collect::<String>(),
        "name": alert.name.unwrap_or_else(|| "自选股".into()).chars().take(80).collect::<String>(),
        "price": alert.price, "changePct": alert.change_pct,
        "openPrice": alert.open_price.filter(|n| n.is_finite() && *n > 0.0),
        "basePrice": alert.base_price.filter(|n| n.is_finite() && *n > 0.0),
        "baseLabel": alert.base_label.unwrap_or_else(|| "基准".into()).chars().take(16).collect::<String>(),
        "threshold": alert.threshold.filter(|n| n.is_finite() && *n > 0.0),
        "time": alert.time.unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
        "opacity": alert.opacity.unwrap_or(1.0).clamp(0.2, 1.0),
        "soundEnabled": alert.sound_enabled.unwrap_or(true),
    });
    if let Some(main) = app.get_webview_window("main") {
        let _ = window.set_position(screen_position(&main, ALERT_W, ALERT_H, true));
    }
    let _ = window.emit("stock-alert", payload);
    let _ = window.show();
    let weak = window.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(6)).await;
        let _ = weak.hide();
    });
    json!({"ok": true})
}

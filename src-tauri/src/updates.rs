use crate::config::ConfigStore;
use serde_json::{json, Value};
use std::{sync::Mutex, time::Duration};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};

const KEY: &str = "fund_tracker_update_settings";
const REPOSITORY: &str = "/lrwei91/fund-tracker-desktop/releases/download/";
const MAX_DOWNLOAD: u64 = 128 * 1024 * 1024;

#[derive(Default)]
struct Inner {
    phase: String,
    error: Option<String>,
    checked_at: Option<String>,
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
    received: u64,
    total: Option<u64>,
}

#[derive(Default)]
pub struct Updates(Mutex<Inner>, tokio::sync::Notify);

fn main_only(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("仅主窗口可管理更新".into())
    }
}

fn automatic(store: &ConfigStore) -> bool {
    store
        .data_value(KEY)
        .get("automatic")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn install_supported() -> bool {
    #[cfg(windows)]
    return std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.join("uninstall.exe")))
        .is_some_and(|p| p.is_file());
    #[cfg(not(windows))]
    return cfg!(target_os = "macos");
}

fn allowed_asset(url: &url::Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path().starts_with(REPOSITORY)
        && url.path()[REPOSITORY.len()..].split('/').count() == 2
        && !url.path().contains("%")
}

fn snapshot(app: &AppHandle, inner: &Inner) -> Value {
    json!({
        "currentVersion": app.package_info().version.to_string(),
        "automatic": automatic(&app.state::<ConfigStore>()),
        "enabled": !cfg!(debug_assertions), "canInstall": install_supported(),
        "phase": if inner.phase.is_empty() { "idle" } else { &inner.phase },
        "error": inner.error, "checkedAt": inner.checked_at,
        "received": inner.received, "total": inner.total,
        "version": inner.update.as_ref().map(|u| &u.version),
        "notes": inner.update.as_ref().and_then(|u| u.body.as_deref()).map(|s| s.chars().take(12000).collect::<String>()),
    })
}

fn emit(app: &AppHandle, inner: &Inner) {
    let _ = app.emit_to("main", "app-update-state", snapshot(app, inner));
}

#[tauri::command]
pub fn update_status(window: WebviewWindow, app: AppHandle) -> Result<Value, String> {
    main_only(&window)?;
    let state = app.state::<Updates>();
    let inner = state.0.lock().map_err(|_| "更新状态不可用")?;
    Ok(snapshot(&app, &inner))
}

#[tauri::command]
pub fn update_preferences(
    window: WebviewWindow,
    app: AppHandle,
    automatic: bool,
) -> Result<Value, String> {
    main_only(&window)?;
    app.state::<ConfigStore>()
        .update_data(KEY, |_| Ok(json!({"automatic": automatic})))?;
    app.state::<Updates>().1.notify_one();
    update_status(window, app)
}

async fn check(app: &AppHandle) -> Result<Value, String> {
    let state = app.state::<Updates>();
    {
        let mut inner = state.0.lock().map_err(|_| "更新状态不可用")?;
        if cfg!(debug_assertions) {
            inner.phase = "development".into();
            emit(app, &inner);
            return Ok(snapshot(app, &inner));
        }
        if matches!(
            inner.phase.as_str(),
            "checking" | "downloading" | "downloaded" | "installing"
        ) {
            return Ok(snapshot(app, &inner));
        }
        inner.phase = "checking".into();
        inner.error = None;
        inner.update = None;
        inner.bytes = None;
        emit(app, &inner);
    }
    let result = async {
        let updater = app
            .updater_builder()
            .timeout(Duration::from_secs(180))
            .version_comparator(|current, release| {
                release.version.pre.is_empty() && release.version > current
            })
            .configure_client(|client| client.redirect(reqwest_updater_redirect()))
            .build()
            .map_err(|e| e.to_string())?;
        let update = updater.check().await.map_err(|e| e.to_string())?;
        if update
            .as_ref()
            .is_some_and(|u| !allowed_asset(&u.download_url))
        {
            return Err("更新包来源不属于本项目的 GitHub Release".into());
        }
        Ok::<_, String>(update)
    }
    .await;
    let mut inner = state.0.lock().map_err(|_| "更新状态不可用")?;
    inner.checked_at = Some(chrono::Utc::now().to_rfc3339());
    match result {
        Ok(update) => {
            inner.phase = if update.is_some() {
                "available"
            } else {
                "latest"
            }
            .into();
            inner.update = update;
        }
        Err(_) => {
            inner.phase = "error".into();
            inner.error =
                Some("检查失败：GitHub 不可达，或该版本尚未发布完整更新文件。请稍后重试。".into());
        }
    }
    emit(app, &inner);
    Ok(snapshot(app, &inner))
}

fn reqwest_updater_redirect() -> reqwest_updater::redirect::Policy {
    reqwest_updater::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            return attempt.error("更新重定向次数过多");
        }
        if attempt.url().scheme() == "https"
            && matches!(
                attempt.url().host_str(),
                Some(
                    "github.com"
                        | "release-assets.githubusercontent.com"
                        | "objects.githubusercontent.com"
                )
            )
        {
            attempt.follow()
        } else {
            attempt.error("更新重定向来源不允许")
        }
    })
}

#[tauri::command]
pub async fn update_check(window: WebviewWindow, app: AppHandle) -> Result<Value, String> {
    main_only(&window)?;
    check(&app).await
}

#[tauri::command]
pub async fn update_download(window: WebviewWindow, app: AppHandle) -> Result<Value, String> {
    main_only(&window)?;
    if cfg!(debug_assertions) || !install_supported() {
        return Err("自动安装仅在 macOS 应用或 Windows 安装版启用".into());
    }
    let state = app.state::<Updates>();
    let update = {
        let mut inner = state.0.lock().map_err(|_| "更新状态不可用")?;
        if !matches!(inner.phase.as_str(), "available" | "error") {
            return Err("请先检查可用更新".into());
        }
        let update = inner.update.clone().ok_or("没有可下载的更新")?;
        inner.phase = "downloading".into();
        inner.error = None;
        inner.received = 0;
        inner.total = None;
        emit(&app, &inner);
        update
    };
    let (limit_tx, limit_rx) = tokio::sync::oneshot::channel();
    let mut limit_tx = Some(limit_tx);
    let mut notified = 0;
    let result = tokio::select! {
        _ = limit_rx => Err("更新包超过体积限制".to_string()),
        result = update.download(|chunk, total| {
            if let Ok(mut inner) = state.0.lock() {
                inner.received += chunk as u64; inner.total = total;
                if inner.received > MAX_DOWNLOAD || total.is_some_and(|n| n > MAX_DOWNLOAD) {
                    if let Some(tx) = limit_tx.take() { let _ = tx.send(()); }
                }
                if inner.received.saturating_sub(notified) >= 128 * 1024 {
                    notified = inner.received; emit(&app, &inner);
                }
            }
        }, || {}) => result.map_err(|_| "下载或签名校验失败，原版本未改变；可以重试。".to_string()),
    };
    let mut inner = state.0.lock().map_err(|_| "更新状态不可用")?;
    match result {
        Ok(bytes) if bytes.len() as u64 <= MAX_DOWNLOAD => {
            inner.bytes = Some(bytes);
            inner.phase = "downloaded".into();
        }
        Ok(_) => {
            inner.phase = "error".into();
            inner.error = Some("更新包超过体积限制".into());
        }
        Err(error) => {
            inner.phase = "error".into();
            inner.error = Some(error);
        }
    }
    emit(&app, &inner);
    Ok(snapshot(&app, &inner))
}

#[tauri::command]
pub fn update_install(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    main_only(&window)?;
    if cfg!(debug_assertions) || !install_supported() {
        return Err("当前运行方式不支持自动安装".into());
    }
    let state = app.state::<Updates>();
    let (update, bytes) = {
        let mut inner = state.0.lock().map_err(|_| "更新状态不可用")?;
        if inner.phase != "downloaded" {
            return Err("请先完成更新下载与签名校验".into());
        }
        let update = inner.update.clone().ok_or("更新信息不可用")?;
        let bytes = inner.bytes.take().ok_or("更新包不可用")?;
        inner.phase = "installing".into();
        emit(&app, &inner);
        (update, bytes)
    };
    if update.install(&bytes).is_err() {
        let mut inner = state.0.lock().map_err(|_| "更新状态不可用")?;
        inner.bytes = Some(bytes);
        inner.phase = "downloaded".into();
        inner.error = Some("安装失败，请检查应用目录权限后重试；配置未被覆盖。".into());
        emit(&app, &inner);
        return Err(inner.error.clone().unwrap_or_default());
    }
    app.restart();
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut delay = 30;
        loop {
            let state = app.state::<Updates>();
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(delay)) => {},
                _ = state.1.notified() => { delay = 30; continue; },
            }
            if automatic(&app.state::<ConfigStore>()) && !cfg!(debug_assertions) {
                let _ = check(&app).await;
            }
            delay = 86400;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    #[test]
    fn updater_signed_artifact_smoke() {
        let Ok(directory) = std::env::var("UPDATER_ARTIFACT_DIR") else {
            return;
        };
        let directory = std::path::PathBuf::from(directory);
        let directory = if directory.is_absolute() {
            directory
        } else {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join(directory)
        };
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let public = base64::engine::general_purpose::STANDARD
            .decode(config["plugins"]["updater"]["pubkey"].as_str().unwrap())
            .unwrap();
        let public =
            minisign_verify::PublicKey::decode(std::str::from_utf8(&public).unwrap()).unwrap();
        let mut checked = 0;
        for entry in std::fs::read_dir(&directory).unwrap() {
            let entry = entry.unwrap();
            if !entry.file_name().to_string_lossy().ends_with(".part.json") {
                continue;
            }
            let part: Value =
                serde_json::from_str(&std::fs::read_to_string(entry.path()).unwrap()).unwrap();
            let signature = base64::engine::general_purpose::STANDARD
                .decode(part["signature"].as_str().unwrap())
                .unwrap();
            let signature =
                minisign_verify::Signature::decode(std::str::from_utf8(&signature).unwrap())
                    .unwrap();
            let bytes = std::fs::read(
                std::path::Path::new(&directory).join(part["file"].as_str().unwrap()),
            )
            .unwrap();
            public.verify(&bytes, &signature, true).unwrap();
            let mut tampered = bytes.clone();
            tampered[0] ^= 1;
            assert!(public.verify(&tampered, &signature, true).is_err());
            checked += 1;
        }
        assert!(checked > 0, "没有可验证的签名更新包");
        println!("已验证 {checked} 个更新包的真实签名，篡改内容均被拒绝");
    }
    #[test]
    fn only_project_release_assets_are_accepted() {
        assert!(allowed_asset(&url::Url::parse("https://github.com/lrwei91/fund-tracker-desktop/releases/download/v1.2.0/app.tar.gz").unwrap()));
        for url in [
            "http://github.com/lrwei91/fund-tracker-desktop/releases/download/v1/x",
            "https://github.com/other/repo/releases/download/v1/x",
            "https://github.com/lrwei91/fund-tracker-desktop/releases/download/v1/x?token=x",
            "https://github.com/lrwei91/fund-tracker-desktop/releases/download/v1/nested/x",
        ] {
            assert!(!allowed_asset(&url::Url::parse(url).unwrap()));
        }
    }
}

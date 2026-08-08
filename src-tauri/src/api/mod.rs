mod diagnostics;
mod endpoints;
mod handlers;
mod http;
mod kline;
mod market;
mod minute;
mod policy;
mod routes;

use serde_json::Value;
use std::{collections::HashMap, sync::Arc};

pub struct ApiState {
    gateway: Arc<http::Gateway>,
}

impl ApiState {
    pub fn new() -> Self {
        Self {
            gateway: http::Gateway::new(),
        }
    }

    pub fn clear_diagnostics(&self) -> Result<(), String> {
        self.gateway.clear_diagnostics()
    }

    pub fn diagnostics(&self) -> Value {
        diagnostics::redacted_diagnostic_payload(self.gateway.diagnostics().snapshot())
    }
}

#[tauri::command]
pub fn diagnostics_snapshot(state: tauri::State<'_, ApiState>) -> Value {
    state.diagnostics()
}

#[tauri::command]
pub fn diagnostics_clear(state: tauri::State<'_, ApiState>) -> Result<(), String> {
    state.clear_diagnostics()
}

#[tauri::command]
pub async fn fetch_data(
    state: tauri::State<'_, ApiState>,
    path: String,
    query: HashMap<String, String>,
) -> Result<Value, String> {
    let gateway = state.gateway.clone();
    Ok(routes::dispatch(gateway, &path, query).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn live_data_smoke() {
        if std::env::var("RUN_LIVE_DATA").as_deref() != Ok("1") {
            eprintln!("SKIP: set RUN_LIVE_DATA=1 to run live data smoke");
            return;
        }
        let gateway = http::Gateway::new();
        let targets = [
            ("cls-news", [("limit", "3")].as_slice()),
            ("dragon-tiger", [].as_slice()),
            (
                "fund-flow-120d",
                [("codes", "600519"), ("days", "60")].as_slice(),
            ),
            ("market-data", [("type", "index")].as_slice()),
            (
                "stock-risk",
                [("code", "000858"), ("limit", "3")].as_slice(),
            ),
        ];
        for (path, pairs) in targets {
            let query = pairs
                .iter()
                .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
                .collect();
            let result = routes::dispatch(gateway.clone(), path, query).await;
            assert_eq!(result["success"], true, "{path}: {result}");
            eprintln!("OK: {path}");
        }
    }
}

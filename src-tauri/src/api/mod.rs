mod diagnostics;
mod endpoints;
mod handlers;
mod http;
mod kline;
mod market;
mod minute;
mod policy;
mod routes;
mod symbol;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc};

pub struct ApiState {
    gateway: Arc<http::Gateway>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchOptions {
    #[serde(default)]
    pub cache_mode: Option<String>,
    #[serde(default)]
    pub cycle_id: Option<u64>,
}

fn parse_cache_mode(options: Option<&FetchOptions>) -> http::CacheMode {
    match options.and_then(|value| value.cache_mode.as_deref()) {
        Some("bypass_fresh") => http::CacheMode::BypassFresh,
        _ => http::CacheMode::Normal,
    }
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
    options: Option<FetchOptions>,
) -> Result<Value, String> {
    let gateway = state.gateway.clone();
    Ok(routes::dispatch_with_options(
        gateway,
        &path,
        query,
        parse_cache_mode(options.as_ref()),
        options.and_then(|value| value.cycle_id),
    )
    .await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn live_data_smoke() {
        if std::env::var("RUN_LIVE_DATA").as_deref() != Ok("1") {
            eprintln!("SKIP: set RUN_LIVE_DATA=1 to run live data smoke");
            return;
        }
        let gateway = http::Gateway::new();
        let monitor = endpoints::stock_monitor(&gateway)
            .await
            .expect("stock monitor live data");
        assert!(monitor.iter().all(|item| item["code"].is_string()));
        eprintln!("OK: stock-monitor ({})", monitor.len());
        let anomaly = endpoints::price_anomaly(&gateway)
            .await
            .expect("price anomaly live data");
        assert!(anomaly["items"].is_array());
        eprintln!("OK: price-anomaly");
        let targets = [
            ("stock", [("codes", "600519,000858,920982")].as_slice()),
            ("cls-news", [("limit", "3")].as_slice()),
            ("dragon-tiger", [].as_slice()),
            (
                "fund-flow-120d",
                [("codes", "600519"), ("days", "60")].as_slice(),
            ),
            ("market-data", [("type", "index")].as_slice()),
            ("market-data", [("type", "sector")].as_slice()),
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
            if path == "stock" {
                assert!(result["data"]["600519"]["priceValue"].is_number());
                assert!(result["data"]["000858"]["priceValue"].is_number());
                assert!(result["data"]["920982"]["priceValue"].is_number());
                assert_eq!(result["meta"]["missingCodes"], json!([]));
            }
            eprintln!("OK: {path}");
        }
    }
}

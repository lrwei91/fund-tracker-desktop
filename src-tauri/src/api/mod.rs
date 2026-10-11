mod diagnostics;
mod endpoints;
mod handlers;
pub(crate) mod http;
mod intraday;
mod kline;
mod market;
mod minute;
pub(crate) mod policy;
mod routes;
mod symbol;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc};

pub struct ApiState {
    gateway: Arc<http::Gateway>,
    recent_quotes: std::sync::Mutex<HashMap<String, Value>>,
}

pub(crate) use handlers::research::snapshot as research_snapshot;
pub(crate) fn valid_stock_code(code: &str) -> bool {
    symbol::valid_code(code) && !symbol::is_legacy_beijing(code)
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
            recent_quotes: std::sync::Mutex::new(HashMap::new()),
        }
    }

    pub fn clear_diagnostics(&self) -> Result<(), String> {
        self.gateway.clear_diagnostics()
    }

    pub async fn price_alert_quotes(&self, mut codes: Vec<String>) -> Value {
        codes.sort();
        codes.dedup();
        let mut data = serde_json::Map::new();
        if let Ok(cache) = self.recent_quotes.lock() {
            for code in &codes {
                if let Some(quote) = cache.get(code) {
                    let fresh = quote["quoteTimeRaw"]
                        .as_str()
                        .and_then(|s| chrono::NaiveDateTime::parse_from_str(s, "%Y%m%d%H%M%S").ok())
                        .and_then(|dt| dt.and_local_timezone(chrono_tz::Asia::Shanghai).single())
                        .is_some_and(|at| {
                            let age =
                                (chrono::Utc::now() - at.with_timezone(&chrono::Utc)).num_seconds();
                            (0..=30).contains(&age)
                        });
                    if fresh {
                        data.insert(code.clone(), quote.clone());
                    }
                }
            }
        }
        let missing: Vec<_> = codes
            .into_iter()
            .filter(|code| !data.contains_key(code))
            .collect();
        if !missing.is_empty() {
            let result = routes::dispatch(
                self.gateway.clone(),
                "stock",
                HashMap::from([("codes".into(), missing.join(","))]),
            )
            .await;
            if let Some(rows) = result["data"].as_object() {
                data.extend(rows.clone());
            }
        }
        serde_json::json!({"success":!data.is_empty(),"data":data})
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
    window: tauri::WebviewWindow,
    state: tauri::State<'_, ApiState>,
    config: tauri::State<'_, crate::config::ConfigStore>,
    research: tauri::State<'_, crate::research_ai::ResearchAi>,
    path: String,
    query: HashMap<String, String>,
    options: Option<FetchOptions>,
) -> Result<Value, String> {
    let gateway = state.gateway.clone();
    let route = path.trim_start_matches('/');
    if matches!(route, "stock-ai-research" | "price-alerts") {
        if window.label() != "main" {
            return Err("该功能仅允许主窗口调用".into());
        }
        return Ok(if route == "price-alerts" {
            crate::price_alerts::handle(&config, query)
        } else {
            crate::research_ai::handle(gateway.scoped(route), &config, &research, query).await
        });
    }
    let result = routes::dispatch_with_options(
        gateway,
        &path,
        query,
        parse_cache_mode(options.as_ref()),
        options.and_then(|value| value.cycle_id),
    )
    .await;
    if route == "stock" {
        if let (Some(rows), Ok(mut cache)) =
            (result["data"].as_object(), state.recent_quotes.lock())
        {
            cache.extend(
                rows.iter()
                    .map(|(code, quote)| (code.clone(), quote.clone())),
            );
            if cache.len() > 1000 {
                cache.clear();
            }
        }
    }
    Ok(result)
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
        let targets = vec![
            ("stock", vec![("codes", "600519,000858,920982")]),
            ("stock-search", vec![("q", "茅台")]),
            ("hot-rank", vec![("source", "ths"), ("limit", "5")]),
            ("limit-up", vec![("type", "zt"), ("limit", "5")]),
            ("cls-news", vec![("limit", "3")]),
            ("global-news", vec![("limit", "3")]),
            ("news", vec![("limit", "3")]),
            (
                "stock-news",
                vec![("code", "600519"), ("name", "贵州茅台"), ("limit", "3")],
            ),
            ("stock-risk", vec![("code", "000858"), ("limit", "3")]),
            ("dragon-tiger", vec![]),
            ("fund-flow-120d", vec![("codes", "600519"), ("days", "60")]),
            ("market-data", vec![("type", "index")]),
            ("market-data", vec![("type", "capital")]),
            ("market-data", vec![("type", "breadth")]),
            ("market-data", vec![("type", "sector-panorama")]),
            (
                "market-data",
                vec![
                    ("type", "sector"),
                    ("boardType", "industry"),
                    ("period", "today"),
                ],
            ),
            (
                "market-data",
                vec![
                    ("type", "sector"),
                    ("boardType", "concept"),
                    ("period", "5d"),
                ],
            ),
            (
                "market-data",
                vec![
                    ("type", "sector"),
                    ("boardType", "region"),
                    ("period", "10d"),
                ],
            ),
            ("stock-kline", vec![("code", "600519"), ("days", "120")]),
            ("stock-minute", vec![("code", "600519"), ("count", "30")]),
            ("stock-fundamentals", vec![("code", "600519")]),
            ("stock-research", vec![("code", "600519")]),
            ("opportunity-radar", vec![("limit", "3")]),
            ("market-warnings", vec![("codes", "600664,600519")]),
            ("sector-rotation", vec![]),
            ("intraday-screening", vec![]),
        ];
        let mut failures = Vec::new();
        for (path, pairs) in targets {
            let query = pairs
                .iter()
                .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
                .collect();
            let result = routes::dispatch(gateway.clone(), path, query).await;
            if result["success"] != true {
                failures.push(format!("{path}: {result}"));
                eprintln!("FAIL: {path}");
                continue;
            }
            if path == "stock" {
                assert!(result["data"]["600519"]["priceValue"].is_number());
                assert!(result["data"]["000858"]["priceValue"].is_number());
                assert!(result["data"]["920982"]["priceValue"].is_number());
                assert_eq!(result["meta"]["missingCodes"], json!([]));
            }
            let valid = match path {
                "stock-search" => result["data"]
                    .as_array()
                    .is_some_and(|rows| !rows.is_empty()),
                "global-news" => {
                    result["data"]["data"]
                        .as_array()
                        .is_some_and(|rows| rows.len() >= 3)
                        && result["data"]["nextCursor"].is_string()
                }
                "stock-news" => result["data"]["items"]
                    .as_array()
                    .is_some_and(|rows| !rows.is_empty()),
                "stock-risk" => result["data"]["announcements"]["available"] == true,
                "stock-fundamentals" => {
                    result["data"]["available"] == true
                        && result["data"]["periods"][0]["disclosedAt"].is_string()
                }
                "stock-research" => {
                    result["data"]["quant"]["score"].is_number()
                        && result["data"]["quote"]["priceValue"].is_number()
                }
                "fund-flow-120d" => result["data"]["items"][0]["available"] == true,
                "stock-kline" => result["data"]["bars"]
                    .as_array()
                    .is_some_and(|rows| !rows.is_empty()),
                "opportunity-radar" => result["data"]["items"]
                    .as_array()
                    .is_some_and(|rows| !rows.is_empty()),
                "market-warnings" => result["data"].is_object(),
                "sector-rotation" => {
                    let today = chrono::Utc::now()
                        .with_timezone(&chrono::FixedOffset::east_opt(8 * 60 * 60).unwrap())
                        .format("%Y-%m-%d")
                        .to_string();
                    result["data"]["snapshotDate"]
                        .as_str()
                        .is_some_and(|date| date < today.as_str())
                        && result["data"]["sectors"]
                            .as_array()
                            .is_some_and(|rows| !rows.is_empty())
                }
                "intraday-screening" => matches!(
                    result["data"]["status"].as_str(),
                    Some("ready" | "not_ready")
                ),
                "market-data" if pairs.iter().any(|pair| pair == &("type", "capital")) => {
                    result["data"]["mainFund"]["available"] == true
                }
                "market-data" if pairs.iter().any(|pair| pair == &("type", "breadth")) => {
                    result["data"]["available"] == true
                        && result["data"]["up"].as_u64().is_some()
                        && result["data"]["down"].as_u64().is_some()
                        && result["data"]["flat"].as_u64().is_some()
                        && result["data"]["covered"]
                            .as_u64()
                            .is_some_and(|count| count > 0)
                }
                "market-data"
                    if pairs
                        .iter()
                        .any(|pair| pair == &("type", "sector-panorama")) =>
                {
                    result["data"]["available"] == true
                        && result["data"]["items"]
                            .as_array()
                            .is_some_and(|rows| rows.len() == 25)
                        && result["data"]["items"]
                            .as_array()
                            .is_some_and(|rows| rows.iter().any(|row| row["changePct"].is_number()))
                }
                "market-data" if pairs.iter().any(|pair| pair == &("type", "sector")) => {
                    result["data"]["inflow"]
                        .as_array()
                        .is_some_and(|rows| !rows.is_empty())
                        || result["data"]["outflow"]
                            .as_array()
                            .is_some_and(|rows| !rows.is_empty())
                }
                _ => true,
            };
            if !valid {
                failures.push(format!(
                    "{path}: success response has incomplete data: {result}"
                ));
                eprintln!("FAIL: {path} incomplete data");
                continue;
            }
            eprintln!("OK: {path}");
        }
        assert!(
            failures.is_empty(),
            "{} live data checks failed:\n{}",
            failures.len(),
            failures.join("\n")
        );
    }
}

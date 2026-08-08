use super::{endpoints::Query, handlers, http::Gateway, policy};
use serde_json::Value;
use std::sync::Arc;

pub async fn dispatch(gateway: Arc<Gateway>, path: &str, query: Query) -> Value {
    let route = path.trim_start_matches('/');
    let scoped = gateway.scoped(route);
    let endpoint_policy = policy::endpoint_policy(route);
    let cache_key = Gateway::endpoint_key(route, &query);
    let result = handlers::dispatch_raw(scoped.clone(), route, query).await;

    if result.get("success") == Some(&Value::Bool(true)) {
        scoped.remember_endpoint(cache_key, result.clone(), endpoint_policy.stale_for());
        return result;
    }
    let status = result
        .get("status")
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok());
    let error_code = result.get("errorCode").and_then(Value::as_str);
    scoped.record_marker("gateway", "error", "miss", status, error_code, 0);
    if endpoint_policy.allows_stale() {
        if let Some((mut stale, age_seconds, fetched_at)) = scoped.stale_endpoint(&cache_key) {
            policy::add_stale_meta(&mut stale, age_seconds, &fetched_at);
            scoped.record_marker("endpoint-cache", "stale", "stale", None, None, 0);
            return stale;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    const ROUTES: &[&str] = &[
        "stock",
        "stock-search",
        "hot-rank",
        "limit-up",
        "cls-news",
        "global-news",
        "news",
        "stock-news",
        "stock-risk",
        "dragon-tiger",
        "fund-flow-120d",
        "market-data",
        "stock-kline",
        "stock-minute",
        "opportunity-radar",
    ];

    fn cache_key(path: &str, query: &HashMap<String, String>) -> String {
        Gateway::endpoint_key(path, query)
    }

    #[test]
    fn cache_key_is_stable_for_query_order() {
        let first = HashMap::from([
            ("code".to_string(), "600000".to_string()),
            ("limit".to_string(), "8".to_string()),
        ]);
        let second = HashMap::from([
            ("limit".to_string(), "8".to_string()),
            ("code".to_string(), "600000".to_string()),
        ]);
        assert_eq!(
            cache_key("/stock-risk", &first),
            cache_key("stock-risk", &second)
        );
        assert_eq!(
            json!("stock-risk?code=600000&limit=8"),
            cache_key("stock-risk", &first)
        );
    }

    #[test]
    fn fixed_route_fixtures_cover_the_public_contract() {
        let fixtures: serde_json::Map<String, Value> =
            serde_json::from_str(include_str!("../../fixtures/routes.json"))
                .expect("route fixtures JSON");
        for route in ROUTES {
            let fixture = fixtures.get(*route).expect("fixture route");
            assert_eq!(fixture["success"], true, "{route}");
            assert!(fixture.get("data").is_some(), "{route} data");
            assert!(fixture.get("meta").is_some(), "{route} meta");
            assert!(fixture["meta"].get("stale").is_some(), "{route} stale");
        }
        assert_eq!(fixtures.len(), ROUTES.len());
    }
}

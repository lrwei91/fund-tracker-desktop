use serde_json::{json, Value};
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndpointPolicy {
    Live,
    Informational { stale_for: Duration },
    Derived { stale_for: Duration },
}

impl EndpointPolicy {
    pub fn allows_stale(self) -> bool {
        !matches!(self, Self::Live)
    }

    pub fn stale_for(self) -> Duration {
        match self {
            Self::Live => Duration::ZERO,
            Self::Informational { stale_for } | Self::Derived { stale_for } => stale_for,
        }
    }
}

pub fn endpoint_policy(path: &str) -> EndpointPolicy {
    match path.trim_start_matches('/') {
        "stock"
        | "market-data"
        | "stock-minute"
        | "intraday-screening"
        | "fund-board-trends"
        | "fund-board-realtime" => EndpointPolicy::Live,
        "sector-rotation" => EndpointPolicy::Informational {
            stale_for: Duration::from_secs(30 * 60),
        },
        "opportunity-radar" => EndpointPolicy::Derived {
            stale_for: Duration::from_secs(10 * 60),
        },
        "stock-search" | "fund-search" | "fund-quotes" | "fund-board" | "fund-diagnosis"
        | "hot-rank" | "limit-up" | "cls-news" | "global-news" | "news" | "stock-news"
        | "stock-risk" | "dragon-tiger" | "fund-flow-120d" | "stock-kline" | "market-warnings" => {
            EndpointPolicy::Informational {
                stale_for: Duration::from_secs(30 * 60),
            }
        }
        _ => EndpointPolicy::Live,
    }
}

pub fn error_code(message: &str, status: Option<u16>) -> (&'static str, bool) {
    let parsed_status = status.or_else(|| {
        message
            .strip_prefix("HTTP ")
            .and_then(|value| value.split_whitespace().next())
            .and_then(|value| value.parse::<u16>().ok())
    });
    if let Some(status) = parsed_status {
        return match status {
            403 => ("forbidden", true),
            429 => ("rate_limited", true),
            500..=599 => ("upstream_5xx", true),
            400..=499 => ("upstream_4xx", false),
            _ => ("upstream_error", true),
        };
    }
    let lower = message.to_ascii_lowercase();
    if lower.contains("timeout") || message.contains("超时") {
        return ("timeout", true);
    }
    if message.contains("熔断") || lower.contains("circuit") {
        return ("circuit_open", true);
    }
    if message.contains("为空") || lower.contains("empty") {
        return ("empty_data", true);
    }
    if lower.contains("json")
        || lower.contains("eof")
        || lower.contains("expected value")
        || lower.contains("at line")
        || message.contains("解析")
        || message.contains("乱码")
    {
        return ("parse_error", true);
    }
    if message.contains("缺少") || message.contains("无效") || message.contains("非法") {
        return ("invalid_input", false);
    }
    ("upstream_error", true)
}

pub fn failure(message: &str, error: &str, status: Option<u16>) -> Value {
    let classification = if error.trim().is_empty() {
        message
    } else {
        error
    };
    let (code, retryable) = error_code(classification, status);
    let mut value = json!({
        "success": false,
        "message": message,
        "error": error,
        "errorCode": code,
        "retryable": retryable,
        "meta": {"degraded": false, "stale": false}
    });
    if let Some(status) = status {
        value["status"] = json!(status);
    }
    value
}

pub fn finalize_response(value: &mut Value, trace_id: &str) {
    let success = value.get("success") == Some(&Value::Bool(true));
    let object = match value.as_object_mut() {
        Some(object) => object,
        None => return,
    };
    object.insert("traceId".into(), Value::String(trace_id.to_string()));
    let meta = object.entry("meta").or_insert_with(|| json!({}));
    if !meta.is_object() {
        *meta = json!({});
    }
    if let Some(meta) = meta.as_object_mut() {
        meta.entry("available").or_insert(Value::Bool(success));
        meta.entry("degraded").or_insert(Value::Bool(false));
        meta.entry("stale").or_insert(Value::Bool(false));
        if !meta.contains_key("actualSource") {
            let actual = meta
                .get("sources")
                .and_then(Value::as_object)
                .and_then(|sources| {
                    sources.values().find_map(|source| {
                        source
                            .get("actual")
                            .or_else(|| source.get("actualLabel"))
                            .cloned()
                    })
                })
                .unwrap_or(Value::Null);
            meta.insert("actualSource".into(), actual);
        }
    }
    if success {
        object.entry("errorCode").or_insert(Value::Null);
        object.entry("retryable").or_insert(Value::Bool(false));
        return;
    }
    let status = object
        .get("status")
        .and_then(Value::as_u64)
        .and_then(|v| u16::try_from(v).ok());
    let source = object
        .get("error")
        .and_then(Value::as_str)
        .or_else(|| object.get("message").and_then(Value::as_str))
        .unwrap_or("");
    let (code, retryable) = error_code(source, status);
    let message = match code {
        "timeout" => "上游响应超时，请稍后重试",
        "rate_limited" => "上游请求繁忙，请稍后重试",
        "circuit_open" => "上游暂时不可用，正在等待恢复",
        "invalid_input" => "请求参数无效",
        "empty_data" => "上游暂未返回可用数据",
        "parse_error" => "上游数据格式暂不可用",
        _ => "上游服务暂不可用",
    };
    object.insert("message".into(), Value::String(message.into()));
    object.insert("error".into(), Value::String(code.into()));
    object.insert("errorCode".into(), Value::String(code.into()));
    object.insert("retryable".into(), Value::Bool(retryable));
}

pub fn add_stale_meta(value: &mut Value, age_seconds: u64, fetched_at: &str) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    let meta = object
        .entry("meta".to_string())
        .or_insert_with(|| json!({}));
    if !meta.is_object() {
        *meta = json!({});
    }
    if let Some(meta_object) = meta.as_object_mut() {
        meta_object.insert("stale".into(), Value::Bool(true));
        meta_object.insert("staleAgeSeconds".into(), json!(age_seconds));
        meta_object.insert("updatedAt".into(), Value::String(fetched_at.to_string()));
        meta_object
            .entry("fallbackReason")
            .or_insert_with(|| Value::String("endpoint-cache-stale".into()));
        meta_object.entry("degraded").or_insert(Value::Bool(true));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_endpoints_never_allow_stale() {
        assert!(!endpoint_policy("stock").allows_stale());
        assert!(!endpoint_policy("market-data").allows_stale());
        assert!(!endpoint_policy("stock-minute").allows_stale());
        assert!(!endpoint_policy("intraday-screening").allows_stale());
    }

    #[test]
    fn informational_failure_has_stable_error_fields() {
        let response = failure("接口不可用", "HTTP 429", Some(429));
        assert_eq!(response["errorCode"], "rate_limited");
        assert_eq!(response["retryable"], true);
        assert_eq!(response["meta"]["stale"], false);
    }

    #[test]
    fn final_response_redacts_internal_error_and_adds_contract() {
        let mut response = failure(
            "失败",
            "error sending request for url https://host/path?token=secret",
            None,
        );
        finalize_response(&mut response, "trace-1");
        assert_eq!(response["traceId"], "trace-1");
        assert_eq!(response["meta"]["available"], false);
        assert_eq!(response["error"], "upstream_error");
        assert!(!response.to_string().contains("secret"));
    }

    #[test]
    fn stale_meta_is_additive() {
        let mut response = json!({"success": true, "data": []});
        add_stale_meta(&mut response, 31, "2026-08-09T00:00:00Z");
        assert_eq!(response["meta"]["stale"], true);
        assert_eq!(response["meta"]["staleAgeSeconds"], 31);
        assert_eq!(response["meta"]["updatedAt"], "2026-08-09T00:00:00Z");
    }
}

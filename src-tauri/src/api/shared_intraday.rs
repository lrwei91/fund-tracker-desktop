use super::{
    endpoints::Query,
    http::{ApiError, Gateway, RequestSpec},
    policy,
};
use crate::config::ConfigStore;
use reqwest::Method;
use serde_json::{json, Value};
use std::{collections::HashSet, sync::Arc};

const MAX_CODES: usize = 30;

fn service_base_url() -> Option<String> {
    std::env::var("FUND_INTRADAY_SERVICE_URL")
        .ok()
        .or_else(|| option_env!("FUND_INTRADAY_SERVICE_URL").map(str::to_owned))
        .map(|value| value.trim_end_matches('/').to_string())
        .filter(|value| {
            url::Url::parse(value).is_ok_and(|parsed| {
                parsed.scheme() == "https"
                    || (parsed.scheme() == "http"
                        && matches!(parsed.host_str(), Some("127.0.0.1" | "localhost")))
            })
        })
}

fn sanitize_codes(value: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    value
        .split(',')
        .map(str::trim)
        .filter(|code| code.len() == 6 && code.bytes().all(|byte| byte.is_ascii_digit()))
        .filter(|code| seen.insert((*code).to_string()))
        .take(MAX_CODES)
        .map(str::to_owned)
        .collect()
}

fn failure(message: &str, error: &ApiError) -> Value {
    policy::failure(message, &error.message, error.status)
}

async fn ensure_token(
    gateway: &Arc<Gateway>,
    config: &ConfigStore,
    base_url: &str,
    service_host: &str,
) -> Result<String, Value> {
    if let Some(token) = config.private_collector_token() {
        return Ok(token);
    }
    let payload = gateway
        .json(
            RequestSpec::get(format!("{base_url}/v1/installations"))
                .body("{}".to_string())
                .header("content-type", "application/json")
                .allow_host(service_host)
                .cache(0),
        )
        .await
        .map_err(|error| failure("共享采集服务注册失败", &error))?;
    let token = payload
        .get("data")
        .and_then(|data| data.get("token"))
        .and_then(Value::as_str)
        .filter(|value| value.len() >= 32)
        .ok_or_else(|| policy::failure("共享采集服务注册失败", "安装令牌字段无效", None))?
        .to_string();
    config
        .set_private_collector_token(&token)
        .map_err(|error| policy::failure("共享采集服务注册失败", &error, None))?;
    Ok(token)
}

pub async fn fetch(gateway: Arc<Gateway>, config: &ConfigStore, query: Query) -> Value {
    let Some(base_url) = service_base_url() else {
        return policy::failure(
            "共享盘中估值服务未配置",
            "构建时缺少 FUND_INTRADAY_SERVICE_URL",
            None,
        );
    };
    let service_host = url::Url::parse(&base_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_default();
    let raw_codes = query.get("codes").map(String::as_str).unwrap_or_default();
    let codes = sanitize_codes(raw_codes);
    if raw_codes
        .split(',')
        .filter(|code| !code.trim().is_empty())
        .count()
        > MAX_CODES
    {
        return policy::failure("自选基金数量超过上限", "单次最多登记 30 只基金", None);
    }
    let token = match ensure_token(&gateway, config, &base_url, &service_host).await {
        Ok(token) => token,
        Err(error) => return error,
    };
    let authorization = format!("Bearer {token}");
    let subscription = match gateway
        .json(
            RequestSpec::get(format!("{base_url}/v1/subscriptions"))
                .body(json!({"codes": codes}).to_string())
                .method(Method::PUT)
                .header("authorization", authorization.clone())
                .header("content-type", "application/json")
                .allow_host(&service_host)
                .cache(0),
        )
        .await
    {
        Ok(value) if value.get("success") != Some(&Value::Bool(false)) => value,
        Ok(_) => return policy::failure("共享采集订阅同步失败", "服务返回失败状态", None),
        Err(error) => {
            if error.status == Some(401) {
                let _ = config.clear_private_collector_token();
            }
            return failure("共享采集订阅同步失败", &error);
        }
    };
    if codes.is_empty() {
        return json!({
            "success": true,
            "data": {},
            "meta": {
                "subscription": subscription.get("data").cloned().unwrap_or(Value::Null),
                "source": "DeepQ 盘中估值 · 共享采集",
                "degraded": false,
                "stale": false
            }
        });
    }
    let date = query.get("date").map(String::as_str).unwrap_or_default();
    let mut url = match url::Url::parse(&format!("{base_url}/v1/funds/intraday")) {
        Ok(url) => url,
        Err(error) => return policy::failure("共享盘中估值服务地址无效", &error.to_string(), None),
    };
    url.query_pairs_mut().append_pair("codes", &codes.join(","));
    if !date.is_empty() {
        url.query_pairs_mut().append_pair("date", date);
    }
    match gateway
        .json(
            RequestSpec::get(url.to_string())
                .header("authorization", authorization)
                .allow_host(&service_host)
                .cache(30),
        )
        .await
    {
        Ok(mut value) if value.get("success") != Some(&Value::Bool(false)) => {
            if !value.get("meta").is_some_and(Value::is_object) {
                value["meta"] = json!({});
            }
            value["meta"]["subscription"] =
                subscription.get("data").cloned().unwrap_or(Value::Null);
            value["meta"]["degraded"] = json!(false);
            value["meta"]["stale"] = json!(false);
            value
        }
        Ok(_) => policy::failure("共享盘中估值加载失败", "服务返回失败状态", None),
        Err(error) => {
            if error.status == Some(401) {
                let _ = config.clear_private_collector_token();
            }
            failure("共享盘中估值加载失败", &error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_validated_deduplicated_and_limited() {
        let raw = std::iter::once("bad".to_string())
            .chain((0..40).map(|index| format!("{index:06}")))
            .chain(std::iter::once("000001".to_string()))
            .collect::<Vec<_>>()
            .join(",");
        let codes = sanitize_codes(&raw);
        assert_eq!(codes.len(), 30);
        assert_eq!(codes[0], "000000");
    }
}

use super::super::{
    endpoints::Query,
    http::{ApiError, Gateway, RequestSpec},
    policy,
};
use chrono::NaiveDate;
use serde_json::{json, Map, Value};
use std::{collections::HashSet, sync::Arc};

const MAX_FUND_CODES: usize = 30;

fn query_value<'a>(query: &'a Query, key: &str) -> &'a str {
    query.get(key).map(String::as_str).unwrap_or("")
}

fn is_fund_code(value: &str) -> bool {
    value.len() == 6 && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn sanitize_codes(value: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    value
        .split(',')
        .map(str::trim)
        .filter(|code| is_fund_code(code))
        .filter(|code| seen.insert((*code).to_string()))
        .take(MAX_FUND_CODES)
        .map(str::to_owned)
        .collect()
}

fn fail(message: &str, error: impl ToString) -> Value {
    policy::failure(message, &error.to_string(), None)
}

fn fail_api(message: &str, error: &ApiError) -> Value {
    let mut value = policy::failure(message, &error.message, error.status);
    if let Some(meta) = value.get_mut("meta").and_then(Value::as_object_mut) {
        meta.insert(
            "sourceError".into(),
            json!({"status": error.status, "code": error.error_code().0}),
        );
    }
    value
}

fn value_as_string(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_default()
}

fn value_as_number(value: Option<&Value>) -> Option<f64> {
    value.and_then(|item| {
        item.as_f64()
            .or_else(|| item.as_str().and_then(|raw| raw.parse::<f64>().ok()))
    })
}

fn parse_search_payload(payload: &Value) -> Vec<Value> {
    payload
        .get("Datas")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let code = row.get("CODE").and_then(Value::as_str)?;
            let name = row.get("NAME").and_then(Value::as_str)?;
            let category = row
                .get("CATEGORYDESC")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !is_fund_code(code) || category != "基金" || name.trim().is_empty() {
                return None;
            }
            let info = row.get("FundBaseInfo").unwrap_or(&Value::Null);
            Some(json!({
                "code": code,
                "name": name,
                "type": value_as_string(info.get("FTYPE")),
                "company": value_as_string(info.get("JJGS")),
                "nav": value_as_number(info.get("DWJZ")),
                "navDate": value_as_string(info.get("FSRQ")),
            }))
        })
        .take(12)
        .collect()
}

fn parse_optional_number(raw: Option<&&str>) -> Option<f64> {
    raw.map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite())
}

fn parse_sina_fund_quotes(payload: &str, expected: &[String]) -> Map<String, Value> {
    let expected = expected.iter().map(String::as_str).collect::<HashSet<_>>();
    let mut quotes = Map::new();
    for line in payload
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let Some(marker) = line.find("hq_str_f_") else {
            continue;
        };
        let code_start = marker + "hq_str_f_".len();
        let Some(code) = line.get(code_start..code_start + 6) else {
            continue;
        };
        if !expected.contains(code) || !is_fund_code(code) {
            continue;
        }
        let Some(first_quote) = line.find('"') else {
            continue;
        };
        let Some(last_quote) = line.rfind('"') else {
            continue;
        };
        if last_quote <= first_quote + 1 {
            continue;
        }
        let fields = line[first_quote + 1..last_quote]
            .split(',')
            .collect::<Vec<_>>();
        if fields.len() < 5 || fields[0].trim().is_empty() {
            continue;
        }
        let Some(unit_nav) = parse_optional_number(fields.get(1)) else {
            continue;
        };
        let cumulative_nav = parse_optional_number(fields.get(2));
        let previous_nav = parse_optional_number(fields.get(3)).filter(|value| *value > 0.0);
        let nav_date = fields[4].trim();
        if NaiveDate::parse_from_str(nav_date, "%Y-%m-%d").is_err() {
            continue;
        }
        let nav_change = previous_nav.map(|previous| unit_nav - previous);
        let day_change_percent = previous_nav.map(|previous| {
            let value = (unit_nav - previous) / previous * 100.0;
            (value * 100.0).round() / 100.0
        });
        quotes.insert(
            code.to_string(),
            json!({
                "code": code,
                "name": fields[0].trim(),
                "unitNav": unit_nav,
                "cumulativeNav": cumulative_nav,
                "previousNav": previous_nav,
                "navChange": nav_change,
                "dayChangePercent": day_change_percent,
                "navDate": nav_date,
            }),
        );
    }
    quotes
}

pub(crate) async fn search(gateway: Arc<Gateway>, query: Query) -> Value {
    let term = query_value(&query, "q").trim();
    if term.is_empty() {
        return fail("缺少基金搜索关键词", "");
    }
    let url = format!(
        "https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key={}",
        urlencoding::encode(term)
    );
    match gateway.json(RequestSpec::get(url).em().cache(300)).await {
        Ok(payload) => {
            let items = parse_search_payload(&payload);
            json!({
                "success": true,
                "data": items,
                "meta": {
                    "degraded": false,
                    "stale": false,
                    "sources": {"search": {"actual": "eastmoney-fund", "actualLabel": "东方财富基金"}}
                }
            })
        }
        Err(error) => fail_api("基金搜索接口不可用", &error),
    }
}

pub(crate) async fn quotes(gateway: Arc<Gateway>, query: Query) -> Value {
    let codes = sanitize_codes(query_value(&query, "codes"));
    if codes.is_empty() {
        return fail("缺少有效基金代码", "基金代码必须是 6 位数字");
    }
    let symbols = codes
        .iter()
        .map(|code| format!("f_{code}"))
        .collect::<Vec<_>>()
        .join(",");
    let request = RequestSpec::get(format!("https://hq.sinajs.cn/list={symbols}"))
        .header("referer", "https://finance.sina.com.cn/")
        .cache(60);
    match gateway.gbk(request).await {
        Ok(payload) => {
            let data = parse_sina_fund_quotes(&payload, &codes);
            if data.is_empty() {
                return fail("基金行情接口不可用", "基金净值数据为空或字段无效");
            }
            let mut received_codes = data.keys().cloned().collect::<Vec<_>>();
            received_codes.sort();
            let missing_codes = codes
                .iter()
                .filter(|code| !data.contains_key(code.as_str()))
                .cloned()
                .collect::<Vec<_>>();
            let latest_date = data
                .values()
                .filter_map(|item| item.get("navDate").and_then(Value::as_str))
                .max()
                .unwrap_or_default()
                .to_string();
            json!({
                "success": true,
                "data": Value::Object(data),
                "time": latest_date,
                "meta": {
                    "degraded": !missing_codes.is_empty(),
                    "stale": false,
                    "expectedCodes": codes,
                    "receivedCodes": received_codes,
                    "missingCodes": missing_codes,
                    "sources": {"quotes": {"actual": "sina-fund", "actualLabel": "新浪基金行情"}}
                }
            })
        }
        Err(error) => fail_api("基金行情接口不可用", &error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fund_codes_are_validated_deduplicated_and_limited() {
        let mut raw = vec!["110022", "bad", "110022", "000001"]
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        raw.extend((0..40).map(|index| format!("{index:06}")));
        let result = sanitize_codes(&raw.join(","));
        assert_eq!(&result[..2], &["110022", "000001"]);
        assert_eq!(result.len(), MAX_FUND_CODES);
    }

    #[test]
    fn search_parser_only_returns_real_funds() {
        let payload = json!({"Datas": [
            {"CODE":"110022","NAME":"易方达消费行业股票","CATEGORYDESC":"基金","FundBaseInfo":{"FTYPE":"股票型","JJGS":"易方达基金","DWJZ":2.95,"FSRQ":"2026-08-12"}},
            {"CODE":"600519","NAME":"贵州茅台","CATEGORYDESC":"股票"},
            {"CODE":"bad","NAME":"异常基金","CATEGORYDESC":"基金"}
        ]});
        let items = parse_search_payload(&payload);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["code"], "110022");
        assert_eq!(items[0]["type"], "股票型");
        assert_eq!(items[0]["nav"], 2.95);
    }

    #[test]
    fn sina_parser_builds_batch_quotes_and_daily_change() {
        let payload = concat!(
            "var hq_str_f_110022=\"易方达消费行业股票,2.95,2.95,2.953,2026-08-12,36.5105\";\n",
            "var hq_str_f_000001=\"华夏成长混合A,1.354,3.927,1.328,2026-08-12,24.0598\";"
        );
        let codes = vec!["110022".into(), "000001".into()];
        let data = parse_sina_fund_quotes(payload, &codes);
        assert_eq!(data.len(), 2);
        assert_eq!(data["110022"]["dayChangePercent"], -0.1);
        assert_eq!(data["000001"]["dayChangePercent"], 1.96);
    }

    #[test]
    fn sina_parser_keeps_money_fund_without_fake_daily_change() {
        let payload = "var hq_str_f_110006=\"易方达货币A,0.2027,0.88,,2026-08-12,13.8127\";";
        let data = parse_sina_fund_quotes(payload, &["110006".into()]);
        assert_eq!(data["110006"]["unitNav"], 0.2027);
        assert!(data["110006"]["previousNav"].is_null());
        assert!(data["110006"]["dayChangePercent"].is_null());
    }

    #[test]
    fn sina_parser_rejects_unrequested_or_malformed_rows() {
        let payload = concat!(
            "var hq_str_f_110022=\"易方达消费行业股票,not-a-number,2.95,2.953,2026-08-12,36\";\n",
            "var hq_str_f_000001=\"华夏成长混合A,1.354,3.927,1.328,bad-date,24\";\n",
            "var hq_str_f_999999=\"越界基金,1,1,1,2026-08-12,1\";"
        );
        let data = parse_sina_fund_quotes(payload, &["110022".into(), "000001".into()]);
        assert!(data.is_empty());
    }
}

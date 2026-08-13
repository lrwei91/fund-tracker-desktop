use super::super::{
    endpoints::Query,
    http::{ApiError, Gateway, RequestSpec},
    policy,
};
use chrono::NaiveDate;
use serde_json::{json, Map, Value};
use std::{collections::HashSet, sync::Arc};

const MAX_FUND_CODES: usize = 30;
const MAX_BOARD_FUND_CODES: usize = 300;
const MAX_BOARD_SECTORS: usize = 120;
const STAR_BASE_URL: &str = "https://sq.deepq.tech/star/api";

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

fn sanitize_board_codes(value: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    value
        .split(',')
        .map(str::trim)
        .filter(|code| is_fund_code(code))
        .filter(|code| seen.insert((*code).to_string()))
        .take(MAX_BOARD_FUND_CODES)
        .map(str::to_owned)
        .collect()
}

fn sanitize_sectors(value: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    value
        .split(',')
        .map(str::trim)
        .filter(|sector| !sector.is_empty() && sector.chars().count() <= 32)
        .filter(|sector| seen.insert((*sector).to_string()))
        .take(MAX_BOARD_SECTORS)
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

fn parse_csv_row(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(character) = chars.next() {
        match character {
            '"' if quoted && chars.peek() == Some(&'"') => {
                current.push('"');
                chars.next();
            }
            '"' => quoted = !quoted,
            ',' if !quoted => {
                fields.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(character),
        }
    }
    fields.push(current.trim().to_string());
    fields
}

fn parse_board_csv(payload: &str) -> Vec<Value> {
    let mut lines = payload.lines().filter(|line| !line.trim().is_empty());
    let Some(header_line) = lines.next() else {
        return vec![];
    };
    let headers = parse_csv_row(header_line.trim_start_matches('\u{feff}'));
    let expected = [
        "板块",
        "基金名称",
        "基金代码",
        "近1周涨幅",
        "2025年涨幅",
        "今年最大回撤",
        "基金规模",
        "机构持有",
        "基金经理持有",
        "内部人士持有",
        "评分星级",
        "特色标签",
        "赎回手续费",
    ];
    if headers != expected {
        return vec![];
    }
    lines
        .filter_map(|line| {
            let fields = parse_csv_row(line);
            if fields.len() != headers.len() || !is_fund_code(&fields[2]) {
                return None;
            }
            Some(json!({
                "sector": fields[0], "name": fields[1], "code": fields[2], "weekReturn": fields[3],
                "yearReturn": fields[4], "maxDrawdown": fields[5], "scale": fields[6],
                "institutionHolding": fields[7], "managerHolding": fields[8], "internalHolding": fields[9],
                "stars": fields[10], "tags": fields[11], "redemptionFee": fields[12],
            }))
        })
        .collect()
}

pub(crate) async fn board(gateway: Arc<Gateway>, _query: Query) -> Value {
    let data_request = RequestSpec::get(format!("{STAR_BASE_URL}/data"))
        .cache(5 * 60)
        .independent_circuit();
    let etf_request = RequestSpec::get(format!("{STAR_BASE_URL}/etf_info"))
        .cache(30 * 60)
        .independent_circuit();
    let (data_result, etf_result) =
        tokio::join!(gateway.text(data_request), gateway.json(etf_request));
    let payload = match data_result {
        Ok(value) => value,
        Err(error) => return fail_api("基金池数据不可用", &error),
    };
    let funds = parse_board_csv(&payload);
    if funds.is_empty() {
        return fail("基金池数据不可用", "CSV 数据为空或字段已变更");
    }
    let (etf_info, degraded, etf_status) = match etf_result {
        Ok(value) if value.is_object() => (value, false, "ready"),
        _ => (json!({}), true, "unavailable"),
    };
    json!({
        "success": true,
        "data": {"funds": funds, "etfInfo": etf_info},
        "meta": {
            "degraded": degraded, "stale": false,
            "sources": {
                "fundPool": {"actual": "deepq-star", "actualLabel": "DeepQ 基金数据"},
                "sectorEtf": {"actual": "deepq-star", "actualLabel": "DeepQ 基金数据", "status": etf_status}
            }
        }
    })
}

pub(crate) async fn board_trends(gateway: Arc<Gateway>, query: Query) -> Value {
    let sectors = sanitize_sectors(query_value(&query, "sectors"));
    if sectors.is_empty() {
        return fail("缺少有效板块", "板块名称为空或格式无效");
    }
    let encoded = sectors
        .iter()
        .map(|sector| urlencoding::encode(sector).into_owned())
        .collect::<Vec<_>>()
        .join(",");
    let request = RequestSpec::get(format!("{STAR_BASE_URL}/changeRatio/{encoded}"))
        .cache(60)
        .independent_circuit();
    match gateway.json(request).await {
        Ok(data) if data.is_object() => json!({
            "success": true, "data": data,
            "meta": {"degraded": false, "stale": false, "sources": {"sectorTrend": {"actual": "deepq-star", "actualLabel": "DeepQ 板块行情"}}}
        }),
        Ok(_) => fail("DeepQ 板块行情不可用", "返回字段无效"),
        Err(error) => fail_api("DeepQ 板块行情不可用", &error),
    }
}

pub(crate) async fn board_realtime(gateway: Arc<Gateway>, query: Query) -> Value {
    let codes = sanitize_board_codes(query_value(&query, "codes"));
    if codes.is_empty() {
        return fail("缺少有效基金代码", "基金代码必须是 6 位数字");
    }
    let request = RequestSpec::get(format!(
        "{STAR_BASE_URL}/fund_realtime?codes={}",
        codes.join(",")
    ))
    .cache(60)
    .independent_circuit();
    match gateway.json(request).await {
        Ok(data) if data.is_object() => json!({
            "success": true, "data": data,
            "meta": {"degraded": false, "stale": false, "sources": {"fundRealtime": {"actual": "deepq-star", "actualLabel": "DeepQ 基金实时估值"}}}
        }),
        Ok(_) => fail("DeepQ 基金实时估值不可用", "返回字段无效"),
        Err(error) => fail_api("DeepQ 基金实时估值不可用", &error),
    }
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

    #[test]
    fn board_csv_parser_maps_the_published_contract() {
        let payload = "\u{feff}板块,基金名称,基金代码,近1周涨幅,2025年涨幅,今年最大回撤,基金规模,机构持有,基金经理持有,内部人士持有,评分星级,特色标签,赎回手续费\n有色金属,示例基金,017193,1.35%,56.35%,32.15%,65.2亿,3%,0万份,37万份,★★★★★,涨得多、跌得少,7免";
        let data = parse_board_csv(payload);
        assert_eq!(data.len(), 1);
        assert_eq!(data[0]["sector"], "有色金属");
        assert_eq!(data[0]["code"], "017193");
        assert_eq!(data[0]["stars"], "★★★★★");
    }

    #[test]
    fn board_csv_parser_handles_quoted_commas() {
        let fields = parse_csv_row("板块,\"带,逗号的基金\",017193");
        assert_eq!(fields, ["板块", "带,逗号的基金", "017193"]);
    }

    #[test]
    fn board_inputs_are_validated_deduplicated_and_bounded() {
        assert_eq!(
            sanitize_board_codes("017193,bad,017193,015596"),
            ["017193", "015596"]
        );
        assert_eq!(
            sanitize_sectors("有色金属,,有色金属,半导体"),
            ["有色金属", "半导体"]
        );
    }
}

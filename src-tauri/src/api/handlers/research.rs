use super::super::{
    endpoints::{self, Query},
    http::{Gateway, RequestSpec},
    policy, symbol,
};
use chrono::{NaiveDate, Utc};
use serde_json::{json, Value};
use std::sync::Arc;

fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|n| n.is_finite())
}

pub(crate) fn parse_financials(payload: &Value, today: NaiveDate) -> Value {
    let mut rows: Vec<Value> = payload.pointer("/result/data").and_then(Value::as_array).into_iter().flatten()
        .filter(|row| row["NOTICE_DATE"].as_str().and_then(|s| NaiveDate::parse_from_str(s.get(..10)?, "%Y-%m-%d").ok()).is_some_and(|date| date <= today))
        .map(|row| json!({
            "reportDate": row["REPORT_DATE"].as_str().unwrap_or("").chars().take(10).collect::<String>(),
            "disclosedAt": row["NOTICE_DATE"].as_str().unwrap_or("").chars().take(10).collect::<String>(),
            "revenue": number(&row["TOTALOPERATEREVE"]), "netProfit": number(&row["PARENTNETPROFIT"]),
            "revenueGrowth": number(&row["TOTALOPERATEREVETZ"]), "profitGrowth": number(&row["PARENTNETPROFITTZ"]),
            "roe": number(&row["ROEJQ"]), "grossMargin": number(&row["XSMLL"]),
            "debtRatio": number(&row["ZCFZL"]), "cashPerShare": number(&row["MGJYXJJE"]), "eps": number(&row["EPSJB"])
        })).collect();
    rows.sort_by(|a, b| b["reportDate"].as_str().cmp(&a["reportDate"].as_str()));
    json!({"available": !rows.is_empty(), "source": "eastmoney", "sourceLabel": "东方财富财务指标", "periods": rows})
}

pub(crate) async fn fundamentals(gateway: Arc<Gateway>, query: Query) -> Value {
    let code = query.get("code").map(String::as_str).unwrap_or("");
    if !symbol::valid_code(code) || symbol::is_legacy_beijing(code) {
        return policy::failure("股票代码无效", "请使用当前六位股票代码", None);
    }
    let filter = urlencoding::encode(&format!("(SECURITY_CODE=\"{code}\")")).into_owned();
    let url = format!("https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_F10_FINANCE_MAINFINADATA&columns=SECURITY_CODE,REPORT_DATE,NOTICE_DATE,TOTALOPERATEREVE,PARENTNETPROFIT,TOTALOPERATEREVETZ,PARENTNETPROFITTZ,ROEJQ,XSMLL,ZCFZL,MGJYXJJE,EPSJB&filter={filter}&sortColumns=REPORT_DATE&sortTypes=-1&pageSize=6&pageNumber=1");
    match gateway.json(RequestSpec::get(url).em().cache(3600)).await {
        Ok(payload) => {
            let data = parse_financials(
                &payload,
                Utc::now()
                    .with_timezone(&chrono_tz::Asia::Shanghai)
                    .date_naive(),
            );
            if data["available"] != true {
                return policy::failure("财务指标不可用", "没有已披露的有效财务记录", None);
            }
            json!({"success":true,"data":data,"meta":{"stale":false,"degraded":false}})
        }
        Err(error) => policy::failure("财务指标不可用", "财务数据源请求失败", error.status),
    }
}

// One canonical snapshot supplies both stock research and the AI request.
pub(crate) async fn snapshot(g: Arc<Gateway>, query: Query) -> Value {
    let code = query.get("code").cloned().unwrap_or_default();
    if !symbol::valid_code(&code) || symbol::is_legacy_beijing(&code) {
        return policy::failure("股票代码无效", "请使用当前六位股票代码", None);
    }
    let q = |key: &str, value: &str| Query::from([(key.into(), value.into())]);
    let (quote, kline, flow, news, risk, financial) = tokio::join!(
        endpoints::stock(g.clone(), q("codes", &code)),
        endpoints::stock_kline(g.clone(), q("code", &code)),
        endpoints::fund_flow(g.clone(), q("codes", &code)),
        endpoints::stock_news(g.clone(), q("code", &code)),
        endpoints::stock_risk(g.clone(), q("code", &code)),
        fundamentals(g, q("code", &code))
    );
    let sources = json!({"quote":quote,"technical":kline,"fund":flow,"news":news,"risk":risk,"financial":financial});
    build_snapshot(&code, &sources)
}

pub(crate) fn build_snapshot(code: &str, sources: &Value) -> Value {
    let quote = sources["quote"]["data"]
        .get(code)
        .cloned()
        .unwrap_or(Value::Null);
    let technical = sources["technical"]["data"]["analysis"].clone();
    let financial = sources["financial"]["data"].clone();
    let latest_flow = sources["fund"]["data"]["items"]
        .as_array()
        .and_then(|items| items.iter().find(|item| item["code"] == code))
        .and_then(|item| item["recent"].as_array())
        .and_then(|rows| rows.last())
        .cloned()
        .unwrap_or(Value::Null);
    let available = |key: &str| {
        if sources[key]["success"] != true
            || sources[key].pointer("/meta/stale") == Some(&Value::Bool(true))
        {
            return false;
        }
        match key {
            "quote" => {
                number(&quote["priceValue"]).is_some_and(|n| n > 0.0)
                    && quote["quoteTimeRaw"]
                        .as_str()
                        .and_then(|s| chrono::NaiveDateTime::parse_from_str(s, "%Y%m%d%H%M%S").ok())
                        .is_some()
            }
            "technical" => {
                number(&technical["score"]).is_some()
                    && sources[key]["data"]["bars"]
                        .as_array()
                        .is_some_and(|rows| !rows.is_empty())
            }
            "fund" => number(&latest_flow["mainNet"]).is_some(),
            "news" => sources[key]["data"]["items"]
                .as_array()
                .is_some_and(|rows| !rows.is_empty()),
            "risk" => {
                sources[key]["data"]["announcements"]["available"] == true
                    || sources[key]["data"]["lockup"]["available"] == true
            }
            "financial" => {
                financial["available"] == true
                    && financial["periods"]
                        .as_array()
                        .is_some_and(|rows| !rows.is_empty())
            }
            _ => false,
        }
    };
    let mut factors = vec![];
    if available("technical") {
        if let Some(n) = number(&technical["score"]) {
            factors.push(json!({"label":"技术趋势","score":(50.0+n/2.0).clamp(0.0,100.0),"evidence":"technical"}));
        }
    }
    if available("fund") {
        if let Some(n) = number(&latest_flow["mainNet"]) {
            factors.push(json!({"label":"资金方向","score":if n>0.0 {65.0}else if n<0.0 {35.0}else {50.0},"evidence":"fund"}));
        }
    }
    if available("news") {
        if let Some(n) = number(&sources["news"]["data"]["score"]["score"]) {
            factors.push(json!({"label":"新闻关键词","score":(50.0+n*5.0).clamp(0.0,100.0),"evidence":"news"}));
        }
    }
    if available("financial") {
        if let Some(n) = financial["periods"]
            .as_array()
            .and_then(|p| p.first())
            .and_then(|p| number(&p["profitGrowth"]))
        {
            factors.push(json!({"label":"盈利变化","score":(50.0+n.clamp(-50.0,50.0)).clamp(0.0,100.0),"evidence":"financial"}));
        }
    }
    let missing: Vec<_> = ["quote", "technical", "fund", "news", "risk", "financial"]
        .into_iter()
        .filter(|key| !available(key))
        .collect();
    let name = quote["name"].as_str().unwrap_or(code);
    let special_risk = name.to_uppercase().contains("ST") || name.contains('退');
    let score = if factors.len() >= 3 && available("quote") {
        Some(
            (factors
                .iter()
                .filter_map(|f| number(&f["score"]))
                .sum::<f64>()
                / factors.len() as f64
                - if special_risk { 30.0 } else { 0.0 })
            .clamp(0.0, 100.0)
            .round(),
        )
    } else {
        None
    };
    json!({"success":true,"data":{
        "code":code,"name":name,"generatedAt":Utc::now().to_rfc3339(),"quote":if available("quote"){quote.clone()}else{Value::Null},"technical":if available("technical"){technical.clone()}else{Value::Null},
        "financial":if available("financial"){financial.clone()}else{Value::Null},"fund":if available("fund"){latest_flow.clone()}else{Value::Null},"news":if available("news"){sources["news"]["data"].clone()}else{Value::Null},"risk":if available("risk"){sources["risk"]["data"].clone()}else{Value::Null},
        "quant":{"score":score,"factors":factors,"coverage":((6-missing.len())*100/6),"missingSources":missing,"specialRisk":special_risk,"method":"研究规则 v1 · 技术、资金、新闻关键词、盈利变化等权；非上涨概率"},
        "evidence":sources
    },"meta":{"stale":false,"degraded":!missing.is_empty()}})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn research_live_smoke() {
        if std::env::var("RUN_LIVE_DATA").as_deref() != Ok("1") {
            return;
        }
        let value = snapshot(
            Gateway::new(),
            Query::from([("code".into(), "600519".into())]),
        )
        .await;
        assert_eq!(value["success"], true);
        eprintln!(
            "研究快照：覆盖 {}%，量化分 {}，缺项 {}，行情 {}",
            value["data"]["quant"]["coverage"],
            value["data"]["quant"]["score"],
            value["data"]["quant"]["missingSources"],
            value["data"]["quote"]["quoteTimeRaw"]
        );
        assert!(value["data"]["quote"]["turnover"].is_number());
        assert!(value["data"]["quote"]["volumeRatio"].is_number());
        assert_eq!(value["data"]["financial"]["available"], true);
        assert!(value["data"]["quant"]["score"].is_number());
    }
    #[test]
    fn excludes_unpublished_reports_and_preserves_missing_numbers() {
        let payload = json!({"result":{"data":[{"REPORT_DATE":"2026-06-30","NOTICE_DATE":"2026-08-15","ROEJQ":12},{"REPORT_DATE":"2026-09-30","NOTICE_DATE":"2026-10-30","ROEJQ":20}]}});
        let value = parse_financials(&payload, NaiveDate::from_ymd_opt(2026, 10, 11).unwrap());
        assert_eq!(value["periods"].as_array().unwrap().len(), 1);
        assert!(value["periods"][0]["revenue"].is_null());
    }
    #[test]
    fn missing_sources_do_not_produce_neutral_score() {
        let value = build_snapshot("600519", &json!({}));
        assert!(value["data"]["quant"]["score"].is_null());
        assert_eq!(value["data"]["quant"]["coverage"], 0);
        assert_eq!(value["meta"]["degraded"], true);
    }
    #[test]
    fn successful_empty_sources_do_not_count_as_evidence() {
        let sources = json!({"quote":{"success":true,"data":{"600519":{"priceValue":10}}},"technical":{"success":true,"data":{"analysis":{}}},"news":{"success":true,"data":{"items":[],"score":{"score":0}}},"risk":{"success":true,"data":{"announcements":{"available":false}}}});
        let value = build_snapshot("600519", &sources);
        assert_eq!(value["data"]["quant"]["coverage"], 0);
        assert!(value["data"]["news"].is_null());
    }
}

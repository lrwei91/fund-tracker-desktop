use crate::{api, config::ConfigStore, windows};
use chrono::{DateTime, Datelike, NaiveDateTime, Timelike, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use tauri::{Emitter, Manager};

const KEY: &str = "fund_tracker_price_alerts";
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Condition {
    field: String,
    op: String,
    value: f64,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Rule {
    id: String,
    code: String,
    name: String,
    enabled: bool,
    logic: String,
    conditions: Vec<Condition>,
    cooldown_minutes: u32,
    max_per_day: u32,
    once: bool,
    edge_only: bool,
    expires_at: Option<String>,
    last_matched: Option<bool>,
    last_values: Vec<Option<f64>>,
    last_trigger_at: Option<String>,
    count_date: String,
    count_today: u32,
}
impl Default for Rule {
    fn default() -> Self {
        Self {
            id: String::new(),
            code: String::new(),
            name: String::new(),
            enabled: true,
            logic: "and".into(),
            conditions: vec![],
            cooldown_minutes: 30,
            max_per_day: 3,
            once: false,
            edge_only: true,
            expires_at: None,
            last_matched: None,
            last_values: vec![],
            last_trigger_at: None,
            count_date: String::new(),
            count_today: 0,
        }
    }
}
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
struct Document {
    rules: Vec<Rule>,
    history: Vec<Value>,
    last_checked_at: Option<String>,
    status: String,
}

fn validate(mut rule: Rule) -> Result<Rule, String> {
    if !api::valid_stock_code(&rule.code) {
        return Err("股票代码无效，请使用当前六位股票代码".into());
    }
    if !["and", "or"].contains(&rule.logic.as_str())
        || rule.conditions.is_empty()
        || rule.conditions.len() > 6
    {
        return Err("请设置 1 至 6 个有效条件".into());
    }
    for c in &rule.conditions {
        if !["price", "changePct", "turnover", "volumeRatio"].contains(&c.field.as_str())
            || ![">=", "<=", ">", "<", "crossAbove", "crossBelow"].contains(&c.op.as_str())
            || !c.value.is_finite()
            || (c.field != "changePct" && c.value <= 0.0)
        {
            return Err("提醒条件无效".into());
        }
    }
    if rule.cooldown_minutes > 1440 || rule.max_per_day == 0 || rule.max_per_day > 100 {
        return Err("冷却时间或每日次数无效".into());
    }
    if let Some(expiry) = &rule.expires_at {
        DateTime::parse_from_rfc3339(expiry).map_err(|_| "到期时间必须包含时区")?;
    }
    rule.name = rule.name.chars().take(60).collect();
    if rule.id.is_empty() {
        rule.id = uuid::Uuid::new_v4().to_string();
    }
    if uuid::Uuid::parse_str(&rule.id).is_err() {
        return Err("提醒编号无效".into());
    }
    rule.last_matched = None;
    rule.last_values.clear();
    rule.last_trigger_at = None;
    rule.count_date.clear();
    rule.count_today = 0;
    Ok(rule)
}
fn document(value: Value) -> Result<Document, String> {
    if value.is_null() {
        return Ok(Document::default());
    }
    serde_json::from_value(value).map_err(|_| "提醒数据格式无效，原数据已保留".into())
}
fn active(rule: &Rule, now: DateTime<Utc>) -> bool {
    rule.enabled
        && rule
            .expires_at
            .as_deref()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .is_none_or(|at| now < at.with_timezone(&Utc))
}

pub fn handle(store: &ConfigStore, query: HashMap<String, String>) -> Value {
    let operation = query.get("op").map(String::as_str).unwrap_or("list");
    if operation == "list" {
        return match document(store.data_value(KEY)) {
            Ok(mut doc) => {
                let now = Utc::now();
                if !doc.rules.iter().any(|r| active(r, now)) {
                    doc.status = "idle".into();
                } else if !trading_window(now) {
                    doc.status = "waiting".into();
                }
                json!({"success":true,"data":doc,"meta":{"stale":false,"degraded":false}})
            }
            Err(message) => json!({"success":false,"message":message,"retryable":false}),
        };
    }
    let result = store.update_data(KEY, |value| {
        let mut doc = document(value)?;
        match operation {
            "save" => {
                let raw = query
                    .get("rule")
                    .filter(|s| s.len() < 8000)
                    .ok_or("缺少提醒规则")?;
                let mut rule =
                    validate(serde_json::from_str(raw).map_err(|_| "提醒规则格式无效")?)?;
                let pos = doc.rules.iter().position(|r| r.id == rule.id);
                if let Some(pos) = pos {
                    rule.last_trigger_at = doc.rules[pos].last_trigger_at.clone();
                    rule.count_date = doc.rules[pos].count_date.clone();
                    rule.count_today = doc.rules[pos].count_today;
                    doc.rules[pos] = rule;
                } else {
                    if doc.rules.len() >= 100 {
                        return Err("最多保存 100 条提醒规则".into());
                    }
                    doc.rules.push(rule);
                }
            }
            "toggle" => {
                let rule = doc
                    .rules
                    .iter_mut()
                    .find(|r| Some(&r.id) == query.get("id"))
                    .ok_or("提醒规则不存在")?;
                rule.enabled = !rule.enabled;
                rule.last_matched = None;
                rule.last_values.clear();
            }
            "delete" => {
                doc.rules.retain(|r| Some(&r.id) != query.get("id"));
            }
            _ => return Err("提醒操作无效".into()),
        }
        serde_json::to_value(doc).map_err(|_| "提醒保存失败".into())
    });
    match result {
        Ok(data) => json!({"success":true,"data":data,"meta":{"stale":false,"degraded":false}}),
        Err(error) => {
            json!({"success":false,"message":error,"errorCode":"invalid_input","retryable":false})
        }
    }
}
fn metric(quote: &Value, field: &str) -> Option<f64> {
    let key = match field {
        "price" => "priceValue",
        "changePct" => "changePercent",
        other => other,
    };
    quote[key].as_f64().filter(|n| n.is_finite())
}
fn matched(condition: &Condition, value: f64, previous: Option<f64>) -> bool {
    match condition.op.as_str() {
        ">=" => value >= condition.value,
        "<=" => value <= condition.value,
        ">" => value > condition.value,
        "<" => value < condition.value,
        "crossAbove" => previous.is_some_and(|p| p < condition.value) && value >= condition.value,
        "crossBelow" => previous.is_some_and(|p| p > condition.value) && value <= condition.value,
        _ => false,
    }
}
fn trading_window(now: DateTime<Utc>) -> bool {
    let local = now.with_timezone(&chrono_tz::Asia::Shanghai);
    let minute = local.hour() * 60 + local.minute();
    local.weekday().number_from_monday() <= 5
        && ((570..=690).contains(&minute) || (780..=900).contains(&minute))
}
fn fresh_quote(quote: &Value, now: DateTime<Utc>) -> bool {
    let Some(at) = quote["quoteTimeRaw"]
        .as_str()
        .and_then(|s| NaiveDateTime::parse_from_str(s, "%Y%m%d%H%M%S").ok())
        .and_then(|dt| dt.and_local_timezone(chrono_tz::Asia::Shanghai).single())
    else {
        return false;
    };
    let age = (now - at.with_timezone(&Utc)).num_seconds();
    (0..=120).contains(&age) && metric(quote, "price").is_some_and(|n| n > 0.0)
}

// None means incomplete data: it must not re-arm a rule or count as a trigger.
fn evaluate(rule: &mut Rule, quote: &Value, now: DateTime<Utc>) -> Option<Value> {
    if !active(rule, now) {
        return None;
    }
    let values: Vec<_> = rule
        .conditions
        .iter()
        .map(|c| metric(quote, &c.field))
        .collect();
    if values.iter().any(Option::is_none) {
        return None;
    }
    let checks: Vec<_> = rule
        .conditions
        .iter()
        .enumerate()
        .map(|(i, c)| {
            matched(
                c,
                values[i].expect("checked"),
                rule.last_values.get(i).copied().flatten(),
            )
        })
        .collect();
    let hit = if rule.logic == "or" {
        checks.iter().any(|v| *v)
    } else {
        checks.iter().all(|v| *v)
    };
    let was_matched = rule.last_matched == Some(true);
    rule.last_matched = Some(hit);
    rule.last_values = values;
    let day = now
        .with_timezone(&chrono_tz::Asia::Shanghai)
        .format("%Y-%m-%d")
        .to_string();
    if rule.count_date != day {
        rule.count_date = day;
        rule.count_today = 0;
    }
    let cooling = rule
        .last_trigger_at
        .as_deref()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .is_some_and(|at| {
            (now - at.with_timezone(&Utc)).num_seconds() < i64::from(rule.cooldown_minutes) * 60
        });
    if !hit || (rule.edge_only && was_matched) || cooling || rule.count_today >= rule.max_per_day {
        return None;
    }
    rule.last_trigger_at = Some(now.to_rfc3339());
    rule.count_today += 1;
    if rule.once {
        rule.enabled = false;
    }
    let condition_text = rule
        .conditions
        .iter()
        .zip(checks)
        .filter(|(_, hit)| *hit)
        .map(|(c, _)| {
            format!(
                "{} {} {}",
                match c.field.as_str() {
                    "price" => "价格",
                    "changePct" => "涨跌幅(%)",
                    "turnover" => "成交额(元)",
                    _ => "量比",
                },
                match c.op.as_str() {
                    "crossAbove" => "上穿",
                    "crossBelow" => "下破",
                    other => other,
                },
                c.value
            )
        })
        .collect::<Vec<_>>()
        .join("；");
    Some(
        json!({"id":uuid::Uuid::new_v4().to_string(),"ruleId":rule.id,"ruleName":rule.name,"code":rule.code,"name":quote["name"],"time":now.to_rfc3339(),"price":quote["priceValue"],"changePct":quote["changePercent"],"quoteTime":quote["quoteTimeRaw"],"detail":condition_text}),
    )
}

pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let now = Utc::now();
            let store = app.state::<ConfigStore>();
            let doc = match document(store.data_value(KEY)) {
                Ok(doc) => doc,
                Err(_) => {
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                    continue;
                }
            };
            let codes: Vec<_> = doc
                .rules
                .iter()
                .filter(|r| active(r, now) && validate((*r).clone()).is_ok())
                .map(|r| r.code.clone())
                .collect();
            if !codes.is_empty() && trading_window(now) {
                let state = app.state::<api::ApiState>();
                let response = state.price_alert_quotes(codes).await;
                let mut hits = vec![];
                let result = store.update_data(KEY, |value| {
                    let mut doc = document(value)?;
                    doc.last_checked_at = Some(Utc::now().to_rfc3339());
                    doc.status = "monitoring".into();
                    for rule in &mut doc.rules {
                        if !active(rule, Utc::now()) || validate(rule.clone()).is_err() {
                            continue;
                        }
                        let quote = &response["data"][&rule.code];
                        if response["success"] != true
                            || !fresh_quote(quote, Utc::now())
                            || rule
                                .conditions
                                .iter()
                                .any(|c| metric(quote, &c.field).is_none())
                        {
                            doc.status = "data_unavailable".into();
                            continue;
                        }
                        if let Some(hit) = evaluate(rule, quote, Utc::now()) {
                            hits.push(hit);
                        }
                    }
                    for hit in &hits {
                        doc.history.insert(0, hit.clone());
                    }
                    doc.history.truncate(100);
                    serde_json::to_value(doc).map_err(|_| "提醒状态保存失败".into())
                });
                if result.is_ok() {
                    for hit in hits {
                        let alert = windows::StockAlert::from_price_rule(
                            &hit,
                            &store.data_value("fund_tracker_alert_settings"),
                        );
                        windows::show_stock_alert(app.clone(), alert).await;
                        let _ = app.emit("price-alert-hit", hit);
                    }
                } else {
                    let _ = app.emit(
                        "price-alert-error",
                        json!({"message":"提醒状态无法保存，未发送告警"}),
                    );
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn time() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-12T02:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }
    fn rule() -> Rule {
        validate(Rule {
            code: "600519".into(),
            conditions: vec![Condition {
                field: "price".into(),
                op: ">=".into(),
                value: 10.0,
            }],
            ..Default::default()
        })
        .unwrap()
    }
    #[test]
    fn edge_cooldown_and_daily_limit() {
        let mut r = rule();
        let quote = |price| json!({"priceValue":price,"changePercent":1});
        assert!(evaluate(&mut r, &quote(11), time()).is_some());
        assert!(evaluate(&mut r, &quote(11), time() + chrono::Duration::minutes(31)).is_none());
        evaluate(&mut r, &quote(9), time() + chrono::Duration::minutes(31));
        assert!(evaluate(&mut r, &quote(11), time() + chrono::Duration::minutes(32)).is_some());
    }
    #[test]
    fn crossings_require_a_previous_valid_observation() {
        let mut r = rule();
        r.conditions[0].op = "crossAbove".into();
        assert!(evaluate(&mut r, &json!({"priceValue":11}), time()).is_none());
        evaluate(&mut r, &json!({"priceValue":9}), time());
        assert!(evaluate(&mut r, &json!({"priceValue":11}), time()).is_some());
    }
    #[test]
    fn missing_metrics_never_rearm() {
        let mut r = rule();
        r.last_matched = Some(true);
        r.conditions.push(Condition {
            field: "volumeRatio".into(),
            op: ">=".into(),
            value: 2.0,
        });
        assert!(evaluate(&mut r, &json!({"priceValue":11}), time()).is_none());
        assert_eq!(r.last_matched, Some(true));
    }
    #[test]
    fn stale_weekend_and_expired_data_are_rejected() {
        assert!(fresh_quote(
            &json!({"priceValue":10,"quoteTimeRaw":"20261012100000"}),
            time()
        ));
        assert!(!fresh_quote(
            &json!({"priceValue":10,"quoteTimeRaw":"20261009100000"}),
            time()
        ));
        assert!(!trading_window(time() - chrono::Duration::days(1)));
        let mut r = rule();
        r.expires_at = Some("2026-10-11T00:00:00Z".into());
        assert!(evaluate(&mut r, &json!({"priceValue":11}), time()).is_none());
    }
    #[test]
    fn malformed_documents_are_not_overwritten() {
        assert!(document(json!({"rules":"invalid"})).is_err());
        assert!(document(Value::Null).unwrap().rules.is_empty());
    }
    #[test]
    fn editing_a_rule_cannot_reset_its_daily_limit_or_cooldown() {
        let path =
            std::env::temp_dir().join(format!("price-alert-test-{}.json", uuid::Uuid::new_v4()));
        let store = ConfigStore::new(path.clone());
        let mut r = rule();
        evaluate(&mut r, &json!({"priceValue":11}), time());
        store
            .update_data(KEY, |_| Ok(json!({"rules":[r]})))
            .unwrap();
        r.name = "改名".into();
        r.count_today = 0;
        r.last_trigger_at = None;
        let value = handle(
            &store,
            HashMap::from([
                ("op".into(), "save".into()),
                ("rule".into(), serde_json::to_string(&r).unwrap()),
            ]),
        );
        assert_eq!(value["success"], true);
        assert_eq!(value["data"]["rules"][0]["countToday"], 1);
        assert!(value["data"]["rules"][0]["lastTriggerAt"].is_string());
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn or_once_and_daily_cap() {
        let mut r = rule();
        r.logic = "or".into();
        r.conditions.push(Condition {
            field: "changePct".into(),
            op: "<=".into(),
            value: -2.0,
        });
        r.once = true;
        assert!(evaluate(&mut r, &json!({"priceValue":9,"changePercent":-3}), time()).is_some());
        assert!(!r.enabled);
        let mut r = rule();
        r.edge_only = false;
        r.max_per_day = 1;
        assert!(evaluate(&mut r, &json!({"priceValue":11}), time()).is_some());
        assert!(evaluate(
            &mut r,
            &json!({"priceValue":11}),
            time() + chrono::Duration::minutes(31)
        )
        .is_none());
        assert!(evaluate(
            &mut r,
            &json!({"priceValue":11}),
            time() + chrono::Duration::days(1)
        )
        .is_some());
    }
}

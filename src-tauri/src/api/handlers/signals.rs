use super::super::endpoints::Query;
use super::super::{
    endpoints,
    http::{Gateway, RequestSpec},
    policy,
};
use chrono::{FixedOffset, Utc};
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) async fn dragon_tiger(gateway: Arc<Gateway>, query: Query) -> Value {
    endpoints::dragon_tiger(gateway, query).await
}

pub(crate) async fn opportunity(gateway: Arc<Gateway>, query: Query) -> Value {
    endpoints::opportunity_radar(gateway, query).await
}

pub(crate) async fn market_warnings(gateway: Arc<Gateway>, query: Query) -> Value {
    endpoints::market_warnings(gateway, query).await
}

pub(crate) async fn intraday_screening(gateway: Arc<Gateway>, _query: Query) -> Value {
    super::super::intraday::handle(gateway).await
}

fn normalize_rotation_date(value: &str) -> Option<String> {
    let normalized = value.trim().replace('/', "-");
    chrono::NaiveDate::parse_from_str(&normalized, "%Y-%m-%d")
        .ok()
        .map(|date| date.format("%Y-%m-%d").to_string())
}

fn previous_rotation_snapshot(payload: &Value, today: &str) -> Option<Value> {
    payload
        .get("data")?
        .as_array()?
        .iter()
        .filter_map(|item| {
            let date = normalize_rotation_date(item.get("date")?.as_str()?)?;
            (date.as_str() < today).then_some((date, item))
        })
        .max_by(|left, right| left.0.cmp(&right.0))
        .map(|(date, item)| {
            let sectors = item
                .get("sectors")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            json!({"date": date, "sectors": sectors})
        })
}

pub(crate) async fn sector_rotation(gateway: Arc<Gateway>, _query: Query) -> Value {
    let request =
        RequestSpec::get("https://sq.deepq.tech/ticai/api/concept-rotation/sector-rotation")
            .cache(5 * 60)
            .independent_circuit();
    let payload = match gateway.json(request).await {
        Ok(value) => value,
        Err(error) => {
            return policy::failure("轮动板块数据不可用", &error.to_string(), error.status)
        }
    };
    let shanghai = FixedOffset::east_opt(8 * 60 * 60).expect("Shanghai offset");
    let today = Utc::now()
        .with_timezone(&shanghai)
        .format("%Y-%m-%d")
        .to_string();
    let Some(snapshot) = previous_rotation_snapshot(&payload, &today) else {
        return policy::failure("上一交易日轮动板块尚未发布", "没有早于今日的有效数据", None);
    };
    let source_updated_at = payload.get("updateTime").cloned().unwrap_or(Value::Null);
    json!({
        "success": true,
        "data": {
            "status": "ready",
            "snapshotDate": snapshot["date"],
            "sectors": snapshot["sectors"],
            "source": "deepq-ticai",
            "sourceLabel": "DeepQ 题材记忆库",
            "sourceUpdatedAt": source_updated_at,
        },
        "meta": {
            "degraded": false,
            "stale": false,
            "sources": {"rotation": {"actual": "deepq-ticai", "actualLabel": "DeepQ 题材记忆库"}}
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotation_uses_latest_available_day_strictly_before_today() {
        let payload = json!({"data": [
            {"date":"2026/08/11","sectors":[{"rank":1,"sectorName":"芯片"}]},
            {"date":"2026/08/12","sectors":[{"rank":1,"sectorName":"医药"}]},
            {"date":"2026/08/13","sectors":[{"rank":1,"sectorName":"消费"}]}
        ]});
        let selected = previous_rotation_snapshot(&payload, "2026-08-13").unwrap();
        assert_eq!(selected["date"], "2026-08-12");
        assert_eq!(selected["sectors"][0]["sectorName"], "医药");
    }

    #[test]
    fn rotation_skips_weekend_gap_by_using_latest_published_day() {
        let payload = json!({"data": [
            {"date":"2026/08/07","sectors":[]},
            {"date":"2026/08/10","sectors":[]}
        ]});
        let selected = previous_rotation_snapshot(&payload, "2026-08-10").unwrap();
        assert_eq!(selected["date"], "2026-08-07");
    }
}

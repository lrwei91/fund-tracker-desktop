use super::http::{ApiError, Gateway, RequestSpec};
use serde_json::{json, Value};
use std::{process::Stdio, sync::Arc};
use tokio::process::Command;
fn num(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str()?.replace([',', '%'], "").trim().parse().ok())
}
fn time(v: &str) -> String {
    let digits: String = v.chars().filter(char::is_ascii_digit).collect();
    if let Some(p) = v.find(':') {
        return v[p.saturating_sub(2)..].chars().take(5).collect();
    }
    if digits.len() >= 4 {
        format!(
            "{}:{}",
            &digits[digits.len() - 4..digits.len() - 2],
            &digits[digits.len() - 2..]
        )
    } else {
        String::new()
    }
}
fn symbol(code: &str) -> String {
    format!(
        "{}{}",
        if code.starts_with(['5', '6', '9']) {
            "sh"
        } else {
            "sz"
        },
        code
    )
}
fn market(code: &str) -> i32 {
    if code.starts_with(['5', '6', '9']) {
        1
    } else {
        0
    }
}
async fn tdx(code: &str, count: usize) -> Result<Value, ApiError> {
    let (cmd, mut args) = if let Ok(x) = std::env::var("TDXRS_BIN") {
        (x, vec!["minutes".into()])
    } else if let Ok(x) = std::env::var("TDXRS_PYTHON") {
        (x, vec!["-m".into(), "tdxrs".into(), "minutes".into()])
    } else {
        return Err(ApiError::new("tdxrs 未配置"));
    };
    args.extend([
        "--count".into(),
        count.to_string(),
        "--format".into(),
        "json".into(),
        "--timeout".into(),
        "5".into(),
        code.into(),
    ]);
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        Command::new(&cmd)
            .args(args)
            .stdout(Stdio::piped())
            .output(),
    )
    .await
    .map_err(|_| ApiError::new("tdxrs 超时"))?
    .map_err(|e| ApiError::new(e.to_string()))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let (a, b) = (
        text.find('[')
            .ok_or_else(|| ApiError::new("JSON 输出为空"))?,
        text.rfind(']')
            .ok_or_else(|| ApiError::new("JSON 输出为空"))?,
    );
    let rows: Value =
        serde_json::from_str(&text[a..=b]).map_err(|e| ApiError::new(e.to_string()))?;
    let mut points:Vec<Value>=rows.as_array().into_iter().flatten().filter_map(|x|{let price=num(x.get("price").or_else(||x.get("价格")).unwrap_or(&Value::Null))?;let avg=num(x.get("avg_price").or_else(||x.get("avgPrice")).or_else(||x.get("均价")).unwrap_or(&Value::Null)).unwrap_or(price);let t=time(x.get("time").or_else(||x.get("时间")).and_then(Value::as_str).unwrap_or(""));if t.is_empty(){None}else{Some(json!({"time":t,"price":price,"avgPrice":avg,"volume":num(x.get("vol").or_else(||x.get("volume")).or_else(||x.get("成交量")).unwrap_or(&Value::Null)),"amount":num(x.get("amount").or_else(||x.get("成交额")).unwrap_or(&Value::Null)),"changePercent":num(x.get("changePercent").or_else(||x.get("change_pct")).or_else(||x.get("涨跌幅%")).unwrap_or(&Value::Null))}))}}).collect();
    points.sort_by_key(|x| x["time"].as_str().unwrap_or("").to_string());
    if points.len() > count {
        points = points.split_off(points.len() - count)
    }
    if points.is_empty() {
        return Err(ApiError::new("分时数据为空"));
    }
    let pre = points.iter().rev().find_map(|p| {
        let price = num(&p["price"])?;
        let pct = num(&p["changePercent"])?;
        let base = price / (1.0 + pct / 100.0);
        if base.is_finite() && base > 0.0 {
            Some((base * 10000.0).round() / 10000.0)
        } else {
            None
        }
    });
    Ok(
        json!({"source":"tdxrs","sourceLabel":"tdxrs","command":cmd,"name":"","preClose":pre,"tradeDate":"","points":points}),
    )
}
async fn tencent(g: &Arc<Gateway>, code: &str, count: usize) -> Result<Value, ApiError> {
    let s = symbol(code);
    let v = g
        .json(
            RequestSpec::get(format!(
                "https://web.ifzq.gtimg.cn/appstock/app/minute/query?code={s}"
            ))
            .header("referer", "https://gu.qq.com/"),
        )
        .await?;
    let raw = v
        .pointer(&format!("/data/{s}/data"))
        .unwrap_or(&Value::Null);
    let quote = v
        .pointer(&format!("/data/{s}/qt/{s}"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let pre = quote.get(4).and_then(num);
    let mut points:Vec<_>=raw.get("data").and_then(Value::as_array).into_iter().flatten().filter_map(|x|{let p:Vec<_>=x.as_str()?.split_whitespace().collect();if p.len()<3{return None}let price=p[1].parse::<f64>().ok()?;Some(json!({"time":time(p[0]),"price":price,"avgPrice":price,"volume":p[2].parse::<f64>().ok(),"amount":p.get(3).and_then(|x|x.parse::<f64>().ok()),"changePercent":pre.filter(|x|*x>0.0).map(|x|(price-x)/x*100.0)}))}).collect();
    if points.len() > count {
        points = points.split_off(points.len() - count)
    }
    if points.is_empty() {
        return Err(ApiError::new("腾讯分时数据为空"));
    }
    let date = raw.get("date").and_then(Value::as_str).unwrap_or("");
    let date = if date.len() == 8 {
        format!("{}-{}-{}", &date[..4], &date[4..6], &date[6..])
    } else {
        date.into()
    };
    Ok(
        json!({"source":"tencent","sourceLabel":"腾讯分时","command":"","name":quote.get(1).and_then(Value::as_str).unwrap_or(""),"preClose":pre,"tradeDate":date,"points":points}),
    )
}
async fn eastmoney(g: &Arc<Gateway>, code: &str, count: usize) -> Result<Value, ApiError> {
    let url=format!("https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid={}.{}&fields1=f1%2Cf2%2Cf3%2Cf4%2Cf5%2Cf6%2Cf7%2Cf8%2Cf9%2Cf10%2Cf11&fields2=f51%2Cf52%2Cf53%2Cf54%2Cf55%2Cf56%2Cf57%2Cf58&iscr=0&iscca=0&ndays=1",market(code),code);
    let v = g
        .json(
            RequestSpec::get(url)
                .em()
                .header("referer", "https://quote.eastmoney.com/"),
        )
        .await?;
    let data = v.get("data").unwrap_or(&Value::Null);
    let pre = num(data.get("preClose").unwrap_or(&Value::Null));
    let mut points:Vec<_>=data.get("trends").and_then(Value::as_array).into_iter().flatten().filter_map(|x|{let p:Vec<_>=x.as_str()?.split(',').collect();if p.len()<3{return None}let price=p[2].parse::<f64>().ok()?;let raw=p[0];Some(json!({"date":raw.chars().take(10).collect::<String>(),"time":time(raw),"open":p.get(1).and_then(|x|x.parse::<f64>().ok()),"price":price,"high":p.get(3).and_then(|x|x.parse::<f64>().ok()),"low":p.get(4).and_then(|x|x.parse::<f64>().ok()),"volume":p.get(5).and_then(|x|x.parse::<f64>().ok()),"amount":p.get(6).and_then(|x|x.parse::<f64>().ok()),"avgPrice":p.get(7).and_then(|x|x.parse::<f64>().ok()).unwrap_or(price),"changePercent":pre.filter(|x|*x>0.0).map(|x|(price-x)/x*100.0)}))}).collect();
    points.sort_by_key(|x| x["time"].as_str().unwrap_or("").to_string());
    if points.len() > count {
        points = points.split_off(points.len() - count)
    }
    if points.is_empty() {
        return Err(ApiError::new("东方财富分时数据为空"));
    }
    let last = points.last().unwrap();
    Ok(
        json!({"source":"eastmoney","sourceLabel":"东方财富","command":"","name":data.get("name").and_then(Value::as_str).unwrap_or(""),"preClose":pre,"tradeDate":last.get("date").cloned().unwrap_or(json!("")),"latestTime":last.get("time").cloned().unwrap_or(json!("")),"points":points}),
    )
}
pub async fn handle(g: Arc<Gateway>, code: &str, count: usize, source: &str) -> Value {
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return json!({"success":false,"message":"缺少股票代码"});
    }
    if !["auto", "tdxrs", "tencent", "eastmoney"].contains(&source) {
        return json!({"success":false,"message":"未知分时数据源"});
    }
    let mut fallback = String::new();
    let result = if source == "tdxrs" {
        tdx(code, count).await
    } else if source == "tencent" {
        tencent(&g, code, count).await
    } else if source == "eastmoney" {
        eastmoney(&g, code, count).await
    } else {
        let mut found = None;
        if std::env::var("TDXRS_BIN").is_ok() || std::env::var("TDXRS_PYTHON").is_ok() {
            match tdx(code, count).await {
                Ok(v) => found = Some(v),
                Err(e) => fallback = format!("tdxrs: {e}"),
            }
        }
        if found.is_none() {
            match tencent(&g, code, count).await {
                Ok(v) => found = Some(v),
                Err(e) => {
                    fallback = if fallback.is_empty() {
                        format!("腾讯: {e}")
                    } else {
                        format!("{fallback}; 腾讯: {e}")
                    }
                }
            }
        }
        if found.is_none() {
            match eastmoney(&g, code, count).await {
                Ok(v) => found = Some(v),
                Err(e) => fallback = format!("{fallback}; 东财: {e}"),
            }
        }
        found.ok_or_else(|| ApiError::new(&fallback))
    };
    match result {
        Ok(mut data) => {
            let latest = data
                .get("latestTime")
                .cloned()
                .or_else(|| {
                    data["points"]
                        .as_array()
                        .and_then(|x| x.last())
                        .and_then(|x| x.get("time"))
                        .cloned()
                })
                .unwrap_or(json!(""));
            let points = data["points"].as_array().cloned().unwrap_or_default();
            data.as_object_mut().unwrap().extend(json!({"code":code,"market":market(code),"count":points.len(),"latestTime":latest,"fallbackReason":fallback}).as_object().unwrap().clone());
            json!({"success":true,"data":data,"time":chrono::Utc::now().with_timezone(&chrono_tz::Asia::Shanghai).format("%H:%M:%S").to_string()})
        }
        Err(e) => json!({"success":false,"message":"分时数据接口不可用","error":e.to_string()}),
    }
}

use super::http::{ApiError, Gateway, RequestSpec};
use super::policy;
use serde_json::{json, Value};
use std::{cell::Cell, process::Stdio, sync::Arc};
use tokio::process::Command;

#[derive(Clone, Debug)]
#[allow(dead_code)]
struct Bar {
    date: String,
    open: f64,
    close: f64,
    high: f64,
    low: f64,
    volume: f64,
    amount: f64,
    pct: Option<f64>,
}
fn num(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str()?.replace(',', "").parse().ok())
}
fn rounded(v: Option<f64>, d: i32) -> Value {
    v.filter(|x| x.is_finite())
        .map(|x| {
            let p = 10f64.powi(d);
            json!((x * p).round() / p)
        })
        .unwrap_or(Value::Null)
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
    if code.starts_with(['6', '9']) {
        1
    } else {
        0
    }
}

async fn tdx(code: &str, days: usize) -> Result<(String, String, String, Vec<Bar>), ApiError> {
    let (cmd, mut args) = if let Ok(bin) = std::env::var("TDXRS_BIN") {
        (bin, vec!["bars".into()])
    } else if let Ok(py) = std::env::var("TDXRS_PYTHON") {
        (py, vec!["-m".into(), "tdxrs".into(), "bars".into()])
    } else {
        return Err(ApiError::new("tdxrs 未配置"));
    };
    args.extend([
        "--count".into(),
        days.clamp(60, 800).to_string(),
        "--fq".into(),
        "1".into(),
        "--category".into(),
        "day".into(),
        "--format".into(),
        "json".into(),
        "--timeout".into(),
        "8".into(),
        code.into(),
    ]);
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(13),
        Command::new(&cmd)
            .args(&args)
            .stdout(Stdio::piped())
            .output(),
    )
    .await
    .map_err(|_| ApiError::new("tdxrs 超时"))?
    .map_err(|e| ApiError::new(e.to_string()))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let (a, b) = (
        text.find('[')
            .ok_or_else(|| ApiError::new("tdxrs JSON 为空"))?,
        text.rfind(']')
            .ok_or_else(|| ApiError::new("tdxrs JSON 为空"))?,
    );
    let rows: Value =
        serde_json::from_str(&text[a..=b]).map_err(|e| ApiError::new(e.to_string()))?;
    let mut bars = Vec::new();
    for x in rows.as_array().into_iter().flatten() {
        if let (Some(open), Some(close), Some(high), Some(low)) = (
            num(&x["开盘"]),
            num(&x["收盘"]),
            num(&x["最高"]),
            num(&x["最低"]),
        ) {
            bars.push(Bar {
                date: x["日期"].as_str().unwrap_or("").into(),
                open,
                close,
                high,
                low,
                volume: num(&x["成交量"]).unwrap_or(0.0),
                amount: num(&x["成交额"]).unwrap_or(0.0),
                pct: None,
            })
        }
    }
    complete(&mut bars);
    Ok((
        String::new(),
        "tdxrs".into(),
        "通达信日K(tdxrs)".into(),
        bars,
    ))
}
async fn tencent(
    g: &Arc<Gateway>,
    code: &str,
    days: usize,
) -> Result<(String, String, String, Vec<Bar>), ApiError> {
    let s = symbol(code);
    let url =
        format!("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={s},day,,,{days},qfq");
    let v = g
        .json(RequestSpec::get(url).header("referer", "https://gu.qq.com/"))
        .await?;
    let root = v.pointer(&format!("/data/{s}")).unwrap_or(&Value::Null);
    let rows = root
        .get("qfqday")
        .or_else(|| root.get("day"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut bars = Vec::new();
    for x in rows {
        let Some(a) = x.as_array() else { continue };
        if a.len() < 6 {
            continue;
        }
        if let (Some(open), Some(close), Some(high), Some(low)) =
            (num(&a[1]), num(&a[2]), num(&a[3]), num(&a[4]))
        {
            bars.push(Bar {
                date: a[0].as_str().unwrap_or("").into(),
                open,
                close,
                high,
                low,
                volume: num(&a[5]).unwrap_or(0.0),
                amount: a.get(6).and_then(num).unwrap_or(0.0),
                pct: None,
            })
        }
    }
    complete(&mut bars);
    let name = root
        .pointer(&format!("/qt/{s}/1"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .into();
    Ok((name, "tencent".into(), "腾讯复权日K".into(), bars))
}
async fn eastmoney(
    g: &Arc<Gateway>,
    code: &str,
    days: usize,
) -> Result<(String, String, String, Vec<Bar>), ApiError> {
    let url=format!("https://push2his.eastmoney.com/api/qt/stock/kline/get?secid={}.{}&klt=101&fqt=1&lmt={days}&fields1=f1%2Cf2%2Cf3%2Cf4%2Cf5%2Cf6&fields2=f51%2Cf52%2Cf53%2Cf54%2Cf55%2Cf56%2Cf57%2Cf58%2Cf59%2Cf60%2Cf61",market(code),code);
    let v = g
        .json(
            RequestSpec::get(url)
                .em()
                .header("referer", "https://quote.eastmoney.com/")
                .timeout(12),
        )
        .await?;
    let mut bars = Vec::new();
    for line in v
        .pointer("/data/klines")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let p: Vec<_> = line.split(',').collect();
        if p.len() < 6 {
            continue;
        }
        if let (Ok(open), Ok(close), Ok(high), Ok(low)) =
            (p[1].parse(), p[2].parse(), p[3].parse(), p[4].parse())
        {
            bars.push(Bar {
                date: p[0].into(),
                open,
                close,
                high,
                low,
                volume: p[5].parse().unwrap_or(0.0),
                amount: p.get(6).and_then(|x| x.parse().ok()).unwrap_or(0.0),
                pct: p.get(8).and_then(|x| x.parse().ok()),
            })
        }
    }
    bars.sort_by(|a, b| a.date.cmp(&b.date));
    Ok((
        v.pointer("/data/name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .into(),
        "eastmoney".into(),
        "东方财富日K".into(),
        bars,
    ))
}
fn complete(bars: &mut [Bar]) {
    bars.sort_by(|a, b| a.date.cmp(&b.date));
    for i in 1..bars.len() {
        let prev = bars[i - 1].close;
        if prev > 0.0 {
            bars[i].pct = Some((bars[i].close - prev) / prev * 100.0)
        }
    }
}
fn avg(v: &[f64]) -> Option<f64> {
    if v.is_empty() {
        None
    } else {
        Some(v.iter().sum::<f64>() / v.len() as f64)
    }
}
fn sma(v: &[f64], n: usize) -> Option<f64> {
    if v.len() < n {
        None
    } else {
        avg(&v[v.len() - n..])
    }
}
fn ema(v: &[f64], n: usize) -> Vec<f64> {
    if v.is_empty() {
        return vec![];
    }
    let k = 2.0 / (n as f64 + 1.0);
    let mut out = vec![v[0]];
    for x in &v[1..] {
        out.push(x * k + out.last().unwrap() * (1.0 - k))
    }
    out
}
fn rsi(v: &[f64], n: usize) -> Option<f64> {
    if v.len() <= n {
        return None;
    }
    let (mut gain, mut loss) = (0.0, 0.0);
    for i in 1..=n {
        let d = v[i] - v[i - 1];
        if d >= 0.0 {
            gain += d
        } else {
            loss -= d
        }
    }
    gain /= n as f64;
    loss /= n as f64;
    for i in n + 1..v.len() {
        let d = v[i] - v[i - 1];
        gain = (gain * (n - 1) as f64 + d.max(0.0)) / n as f64;
        loss = (loss * (n - 1) as f64 + (-d).max(0.0)) / n as f64
    }
    Some(if loss == 0.0 {
        100.0
    } else {
        100.0 - 100.0 / (1.0 + gain / loss)
    })
}
fn analysis(bars: &[Bar]) -> Value {
    let closes: Vec<_> = bars.iter().map(|b| b.close).collect();
    let latest = bars.last().unwrap();
    let (ma20, ma50, ma200) = (sma(&closes, 20), sma(&closes, 50), sma(&closes, 200));
    let rsi14 = rsi(&closes, 14);
    let e12 = ema(&closes, 12);
    let e26 = ema(&closes, 26);
    let diffs: Vec<_> = e12.iter().zip(e26.iter()).map(|(a, b)| a - b).collect();
    let dea = ema(&diffs, 9);
    let macd = diffs.last().zip(dea.last()).map(|(a, b)| (*a, *b));
    let window = &bars[bars.len().saturating_sub(250)..];
    let high = window
        .iter()
        .map(|b| b.high)
        .fold(f64::NEG_INFINITY, f64::max);
    let low = window.iter().map(|b| b.low).fold(f64::INFINITY, f64::min);
    let pos = if high > low {
        Some((latest.close - low) / (high - low) * 100.0)
    } else {
        None
    };
    let momentum = closes
        .len()
        .checked_sub(22)
        .map(|i| (latest.close - closes[i]) / closes[i] * 100.0);
    let volavg = avg(&bars[bars.len().saturating_sub(20)..]
        .iter()
        .map(|b| b.volume)
        .collect::<Vec<_>>());
    let vr = volavg.filter(|x| *x > 0.0).map(|x| latest.volume / x);
    let score = Cell::new(0.0_f64);
    let mut signals = Vec::new();
    let mut add = |title: &str, detail: String, weight: f64| {
        score.set(score.get() + weight);
        signals.push(json!({"title":title,"detail":detail,"weight":weight,"type":if weight>0.0{"positive"}else if weight<0.0{"negative"}else{"neutral"}}))
    };
    if let Some(m) = ma20 {
        add(
            if latest.close >= m {
                "站上 MA20"
            } else {
                "跌破 MA20"
            },
            format!(
                "收盘 {} 20 日均线 {:.2}",
                if latest.close >= m {
                    "高于"
                } else {
                    "低于"
                },
                m
            ),
            if latest.close >= m { 8.0 } else { -8.0 },
        )
    }
    if let (Some(a), Some(b)) = (ma20, ma50) {
        add(
            if a >= b {
                "中期均线偏强"
            } else {
                "中期均线偏弱"
            },
            format!("MA20 {} MA50", if a >= b { "高于" } else { "低于" }),
            if a >= b { 10.0 } else { -10.0 },
        )
    }
    if let (Some(a), Some(b)) = (ma50, ma200) {
        add(
            if a >= b {
                "长期趋势向上"
            } else {
                "长期趋势承压"
            },
            format!("MA50 {} MA200", if a >= b { "高于" } else { "低于" }),
            if a >= b { 12.0 } else { -12.0 },
        )
    }
    if let Some(r) = rsi14 {
        if r >= 70.0 {
            add("RSI 过热", format!("RSI14 {:.1}", r), -6.0)
        } else if r >= 55.0 {
            add("RSI 动能偏强", format!("RSI14 {:.1}", r), 8.0)
        } else if r <= 30.0 {
            add("RSI 超卖", format!("RSI14 {:.1}", r), 6.0)
        } else if r < 45.0 {
            add("RSI 动能偏弱", format!("RSI14 {:.1}", r), -6.0)
        }
    }
    if let Some((d, e)) = macd {
        add(
            if d >= e {
                "MACD 金叉区"
            } else {
                "MACD 死叉区"
            },
            format!("DIF {:.3} / DEA {:.3}", d, e),
            if d >= e { 8.0 } else { -8.0 },
        );
        score.set(score.get() + if d - e > 0.0 { 4.0 } else { -4.0 });
    }
    if let Some(m) = momentum {
        if m >= 5.0 {
            add("近 21 日走强", format!("{m:.2}%"), 8.0)
        } else if m <= -5.0 {
            add("近 21 日走弱", format!("{m:.2}%"), -8.0)
        }
    }
    if let Some(p) = pos {
        if p >= 65.0 {
            add("接近区间高位", format!("52 周位置 {p:.1}%"), 6.0)
        } else if p <= 35.0 {
            add("处于区间低位", format!("52 周位置 {p:.1}%"), -6.0)
        }
    }
    if let (Some(volume_ratio), Some(pct)) = (vr.filter(|x| *x >= 1.5), latest.pct) {
        add(
            if pct >= 0.0 {
                "放量上涨"
            } else {
                "放量下跌"
            },
            format!("量比约 {volume_ratio:.2}x"),
            if pct >= 0.0 { 5.0 } else { -5.0 },
        )
    }
    signals.sort_by(|a, b| {
        num(&b["weight"])
            .unwrap_or(0.0)
            .abs()
            .total_cmp(&num(&a["weight"]).unwrap_or(0.0).abs())
    });
    signals.truncate(6);
    let score = score.get().round().clamp(-100.0, 100.0);
    json!({"score":score,"verdict":if score>=35.0{"强势"}else if score>=15.0{"偏多"}else if score>-15.0{"中性"}else if score>-35.0{"偏弱"}else{"弱势"},"latestDate":latest.date,"indicators":{"close":rounded(Some(latest.close),2),"ma20":rounded(ma20,2),"ma50":rounded(ma50,2),"ma200":rounded(ma200,2),"rsi14":rounded(rsi14,1),"position52w":rounded(pos,1),"momentum21":rounded(momentum,2),"volumeRatio":rounded(vr,2)},"signals":signals})
}
fn chips(bars: &[Bar]) -> Value {
    let valid: Vec<_> = bars
        .iter()
        .rev()
        .take(180)
        .filter(|b| b.volume > 0.0)
        .cloned()
        .collect();
    if valid.len() < 20 {
        return Value::Null;
    }
    let latest = bars.last().unwrap();
    let low = valid.iter().map(|b| b.low).fold(f64::INFINITY, f64::min);
    let high = valid
        .iter()
        .map(|b| b.high)
        .fold(f64::NEG_INFINITY, f64::max);
    if high <= low {
        return Value::Null;
    }
    let step = (high - low) / 48.0;
    let mut weights = vec![0.0; 48];
    for (age, b) in valid.iter().rev().enumerate() {
        let w = b.volume * 0.5f64.powf(age as f64 / 60.0);
        let start = ((b.low - low) / step).floor().clamp(0.0, 47.0) as usize;
        let end = ((b.high - low) / step).floor().clamp(0.0, 47.0) as usize;
        for x in &mut weights[start..=end] {
            *x += w / (end - start + 1) as f64
        }
    }
    let total: f64 = weights.iter().sum();
    let max = weights.iter().copied().fold(0.0, f64::max);
    let levels: Vec<_> = weights
        .iter()
        .enumerate()
        .map(|(i, w)| (low + step * (i as f64 + 0.5), *w))
        .collect();
    let avg = levels.iter().map(|(p, w)| p * w).sum::<f64>() / total;
    let profit = levels
        .iter()
        .filter(|(p, _)| *p <= latest.close)
        .map(|(_, w)| w)
        .sum::<f64>()
        / total
        * 100.0;
    let support = levels
        .iter()
        .filter(|(p, _)| *p < latest.close)
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map(|x| x.0);
    let resistance = levels
        .iter()
        .filter(|(p, _)| *p > latest.close)
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map(|x| x.0);
    json!({"windowDays":valid.len(),"avgCost":rounded(Some(avg),2),"profitRatio":rounded(Some(profit),1),"support":rounded(support,2),"resistance":rounded(resistance,2),"concentration90":null,"levels":levels.into_iter().map(|(p,w)|json!({"price":rounded(Some(p),2),"weightPct":rounded(Some(w/total*100.0),2),"height":rounded(Some(w/max*100.0),1),"inProfit":p<=latest.close})).collect::<Vec<_>>(),"note":"按近 180 个交易日成交量在日内价格区间均匀分布估算"})
}

pub async fn handle(g: Arc<Gateway>, code: &str, days: usize) -> Value {
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return policy::failure("缺少股票代码", "", None);
    }
    let mut reason = String::new();
    let mut attempts = Vec::new();
    let mut result = None;
    if std::env::var("TDXRS_BIN").is_ok() || std::env::var("TDXRS_PYTHON").is_ok() {
        match tdx(code, days).await {
            Ok(v) if v.3.len() >= 60 => {
                attempts.push(json!({"source":"tdxrs","status":200}));
                result = Some(v);
            }
            Ok(v) => {
                attempts.push(json!({"source":"tdxrs","status":"empty","count":v.3.len()}));
                reason = format!("通达信: 数据不足({}条)", v.3.len());
            }
            Err(e) => {
                attempts.push(json!({"source":"tdxrs","status":e.status,"reason":e.to_string()}));
                reason = format!("通达信: {e}");
            }
        }
    }
    if result.is_none() {
        match tencent(&g, code, days).await {
            Ok(v) if v.3.len() >= 60 => {
                attempts.push(json!({"source":"tencent","status":200}));
                result = Some(v);
            }
            Ok(v) => {
                attempts.push(json!({"source":"tencent","status":"empty","count":v.3.len()}));
                reason = format!("腾讯: 数据不足({}条)", v.3.len());
            }
            Err(e) => {
                attempts.push(json!({"source":"tencent","status":e.status,"reason":e.to_string()}));
                reason = format!("腾讯: {e}");
            }
        }
    }
    if result.is_none() {
        match eastmoney(&g, code, days).await {
            Ok(v) if !v.3.is_empty() => {
                attempts.push(json!({"source":"eastmoney","status":200}));
                result = Some(v);
            }
            Ok(_) => attempts.push(json!({"source":"eastmoney","status":"empty"})),
            Err(e) => {
                attempts
                    .push(json!({"source":"eastmoney","status":e.status,"reason":e.to_string()}));
                reason = format!("东方财富: {e}");
            }
        }
    }
    let Some((name, source, label, bars)) = result else {
        return policy::failure("暂无日 K 数据", &reason, None);
    };
    let a = analysis(&bars);
    let latest = a["latestDate"].clone();
    json!({"success":true,"data":{"code":code,"name":name,"days":days,"source":source,"sourceLabel":label,"fallbackReason":reason,"latestDate":latest,"count":bars.len(),"analysis":a,"chips":chips(&bars),"bars":bars.iter().rev().take(60).collect::<Vec<_>>().into_iter().rev().map(|b|json!({"date":b.date,"close":rounded(Some(b.close),2),"pct":rounded(b.pct,2),"volume":b.volume})).collect::<Vec<_>>()},"meta":{"asOf":chrono::Utc::now().to_rfc3339(),"degraded":!reason.is_empty(),"stale":false,"sources":{"kline":{"actual":source,"actualLabel":label,"fallbackReason":reason,"attempts":attempts}}}})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn indicators_are_stable() {
        let bars: Vec<Bar> = (0..260)
            .map(|i| Bar {
                date: i.to_string(),
                open: 10.0 + i as f64 / 100.0,
                close: 10.1 + i as f64 / 100.0,
                high: 10.2 + i as f64 / 100.0,
                low: 9.9 + i as f64 / 100.0,
                volume: 1000.0,
                amount: 0.0,
                pct: Some(0.1),
            })
            .collect();
        assert!(analysis(&bars)["score"].as_f64().unwrap() > 0.0);
        assert!(!chips(&bars).is_null())
    }
}

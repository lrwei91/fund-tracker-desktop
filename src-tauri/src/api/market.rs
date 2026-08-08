use super::http::{ApiError, Gateway, RequestSpec};
use super::policy;
use chrono::{Duration, Utc};
use chrono_tz::Asia::Shanghai;
use serde_json::{json, Value};
use std::sync::Arc;
fn num(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str()?.replace([',', '%'], "").parse().ok())
}
fn yi(v: f64) -> String {
    format!(
        "{}{:.2}亿",
        if v > 0.0 { "+" } else { "" },
        v / 100_000_000.0
    )
}
fn pct(v: Option<f64>) -> String {
    v.map(|x| format!("{}{x:.2}%", if x > 0.0 { "+" } else { "" }))
        .unwrap_or_else(|| "--".into())
}
async fn minute(g: &Arc<Gateway>, s: &str) -> Result<(String, Vec<f64>), ApiError> {
    let v = g
        .json(
            RequestSpec::get(format!(
                "https://web.ifzq.gtimg.cn/appstock/app/minute/query?code={s}"
            ))
            .header("referer", "https://gu.qq.com/")
            .cache(60),
        )
        .await?;
    let d = v
        .pointer(&format!("/data/{s}/data"))
        .unwrap_or(&Value::Null);
    let date = d.get("date").and_then(Value::as_str).unwrap_or("");
    let date = if date.len() == 8 {
        format!("{}-{}-{}", &date[..4], &date[4..6], &date[6..])
    } else {
        date.into()
    };
    let p = d
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|x| x.as_str()?.split_whitespace().nth(1)?.parse().ok())
        .collect();
    Ok((date, p))
}
async fn indexes(g: &Arc<Gateway>) -> Result<Value, ApiError> {
    let list = [
        ("shangzhi", "s_sh000001", "sh000001", "上证指数"),
        ("shengzheng", "s_sz399001", "sz399001", "深证成指"),
        ("chuangye", "s_sz399006", "sz399006", "创业板指"),
        ("zhuanke50", "s_sh000688", "sh000688", "科创50"),
    ];
    let text = g
        .gbk(RequestSpec::get(format!(
            "https://qt.gtimg.cn/q={}",
            list.iter().map(|x| x.1).collect::<Vec<_>>().join(",")
        )))
        .await?;
    let mut out = serde_json::Map::new();
    for (id, s, ms, name) in list {
        let data = text
            .split(';')
            .find_map(|line| {
                if line.contains(s) {
                    let (a, b) = (line.find('"')?, line.rfind('"')?);
                    Some(
                        line[a + 1..b]
                            .split('~')
                            .map(str::to_owned)
                            .collect::<Vec<_>>(),
                    )
                } else {
                    None
                }
            })
            .ok_or_else(|| ApiError::new(format!("指数无数据 {s}")))?;
        let (value, change, cp) = (
            data.get(3).and_then(|x| x.parse::<f64>().ok()),
            data.get(4).and_then(|x| x.parse::<f64>().ok()),
            data.get(5).and_then(|x| x.parse::<f64>().ok()),
        );
        let (d, p) = minute(g, ms).await.unwrap_or_default();
        out.insert(id.into(),json!({"name":name,"value":value.map(|x|format!("{x:.2}")).unwrap_or_else(||"--".into()),"priceValue":value,"change":format!("{}{} / {}",if change.unwrap_or(0.0)>0.0{"+"}else{""},change.map(|x|format!("{x:.2}")).unwrap_or_else(||"--".into()),pct(cp)),"changePercent":cp.unwrap_or(0.0),"sparkline":p,"sparklineDate":d}));
    }
    Ok(Value::Object(out))
}
fn unavailable_main() -> Value {
    json!({"available":false,"source":null,"value":"--","isPositive":null,"note":"暂无数据","breakdown":{"superLarge":{"value":"--","isPositive":null},"large":{"value":"--","isPositive":null},"medium":{"value":"--","isPositive":null},"small":{"value":"--","isPositive":null}}})
}
async fn main_fund(g: &Arc<Gateway>) -> Value {
    let url="https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=6000&po=1&np=1&fltt=2&invt=2&fs=m%3A0%2Bt%3A6%2Cm%3A0%2Bt%3A80%2Cm%3A1%2Bt%3A2%2Cm%3A1%2Bt%3A23%2Cm%3A0%2Bt%3A81%2Bs%3A2048&fields=f12%2Cf14%2Cf62%2Cf66%2Cf72%2Cf78%2Cf84";
    let Ok(v) = g.json(RequestSpec::get(url).em().timeout(15)).await else {
        return unavailable_main();
    };
    let rows = v
        .pointer("/data/diff")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if rows.is_empty() {
        return unavailable_main();
    }
    let sum = |k: &str| rows.iter().filter_map(|x| num(&x[k])).sum::<f64>();
    let (a, b, c, d, e) = (sum("f62"), sum("f66"), sum("f72"), sum("f78"), sum("f84"));
    json!({"available":true,"source":"eastmoney","value":yi(a),"isPositive":a>=0.0,"breakdown":{"superLarge":{"value":yi(b),"isPositive":b>=0.0},"large":{"value":yi(c),"isPositive":c>=0.0},"medium":{"value":yi(d),"isPositive":d>=0.0},"small":{"value":yi(e),"isPositive":e>=0.0}}})
}
async fn north_intraday(g: &Arc<Gateway>) -> Value {
    let Ok(v) = g
        .json(
            RequestSpec::get("https://data.hexin.cn/market/hsgtApi/method/dayChart/")
                .header("referer", "https://data.hexin.cn/"),
        )
        .await
    else {
        return json!({"available":false,"value":"--","isPositive":null,"time":""});
    };
    let times = v
        .get("time")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let values = v
        .get("hgt")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let latest = times
        .iter()
        .zip(values.iter())
        .filter_map(|(t, x)| num(x).map(|n| (t, n)))
        .next_back();
    latest.map(|(t,n)|json!({"available":true,"value":format!("{}{n:.2}亿",if n>0.0{"+"}else{""}),"isPositive":n>=0.0,"time":t})).unwrap_or(json!({"available":false,"value":"--","isPositive":null,"time":""}))
}
async fn hkex(g: &Arc<Gateway>) -> Value {
    for offset in 0..7 {
        let key = (Utc::now() - Duration::days(offset))
            .with_timezone(&Shanghai)
            .format("%Y%m%d");
        if let Ok(text) = g
            .text(
                RequestSpec::get(format!(
                    "https://www.hkex.com.hk/chi/csm/DailyStat/data_tab_daily_{key}c.js"
                ))
                .header("referer", "https://www.hkex.com.hk/")
                .cache(1800),
            )
            .await
        {
            if let (Some(a), Some(b)) = (text.find('['), text.rfind(']')) {
                if let Ok(v) = serde_json::from_str::<Value>(&text[a..=b]) {
                    let markets: Vec<_> = v
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|x| {
                            x.get("market")
                                .and_then(Value::as_str)
                                .is_some_and(|x| x.contains("Northbound"))
                        })
                        .collect();
                    let sum = markets
                        .iter()
                        .filter_map(|x| x.pointer("/content/0/table/tr/0/td/0/0"))
                        .filter_map(num)
                        .sum::<f64>()
                        / 100.0;
                    if sum > 0.0 {
                        return json!({"available":true,"value":format!("{sum:.2}亿"),"isPositive":null,"date":markets.first().and_then(|x|x.get("date")).cloned().unwrap_or(json!(""))});
                    }
                }
            }
        }
    }
    json!({"available":false,"value":"--","isPositive":null,"date":""})
}
async fn sectors(g: &Arc<Gateway>) -> Result<Value, ApiError> {
    let url="https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fid=f62&fs=m%3A90%2Bt%3A2&fields=f3%2Cf12%2Cf14%2Cf62%2Cf104%2Cf105%2Cf136%2Cf140";
    let v = g
        .json(
            RequestSpec::get(url)
                .em()
                .header(
                    "referer",
                    "https://quote.eastmoney.com/center/boardlist.html",
                )
                .timeout(15),
        )
        .await?;
    let mut rows: Vec<_> = v
        .pointer("/data/diff")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|x| {
            let n = x.get("f14").and_then(Value::as_str)?;
            let fund = num(&x["f62"])?;
            if fund == 0.0 {
                return None;
            }
            Some((
                n.to_string(),
                fund,
                num(&x["f3"]).unwrap_or(0.0),
                x.get("f140")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            ))
        })
        .collect();
    let map = |x: &(String, f64, f64, String)| json!({"name":x.0,"value":yi(x.1),"mainFundYuan":x.1,"changePct":x.2,"leader":x.3});
    rows.sort_by(|a, b| b.1.total_cmp(&a.1));
    let inflow = rows
        .iter()
        .filter(|x| x.1 > 0.0)
        .take(10)
        .map(map)
        .collect::<Vec<_>>();
    rows.sort_by(|a, b| a.1.total_cmp(&b.1));
    let outflow = rows
        .iter()
        .filter(|x| x.1 < 0.0)
        .take(10)
        .map(map)
        .collect::<Vec<_>>();
    Ok(json!({"inflow":inflow,"outflow":outflow}))
}
pub async fn handle(g: Arc<Gateway>, kind: &str) -> Value {
    match kind {
        "index" => match indexes(&g).await {
            Ok(v) => json!({"success":true,"data":v,"meta":{"degraded":false,"stale":false}}),
            Err(e) => policy::failure("真实行情接口不可用", &e.to_string(), e.status),
        },
        "capital" => {
            let (a, b, c) = tokio::join!(main_fund(&g), north_intraday(&g), hkex(&g));
            let degraded =
                a["available"] != true || b["available"] != true || c["available"] != true;
            json!({"success":true,"data":{"mainFund":a,"northHgtIntraday":b,"northboundDaily":c},"meta":{"asOf":Utc::now().to_rfc3339(),"degraded":degraded,"stale":false,"sources":{"marketFund":{"actual":if a["available"]==true{json!("eastmoney")}else{Value::Null},"status":if a["available"]==true{"live"}else{"unavailable"}},"northHgtIntraday":{"actual":"hexin","status":if b["available"]==true{"live"}else{"unavailable"}},"northboundDaily":{"actual":"hkex","status":if c["available"]==true{"live"}else{"unavailable"}}}}})
        }
        "sector" => match sectors(&g).await {
            Ok(v) => json!({"success":true,"data":v,"meta":{"degraded":false,"stale":false}}),
            Err(e) => policy::failure("真实行情接口不可用", &e.to_string(), e.status),
        },
        "multiday-flow" => match sectors(&g).await {
            Ok(v) => {
                let day = Utc::now()
                    .with_timezone(&Shanghai)
                    .format("%-m/%-d")
                    .to_string();
                let map = |key: &str, trend: &str| {
                    v[key].as_array().into_iter().flatten().map(|x|json!({"name":x["name"],"data":[x["value"].clone()],"consecutiveDays":1,"trend":trend})).collect::<Vec<_>>()
                };
                json!({"success":true,"data":{"dates":[day],"inflowSectors":map("inflow","up"),"outflowSectors":map("outflow","down")},"meta":{"degraded":false,"stale":false}})
            }
            Err(e) => policy::failure("真实行情接口不可用", &e.to_string(), e.status),
        },
        _ => policy::failure("未知 market-data 类型", "market-data type invalid", None),
    }
}

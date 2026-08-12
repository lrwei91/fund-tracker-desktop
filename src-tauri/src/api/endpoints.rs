use super::{
    http::{ApiError, Gateway, RequestSpec},
    policy, symbol,
};
use chrono::Utc;
use chrono_tz::Asia::Shanghai;
use md5::Md5;

#[derive(Clone, Default)]
struct Candidate {
    code: String,
    name: String,
    pct: Option<f64>,
    price: Option<f64>,
    tags: Vec<String>,
    signals: Vec<Value>,
    source_score: f64,
    industry: String,
    limit_type: String,
    dragon: Option<f64>,
    dragon_reason: String,
    limit_down: bool,
    source_types: Vec<String>,
    monitored: bool,
    monitor_end: String,
    anomaly_rule: String,
}
use serde_json::{json, Map, Value};
use sha1::{Digest, Sha1};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::Arc,
};

pub(crate) type Query = HashMap<String, String>;
fn q<'a>(query: &'a Query, key: &str) -> &'a str {
    query.get(key).map(String::as_str).unwrap_or("")
}
fn int(query: &Query, key: &str, default: i64, min: i64, max: i64) -> i64 {
    q(query, key).parse().unwrap_or(default).clamp(min, max)
}
fn ok(data: Value) -> Value {
    json!({"success":true,"data":data,"meta":{"degraded":false,"stale":false}})
}
fn ok_extra(data: Value, extra: Value) -> Value {
    let mut out = json!({"success":true,"data":data,"meta":{"degraded":false,"stale":false}});
    if let (Some(a), Some(b)) = (out.as_object_mut(), extra.as_object()) {
        a.extend(b.clone())
    }
    out
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
fn number(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str()?.parse().ok())
}
fn string(v: Option<&Value>) -> String {
    v.and_then(|x| x.as_str().map(str::to_owned))
        .unwrap_or_else(|| v.map(Value::to_string).unwrap_or_default())
}
fn field<'a>(v: &'a Value, key: &str) -> &'a Value {
    v.get(key).unwrap_or(&Value::Null)
}
fn round(v: f64, d: i32) -> f64 {
    let p = 10f64.powi(d);
    (v * p).round() / p
}
fn now_iso() -> String {
    Utc::now().to_rfc3339()
}
fn today() -> String {
    Utc::now()
        .with_timezone(&Shanghai)
        .format("%Y%m%d")
        .to_string()
}

fn today_iso() -> String {
    Utc::now()
        .with_timezone(&Shanghai)
        .format("%Y-%m-%d")
        .to_string()
}

fn valid_code(code: &str) -> bool {
    symbol::valid_code(code)
}

pub(crate) async fn stock(g: Arc<Gateway>, query: Query) -> Value {
    let requested: Vec<String> = q(&query, "codes")
        .split(',')
        .map(str::trim)
        .filter(|c| valid_code(c))
        .map(str::to_owned)
        .collect();
    if requested.is_empty() {
        return fail("缺少股票代码", "");
    }
    let rejected: Vec<_> = requested
        .iter()
        .filter(|code| symbol::is_legacy_beijing(code))
        .cloned()
        .collect();
    let codes: Vec<_> = requested
        .iter()
        .filter(|code| !symbol::is_legacy_beijing(code))
        .cloned()
        .collect();
    if codes.is_empty() {
        return fail(
            "北交所旧代码已迁移",
            "无效的北交所旧代码：43/83/87 号段可能返回迁移日前的僵尸行情，请改用 920xxx 新代码",
        );
    }
    let symbols = codes
        .iter()
        .filter_map(|code| symbol::tencent_symbol(code))
        .collect::<Vec<_>>()
        .join(",");
    match g
        .gbk(RequestSpec::get(format!("https://qt.gtimg.cn/q={symbols}")).cache(5))
        .await
    {
        Ok(text) => {
            let mut data = Map::new();
            let mut times = Vec::new();
            let expected: HashSet<_> = codes.iter().map(String::as_str).collect();
            for line in text.split(';').map(str::trim).filter(|l| !l.is_empty()) {
                let Some(eq) = line.find('=') else { continue };
                let Some(code) = line.get(2..eq).and_then(|value| value.get(2..)) else {
                    continue;
                };
                let Some(first) = line.find('"') else {
                    continue;
                };
                let Some(last) = line.rfind('"') else {
                    continue;
                };
                if last <= first {
                    continue;
                }
                let Some(payload) = line.get(first + 1..last) else {
                    continue;
                };
                let parts: Vec<&str> = payload.split('~').collect();
                if !expected.contains(code) || parts.len() < 33 {
                    continue;
                }
                let price = parts[3]
                    .parse::<f64>()
                    .ok()
                    .filter(|value| value.is_finite() && *value > 0.0);
                if price.is_none() {
                    continue;
                }
                let pct = parts[32].parse::<f64>().unwrap_or(0.0);
                let change = parts[31].parse::<f64>().ok();
                let mut open = parts
                    .get(5)
                    .and_then(|v| v.parse::<f64>().ok())
                    .filter(|v| *v > 0.0);
                if open.is_none() {
                    if let Some(p) = price {
                        let prev = p / (1.0 + pct / 100.0);
                        if prev.is_finite() && prev > 0.0 {
                            open = Some(round(prev, 2))
                        }
                    }
                }
                let raw = parts.get(30).copied().unwrap_or("");
                let display = raw
                    .get(8..14)
                    .filter(|value| value.len() == 6)
                    .map(|value| format!("{}:{}:{}", &value[0..2], &value[2..4], &value[4..6]))
                    .unwrap_or_default();
                if raw.len() == 14 {
                    times.push(raw.to_string())
                }
                data.insert(code.into(),json!({"code":code,"name":parts.get(1).copied().unwrap_or(code),"price":price.map(|p|format!("{p:.2}")).unwrap_or_else(||"--".into()),"priceValue":price,"change":change,"changePercent":pct,"volume":parts.get(36).or(parts.get(6)).copied().unwrap_or("--"),"openPrice":open,"quoteTime":display,"quoteTimeRaw":raw}));
            }
            times.sort();
            let request_time = Utc::now()
                .with_timezone(&Shanghai)
                .format("%H:%M:%S")
                .to_string();
            let latest = times.last().and_then(|s| {
                s.get(8..14)
                    .filter(|value| value.len() == 6)
                    .map(|value| format!("{}:{}:{}", &value[0..2], &value[2..4], &value[4..6]))
            });
            if data.is_empty() {
                return fail("真实股票行情接口不可用", "行情数据为空或字段无效");
            }
            let mut received = data.keys().cloned().collect::<Vec<_>>();
            received.sort();
            let missing = codes
                .iter()
                .filter(|code| !data.contains_key(code.as_str()))
                .cloned()
                .collect::<Vec<_>>();
            let degraded = !missing.is_empty() || !rejected.is_empty();
            ok_extra(
                Value::Object(data),
                json!({
                    "time":latest.clone().unwrap_or(request_time),
                    "timeSource":if latest.is_some(){"quote"}else{"request"},
                    "meta":{
                        "degraded":degraded,
                        "stale":false,
                        "expectedCodes":requested,
                        "receivedCodes":received,
                        "missingCodes":missing,
                        "rejectedCodes":rejected.iter().map(|code|json!({"code":code,"reason":"北交所旧代码已迁移，请使用 920xxx 新代码"})).collect::<Vec<_>>(),
                        "sources":{"quotes":{"actual":"tencent","actualLabel":"腾讯行情"}}
                    }
                }),
            )
        }
        Err(e) => fail_api("真实股票行情接口不可用", &e),
    }
}

pub(crate) async fn stock_search(g: Arc<Gateway>, query: Query) -> Value {
    let term = q(&query, "q").trim();
    if term.is_empty() {
        return fail("缺少搜索关键词", "");
    }
    let url=format!("https://searchapi.eastmoney.com/api/suggest/get?input={}&type=14&token=44c9d251add88e27b65ed86506f6e5da&count=8",urlencoding::encode(term));
    match g.json(RequestSpec::get(url).em()).await {
        Ok(v) => {
            let rows = v
                .pointer("/QuotationCodeTable/Data")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            ok(Value::Array(
                rows.into_iter()
                    .filter_map(|r| {
                        let c = r.get("Code")?.as_str()?;
                        let n = r.get("Name")?.as_str()?;
                        let t = r.get("SecurityTypeName")?.as_str()?;
                        if valid_code(c) && t.contains('A') {
                            Some(json!({"code":c,"name":n}))
                        } else {
                            None
                        }
                    })
                    .collect(),
            ))
        }
        Err(e) => fail_api("真实股票搜索接口不可用", &e),
    }
}

pub(crate) async fn hot_rank(g: Arc<Gateway>, query: Query) -> Value {
    let source = if q(&query, "source").is_empty() {
        "ths"
    } else {
        q(&query, "source")
    };
    if source == "ths" {
        let period = if q(&query, "period").is_empty() {
            "hour"
        } else {
            q(&query, "period")
        };
        let url=format!("https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock?stock_type=a&type={period}&list_type=normal");
        return match g.json(RequestSpec::get(url)).await {
            Ok(v) => {
                let items:Vec<Value>=v.pointer("/data/stock_list").and_then(Value::as_array).into_iter().flatten().take(30).map(|x|json!({"rank":field(x,"order"),"code":field(x,"code"),"name":field(x,"name"),"heat":number(field(x,"rate")).unwrap_or(0.0).div_euclid(10000.0).round(),"pct":number(field(x,"rise_and_fall")).unwrap_or(0.0),"rankChg":field(x,"hot_rank_chg"),"concepts":x.pointer("/tag/concept_tag").cloned().unwrap_or(json!([])),"tag":x.pointer("/tag/popularity_tag").cloned().unwrap_or(json!(""))})).collect();
                ok(json!({"source":source,"period":period,"items":items}))
            }
            Err(e) => fail_api("真实市场热度接口不可用", &e),
        };
    }
    if source != "em" {
        return fail("未知 source（支持 ths / em）", "");
    }
    let limit = int(&query, "limit", 20, 1, 30) as usize;
    let body=json!({"appId":"appId01","globalId":"786e4c21-70dc-435a-93bb-38","marketType":"","pageNo":1,"pageSize":limit}).to_string();
    let main = match g
        .json(
            RequestSpec::get("https://emappdata.eastmoney.com/stockrank/getAllCurrentList")
                .em()
                .header("content-type", "application/json")
                .body(body),
        )
        .await
    {
        Ok(v) => v,
        Err(e) => return fail_api("真实市场热度接口不可用", &e),
    };
    let data = main
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if data.is_empty() {
        return ok(json!({"source":"em","items":[]}));
    }
    let secids = data
        .iter()
        .filter_map(|x| x.get("sc").and_then(Value::as_str))
        .filter_map(|sc| sc.get(2..))
        .filter(|code| !symbol::is_legacy_beijing(code))
        .filter_map(symbol::eastmoney_secid)
        .collect::<Vec<_>>()
        .join(",");
    if secids.is_empty() {
        return ok_extra(
            json!({"source":"em","items":[]}),
            json!({"meta":{"degraded":true,"stale":false,"emptyReason":"热榜未返回可用证券代码"}}),
        );
    }
    let url=format!("https://push2.eastmoney.com/api/qt/ulist.np/get?ut=f057cbcbce2a86e2866ab8877db1d059&fltt=2&invt=2&fields=f14%2Cf3%2Cf12%2Cf2&secids={}",urlencoding::encode(&secids));
    let lookup = match g.json(RequestSpec::get(url).em()).await {
        Ok(v) => v,
        Err(e) => return fail_api("真实市场热度接口不可用", &e),
    };
    let mut names = HashMap::new();
    if let Some(diff) = lookup.pointer("/data/diff") {
        for x in diff.as_array().cloned().unwrap_or_else(|| {
            diff.as_object()
                .map(|m| m.values().cloned().collect())
                .unwrap_or_default()
        }) {
            if let Some(c) = x.get("f12").and_then(Value::as_str) {
                names.insert(c.to_string(), x);
            }
        }
    }
    let items:Vec<Value>=data.iter().take(limit).map(|it|{let sc=it.get("sc").and_then(Value::as_str).unwrap_or("");let code=sc.get(2..).unwrap_or("");let info=names.get(code);json!({"rank":field(it,"rk"),"code":code,"name":info.and_then(|x|x.get("f14")).cloned().unwrap_or(json!("")),"price":info.and_then(|x|number(field(x,"f2"))),"pct":info.and_then(|x|number(field(x,"f3"))),"rankChg":field(it,"hisRc")})}).collect();
    ok(json!({"source":"em","items":items}))
}

fn zt_time(v: &Value) -> String {
    let raw = if let Some(n) = v.as_i64() {
        n.to_string()
    } else {
        v.as_str().unwrap_or("").into()
    };
    let digits: String = raw.chars().filter(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return String::new();
    }
    let s = format!("{:0>6}", digits);
    format!("{}:{}:{}", &s[0..2], &s[2..4], &s[4..6])
}
async fn pool(
    g: &Arc<Gateway>,
    kind: &str,
    date: &str,
    limit: usize,
) -> Result<Vec<Value>, ApiError> {
    let (endpoint, sort) = match kind {
        "zt" => ("getTopicZTPool", "fbt:asc"),
        "zb" => ("getTopicZBPool", "fbt:asc"),
        "dt" => ("getTopicDTPool", "fund:asc"),
        "yzt" => ("getYesterdayZTPool", "zs:desc"),
        _ => return Err(ApiError::new("未知池类型")),
    };
    let url=format!("https://push2ex.eastmoney.com/{endpoint}?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize={limit}&sort={}&date={date}",urlencoding::encode(sort));
    let v = g.json(RequestSpec::get(url).em().timeout(12)).await?;
    Ok(v.pointer("/data/pool")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}
fn map_pool(kind: &str, p: &Value) -> Value {
    let z = field(p, "zttj");
    let common = json!({"code":field(p,"c"),"name":field(p,"n"),"market":field(p,"m"),"price":number(field(p,"p")).unwrap_or(0.0)/1000.0,"pct":round(number(field(p,"zdp")).unwrap_or(0.0),2),"turnover":round(number(field(p,"hs")).unwrap_or(0.0),2),"industry":field(p,"hybk"),"ztStat":if !field(z,"days").is_null()&&!field(z,"ct").is_null(){format!("{}天{}板",field(z,"days"),field(z,"ct"))}else{String::new()}});
    let mut o = common.as_object().cloned().unwrap_or_default();
    let extra = match kind {
        "zt" => {
            json!({"amount":field(p,"amount"),"floatCap":field(p,"ltsz"),"limitDays":field(p,"lbc"),"firstSeal":zt_time(field(p,"fbt")),"lastSeal":zt_time(field(p,"lbt")),"sealFund":field(p,"fund"),"breakTimes":field(p,"zbc")})
        }
        "zb" => {
            json!({"limitPrice":number(field(p,"ztp")).unwrap_or(0.0)/1000.0,"firstSeal":zt_time(field(p,"fbt")),"breakTimes":field(p,"zbc"),"amplitude":round(number(field(p,"zf")).unwrap_or(0.0),2),"speed":round(number(field(p,"zs")).unwrap_or(0.0),2)})
        }
        "dt" => {
            json!({"sealFund":field(p,"fund"),"lastSeal":zt_time(field(p,"lbt")),"boardAmount":field(p,"fba"),"dtDays":field(p,"days"),"openTimes":field(p,"oc")})
        }
        _ => {
            json!({"amplitude":round(number(field(p,"zf")).unwrap_or(0.0),2),"speed":round(number(field(p,"zs")).unwrap_or(0.0),2),"yFirstSeal":zt_time(field(p,"yfbt")),"yLimitDays":field(p,"ylbc")})
        }
    };
    if let Some(extra) = extra.as_object() {
        o.extend(extra.clone());
    }
    Value::Object(o)
}
pub(crate) async fn limit_up(g: Arc<Gateway>, query: Query) -> Value {
    let kind = if q(&query, "type").is_empty() {
        "zt"
    } else {
        q(&query, "type")
    };
    let date = q(&query, "date").replace('-', "");
    let date = if date.is_empty() { today() } else { date };
    if !["zt", "zb", "dt", "yzt", "summary"].contains(&kind) {
        return fail("未知 type（支持 zt/zb/dt/yzt/summary）", "");
    }
    if kind == "summary" {
        let (a, b, c, d) = tokio::join!(
            pool(&g, "zt", &date, 100),
            pool(&g, "zb", &date, 100),
            pool(&g, "dt", &date, 100),
            pool(&g, "yzt", &date, 100)
        );
        let (zt, zb, dt, yzt) = match (a, b, c, d) {
            (Ok(a), Ok(b), Ok(c), Ok(d)) => (a, b, c, d),
            x => return fail("真实打板接口不可用", format!("{x:?}")),
        };
        let mut ladder = BTreeMap::new();
        for p in &zt {
            let n = field(p, "lbc").as_i64().unwrap_or(0);
            if n > 0 {
                *ladder.entry(n).or_insert(0) += 1
            }
        }
        let promote = yzt
            .iter()
            .filter(|p| number(field(p, "zdp")).unwrap_or(0.0) >= 9.8)
            .count();
        return ok(
            json!({"date":date,"ztCount":zt.len(),"zbCount":zb.len(),"dtCount":dt.len(),"yztCount":yzt.len(),"breakRate":if zt.len()+zb.len()>0{round(zb.len() as f64/(zt.len()+zb.len())as f64*100.0,1)}else{0.0},"maxHeight":zt.iter().filter_map(|p|field(p,"lbc").as_i64()).max().unwrap_or(0),"promoteRate":if yzt.is_empty(){0.0}else{round(promote as f64/yzt.len()as f64*100.0,1)},"ladder":ladder}),
        );
    }
    let limit = int(&query, "limit", 30, 1, 100) as usize;
    match pool(&g, kind, &date, limit).await {
        Ok(raw) => {
            let items: Vec<_> = raw.iter().map(|p| map_pool(kind, p)).collect();
            ok(json!({"type":kind,"date":date,"count":items.len(),"items":items}))
        }
        Err(e) => fail_api("真实打板接口不可用", &e),
    }
}

fn cls_request(cursor: &str, limit: usize) -> (String, String) {
    let query = format!(
        "appName=CailianpressWeb&last_time={cursor}&os=web&refresh_type=1&rn={limit}&sv=7.7.5"
    );
    let sha = format!("{:x}", Sha1::digest(query.as_bytes()));
    let sign = format!("{:x}", Md5::digest(sha.as_bytes()));
    (query, sign)
}
fn cls_time(ts: i64) -> String {
    chrono::DateTime::from_timestamp(ts, 0)
        .map(|d| {
            d.with_timezone(&Shanghai)
                .format("%Y-%m-%d %H:%M:%S")
                .to_string()
        })
        .unwrap_or_default()
}
async fn load_cls(g: &Arc<Gateway>, cursor: &str, limit: usize) -> Result<Vec<Value>, ApiError> {
    let (request, sign) = cls_request(cursor, limit);
    let v = g
        .json(
            RequestSpec::get(format!(
                "https://www.cls.cn/v1/roll/get_roll_list?{request}&sign={sign}"
            ))
            .header("referer", "https://www.cls.cn/")
            .cache(30),
        )
        .await?;
    if v.get("errno")
        .and_then(Value::as_i64)
        .is_some_and(|n| n != 0)
    {
        return Err(ApiError::new(string(v.get("msg"))));
    }
    let rows = v
        .pointer("/data/roll_data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(rows.into_iter().filter_map(|x|{let content=["content","brief","title"].iter().find_map(|k|x.get(k).and_then(Value::as_str)).unwrap_or("").trim().to_string();let title=["title","brief"].iter().find_map(|k|x.get(k).and_then(Value::as_str)).unwrap_or(&content).trim().to_string();if title.is_empty()&&content.is_empty(){return None}let ts=field(&x,"ctime").as_i64().unwrap_or(0);let fallback=format!("{:x}",Sha1::digest(format!("{ts}:{title}:{content}").as_bytes()));Some(json!({"id":x.get("id").or_else(||x.get("telegraph_id")).map(Value::to_string).unwrap_or_else(||fallback[..16].into()).trim_matches('"'),"timestamp":ts,"time":cls_time(ts),"title":title,"summary":content,"url":x.get("shareurl").or_else(||x.get("url")).and_then(Value::as_str).unwrap_or("https://www.cls.cn/telegraph")}))}).collect())
}
async fn load_em_news(
    g: &Arc<Gateway>,
    cursor: &str,
    limit: usize,
) -> Result<Vec<Value>, ApiError> {
    let url=format!("https://np-weblist.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd={}&pageSize={limit}&req_trace={}",urlencoding::encode(cursor),uuid::Uuid::new_v4());
    let v = g
        .json(
            RequestSpec::get(url)
                .em()
                .header("referer", "https://kuaixun.eastmoney.com/")
                .cache(30),
        )
        .await?;
    Ok(v.pointer("/data/fastNewsList")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(map_em_news_row)
        .collect())
}

fn map_em_news_row(x: &Value) -> Option<Value> {
    let title = string(x.get("title"));
    let summary = string(x.get("summary"));
    if title.is_empty() && summary.is_empty() {
        return None;
    }
    Some(json!({
        "id":x.get("seq").or_else(||x.get("id")).or_else(||x.get("code")).or_else(||x.get("realSort")).or_else(||x.get("url")).cloned().unwrap_or(json!("")),
        "cursor":x.get("realSort").or_else(||x.get("sortEnd")).cloned().unwrap_or(json!("")),
        "title":title,
        "summary":summary,
        "time":x.get("showTime").or_else(||x.get("createTime")).cloned().unwrap_or(json!("")),
        "url":x.get("url").cloned().unwrap_or(json!("https://kuaixun.eastmoney.com/"))
    }))
}
fn source_meta(
    key: &str,
    actual: &str,
    label: &str,
    degraded: bool,
    reason: &str,
    requested: &str,
) -> Value {
    let attempts = if degraded {
        let failed_status = reason
            .strip_prefix("HTTP ")
            .and_then(|value| value.split_whitespace().next())
            .and_then(|value| value.parse::<u16>().ok())
            .map(|status| json!(status))
            .unwrap_or_else(|| json!("failed"));
        json!([
            {"source":requested,"label":requested,"status":failed_status,"reason":reason},
            {"source":actual,"label":label,"status":200,"reason":"备用源成功"}
        ])
    } else {
        json!([])
    };
    json!({"asOf":now_iso(),"degraded":degraded,"stale":false,"sources":{key:{"actual":actual,"actualLabel":label,"attempts":attempts,"degraded":degraded,"fallbackReason":reason,"requested":requested}}})
}
pub(crate) async fn cls_news(g: Arc<Gateway>, query: Query) -> Value {
    let limit = int(&query, "limit", 20, 1, 40) as usize;
    let cursor = q(&query, "cursor").trim();
    let mut degraded = false;
    let mut reason = String::new();
    let (items, actual, label) = match load_cls(&g, cursor, limit).await {
        Ok(v) if !v.is_empty() => (v, "cls", "财联社"),
        Err(e) if cursor.is_empty() => {
            degraded = true;
            reason = e.to_string();
            match load_em_news(&g, "", limit).await {
                Ok(v) if !v.is_empty() => (v, "eastmoney", "东方财富"),
                Err(e) => return fail("财联社快讯接口不可用", format!("{reason}; {e}")),
                _ => return fail("财联社快讯接口不可用", "数据为空"),
            }
        }
        Ok(_) if cursor.is_empty() => {
            degraded = true;
            reason = "财联社数据为空".into();
            match load_em_news(&g, "", limit).await {
                Ok(v) if !v.is_empty() => (v, "eastmoney", "东方财富"),
                _ => return fail("财联社快讯接口不可用", reason),
            }
        }
        Err(e) => return fail_api("财联社快讯接口不可用", &e),
        _ => return fail("财联社快讯接口不可用", "数据为空"),
    };
    let sliced: Vec<_> = items.into_iter().take(limit).collect();
    let next = if actual == "cls" {
        sliced
            .last()
            .and_then(|x| field(x, "timestamp").as_i64())
            .filter(|x| *x > 0)
            .map(|x| x.to_string())
    } else {
        None
    };
    ok_extra(
        json!({"data":sliced,"nextCursor":next,"hasMore":next.is_some()&&sliced.len()>=limit,"source":actual,"sourceLabel":label}),
        json!({"meta":source_meta("news",actual,label,degraded,&reason,"cls")}),
    )
}
pub(crate) async fn global_news(g: Arc<Gateway>, query: Query) -> Value {
    let limit = int(&query, "limit", 20, 1, 40) as usize;
    let cursor = q(&query, "cursor").trim();
    let mut degraded = false;
    let mut reason = String::new();
    let (items, actual, label) = match load_em_news(&g, cursor, limit).await {
        Ok(v) if !v.is_empty() => (v, "eastmoney", "东方财富"),
        Err(e) if cursor.is_empty() => {
            degraded = true;
            reason = e.to_string();
            match load_cls(&g, "", limit).await {
                Ok(v) if !v.is_empty() => (v, "cls", "财联社"),
                _ => return fail("真实东财资讯接口不可用", reason),
            }
        }
        Ok(_) if cursor.is_empty() => {
            degraded = true;
            reason = "东方财富数据为空".into();
            match load_cls(&g, "", limit).await {
                Ok(v) if !v.is_empty() => (v, "cls", "财联社"),
                _ => return fail("真实东财资讯接口不可用", reason),
            }
        }
        Err(e) => return fail_api("真实东财资讯接口不可用", &e),
        _ => return fail("真实东财资讯接口不可用", "数据为空"),
    };
    let sliced: Vec<_> = items.into_iter().take(limit).collect();
    let next = if actual == "eastmoney" {
        sliced
            .last()
            .and_then(|x| x.get("cursor"))
            .and_then(Value::as_str)
            .filter(|x| !x.is_empty())
            .map(str::to_owned)
    } else {
        None
    };
    ok_extra(
        json!({"data":sliced,"nextCursor":if sliced.len()>=limit{next.clone()}else{None},"hasMore":next.is_some()&&sliced.len()>=limit,"source":actual,"sourceLabel":label}),
        json!({"meta":source_meta("news",actual,label,degraded,&reason,"eastmoney")}),
    )
}

fn strip_html(text: &str) -> String {
    let re = regex::Regex::new(r"(?is)<br\s*/?>|</p\s*>").unwrap();
    let text = re.replace_all(text, " ");
    let tags = regex::Regex::new(r"(?is)<[^>]*>").unwrap();
    let text = tags.replace_all(&text, "");
    let decoded = text
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    regex::Regex::new(r"\s+")
        .unwrap()
        .replace_all(&decoded, " ")
        .trim()
        .to_string()
}
pub(crate) async fn news(g: Arc<Gateway>, query: Query) -> Value {
    let limit = int(&query, "limit", 20, 1, 40) as usize;
    let cursor = serde_json::from_str::<Value>(q(&query, "cursor")).ok();
    let mut url = "https://flash-api.jin10.com/get_flash_list?channel=-8200&vip=1".to_string();
    if let Some(c) = &cursor {
        if let Some(x) = c.get("maxTime").and_then(Value::as_str) {
            url.push_str("&max_time=");
            url.push_str(&urlencoding::encode(x))
        }
        if let Some(x) = c.get("lastId").and_then(Value::as_str) {
            url.push_str("&last_id=");
            url.push_str(&urlencoding::encode(x))
        }
    }
    let result = g
        .json(
            RequestSpec::get(url)
                .header("x-app-id", "bVBF4FyRTn5NJF5n")
                .header("x-version", "1.0.0")
                .header("referer", "https://www.jin10.com/")
                .header("origin", "https://www.jin10.com/"),
        )
        .await;
    let (mut rows, mut actual, mut label, mut degraded, mut reason) =
        (Vec::new(), "jin10", "金十", false, String::new());
    match result {
        Ok(v) if v.get("status").and_then(Value::as_i64) == Some(200) => {
            for x in v
                .get("data")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let id = string(x.get("id"));
                let data = field(x, "data");
                let content = strip_html(
                    ["content", "title"]
                        .iter()
                        .find_map(|k| data.get(k).and_then(Value::as_str))
                        .unwrap_or(""),
                );
                if id.is_empty()
                    || content.is_empty()
                    || field(data, "lock").as_bool() == Some(true)
                    || content.contains("VIP专享")
                    || content.contains("解锁直达")
                    || content.contains("升级")
                {
                    continue;
                }
                rows.push(json!({"id":id,"time":field(x,"time"),"data":{"content":content},"url":data.get("link").cloned().unwrap_or(json!("https://www.jin10.com/flash"))}));
            }
        }
        Ok(v) => reason = format!("金十返回异常 {}", field(&v, "status")),
        Err(e) => reason = e.to_string(),
    }
    if rows.is_empty() && cursor.is_none() {
        match load_cls(&g, "", limit).await {
            Ok(v) if !v.is_empty() => {
                rows=v.into_iter().map(|x|json!({"id":field(&x,"id"),"time":field(&x,"time"),"data":{"content":if string(x.get("summary")).is_empty(){field(&x,"title")}else{field(&x,"summary")}},"url":field(&x,"url")})).collect();
                actual = "cls";
                label = "财联社";
                degraded = true
            }
            _ => return fail("真实金十快讯接口不可用", reason),
        }
    } else if rows.is_empty() {
        return fail("真实金十快讯接口不可用", reason);
    }
    let sliced: Vec<_> = rows.into_iter().take(limit).collect();
    let next = sliced
        .last()
        .map(|x| json!({"maxTime":field(x,"time"),"lastId":field(x,"id")}).to_string());
    let has_more = next.is_some() && !sliced.is_empty();
    ok_extra(
        json!({"data":sliced,"nextCursor":next,"hasMore":has_more,"source":actual,"sourceLabel":label}),
        json!({"meta":source_meta("news",actual,label,degraded,&reason,"jin10")}),
    )
}

pub(crate) async fn stock_news(g: Arc<Gateway>, query: Query) -> Value {
    let code = q(&query, "code").trim();
    if !valid_code(code) {
        return fail("缺少股票代码", "");
    }
    let name = q(&query, "name")
        .trim()
        .chars()
        .take(24)
        .collect::<String>();
    let limit = int(&query, "limit", 6, 1, 10) as usize;
    let keyword = if name.is_empty() { code } else { &name };
    let param = json!({"uid":"","keyword":keyword,"type":["cmsArticleWebOld"],"client":"web","clientType":"web","clientVersion":"curr","param":{"cmsArticleWebOld":{"searchScope":"default","sort":"default","pageIndex":1,"pageSize":limit,"preTag":"<em>","postTag":"</em>"}}});
    let url=format!("https://search-api-web.eastmoney.com/search/jsonp?cb=jQuery_fund_tracker_stock_news&param={}&_={}",urlencoding::encode(&param.to_string()),Utc::now().timestamp_millis());
    let text = match g
        .text(
            RequestSpec::get(url)
                .em()
                .header(
                    "referer",
                    format!(
                        "https://so.eastmoney.com/news/s?keyword={}",
                        urlencoding::encode(keyword)
                    ),
                )
                .cache(300),
        )
        .await
    {
        Ok(v) => v,
        Err(e) => return fail_api("个股新闻接口不可用", &e),
    };
    let Some(start) = text.find('(') else {
        return fail("个股新闻接口不可用", "东财新闻返回格式异常");
    };
    let Some(end) = text.rfind(')') else {
        return fail("个股新闻接口不可用", "东财新闻返回格式异常");
    };
    let payload: Value = match serde_json::from_str(&text[start + 1..end]) {
        Ok(v) => v,
        Err(e) => return fail("个股新闻接口不可用", e),
    };
    let items:Vec<Value>=payload.pointer("/result/cmsArticleWebOld").and_then(Value::as_array).into_iter().flatten().take(limit).filter_map(|x|{let title=strip_html(x.get("title").and_then(Value::as_str).unwrap_or(""));if title.is_empty(){return None}let article=string(x.get("code"));Some(json!({"title":title,"summary":strip_html(x.get("content").or_else(||x.get("summary")).and_then(Value::as_str).unwrap_or("")),"time":field(x,"date"),"source":field(x,"mediaName"),"url":if article.is_empty(){String::new()}else{format!("https://finance.eastmoney.com/a/{article}.html")}}))}).collect();
    if items.is_empty() {
        return fail("个股新闻接口不可用", "个股新闻为空");
    }
    let all = items
        .iter()
        .map(|x| format!("{} {}", string(x.get("title")), string(x.get("summary"))))
        .collect::<Vec<_>>()
        .join(" ");
    let positives = [
        "订单",
        "增长",
        "预增",
        "扭亏",
        "回购",
        "合作",
        "中标",
        "突破",
        "量产",
        "扩产",
        "涨价",
        "政策",
        "获批",
        "创新高",
        "机构调研",
        "出海",
        "投产",
        "回升",
    ];
    let risks = [
        "减持", "亏损", "处罚", "问询", "立案", "下滑", "诉讼", "终止", "风险", "解禁", "质押",
        "退市", "暴雷", "商誉",
    ];
    let ph: Vec<_> = positives.into_iter().filter(|w| all.contains(w)).collect();
    let rh: Vec<_> = risks.into_iter().filter(|w| all.contains(w)).collect();
    ok(
        json!({"code":code,"name":name,"source":"eastmoney","sourceLabel":"东方财富新闻","count":items.len(),"items":items,"score":{"score":round(ph.len()as f64*0.8-rh.len()as f64*1.1,1),"positiveHits":ph,"riskHits":rh}}),
    )
}

pub(crate) async fn stock_risk(g: Arc<Gateway>, query: Query) -> Value {
    let code = q(&query, "code").trim();
    if !valid_code(code) {
        return fail("缺少股票代码", "");
    }
    let limit = int(&query, "limit", 8, 1, 20) as usize;
    let today = Utc::now()
        .with_timezone(&Shanghai)
        .format("%Y-%m-%d")
        .to_string();
    let end = (Utc::now() + chrono::Duration::days(90))
        .with_timezone(&Shanghai)
        .format("%Y-%m-%d")
        .to_string();
    let lock_url=format!("https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_LIFT_STAGE&columns=ALL&filter={}&pageSize=60&pageNumber=1&sortColumns=FREE_DATE&sortTypes=-1",urlencoding::encode(&format!("(SECURITY_CODE=\"{code}\")(FREE_DATE<='{end}')")));
    let announce = async {
        if code.starts_with(['0', '3']) {
            let body=json!({"channelCode":["listedNotice_disc"],"pageSize":limit,"pageNum":1,"stock":[code]}).to_string();
            if let Ok(v) = g
                .json(
                    RequestSpec::get("https://www.szse.cn/api/disc/announcement/annList")
                        .body(body)
                        .header("content-type", "application/json")
                        .header(
                            "referer",
                            "https://www.szse.cn/disclosure/listed/notice/index.html",
                        )
                        .cache(1800),
                )
                .await
            {
                let items:Vec<_>=v.get("data").and_then(Value::as_array).into_iter().flatten().filter_map(|x|{let title=string(x.get("title"));if title.is_empty(){None}else{Some(json!({"title":title,"time":string(x.get("publishTime")).chars().take(10).collect::<String>(),"pdf":x.get("attachPath").and_then(Value::as_str).map(|p|format!("https://disc.static.szse.cn/download{p}")).unwrap_or_default()}))}}).collect();
                if !items.is_empty() {
                    return Ok((items, "szse", false, String::new()));
                }
            }
        }
        let url=format!("https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size={limit}&page_index=1&ann_type=A&client_source=web&stock_list={code}&f_node=0&s_node=0");
        let v = g.json(RequestSpec::get(url).em().cache(1800)).await?;
        let items=v.pointer("/data/list").and_then(Value::as_array).into_iter().flatten().filter_map(|x|{let title=string(x.get("title"));if title.is_empty(){None}else{Some(json!({"title":title,"time":string(x.get("notice_date")).chars().take(10).collect::<String>(),"pdf":x.get("art_code").and_then(Value::as_str).map(|a|format!("https://pdf.dfcfw.com/pdf/H2_{a}_1.pdf")).unwrap_or_default()}))}}).collect();
        Ok::<_, ApiError>((
            items,
            "eastmoney",
            code.starts_with(['0', '3']),
            String::new(),
        ))
    };
    let lock = async {
        let v = g.json(RequestSpec::get(lock_url).em().cache(1800)).await?;
        let mut history = Vec::new();
        let mut upcoming = Vec::new();
        for x in v
            .pointer("/result/data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let date = string(x.get("FREE_DATE"))
                .chars()
                .take(10)
                .collect::<String>();
            if date.is_empty() {
                continue;
            }
            let ratio =
                number(field(x, "FREE_RATIO")).map(|n| if n.abs() <= 1.0 { n * 100.0 } else { n });
            let item = json!({"date":date,"type":field(x,"FREE_SHARES_TYPE"),"shares":number(field(x,"FREE_SHARES")),"ableShares":number(field(x,"ABLE_FREE_SHARES")),"ratioPct":ratio});
            if date < today {
                history.push(item)
            } else {
                upcoming.push(item)
            }
        }
        history.sort_by_key(|x| std::cmp::Reverse(string(x.get("date"))));
        history.truncate(10);
        upcoming.sort_by_key(|x| string(x.get("date")));
        Ok::<_, ApiError>((history, upcoming))
    };
    let (a, l) = tokio::join!(announce, lock);
    let announcements = match &a {
        Ok((items, source, _, _)) => json!({"available":true,"items":items,"source":source}),
        Err(e) => json!({"available":false,"items":[],"source":null,"error":e.to_string()}),
    };
    let lockup = match &l {
        Ok((h, u)) => json!({"available":true,"history":h,"upcoming":u}),
        Err(e) => json!({"available":false,"history":[],"upcoming":[],"error":e.to_string()}),
    };
    let degraded = a.is_err() || l.is_err() || a.as_ref().ok().is_some_and(|x| x.2);
    ok_extra(
        json!({"code":code,"announcements":announcements,"lockup":lockup}),
        json!({"meta":{"asOf":now_iso(),"degraded":degraded,"stale":false,"sources":{"announcements":a.as_ref().map(|x|json!({"actual":x.1,"actualLabel":if x.1 == "szse" {"深圳证券交易所"} else {"东方财富"},"degraded":x.2,"fallbackReason":x.3,"attempts":if x.2 {json!([{"source":"szse","status":"empty"},{"source":"eastmoney","status":200}])} else {json!([])}})).unwrap_or_else(|e|json!({"actual":null,"error":e.to_string(),"attempts":[{"source":"eastmoney","status":e.status,"reason":e.to_string()}]})),"lockup":l.as_ref().map(|_|json!({"actual":"eastmoney","actualLabel":"东方财富","attempts":[{"source":"eastmoney","status":200}]})).unwrap_or_else(|e|json!({"actual":null,"error":e.to_string(),"attempts":[{"source":"eastmoney","status":e.status,"reason":e.to_string()}]}))}}}),
    )
}

pub(crate) async fn dragon_tiger(g: Arc<Gateway>, _query: Query) -> Value {
    let url="https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=TRADE_DATE&sortTypes=-1&pageSize=40&pageNumber=1&reportName=RPT_DAILYBILLBOARD_DETAILS&columns=ALL";
    let reason = match g.json(RequestSpec::get(url).em().cache(1800)).await {
        Ok(v) => {
            let rows = v
                .pointer("/result/data")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let stocks:Vec<_>=rows.iter().filter_map(|x|{let code=string(x.get("SECURITY_CODE"));if !valid_code(&code){return None}Some(json!({"code":code,"name":field(x,"SECURITY_NAME_ABBR"),"reason":x.get("EXPLANATION").or_else(||x.get("EXPLAIN")).cloned().unwrap_or(json!("")),"netBuyWan":number(field(x,"BILLBOARD_NET_AMT")).map(|n|n/10000.0)}))}).collect();
            if !stocks.is_empty() {
                let date = rows
                    .first()
                    .map(|x| {
                        string(x.get("TRADE_DATE"))
                            .chars()
                            .take(10)
                            .collect::<String>()
                    })
                    .unwrap_or_default();
                return ok_extra(
                    json!({"date":date,"stocks":stocks}),
                    json!({"meta":source_meta("dragonTiger","eastmoney","东方财富",false,"","eastmoney")}),
                );
            }
            "东方财富: 数据为空".to_string()
        }
        Err(e) => e.to_string(),
    };
    let re = regex::Regex::new(r"证券代码:\s*(\d{6}).*证券简称:\s*([^\s]+)").unwrap();
    for offset in 0..7 {
        let date = (Utc::now() - chrono::Duration::days(offset))
            .with_timezone(&Shanghai)
            .format("%Y-%m-%d")
            .to_string();
        let szurl=format!("https://www.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON&CATALOGID=1842_xxpl&TABKEY=tab1&txtStart={date}&txtEnd={date}&random=0.9");
        let sseurl=format!("https://query.sse.com.cn/infodisplay/showTradePublicFile.do?jsonCallBack=cb&isPagination=false&dateTx={date}");
        let (a, b) = tokio::join!(
            g.json(
                RequestSpec::get(szurl)
                    .header(
                        "referer",
                        "https://www.szse.cn/disclosure/supervision/dealinfo/index.html"
                    )
                    .cache(1800)
            ),
            g.text(
                RequestSpec::get(sseurl)
                    .header(
                        "referer",
                        "https://www.sse.com.cn/disclosure/diclosure/public/"
                    )
                    .cache(1800)
            )
        );
        let mut stocks = Vec::new();
        if let Ok(v) = a {
            for x in v
                .pointer("/0/data")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let code = string(x.get("zqdm"));
                if valid_code(&code) {
                    stocks.push(json!({"code":code,"name":field(x,"zqjc"),"reason":x.get("plyy").cloned().unwrap_or(json!("深交所公开交易信息")),"netBuyWan":null}))
                }
            }
        }
        if let Ok(text) = b {
            if let (Some(s), Some(e)) = (text.find('('), text.rfind(')')) {
                if let Ok(v) = serde_json::from_str::<Value>(&text[s + 1..e]) {
                    let mut seen = HashSet::new();
                    for line in v
                        .get("fileContents")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                    {
                        if let Some(c) = re.captures(line) {
                            let code = c[1].to_string();
                            if seen.insert(code.clone()) {
                                stocks.push(json!({"code":code,"name":c[2].trim(),"reason":"上交所公开交易信息","netBuyWan":null}))
                            }
                        }
                    }
                }
            }
        }
        if !stocks.is_empty() {
            return ok_extra(
                json!({"date":date,"stocks":stocks}),
                json!({"meta":source_meta("dragonTiger","official-exchange","沪深交易所",true,&reason,"eastmoney")}),
            );
        }
    }
    fail("真实龙虎榜接口不可用", reason)
}

fn flow_row(line: &str) -> Option<Value> {
    let p: Vec<_> = line.split(',').collect();
    if p.first()?.is_empty() {
        return None;
    }
    Some(
        json!({"date":p[0],"mainNet":p.get(1).and_then(|x|x.parse::<f64>().ok()),"smallNet":p.get(2).and_then(|x|x.parse::<f64>().ok()),"midNet":p.get(3).and_then(|x|x.parse::<f64>().ok()),"largeNet":p.get(4).and_then(|x|x.parse::<f64>().ok()),"superNet":p.get(5).and_then(|x|x.parse::<f64>().ok()),"pct":p.get(6).and_then(|x|x.parse::<f64>().ok())}),
    )
}
fn sum_flow(rows: &[Value], key: &str, n: usize) -> f64 {
    rows.iter()
        .rev()
        .take(n)
        .filter_map(|x| number(field(x, key)))
        .sum()
}
async fn flow_names(g: &Arc<Gateway>, codes: &[String]) -> HashMap<String, String> {
    let symbols = codes
        .iter()
        .filter(|code| !symbol::is_legacy_beijing(code))
        .filter_map(|code| symbol::tencent_symbol(code))
        .collect::<Vec<_>>()
        .join(",");
    let Ok(text) = g
        .gbk(RequestSpec::get(format!("https://qt.gtimg.cn/q={symbols}")))
        .await
    else {
        return HashMap::new();
    };
    let mut out = HashMap::new();
    for line in text.split(';') {
        let Some(eq) = line.find('=') else { continue };
        let key = &line[2..eq];
        let code = key.get(2..).unwrap_or("");
        let Some(a) = line.find('"') else { continue };
        let Some(b) = line.rfind('"') else { continue };
        let parts: Vec<_> = line[a + 1..b].split('~').collect();
        if valid_code(code) && parts.len() > 1 {
            out.insert(code.into(), parts[1].into());
        }
    }
    out
}
pub(crate) async fn fund_flow(g: Arc<Gateway>, query: Query) -> Value {
    let codes: Vec<String> = q(&query, "codes")
        .split(',')
        .map(str::trim)
        .filter(|x| valid_code(x))
        .take(10)
        .map(str::to_owned)
        .collect();
    if codes.is_empty() {
        return fail("缺少股票代码", "");
    }
    let days = int(&query, "days", 60, 5, 120) as usize;
    let names = flow_names(&g, &codes).await;
    let mut items = Vec::new();
    for code in &codes {
        if symbol::is_legacy_beijing(code) {
            items.push(json!({"available":false,"code":code,"name":names.get(code).cloned().unwrap_or_default(),"source":null,"sourceLabel":"","fallbackReason":"北交所旧代码已迁移，请使用 920xxx 新代码","recent":[],"summary":{"main_5d":null,"main_20d":null,"main_60d":null,"today":null},"latestDate":null}));
            continue;
        }
        let Some(secid) = symbol::eastmoney_secid(code) else {
            continue;
        };
        let url=format!("https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid={secid}&klt=101&lmt={days}&fields1=f1%2Cf2%2Cf3%2Cf7&fields2=f51%2Cf52%2Cf53%2Cf54%2Cf55%2Cf56%2Cf57");
        let mut source = "eastmoney";
        let mut label = "东方财富";
        let mut fallback = String::new();
        let mut rows = match g
            .json(
                RequestSpec::get(url)
                    .em()
                    .header("referer", "https://quote.eastmoney.com/")
                    .cache(600),
            )
            .await
        {
            Ok(v) => v
                .pointer("/data/klines")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter_map(flow_row)
                .collect::<Vec<_>>(),
            Err(e) => {
                fallback = format!("东方财富: {e}");
                Vec::new()
            }
        };
        if rows.is_empty() {
            source = "sina";
            label = "新浪财经";
            let symbol = symbol::tencent_symbol(code).unwrap_or_default();
            let url=format!("https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_qsfx_zjlrqs?page=1&num={days}&sort=opendate&asc=0&daima={symbol}");
            if let Ok(text) = g
                .text(
                    RequestSpec::get(url)
                        .header("referer", "https://finance.sina.com.cn/")
                        .cache(600),
                )
                .await
            {
                if let (Some(a), Some(b)) = (text.find('['), text.rfind(']')) {
                    if let Ok(v) = serde_json::from_str::<Value>(&text[a..=b]) {
                        rows=v.as_array().into_iter().flatten().map(|x|json!({"date":field(x,"opendate"),"mainNet":number(field(x,"netamount")),"smallNet":null,"midNet":null,"largeNet":null,"superNet":null,"pct":number(field(x,"changeratio")).map(|n|n*100.0)})).collect();
                        rows.sort_by_key(|x| string(x.get("date")))
                    }
                }
            }
        }
        if rows.is_empty() {
            items.push(json!({"available":false,"code":code,"name":names.get(code).cloned().unwrap_or_default(),"source":null,"sourceLabel":"","fallbackReason":if fallback.is_empty(){"资金流不可用"}else{&fallback},"recent":[],"summary":{"main_5d":null,"main_20d":null,"main_60d":null,"today":null},"latestDate":null}));
            continue;
        }
        let last = rows.last().cloned();
        items.push(json!({"available":true,"code":code,"name":names.get(code).cloned().unwrap_or_default(),"source":source,"sourceLabel":label,"fallbackReason":fallback,"recent":rows.iter().rev().take(10).cloned().collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>(),"summary":{"main_5d":sum_flow(&rows,"mainNet",5),"main_20d":sum_flow(&rows,"mainNet",20),"main_60d":sum_flow(&rows,"mainNet",60),"today":last.as_ref().map(|x|json!({"main":field(x,"mainNet"),"large":field(x,"largeNet"),"medium":field(x,"midNet"),"small":field(x,"smallNet")}))},"latestDate":last.as_ref().map(|x|field(x,"date"))}));
        if codes.len() > 1 {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await
        }
    }
    let sources: HashSet<_> = items
        .iter()
        .filter_map(|x| x.get("source").and_then(Value::as_str))
        .collect();
    let unavailable: Vec<_> = items
        .iter()
        .filter(|x| field(x, "available").as_bool() != Some(true))
        .map(|x| field(x, "code"))
        .collect();
    ok_extra(
        json!({"days":days,"count":items.len(),"items":items}),
        json!({"meta":{"asOf":now_iso(),"degraded":items.iter().any(|x|field(x,"available").as_bool()!=Some(true)||field(x,"source")!="eastmoney"),"stale":false,"sources":{"fundFlow":{"actual":if sources.len()==1{sources.iter().next().copied()}else if sources.is_empty(){None}else{Some("mixed")},"unavailable":unavailable}}}}),
    )
}

pub(crate) async fn market_data(g: Arc<Gateway>, query: Query) -> Value {
    super::market::handle(
        g,
        q(&query, "type"),
        q(&query, "boardType"),
        q(&query, "period"),
    )
    .await
}
pub(crate) async fn stock_kline(g: Arc<Gateway>, query: Query) -> Value {
    super::kline::handle(
        g,
        q(&query, "code"),
        int(&query, "days", 260, 60, 520) as usize,
    )
    .await
}
pub(crate) async fn stock_minute(g: Arc<Gateway>, query: Query) -> Value {
    let source = if q(&query, "source").is_empty() {
        "auto"
    } else {
        q(&query, "source")
    };
    super::minute::handle(
        g,
        q(&query, "code"),
        int(&query, "count", 240, 1, 240) as usize,
        source,
    )
    .await
}
fn add_tag(c: &mut Candidate, value: &str) {
    let value = value.trim();
    if !value.is_empty() && !c.tags.iter().any(|x| x == value) {
        c.tags.push(value.into())
    }
}
fn add_source(c: &mut Candidate, value: &str) {
    if !c.source_types.iter().any(|x| x == value) {
        c.source_types.push(value.into())
    }
}
fn add_candidate_signal(c: &mut Candidate, label: &str, points: f64, detail: String) {
    c.source_score += points;
    c.signals
        .push(json!({"label":label,"points":round(points,1),"detail":detail}))
}
fn upsert<'a>(
    map: &'a mut HashMap<String, Candidate>,
    code: &str,
    name: &str,
) -> Option<&'a mut Candidate> {
    if !valid_code(code) {
        return None;
    }
    let c = map.entry(code.into()).or_insert_with(|| Candidate {
        code: code.into(),
        name: if name.is_empty() {
            code.into()
        } else {
            name.into()
        },
        ..Default::default()
    });
    if c.name == c.code && !name.is_empty() {
        c.name = name.into()
    }
    Some(c)
}
fn absorb_hot(map: &mut HashMap<String, Candidate>, payload: &Value, source: &str) {
    for x in payload
        .pointer("/data/items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(24)
    {
        let code = string(x.get("code"));
        let Some(c) = upsert(map, &code, &string(x.get("name"))) else {
            continue;
        };
        let rank = number(field(x, "rank")).unwrap_or(30.0);
        c.pct = c.pct.or_else(|| number(field(x, "pct")));
        c.price = c.price.or_else(|| number(field(x, "price")));
        for tag in x
            .get("concepts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .take(3)
            .filter_map(Value::as_str)
        {
            add_tag(c, tag)
        }
        add_tag(c, x.get("tag").and_then(Value::as_str).unwrap_or(""));
        add_source(c, "hot");
        add_candidate_signal(
            c,
            if source == "ths" {
                "同花顺热榜"
            } else {
                "东财人气榜"
            },
            (22.0 - rank * 0.65).clamp(5.0, 21.0),
            format!("热度排名 {rank}"),
        )
    }
}
fn absorb_limit(map: &mut HashMap<String, Candidate>, payload: &Value, kind: &str) {
    for x in payload
        .pointer("/data/items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(40)
    {
        let code = string(x.get("code"));
        let Some(c) = upsert(map, &code, &string(x.get("name"))) else {
            continue;
        };
        c.limit_type = kind.into();
        c.limit_down |= kind == "dt";
        c.pct = c.pct.or_else(|| number(field(x, "pct")));
        c.price = c.price.or_else(|| number(field(x, "price")));
        let industry = string(x.get("industry"));
        if c.industry.is_empty() {
            c.industry = industry.clone()
        }
        add_tag(c, &industry);
        add_source(c, "limit");
        let (points, label) = match kind {
            "zt" => (4.0, "涨停池"),
            "yzt" => (8.0, "昨涨停"),
            "zb" => (5.0, "炸板池"),
            _ => (-24.0, "跌停池"),
        };
        let detail = if kind == "zt" {
            string(x.get("ztStat"))
        } else if kind == "zb" {
            format!("{}次开板", field(x, "breakTimes"))
        } else {
            format!("{:.2}%", number(field(x, "pct")).unwrap_or(0.0))
        };
        add_candidate_signal(c, label, points, detail)
    }
}
fn absorb_dragon(map: &mut HashMap<String, Candidate>, payload: &Value) {
    for x in payload
        .pointer("/data/stocks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(24)
    {
        let code = string(x.get("code"));
        let Some(c) = upsert(map, &code, &string(x.get("name"))) else {
            continue;
        };
        let net = number(field(x, "netBuyWan"));
        c.dragon = net;
        c.dragon_reason = string(x.get("reason"));
        add_source(c, "dragon");
        add_candidate_signal(
            c,
            "龙虎榜",
            net.map(|x| (x / 2500.0).clamp(-10.0, 13.0)).unwrap_or(0.0),
            if net.is_some_and(|x| x >= 0.0) {
                "净买入".into()
            } else if net.is_some() {
                "净卖出".into()
            } else {
                "交易所公开信息".into()
            },
        )
    }
}
fn eligible_score(c: &Candidate) -> f64 {
    let mut s = c.source_score;
    if c.source_types.iter().any(|x| x != "limit") {
        s += 8.0
    }
    if c.limit_type == "zt" || c.pct.is_some_and(|x| x >= 9.2) {
        s -= 28.0
    }
    if c.limit_down {
        s -= 40.0
    }
    s
}
fn flow_metrics(v: &Value) -> (Option<f64>, Option<f64>, Option<f64>) {
    (
        v.pointer("/summary/today/main").and_then(number),
        v.pointer("/summary/main_5d").and_then(number),
        v.pointer("/summary/main_20d").and_then(number),
    )
}
fn score_candidate(c: &Candidate, fund: &Value, kline: &Value, news: &Value) -> Value {
    let tech = kline.pointer("/analysis/score").and_then(number);
    let momentum = kline
        .pointer("/analysis/indicators/momentum21")
        .and_then(number);
    let volume = kline
        .pointer("/analysis/indicators/volumeRatio")
        .and_then(number);
    let (ns, positive, risks) = if let Some(s) = news.get("score") {
        (
            number(field(s, "score")),
            s.get("positiveHits").cloned().unwrap_or(json!([])),
            s.get("riskHits").cloned().unwrap_or(json!([])),
        )
    } else {
        (None, json!([]), json!([]))
    };
    let (today, five, twenty) = flow_metrics(fund);
    let fund_available = fund.get("available").and_then(Value::as_bool) != Some(false)
        && [today, five, twenty].into_iter().any(|x| x.is_some());
    let topic =
        (48.0 + c.source_score + if c.tags.is_empty() { 0.0 } else { 4.0 }).clamp(0.0, 100.0);
    let momentum_score = c.pct.map(|p| {
        (50.0
            + p * 3.2
            + momentum.unwrap_or(0.0) * 0.75
            + if volume.is_some_and(|x| x > 1.4) {
                6.0
            } else {
                0.0
            })
        .clamp(0.0, 100.0)
    });
    let fund_score = if fund_available {
        Some(
            (50.0
                + today.unwrap_or(0.0) / 100_000_000.0 * 11.0
                + five.unwrap_or(0.0) / 300_000_000.0 * 8.0
                + c.dragon.unwrap_or(0.0) / 10000.0 * 3.0)
                .clamp(0.0, 100.0),
        )
    } else {
        None
    };
    let technical = tech.map(|x| (50.0 + x * 0.5).clamp(0.0, 100.0));
    let news_score = ns.map(|x| (50.0 + x * 9.0).clamp(0.0, 100.0));
    let components = json!({"topic":round(topic,0),"momentum":momentum_score.map(|x|round(x,0)),"fund":fund_score.map(|x|round(x,0)),"technical":technical.map(|x|round(x,0)),"news":news_score.map(|x|round(x,0))});
    let mut risk_items = Vec::new();
    if c.name.to_uppercase().contains("ST") || c.name.contains('退') {
        risk_items.push((30, "特殊风险"))
    }
    if c.limit_down {
        risk_items.push((22, "跌停池"))
    }
    if c.limit_type == "zt" {
        risk_items.push((18, "已涨停"))
    } else if c.pct.is_some_and(|x| x >= 9.2) {
        risk_items.push((12, "涨幅过热"))
    }
    if c.pct.is_some_and(|x| x <= -7.0) {
        risk_items.push((7, "跌幅过大"))
    }
    if tech.is_some_and(|x| x <= -35.0) {
        risk_items.push((8, "技术弱势"))
    }
    if today.unwrap_or(0.0) <= -100_000_000.0 {
        risk_items.push((6, "主力流出"))
    }
    if c.monitored {
        risk_items.push((18, "重点监控"))
    }
    if !c.anomaly_rule.is_empty() {
        risk_items.push((12, "严重异动"))
    }
    let risk_words = risks.as_array().cloned().unwrap_or_default();
    if !risk_words.is_empty() {
        risk_items.push(((risk_words.len() * 4).min(14) as i32, "新闻风险"))
    }
    let risk_points: i32 = risk_items.iter().map(|x| x.0).sum();
    let status = if risk_points >= 16 {
        "block"
    } else if risk_points >= 7 {
        "watch"
    } else {
        "pass"
    };
    let weights = [
        ("topic", 0.22),
        ("momentum", 0.20),
        ("fund", 0.20),
        ("technical", 0.20),
        ("news", 0.12),
    ];
    let available: Vec<_> = weights
        .iter()
        .filter_map(|(k, w)| number(&components[*k]).map(|x| (*k, *w, x)))
        .collect();
    let total: f64 = available.iter().map(|x| x.1).sum();
    let score = if available.len() >= 3 && total > 0.0 {
        Some(
            (available.iter().map(|x| x.1 * x.2).sum::<f64>() / total
                - (risk_points - 8).max(0) as f64 * 0.8)
                .clamp(0.0, 100.0),
        )
    } else {
        None
    };
    let mut topic_tags = c.tags.iter().take(3).cloned().collect::<Vec<_>>();
    if topic_tags.is_empty() && !c.dragon_reason.is_empty() {
        topic_tags.push(c.dragon_reason.clone())
    }
    let mut signals = c.signals.clone();
    signals.sort_by(|a, b| {
        number(field(b, "points"))
            .unwrap_or(0.0)
            .abs()
            .total_cmp(&number(field(a, "points")).unwrap_or(0.0).abs())
    });
    signals.truncate(5);
    let bars = kline
        .get("bars")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let valid: Vec<_> = bars
        .iter()
        .filter_map(|x| number(field(x, "pct")))
        .collect();
    let up_rate = if valid.is_empty() {
        None
    } else {
        Some(round(
            valid.iter().filter(|x| **x > 0.0).count() as f64 / valid.len() as f64 * 100.0,
            1,
        ))
    };
    json!({"code":c.code,"name":c.name,"price":c.price,"pct":c.pct.map(|x|round(x,2)),"score":score.map(|x|round(x,0)),"coverage":(available.len()as f64/5.0*100.0).round(),"missingSources":weights.iter().filter(|(k,_)|number(&components[*k]).is_none()).map(|x|x.0).collect::<Vec<_>>(),"topic":if topic_tags.is_empty(){"--".into()}else{topic_tags.join(" / ")},"components":components,"risk":{"status":status,"label":if status=="block"{"回避"}else if status=="watch"{"观察"}else{"可跟踪"},"points":risk_points,"reasons":risk_items.iter().take(4).map(|x|x.1).collect::<Vec<_>>()},"marketWarnings":{"monitored":c.monitored,"monitorEnd":c.monitor_end,"anomaly":!c.anomaly_rule.is_empty(),"anomalyRule":c.anomaly_rule},"signals":signals,"upDayRate60":up_rate,"newsHits":positive,"newsRisks":risks,"latestDate":kline.get("latestDate").cloned().unwrap_or(json!(""))})
}

fn monitor_market(raw: &str) -> String {
    match raw.to_ascii_uppercase().as_str() {
        "1" => "SH".into(),
        "0" => "SZ".into(),
        "B" => "BJ".into(),
        value => format!("?{value}"),
    }
}

fn parse_stock_monitor(value: &Value, date: &str) -> Result<Vec<Value>, ApiError> {
    let rows = value
        .as_array()
        .ok_or_else(|| ApiError::parse("重点监控响应不是数组"))?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let code = row.get("STKCODE")?.as_str()?;
            let start = row
                .get("VALIDATESTARTDATE")
                .and_then(Value::as_str)
                .unwrap_or("");
            let end = row
                .get("VALIDATEENDDATE")
                .and_then(Value::as_str)
                .unwrap_or("");
            if !valid_code(code) || start > date || end < date {
                return None;
            }
            Some(json!({
                "code":code,
                "name":row.get("STKNAME").and_then(Value::as_str).unwrap_or(""),
                "market":monitor_market(row.get("MARKET").and_then(Value::as_str).unwrap_or("")),
                "start":start,
                "end":end,
                "link":row.get("LINK_URL").and_then(Value::as_str).unwrap_or("")
            }))
        })
        .collect())
}

pub(crate) async fn stock_monitor(g: &Arc<Gateway>) -> Result<Vec<Value>, ApiError> {
    let value = g
        .json(
            RequestSpec::get(
                "https://mobappconfig.securities.eastmoney.com/emcfg/stock_monitor.json",
            )
            .em()
            .independent_circuit()
            .header("referer", "https://vipmoney.eastmoney.com/")
            .cache(1800),
        )
        .await?;
    parse_stock_monitor(&value, &today_iso())
}

fn anomaly_rule(code: i64) -> String {
    match code {
        1 => "主板10日内4次同向异常波动",
        2 => "创业板10日内3次同向异常波动",
        3 => "科创板10日内3次同向异常波动",
        4 => "10日累计正偏离达到100%",
        5 => "10日累计负偏离达到50%",
        6 => "30日累计正偏离达到200%",
        7 => "30日累计负偏离达到70%",
        8 => "北交所10日内3次同向异常波动",
        40 => "科创板10日累计正偏离达到150%",
        50 => "科创板10日累计负偏离达到60%",
        60 => "科创板30日累计正偏离达到300%",
        70 => "科创板30日累计负偏离达到75%",
        _ => return format!("未知异动规则 {code}"),
    }
    .into()
}

fn anomaly_market(code: &str, raw_market: i64, board: i64) -> &'static str {
    if symbol::exchange(code) == Some(symbol::Exchange::Beijing) || board == 8 {
        "BJ"
    } else if raw_market == 1 {
        "SH"
    } else {
        "SZ"
    }
}

fn parse_price_anomaly(value: &Value) -> Result<Value, ApiError> {
    if value.get("result").and_then(Value::as_i64) != Some(0) {
        return Err(ApiError::new(format!(
            "东财异动接口拒绝: result={} msg={}",
            field(value, "result"),
            string(value.get("msg"))
        )));
    }
    let items = value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let code = string(row.get("c"));
            if !valid_code(&code) {
                return None;
            }
            let board = number(field(row, "s")).unwrap_or(0.0) as i64;
            let base_rule = number(field(row, "e")).unwrap_or(0.0) as i64;
            let rule_code = if board == 6 && matches!(base_rule, 4..=7) {
                base_rule * 10
            } else {
                base_rule
            };
            Some(json!({
                "code":code,
                "name":string(row.get("n")),
                "market":anomaly_market(&code,number(field(row,"m")).unwrap_or(0.0)as i64,board),
                "changePct":number(field(row,"a")),
                "deviation":number(field(row,"x")),
                "days":number(field(row,"d")),
                "board":board,
                "ruleCode":rule_code,
                "rule":anomaly_rule(rule_code),
                "isToday":number(field(row,"o")).unwrap_or(0.0)as i64 != 2
            }))
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "date":value.get("date").cloned().unwrap_or(json!("")),
        "pages":value.get("pages").cloned().unwrap_or(json!(0)),
        "items":items
    }))
}

pub(crate) async fn price_anomaly(g: &Arc<Gateway>) -> Result<Value, ApiError> {
    let value = g
        .json(
            RequestSpec::get("https://dycalchis.eastmoney.com/price-anomaly/list?team=h5&product=EastMoney&client=WAP&version=9001&name=WAP&user=123&pageSize=200&pageNo=1")
                .em()
                .independent_circuit()
                .header("referer", "https://vipmoney.eastmoney.com/")
                .cache(300),
        )
        .await?;
    parse_price_anomaly(&value)
}

fn market_warning_data(
    codes: &[String],
    monitor: Option<&[Value]>,
    anomaly: Option<&Value>,
) -> Map<String, Value> {
    let monitor_by_code = monitor
        .unwrap_or_default()
        .iter()
        .filter_map(|item| Some((item.get("code")?.as_str()?, item)))
        .collect::<HashMap<_, _>>();
    let anomaly_by_code = anomaly
        .and_then(|value| value.get("items"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| Some((item.get("code")?.as_str()?, item)))
        .collect::<HashMap<_, _>>();
    codes
        .iter()
        .map(|code| {
            let monitored = monitor.map(|_| monitor_by_code.contains_key(code.as_str()));
            let anomaly_hit = anomaly.map(|_| anomaly_by_code.contains_key(code.as_str()));
            let monitor_end = monitor_by_code
                .get(code.as_str())
                .map(|item| string(item.get("end")))
                .unwrap_or_default();
            let anomaly_rule = anomaly_by_code
                .get(code.as_str())
                .map(|item| string(item.get("rule")))
                .unwrap_or_default();
            (
                code.clone(),
                json!({
                    "code":code,
                    "monitored":monitored,
                    "monitorEnd":monitor_end,
                    "anomaly":anomaly_hit,
                    "anomalyRule":anomaly_rule
                }),
            )
        })
        .collect()
}

pub(crate) async fn market_warnings(g: Arc<Gateway>, query: Query) -> Value {
    let mut seen = HashSet::new();
    let codes = q(&query, "codes")
        .split(',')
        .map(str::trim)
        .filter(|code| valid_code(code) && seen.insert((*code).to_string()))
        .take(100)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if codes.is_empty() {
        return fail("缺少股票代码", "");
    }
    let (monitor_result, anomaly_result) = tokio::join!(stock_monitor(&g), price_anomaly(&g));
    if monitor_result.is_err() && anomaly_result.is_err() {
        return fail(
            "市场异动数据不可用",
            format!(
                "重点监控: {}; 严重异动: {}",
                monitor_result
                    .as_ref()
                    .err()
                    .map(|error| error.message.as_str())
                    .unwrap_or("未知错误"),
                anomaly_result
                    .as_ref()
                    .err()
                    .map(|error| error.message.as_str())
                    .unwrap_or("未知错误")
            ),
        );
    }
    let degraded = monitor_result.is_err() || anomaly_result.is_err();
    let data = market_warning_data(
        &codes,
        monitor_result.as_deref().ok(),
        anomaly_result.as_ref().ok(),
    );
    ok_extra(
        Value::Object(data),
        json!({
            "meta":{
                "degraded":degraded,
                "stale":false,
                "sources":{
                    "stockMonitor":{"status":if monitor_result.is_ok(){"live"}else{"failed"},"actual":"eastmoney","actualLabel":"东方财富重点监控"},
                    "priceAnomaly":{"status":if anomaly_result.is_ok(){"live"}else{"failed"},"actual":"eastmoney","actualLabel":"东方财富严重异动"}
                }
            }
        }),
    )
}

fn apply_market_warnings(
    candidates: &mut HashMap<String, Candidate>,
    monitor: &[Value],
    anomaly: &Value,
) {
    let monitors = monitor
        .iter()
        .filter_map(|item| Some((item.get("code")?.as_str()?, item)))
        .collect::<HashMap<_, _>>();
    let anomalies = anomaly
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| Some((item.get("code")?.as_str()?, item)))
        .collect::<HashMap<_, _>>();
    for candidate in candidates.values_mut() {
        if let Some(item) = monitors.get(candidate.code.as_str()) {
            candidate.monitored = true;
            candidate.monitor_end = string(item.get("end"));
            candidate.signals.push(json!({"label":"重点监控","points":-18.0,"detail":format!("监控至 {}",candidate.monitor_end)}));
        }
        if let Some(item) = anomalies.get(candidate.code.as_str()) {
            candidate.anomaly_rule = string(item.get("rule"));
            candidate
                .signals
                .push(json!({"label":"严重异动","points":-12.0,"detail":candidate.anomaly_rule}));
        }
    }
}

pub(crate) async fn opportunity_radar(g: Arc<Gateway>, query: Query) -> Value {
    use futures::{stream, StreamExt};
    let limit = int(&query, "limit", 8, 1, 20) as usize;
    let (ths, em, zt, yzt, zb, dt, dragon, sector, monitor, anomaly) = tokio::join!(
        hot_rank(
            g.clone(),
            HashMap::from([
                ("source".into(), "ths".into()),
                ("limit".into(), "24".into())
            ])
        ),
        hot_rank(
            g.clone(),
            HashMap::from([
                ("source".into(), "em".into()),
                ("limit".into(), "18".into())
            ])
        ),
        limit_up(
            g.clone(),
            HashMap::from([("type".into(), "zt".into()), ("limit".into(), "40".into())])
        ),
        limit_up(
            g.clone(),
            HashMap::from([("type".into(), "yzt".into()), ("limit".into(), "30".into())])
        ),
        limit_up(
            g.clone(),
            HashMap::from([("type".into(), "zb".into()), ("limit".into(), "24".into())])
        ),
        limit_up(
            g.clone(),
            HashMap::from([("type".into(), "dt".into()), ("limit".into(), "20".into())])
        ),
        dragon_tiger(g.clone(), HashMap::new()),
        market_data(g.clone(), HashMap::from([("type".into(), "sector".into())])),
        stock_monitor(&g),
        price_anomaly(&g)
    );
    let mut map = HashMap::new();
    if ths["success"] == true {
        absorb_hot(&mut map, &ths, "ths")
    }
    if em["success"] == true {
        absorb_hot(&mut map, &em, "em")
    }
    for (payload, kind) in [(&zt, "zt"), (&yzt, "yzt"), (&zb, "zb"), (&dt, "dt")] {
        if payload["success"] == true {
            absorb_limit(&mut map, payload, kind)
        }
    }
    if dragon["success"] == true {
        absorb_dragon(&mut map, &dragon)
    }
    if sector["success"] == true {
        for c in map.values_mut() {
            let text = format!("{} {}", c.industry, c.tags.join(" "));
            let inflow = sector
                .pointer("/data/inflow")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .find(|x| {
                    let n = string(x.get("name"));
                    !n.is_empty() && (text.contains(&n) || string(x.get("leader")) == c.name)
                });
            let outflow = sector
                .pointer("/data/outflow")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .find(|x| {
                    let n = string(x.get("name"));
                    !n.is_empty() && (text.contains(&n) || string(x.get("leader")) == c.name)
                });
            if let Some(x) = inflow.or(outflow) {
                let points = if inflow.is_some() { 8.0 } else { -6.0 };
                let name = string(x.get("name"));
                add_tag(c, &name);
                add_source(c, "sector");
                add_candidate_signal(
                    c,
                    "板块资金",
                    points,
                    format!("{} {}", name, string(x.get("value"))),
                )
            }
        }
    }
    let monitor_data = monitor.as_ref().map(Vec::as_slice).unwrap_or(&[]);
    let anomaly_data = anomaly.as_ref().unwrap_or(&Value::Null);
    apply_market_warnings(&mut map, monitor_data, anomaly_data);
    let mut pool: Vec<_> = map
        .into_values()
        .filter(|c| c.source_score > -25.0 && !c.limit_down)
        .collect();
    pool.sort_by(|a, b| eligible_score(b).total_cmp(&eligible_score(a)));
    pool.sort_by_key(|c| {
        let non = c.source_types.iter().any(|x| x != "limit");
        let board = c.limit_type == "zt" || c.pct.is_some_and(|x| x >= 9.2);
        match (non, board) {
            (true, false) => 0,
            (false, false) => 1,
            (true, true) => 2,
            _ => 3,
        }
    });
    pool.truncate(limit);
    let quote = stock(
        g.clone(),
        HashMap::from([(
            "codes".into(),
            pool.iter()
                .map(|x| x.code.as_str())
                .collect::<Vec<_>>()
                .join(","),
        )]),
    )
    .await;
    for c in &mut pool {
        if let Some(x) = quote.pointer(&format!("/data/{}", c.code)) {
            c.name = string(x.get("name"));
            c.pct = number(field(x, "changePercent"));
            c.price = number(field(x, "priceValue"))
        }
    }
    let flow = fund_flow(
        g.clone(),
        HashMap::from([
            (
                "codes".into(),
                pool.iter()
                    .map(|x| x.code.as_str())
                    .collect::<Vec<_>>()
                    .join(","),
            ),
            ("days".into(), "60".into()),
        ]),
    )
    .await;
    let funds: HashMap<_, _> = flow
        .pointer("/data/items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|x| Some((x.get("code")?.as_str()?.to_string(), x.clone())))
        .collect();
    let work = stream::iter(pool.into_iter().map(|c| {
        let g = g.clone();
        let fund = funds.get(&c.code).cloned().unwrap_or(Value::Null);
        async move {
            let (k, n) = tokio::join!(
                super::kline::handle(g.clone(), &c.code, 260),
                stock_news(
                    g.clone(),
                    HashMap::from([
                        ("code".into(), c.code.clone()),
                        ("name".into(), c.name.clone()),
                        ("limit".into(), "4".into())
                    ])
                )
            );
            score_candidate(
                &c,
                &fund,
                k.get("data").unwrap_or(&Value::Null),
                n.get("data").unwrap_or(&Value::Null),
            )
        }
    }))
    .buffer_unordered(3);
    let mut items: Vec<_> = work.collect().await;
    items.sort_by(|a, b| {
        number(field(b, "score"))
            .unwrap_or(-1.0)
            .total_cmp(&number(field(a, "score")).unwrap_or(-1.0))
    });
    let generated = now_iso();
    let status = json!({"hotRank":ths["success"]==true||em["success"]==true,"limitUp":zt["success"]==true||yzt["success"]==true||zb["success"]==true,"dragonTiger":dragon["success"]==true,"sector":sector["success"]==true,"stockMonitor":monitor.is_ok(),"priceAnomaly":anomaly.is_ok()});
    let degraded = status
        .as_object()
        .is_some_and(|object| object.values().any(|x| x != &json!(true)));
    ok_extra(
        json!({"generatedAt":generated,"sourceStatus":status,"items":items}),
        json!({"meta":{"generatedAt":generated,"sources":{"hotRankThs":{"status":if ths["success"]==true{"live"}else{"failed"}},"hotRankEm":{"status":if em["success"]==true{"live"}else{"failed"}},"limitUpZt":{"status":if zt["success"]==true{"live"}else{"failed"}},"limitUpYzt":{"status":if yzt["success"]==true{"live"}else{"failed"}},"limitUpZb":{"status":if zb["success"]==true{"live"}else{"failed"}},"limitUpDt":{"status":if dt["success"]==true{"live"}else{"failed"}},"dragonTiger":{"status":if dragon["success"]==true{"live"}else{"failed"}},"sector":{"status":if sector["success"]==true{"live"}else{"failed"}},"stockMonitor":{"status":if monitor.is_ok(){"live"}else{"failed"}},"priceAnomaly":{"status":if anomaly.is_ok(){"live"}else{"failed"}}},"stale":false,"degraded":degraded}}),
    )
}

#[cfg(test)]
mod contract_tests {
    use super::*;

    #[test]
    fn cls_signature_matches_existing_contract() {
        let (query, sign) = cls_request("", 3);
        assert_eq!(
            query,
            "appName=CailianpressWeb&last_time=&os=web&refresh_type=1&rn=3&sv=7.7.5"
        );
        assert_eq!(sign, "1f0bc409e7f8da02c2638332fd9bc9f3");
    }

    #[test]
    fn query_numbers_are_bounded() {
        let query = HashMap::from([("limit".to_string(), "9999".to_string())]);
        assert_eq!(int(&query, "limit", 20, 1, 100), 100);
        assert_eq!(int(&HashMap::new(), "limit", 20, 1, 100), 20);
    }

    #[test]
    fn eastmoney_fast_news_uses_current_identity_and_cursor_fields() {
        let row = map_em_news_row(&json!({
            "code":"202608103836936514",
            "realSort":"1786370909036514",
            "showTime":"2026-08-10 22:08:29",
            "title":"美股存储股短线拉升",
            "summary":"测试摘要"
        }))
        .unwrap();
        assert_eq!(row["id"], "202608103836936514");
        assert_eq!(row["cursor"], "1786370909036514");
        assert_eq!(row["url"], "https://kuaixun.eastmoney.com/");
    }

    #[test]
    fn malformed_limit_up_time_is_safe_and_short_time_is_padded() {
        assert_eq!(zt_time(&json!(93000)), "09:30:00");
        assert_eq!(zt_time(&json!("bad")), "");
    }

    #[tokio::test]
    async fn legacy_beijing_quote_is_rejected_without_requesting_zombie_data() {
        let result = stock(
            Gateway::new(),
            HashMap::from([("codes".to_string(), "832982".to_string())]),
        )
        .await;
        assert_eq!(result["success"], false);
        assert_eq!(result["errorCode"], "invalid_input");
        assert_eq!(result["retryable"], false);
    }

    #[test]
    fn monitor_and_anomaly_parsers_preserve_beijing_and_reject_api_errors() {
        let monitor = parse_stock_monitor(
            &json!([{
                "MARKET":"B","STKCODE":"920575","STKNAME":"示例",
                "VALIDATESTARTDATE":"2026-08-10","VALIDATEENDDATE":"2026-08-14"
            }]),
            "2026-08-10",
        )
        .unwrap();
        assert_eq!(monitor[0]["market"], "BJ");

        let anomaly = parse_price_anomaly(&json!({
            "result":0,"date":20260810,"pages":1,"data":[
                {"m":0,"c":"920575","n":"示例","s":8,"e":8,"x":40.0,"d":10,"a":12.0,"o":1},
                {"m":1,"c":"688001","n":"科创示例","s":6,"e":4,"x":151.0,"d":10,"a":15.0,"o":2}
            ]
        }))
        .unwrap();
        assert_eq!(anomaly["items"][0]["market"], "BJ");
        assert_eq!(anomaly["items"][0]["ruleCode"], 8);
        assert_eq!(anomaly["items"][1]["ruleCode"], 40);
        assert!(parse_price_anomaly(&json!({"result":1001,"msg":"unknow team"})).is_err());
    }

    #[test]
    fn market_warnings_are_attached_without_removing_candidates() {
        let mut candidates = HashMap::from([(
            "920575".to_string(),
            Candidate {
                code: "920575".into(),
                name: "示例".into(),
                ..Default::default()
            },
        )]);
        let monitor = vec![json!({"code":"920575","end":"2026-08-14"})];
        let anomaly = json!({"items":[{"code":"920575","rule":"北交所严重异动"}]});
        apply_market_warnings(&mut candidates, &monitor, &anomaly);
        let candidate = &candidates["920575"];
        assert!(candidate.monitored);
        assert_eq!(candidate.monitor_end, "2026-08-14");
        assert_eq!(candidate.anomaly_rule, "北交所严重异动");
        assert_eq!(candidate.signals.len(), 2);
    }

    #[test]
    fn market_warning_batch_distinguishes_hits_absence_and_unavailable_sources() {
        let codes = vec!["600664".to_string(), "600519".to_string()];
        let monitor = vec![json!({"code":"600519","end":"2026-08-20"})];
        let anomaly = json!({"items":[{"code":"600664","rule":"30日累计正偏离达到200%"}]});
        let complete = market_warning_data(&codes, Some(&monitor), Some(&anomaly));
        assert_eq!(complete["600664"]["anomaly"], true);
        assert_eq!(complete["600664"]["anomalyRule"], "30日累计正偏离达到200%");
        assert_eq!(complete["600664"]["monitored"], false);
        assert_eq!(complete["600519"]["monitored"], true);
        assert_eq!(complete["600519"]["monitorEnd"], "2026-08-20");

        let partial = market_warning_data(&codes, None, Some(&anomaly));
        assert!(partial["600664"]["monitored"].is_null());
        assert_eq!(partial["600519"]["anomaly"], false);
    }
}

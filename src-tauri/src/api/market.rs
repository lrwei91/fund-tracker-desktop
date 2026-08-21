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

fn breadth_count(v: &Value) -> Option<u64> {
    let value = num(v)?;
    if value.is_finite() && value >= 0.0 && value.fract() == 0.0 {
        Some(value as u64)
    } else {
        None
    }
}

fn parse_market_breadth(value: &Value) -> Result<Value, ApiError> {
    let rows = value
        .pointer("/data/diff")
        .and_then(Value::as_array)
        .ok_or_else(|| ApiError::new("东财市场涨跌家数为空"))?;
    let expected = [
        ("000002", "上证A股"),
        ("399107", "深证A股"),
        ("899050", "北交所"),
    ];
    let mut markets = Vec::with_capacity(expected.len());
    let (mut up, mut down, mut flat) = (0_u64, 0_u64, 0_u64);
    for (code, fallback_name) in expected {
        let row = rows
            .iter()
            .find(|row| row["f12"].as_str() == Some(code))
            .ok_or_else(|| ApiError::new(format!("东财市场涨跌家数缺少 {code}")))?;
        let market_up = breadth_count(&row["f104"])
            .ok_or_else(|| ApiError::new(format!("东财上涨家数字段无效 {code}")))?;
        let market_down = breadth_count(&row["f105"])
            .ok_or_else(|| ApiError::new(format!("东财下跌家数字段无效 {code}")))?;
        let market_flat = breadth_count(&row["f106"])
            .ok_or_else(|| ApiError::new(format!("东财平盘家数字段无效 {code}")))?;
        up += market_up;
        down += market_down;
        flat += market_flat;
        markets.push(json!({
            "code":code,
            "name":row["f14"].as_str().unwrap_or(fallback_name),
            "up":market_up,
            "down":market_down,
            "flat":market_flat,
            "covered":market_up + market_down + market_flat
        }));
    }
    let covered = up + down + flat;
    if covered == 0 {
        return Err(ApiError::new("东财市场涨跌家数无有效样本"));
    }
    Ok(json!({
        "available":true,
        "up":up,
        "down":down,
        "flat":flat,
        "covered":covered,
        "markets":markets,
        "source":"eastmoney",
        "sourceLabel":"东方财富"
    }))
}

async fn market_breadth(g: &Arc<Gateway>) -> Result<Value, ApiError> {
    let url = "https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&secids=1.000002%2C0.399107%2C0.899050&fields=f12%2Cf14%2Cf104%2Cf105%2Cf106";
    let value = g
        .json(
            RequestSpec::get(url)
                .em()
                .header("referer", "https://quote.eastmoney.com/")
                .cache(30)
                .timeout(15),
        )
        .await?;
    parse_market_breadth(&value)
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
    json!({"available":false,"source":null,"sourceLabel":"","label":"主力","value":"--","isPositive":null,"note":"暂无数据","degraded":false,"breakdown":{"superLarge":{"label":"超大单","value":"--","isPositive":null},"large":{"label":"大单","value":"--","isPositive":null},"medium":{"label":"中单","value":"--","isPositive":null},"small":{"label":"小单","value":"--","isPositive":null}}})
}
fn flow_value(label: &str, value: f64) -> Value {
    json!({"available":true,"label":label,"value":yi(value),"isPositive":value>=0.0})
}
async fn eastmoney_main_fund(g: &Arc<Gateway>) -> Result<Value, ApiError> {
    let url="https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=6000&po=1&np=1&fltt=2&invt=2&fs=m%3A0%2Bt%3A6%2Cm%3A0%2Bt%3A80%2Cm%3A1%2Bt%3A2%2Cm%3A1%2Bt%3A23%2Cm%3A0%2Bt%3A81%2Bs%3A2048&fields=f12%2Cf14%2Cf62%2Cf66%2Cf72%2Cf78%2Cf84";
    let v = g.json(RequestSpec::get(url).em().timeout(15)).await?;
    let rows = v
        .pointer("/data/diff")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if rows.is_empty() {
        return Err(ApiError::new("东财全市场资金流为空"));
    }
    let sum = |k: &str| rows.iter().filter_map(|x| num(&x[k])).sum::<f64>();
    let (a, b, c, d, e) = (sum("f62"), sum("f66"), sum("f72"), sum("f78"), sum("f84"));
    Ok(
        json!({"available":true,"source":"eastmoney","sourceLabel":"东方财富","label":"主力","value":yi(a),"isPositive":a>=0.0,"note":"东方财富全市场主力净流入","degraded":false,"breakdown":{"superLarge":flow_value("超大单",b),"large":flow_value("大单",c),"medium":flow_value("中单",d),"small":flow_value("小单",e)}}),
    )
}
fn sina_main_fund_rows(rows: &[Value]) -> Result<Value, ApiError> {
    if rows.len() < 100 {
        return Err(ApiError::new("新浪沪深A股资金流数据不完整"));
    }
    let sum = |key: &str| rows.iter().filter_map(|row| num(&row[key])).sum::<f64>();
    let main_net = sum("r0_net");
    let main_in = sum("r0_in");
    let main_out = sum("r0_out");
    let retail_net = sum("r3_net");
    if ![main_net, main_in, main_out, retail_net]
        .iter()
        .all(|value| value.is_finite())
    {
        return Err(ApiError::new("新浪沪深A股资金流字段无效"));
    }
    Ok(json!({
        "available":true,
        "source":"sina",
        "sourceLabel":"新浪财经",
        "label":"主力",
        "value":yi(main_net),
        "isPositive":main_net>=0.0,
        "note":"新浪口径：主力为单笔成交额不低于100万元",
        "degraded":true,
        "breakdown":{
            "superLarge":{"available":false,"label":"特大单","value":"--","isPositive":null},
            "large":flow_value("主力流入",main_in),
            "medium":flow_value("主力流出",-main_out),
            "small":flow_value("散户",retail_net)
        }
    }))
}
async fn sina_main_fund(g: &Arc<Gateway>) -> Result<Value, ApiError> {
    let url="https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzj_ssggzj?page=1&num=7000&sort=symbol&asc=1&bankuai=hs_a&shichang=";
    let value = g
        .json(
            RequestSpec::get(url)
                .header("referer", "https://finance.sina.com.cn/")
                .cache(60)
                .timeout(20),
        )
        .await?;
    let rows = value
        .as_array()
        .ok_or_else(|| ApiError::new("新浪沪深A股资金流返回格式异常"))?;
    sina_main_fund_rows(rows)
}
async fn main_fund(g: &Arc<Gateway>) -> Value {
    match eastmoney_main_fund(g).await {
        Ok(value) => value,
        Err(primary) => match sina_main_fund(g).await {
            Ok(mut value) => {
                value["fallbackReason"] = json!(format!("东方财富: {primary}"));
                value
            }
            Err(fallback) => {
                let mut value = unavailable_main();
                value["note"] = json!(format!("东方财富: {primary}; 新浪财经: {fallback}"));
                value
            }
        },
    }
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
#[derive(Clone, Copy)]
struct BoardSpec {
    board_type: &'static str,
    period: &'static str,
    fs: &'static str,
    main: &'static str,
    main_pct: &'static str,
    change_pct: &'static str,
    leader: Option<&'static str>,
}

fn board_spec(board_type: &str, period: &str) -> Result<BoardSpec, ApiError> {
    let (board_type, fs) = match board_type {
        "" | "industry" => ("industry", "m:90+t:2"),
        "concept" => ("concept", "m:90+t:3"),
        "region" => ("region", "m:90+t:1"),
        _ => return Err(ApiError::new("无效的板块类型")),
    };
    let (period, main, main_pct, change_pct, leader) = match period {
        "" | "today" => ("today", "f62", "f184", "f3", Some("f204")),
        "5d" => ("5d", "f164", "f165", "f109", Some("f257")),
        "10d" => ("10d", "f174", "f175", "f160", None),
        _ => return Err(ApiError::new("无效的板块资金周期")),
    };
    Ok(BoardSpec {
        board_type,
        period,
        fs,
        main,
        main_pct,
        change_pct,
        leader,
    })
}

fn sector_rows(v: &Value, spec: BoardSpec, positive: bool) -> Result<Vec<Value>, ApiError> {
    let raw = v
        .pointer("/data/diff")
        .and_then(Value::as_array)
        .ok_or_else(|| ApiError::new("板块资金流数据为空"))?;
    let rows = raw
        .iter()
        .filter_map(|x| {
            let name = x.get("f14").and_then(Value::as_str)?;
            let fund = num(&x[spec.main])?;
            if (positive && fund <= 0.0) || (!positive && fund >= 0.0) {
                return None;
            }
            Some(json!({
                "name":name,
                "code":x.get("f12").and_then(Value::as_str).unwrap_or(""),
                "value":yi(fund),
                "mainFundYuan":fund,
                "mainFundPct":num(&x[spec.main_pct]),
                "changePct":num(&x[spec.change_pct]).unwrap_or(0.0),
                "leader":spec.leader.and_then(|field|x.get(field)).and_then(Value::as_str).unwrap_or("")
            }))
        })
        .take(10)
        .collect();
    Ok(rows)
}

fn sina_fenlei(board_type: &str) -> Result<&'static str, ApiError> {
    match board_type {
        "industry" => Ok("9"),
        "concept" => Ok("1"),
        "region" => Ok("8"),
        _ => Err(ApiError::new("无效的板块类型")),
    }
}

fn sina_sector_rows(
    value: &Value,
    spec: BoardSpec,
    positive: bool,
) -> Result<Vec<Value>, ApiError> {
    let raw = value
        .as_array()
        .ok_or_else(|| ApiError::new("新浪板块资金流返回格式异常"))?;
    if raw.is_empty() {
        return Err(ApiError::new("新浪板块资金流数据为空"));
    }
    let (fund_key, pct_key, change_key) = match spec.period {
        "today" => (
            "netamount".to_string(),
            "ratioamount".to_string(),
            "avg_changeratio".to_string(),
        ),
        period => (
            format!("netamount_{}", period.trim_end_matches('d')),
            format!("ratioamount_{}", period.trim_end_matches('d')),
            format!("avg_changeratio_{}", period.trim_end_matches('d')),
        ),
    };
    Ok(raw
        .iter()
        .filter_map(|row| {
            let fund = num(&row[&fund_key])?;
            if (positive && fund <= 0.0) || (!positive && fund >= 0.0) {
                return None;
            }
            Some(json!({
                "name":row.get("name").and_then(Value::as_str).unwrap_or(""),
                "code":row.get("category").and_then(Value::as_str).unwrap_or(""),
                "value":yi(fund),
                "mainFundYuan":fund,
                "mainFundPct":num(&row[&pct_key]).map(|value|value*100.0),
                "changePct":num(&row[&change_key]).map(|value|value*100.0).unwrap_or(0.0),
                "leader":if spec.period == "today" {row.get("ts_name").and_then(Value::as_str).unwrap_or("")} else {""}
            }))
        })
        .take(10)
        .collect())
}

async fn sina_sector_side(
    g: &Arc<Gateway>,
    spec: BoardSpec,
    positive: bool,
) -> Result<Vec<Value>, ApiError> {
    let fenlei = sina_fenlei(spec.board_type)?;
    let asc = if positive { 0 } else { 1 };
    let url = if spec.period == "today" {
        format!("https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzj_bk?page=1&num=20&sort=netamount&asc={asc}&fenlei={fenlei}")
    } else {
        let days = spec.period.trim_end_matches('d');
        format!("https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzjlxt?page=1&num=20&sort=netamount_{days}&asc={asc}&fenlei={fenlei}")
    };
    let value = g
        .json(
            RequestSpec::get(url)
                .header("referer", "https://finance.sina.com.cn/")
                .cache(60)
                .timeout(15),
        )
        .await?;
    sina_sector_rows(&value, spec, positive)
}

async fn sector_side(
    g: &Arc<Gateway>,
    spec: BoardSpec,
    positive: bool,
) -> Result<Vec<Value>, ApiError> {
    let order = if positive { 1 } else { 0 };
    let mut fields = vec!["f12", "f14", spec.change_pct, spec.main, spec.main_pct];
    if let Some(leader) = spec.leader {
        fields.push(leader);
    }
    fields.sort_unstable();
    fields.dedup();
    let url = format!(
        "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=20&po={order}&np=1&fltt=2&invt=2&fid={}&fs={}&fields={}",
        spec.main,
        urlencoding::encode(spec.fs),
        fields.join("%2C")
    );
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
    sector_rows(&v, spec, positive)
}

async fn eastmoney_sectors(
    g: &Arc<Gateway>,
    board_type: &str,
    period: &str,
) -> Result<Value, ApiError> {
    let spec = board_spec(board_type, period)?;
    let (inflow, outflow) = tokio::join!(sector_side(g, spec, true), sector_side(g, spec, false));
    Ok(json!({
        "boardType":spec.board_type,
        "period":spec.period,
        "inflow":inflow?,
        "outflow":outflow?
    }))
}

async fn sina_sectors(g: &Arc<Gateway>, board_type: &str, period: &str) -> Result<Value, ApiError> {
    let spec = board_spec(board_type, period)?;
    let (inflow, outflow) = tokio::join!(
        sina_sector_side(g, spec, true),
        sina_sector_side(g, spec, false)
    );
    Ok(json!({
        "boardType":spec.board_type,
        "period":spec.period,
        "inflow":inflow?,
        "outflow":outflow?
    }))
}

async fn sector_response(g: &Arc<Gateway>, board_type: &str, period: &str) -> Value {
    match eastmoney_sectors(g, board_type, period).await {
        Ok(value) => {
            json!({"success":true,"data":value,"meta":{"degraded":false,"stale":false,"sources":{"sector":{"actual":"eastmoney","actualLabel":"东方财富"}}}})
        }
        Err(primary) => match sina_sectors(g, board_type, period).await {
            Ok(value) => {
                json!({"success":true,"data":value,"meta":{"degraded":true,"stale":false,"fallbackReason":format!("东方财富: {primary}"),"sources":{"sector":{"actual":"sina","actualLabel":"新浪财经","requested":"eastmoney","degraded":true,"fallbackReason":primary.to_string(),"attempts":[{"source":"eastmoney","status":"failed","reason":primary.to_string()},{"source":"sina","status":200,"reason":"备用源成功"}]}}}})
            }
            Err(fallback) => policy::failure(
                "真实行情接口不可用",
                &format!("东方财富: {primary}; 新浪财经: {fallback}"),
                fallback.status.or(primary.status),
            ),
        },
    }
}
pub async fn handle(g: Arc<Gateway>, kind: &str, board_type: &str, period: &str) -> Value {
    match kind {
        "index" => match indexes(&g).await {
            Ok(v) => json!({"success":true,"data":v,"meta":{"degraded":false,"stale":false}}),
            Err(e) => policy::failure("真实行情接口不可用", &e.to_string(), e.status),
        },
        "breadth" => match market_breadth(&g).await {
            Ok(v) => json!({
                "success":true,
                "data":v,
                "meta":{
                    "asOf":Utc::now().to_rfc3339(),
                    "degraded":false,
                    "stale":false,
                    "sources":{"marketBreadth":{"actual":"eastmoney","actualLabel":"东方财富","status":"live"}}
                }
            }),
            Err(e) => policy::failure("市场涨跌家数暂不可用", &e.to_string(), e.status),
        },
        "capital" => {
            let (a, b, c) = tokio::join!(main_fund(&g), north_intraday(&g), hkex(&g));
            let degraded = a["available"] != true
                || a["degraded"] == true
                || b["available"] != true
                || c["available"] != true;
            json!({"success":true,"data":{"mainFund":a,"northHgtIntraday":b,"northboundDaily":c},"meta":{"asOf":Utc::now().to_rfc3339(),"degraded":degraded,"stale":false,"sources":{"marketFund":{"actual":a["source"],"actualLabel":a["sourceLabel"],"status":if a["available"]!=true{"unavailable"}else if a["degraded"]==true{"fallback"}else{"live"},"fallbackReason":a["fallbackReason"]},"northHgtIntraday":{"actual":"hexin","status":if b["available"]==true{"live"}else{"unavailable"}},"northboundDaily":{"actual":"hkex","status":if c["available"]==true{"live"}else{"unavailable"}}}}})
        }
        "sector" => sector_response(&g, board_type, period).await,
        "multiday-flow" => {
            sector_response(
                &g,
                board_type,
                if period.is_empty() { "5d" } else { period },
            )
            .await
        }
        _ => policy::failure("未知 market-data 类型", "market-data type invalid", None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn market_breadth_aggregates_shanghai_shenzhen_and_beijing() {
        let fixture = json!({"data":{"diff":[
            {"f12":"000002","f14":"Ａ股指数","f104":1000,"f105":"1200","f106":60},
            {"f12":"399107","f14":"深证Ａ指","f104":1400,"f105":1300,"f106":90},
            {"f12":"899050","f14":"北证50","f104":100,"f105":200,"f106":10}
        ]}});
        let result = parse_market_breadth(&fixture).unwrap();
        assert_eq!(result["up"], 2500);
        assert_eq!(result["down"], 2700);
        assert_eq!(result["flat"], 160);
        assert_eq!(result["covered"], 5360);
        assert_eq!(result["markets"].as_array().map(Vec::len), Some(3));
        assert_eq!(result["source"], "eastmoney");
    }

    #[test]
    fn market_breadth_rejects_missing_or_invalid_market_counts() {
        assert!(parse_market_breadth(&json!({"data":{"diff":[]}})).is_err());
        assert!(parse_market_breadth(&json!({"data":{"diff":[
            {"f12":"000002","f104":1,"f105":2,"f106":3},
            {"f12":"399107","f104":1,"f105":2,"f106":3},
            {"f12":"899050","f104":-1,"f105":2,"f106":3}
        ]}}))
        .is_err());
    }

    #[test]
    fn sector_sides_keep_only_the_requested_sign_and_contract_fields() {
        let fixture = json!({"data":{"diff":[
            {"f12":"BK1","f14":"流入行业","f62":300000000.0,"f184":8.5,"f3":2.1,"f204":"领涨股"},
            {"f12":"BK2","f14":"流出行业","f62":-200000000.0,"f184":-6.2,"f3":-1.5,"f204":"领跌股"}
        ]}});
        let spec = board_spec("industry", "today").unwrap();
        let inflow = sector_rows(&fixture, spec, true).unwrap();
        let outflow = sector_rows(&fixture, spec, false).unwrap();
        assert_eq!(inflow.len(), 1);
        assert_eq!(inflow[0]["name"], "流入行业");
        assert_eq!(inflow[0]["mainFundPct"], 8.5);
        assert_eq!(outflow.len(), 1);
        assert_eq!(outflow[0]["name"], "流出行业");
        assert_eq!(outflow[0]["mainFundYuan"], -200000000.0);
    }

    #[test]
    fn missing_sector_payload_is_an_error_instead_of_a_fresh_empty_result() {
        assert!(sector_rows(
            &json!({"data":null}),
            board_spec("industry", "today").unwrap(),
            true
        )
        .is_err());
    }

    #[test]
    fn board_specs_cover_all_supported_types_and_periods() {
        assert_eq!(board_spec("concept", "5d").unwrap().main, "f164");
        assert_eq!(board_spec("region", "10d").unwrap().main_pct, "f175");
        assert_eq!(board_spec("industry", "10d").unwrap().leader, None);
        assert!(board_spec("unknown", "today").is_err());
        assert!(board_spec("industry", "3d").is_err());
    }

    #[test]
    fn sina_sector_rows_convert_ratio_fields_to_percent() {
        let fixture = json!([
            {"category":"sw2_1","name":"流入行业","netamount":"300000000","ratioamount":"0.085","avg_changeratio":"0.021","ts_name":"领涨股"},
            {"category":"sw2_2","name":"流出行业","netamount":"-200000000","ratioamount":"-0.062","avg_changeratio":"-0.015","ts_name":"领跌股"}
        ]);
        let spec = board_spec("industry", "today").unwrap();
        let inflow = sina_sector_rows(&fixture, spec, true).unwrap();
        let outflow = sina_sector_rows(&fixture, spec, false).unwrap();
        assert_eq!(inflow[0]["mainFundPct"], 8.5);
        assert_eq!(inflow[0]["changePct"], 2.1);
        assert_eq!(inflow[0]["leader"], "领涨股");
        assert_eq!(outflow[0]["mainFundYuan"], -200000000.0);
    }

    #[test]
    fn sina_multiday_sector_rows_use_requested_period() {
        let fixture = json!([
            {"category":"diyu_1","name":"五日流入","netamount_5":"500000000","ratioamount_5":"0.04","avg_changeratio_5":"0.06","netamount_10":"-1"}
        ]);
        let rows = sina_sector_rows(&fixture, board_spec("region", "5d").unwrap(), true).unwrap();
        assert_eq!(rows[0]["mainFundYuan"], 500000000.0);
        assert_eq!(rows[0]["mainFundPct"], 4.0);
        assert_eq!(rows[0]["changePct"], 6.0);
        assert_eq!(rows[0]["leader"], "");
    }

    #[test]
    fn sina_market_flow_keeps_source_specific_labels() {
        let rows = (0..100)
            .map(|_| json!({"r0_net":"-100","r0_in":"300","r0_out":"400","r3_net":"25"}))
            .collect::<Vec<_>>();
        let value = sina_main_fund_rows(&rows).unwrap();
        assert_eq!(value["source"], "sina");
        assert_eq!(value["breakdown"]["large"]["label"], "主力流入");
        assert_eq!(value["breakdown"]["medium"]["label"], "主力流出");
        assert_eq!(value["breakdown"]["small"]["label"], "散户");
    }
}

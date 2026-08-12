use super::{
    http::{ApiError, Gateway, RequestSpec},
    policy,
};
use chrono::{NaiveDateTime, Utc};
use chrono_tz::Asia::Shanghai;
use regex::Regex;
use serde_json::{json, Value};
use std::sync::Arc;

const PORTFOLIO_URL: &str = "https://portfolio.lrwei91.cn/";
const GITHUB_RAW_URL: &str =
    "https://raw.githubusercontent.com/lrwei91/v9-sim-portfolio/main/index.html";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PublicSource {
    Portfolio,
    GithubRaw,
}

impl PublicSource {
    fn key(self) -> &'static str {
        match self {
            Self::Portfolio => "portfolio",
            Self::GithubRaw => "github-raw",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Portfolio => "公开报告",
            Self::GithubRaw => "GitHub Raw",
        }
    }

    fn url(self) -> &'static str {
        match self {
            Self::Portfolio => PORTFOLIO_URL,
            Self::GithubRaw => GITHUB_RAW_URL,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct IntradaySnapshot {
    date: String,
    time: String,
    at: String,
    module_html: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProbeFailureKind {
    Network,
    Structure,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ProbeResult {
    Parsed(IntradaySnapshot),
    Failed {
        kind: ProbeFailureKind,
        reason: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SourceProbe {
    source: PublicSource,
    result: ProbeResult,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SourceDecision {
    Ready(usize),
    NotReady(usize),
    Failed,
}

fn shanghai_today() -> String {
    Utc::now()
        .with_timezone(&Shanghai)
        .format("%Y-%m-%d")
        .to_string()
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn find_tag_end(html: &str, start: usize) -> Option<usize> {
    let bytes = html.as_bytes();
    let mut quote = None;
    for (offset, byte) in bytes.get(start..)?.iter().enumerate() {
        match (*byte, quote) {
            (b'\'' | b'"', None) => quote = Some(*byte),
            (value, Some(active)) if value == active => quote = None,
            (b'>', None) => return Some(start + offset),
            _ => {}
        }
    }
    None
}

fn is_tag_boundary(value: Option<u8>) -> bool {
    value.is_none_or(|byte| byte.is_ascii_whitespace() || matches!(byte, b'>' | b'/'))
}

fn find_tag(html: &str, needle: &str, from: usize) -> Option<usize> {
    let mut cursor = from;
    while let Some(offset) = html.get(cursor..)?.find(needle) {
        let index = cursor + offset;
        if is_tag_boundary(html.as_bytes().get(index + needle.len()).copied()) {
            return Some(index);
        }
        cursor = index + needle.len();
    }
    None
}

fn find_matching_element(html: &str, start: usize, tag: &str) -> Option<usize> {
    let opening = format!("<{tag}");
    let closing = format!("</{tag}");
    if find_tag(html, &opening, start) != Some(start) {
        return None;
    }

    let mut cursor = start;
    let mut depth = 0usize;
    loop {
        let next_open = find_tag(html, &opening, cursor);
        let next_close = find_tag(html, &closing, cursor);
        match (next_open, next_close) {
            (Some(open), Some(close)) if open < close => {
                depth += 1;
                cursor = find_tag_end(html, open)? + 1;
            }
            (_, Some(close)) => {
                if depth == 0 {
                    return None;
                }
                depth -= 1;
                let end = find_tag_end(html, close)? + 1;
                if depth == 0 {
                    return Some(end);
                }
                cursor = end;
            }
            _ => return None,
        }
    }
}

fn class_value(opening_tag: &str) -> Option<&str> {
    let class_at = opening_tag.find("class=")? + "class=".len();
    let quote = *opening_tag.as_bytes().get(class_at)?;
    if !matches!(quote, b'\'' | b'"') {
        return None;
    }
    let value_start = class_at + 1;
    let value_end = opening_tag.get(value_start..)?.find(char::from(quote))? + value_start;
    opening_tag.get(value_start..value_end)
}

fn has_classes(opening_tag: &str, required: &[&str]) -> bool {
    let Some(classes) = class_value(opening_tag) else {
        return false;
    };
    required.iter().all(|required| {
        classes
            .split_ascii_whitespace()
            .any(|value| value == *required)
    })
}

fn find_opening_before(
    html: &str,
    before: usize,
    tag: &str,
    required_classes: &[&str],
) -> Option<usize> {
    let needle = format!("<{tag}");
    html.get(..before)?
        .rmatch_indices(needle.as_str())
        .find_map(|(index, _)| {
            if !is_tag_boundary(html.as_bytes().get(index + needle.len()).copied()) {
                return None;
            }
            let end = find_tag_end(html, index)?;
            has_classes(html.get(index..=end)?, required_classes).then_some(index)
        })
}

fn contains_unsafe_markup(html: &str) -> bool {
    let lower = html.to_ascii_lowercase();
    [
        "<script",
        "<iframe",
        "<object",
        "<embed",
        "<form",
        "<base",
        "<style",
        "<link",
        "<meta",
        "<img",
        "<video",
        "<audio",
        "<svg",
        "<math",
        "<a ",
        "<a>",
        "javascript:",
        "srcdoc=",
    ]
    .iter()
    .any(|value| lower.contains(value))
        || Regex::new(r"(?i)\son[a-z0-9_-]+\s*=")
            .expect("event attribute regex")
            .is_match(html)
}

fn extract_intraday_snapshot(html: &str) -> Result<IntradaySnapshot, String> {
    let title_at = html
        .find("id=\"intraday-title\"")
        .or_else(|| html.find("id='intraday-title'"))
        .ok_or_else(|| "缺少 intraday-title".to_string())?;
    let section_start = html
        .get(..title_at)
        .and_then(|prefix| prefix.rfind("<section"))
        .ok_or_else(|| "缺少盘中推荐 section".to_string())?;
    let section_end = find_matching_element(html, section_start, "section")
        .ok_or_else(|| "盘中推荐 section 未闭合".to_string())?;
    let section = html
        .get(section_start..section_end)
        .ok_or_else(|| "盘中推荐 section 边界无效".to_string())?;
    if !section.contains("report-rec__time") {
        return Err("缺少 report-rec__time".into());
    }

    let snapshot_pattern = Regex::new(r"筛选快照\s*[:：]\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})")
        .expect("snapshot regex");
    let captures = snapshot_pattern
        .captures(section)
        .ok_or_else(|| "筛选快照时间无效".to_string())?;
    let date = captures[1].to_string();
    let time = captures[2].to_string();
    let at = format!("{date} {time}");
    NaiveDateTime::parse_from_str(&at, "%Y-%m-%d %H:%M")
        .map_err(|_| "筛选快照日期时间无效".to_string())?;

    let time_at = section
        .find("report-rec__time")
        .ok_or_else(|| "缺少筛选快照节点".to_string())?;
    let card_start = find_opening_before(section, time_at, "div", &["report-card", "report-rec"])
        .ok_or_else(|| "缺少盘中推荐模块".to_string())?;
    let card_end = find_matching_element(section, card_start, "div")
        .ok_or_else(|| "盘中推荐模块未闭合".to_string())?;
    let module_html = section
        .get(card_start..card_end)
        .ok_or_else(|| "盘中推荐模块边界无效".to_string())?;
    if !module_html.contains("report-rec__board") {
        return Err("盘中推荐模块缺少板块内容".into());
    }
    if contains_unsafe_markup(module_html) {
        return Err("盘中推荐模块包含不安全标记".into());
    }

    Ok(IntradaySnapshot {
        date,
        time,
        at,
        module_html: module_html.to_string(),
    })
}

async fn probe_source(gateway: &Arc<Gateway>, source: PublicSource) -> SourceProbe {
    let result = match gateway
        .text(RequestSpec::get(source.url()).timeout(15).cache(5))
        .await
    {
        Ok(html) => match extract_intraday_snapshot(&html) {
            Ok(snapshot) => ProbeResult::Parsed(snapshot),
            Err(reason) => ProbeResult::Failed {
                kind: ProbeFailureKind::Structure,
                reason,
            },
        },
        Err(error) => ProbeResult::Failed {
            kind: ProbeFailureKind::Network,
            reason: source_error(&error),
        },
    };
    SourceProbe { source, result }
}

fn source_error(error: &ApiError) -> String {
    match error.status {
        Some(status) => format!("HTTP {status}: {}", error.message),
        None => error.message.clone(),
    }
}

fn choose_source(today: &str, probes: &[SourceProbe]) -> SourceDecision {
    if let Some(index) = probes.iter().position(
        |probe| matches!(&probe.result, ProbeResult::Parsed(snapshot) if snapshot.date == today),
    ) {
        return SourceDecision::Ready(index);
    }

    let mut latest = None;
    for (index, probe) in probes.iter().enumerate() {
        let ProbeResult::Parsed(snapshot) = &probe.result else {
            continue;
        };
        if latest.is_none_or(|current: usize| {
            let ProbeResult::Parsed(current_snapshot) = &probes[current].result else {
                return true;
            };
            snapshot.at > current_snapshot.at
        }) {
            latest = Some(index);
        }
    }
    latest.map_or(SourceDecision::Failed, SourceDecision::NotReady)
}

fn attempts_json(today: &str, probes: &[SourceProbe]) -> Vec<Value> {
    probes
        .iter()
        .map(|probe| match &probe.result {
            ProbeResult::Parsed(snapshot) => json!({
                "source": probe.source.key(),
                "sourceLabel": probe.source.label(),
                "status": if snapshot.date == today { "ready" } else { "not_ready" },
                "snapshotAt": snapshot.at,
            }),
            ProbeResult::Failed { kind, reason } => json!({
                "source": probe.source.key(),
                "sourceLabel": probe.source.label(),
                "status": match kind {
                    ProbeFailureKind::Network => "network_error",
                    ProbeFailureKind::Structure => "structure_error",
                },
                "reason": reason,
            }),
        })
        .collect()
}

fn fallback_reason(today: &str, probes: &[SourceProbe], selected_index: usize) -> String {
    if selected_index == 0 {
        return String::new();
    }
    match probes.first().map(|probe| &probe.result) {
        Some(ProbeResult::Parsed(snapshot)) => {
            format!("公开报告快照日期 {} 不是上海当天 {today}", snapshot.date)
        }
        Some(ProbeResult::Failed { reason, .. }) => format!("公开报告不可用：{reason}"),
        None => "公开报告未请求".into(),
    }
}

fn source_meta(today: &str, probes: &[SourceProbe], selected_index: usize, status: &str) -> Value {
    let selected = &probes[selected_index];
    let degraded = selected.source != PublicSource::Portfolio || status != "ready";
    let fallback = if status == "not_ready" {
        "尚未发布上海当天盘中筛选快照".to_string()
    } else {
        fallback_reason(today, probes, selected_index)
    };
    let mut source = json!({
        "actual": selected.source.key(),
        "actualLabel": selected.source.label(),
        "requested": PublicSource::Portfolio.key(),
        "requestedLabel": PublicSource::Portfolio.label(),
        "status": status,
        "degraded": degraded,
        "attempts": attempts_json(today, probes),
    });
    if !fallback.is_empty() {
        source["fallbackReason"] = json!(fallback);
    }
    source
}

fn response_for(today: &str, probes: &[SourceProbe]) -> Value {
    match choose_source(today, probes) {
        SourceDecision::Ready(index) => {
            let probe = &probes[index];
            let ProbeResult::Parsed(snapshot) = &probe.result else {
                unreachable!("ready source must be parsed")
            };
            let degraded = probe.source != PublicSource::Portfolio;
            json!({
                "success": true,
                "data": {
                    "status": "ready",
                    "snapshotDate": snapshot.date,
                    "snapshotTime": snapshot.time,
                    "snapshotAt": snapshot.at,
                    "source": probe.source.key(),
                    "sourceLabel": probe.source.label(),
                    "moduleHtml": snapshot.module_html,
                },
                "meta": {
                    "asOf": now_iso(),
                    "degraded": degraded,
                    "stale": false,
                    "sources": {
                        "intradayScreening": source_meta(today, probes, index, "ready")
                    }
                }
            })
        }
        SourceDecision::NotReady(index) => {
            let probe = &probes[index];
            let ProbeResult::Parsed(snapshot) = &probe.result else {
                unreachable!("not-ready source must be parsed")
            };
            json!({
                "success": true,
                "data": {
                    "status": "not_ready",
                    "snapshotDate": snapshot.date,
                    "snapshotTime": snapshot.time,
                    "latestPublishedAt": snapshot.at,
                    "source": probe.source.key(),
                    "sourceLabel": probe.source.label(),
                    "moduleHtml": "",
                },
                "meta": {
                    "asOf": now_iso(),
                    "degraded": true,
                    "stale": false,
                    "sources": {
                        "intradayScreening": source_meta(today, probes, index, "not_ready")
                    }
                }
            })
        }
        SourceDecision::Failed => {
            let reason = probes
                .iter()
                .map(|probe| match &probe.result {
                    ProbeResult::Parsed(_) => format!("{}: 快照不可用", probe.source.label()),
                    ProbeResult::Failed { reason, .. } => {
                        format!("{}: {reason}", probe.source.label())
                    }
                })
                .collect::<Vec<_>>()
                .join("；");
            let mut value = policy::failure("盘中筛选快照不可用", &reason, None);
            if let Some(meta) = value.get_mut("meta").and_then(Value::as_object_mut) {
                meta.insert("asOf".into(), json!(now_iso()));
                meta.insert("degraded".into(), json!(true));
                meta.insert(
                    "sources".into(),
                    json!({
                        "intradayScreening": {
                            "actual": "none",
                            "actualLabel": "不可用",
                            "requested": PublicSource::Portfolio.key(),
                            "requestedLabel": PublicSource::Portfolio.label(),
                            "status": "error",
                            "degraded": true,
                            "attempts": attempts_json(today, probes),
                        }
                    }),
                );
            }
            value
        }
    }
}

pub async fn handle(gateway: Arc<Gateway>) -> Value {
    let today = shanghai_today();
    let primary = probe_source(&gateway, PublicSource::Portfolio).await;
    let mut probes = vec![primary];
    if choose_source(&today, &probes) != SourceDecision::Ready(0) {
        probes.push(probe_source(&gateway, PublicSource::GithubRaw).await);
    }
    response_for(&today, &probes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn html(date: &str, time: &str, name: &str) -> String {
        format!(
            r#"<main><section class="report-section" aria-labelledby="intraday-title">
            <h2 id="intraday-title">盘中推荐</h2>
            <div class="report-card report-rec">
              <p class="report-rec__time">筛选快照：{date} {time}</p>
              <div class="report-rec__board"><h3>{name}</h3><div><span>候选</span></div></div>
            </div>
            </section><section><h2>下一节</h2></section></main>"#
        )
    }

    fn parsed(source: PublicSource, date: &str, time: &str) -> SourceProbe {
        SourceProbe {
            source,
            result: ProbeResult::Parsed(
                extract_intraday_snapshot(&html(date, time, source.label())).unwrap(),
            ),
        }
    }

    fn failed(source: PublicSource, kind: ProbeFailureKind) -> SourceProbe {
        SourceProbe {
            source,
            result: ProbeResult::Failed {
                kind,
                reason: "test failure".into(),
            },
        }
    }

    #[test]
    fn extracts_snapshot_and_only_the_intraday_card() {
        let snapshot = extract_intraday_snapshot(&html("2026-08-12", "14:30", "主板")).unwrap();
        assert_eq!(snapshot.date, "2026-08-12");
        assert_eq!(snapshot.time, "14:30");
        assert!(snapshot
            .module_html
            .starts_with("<div class=\"report-card report-rec\">"));
        assert!(snapshot.module_html.contains("report-rec__board"));
        assert!(!snapshot.module_html.contains("下一节"));
    }

    #[test]
    fn primary_same_day_is_ready_without_degradation() {
        let probes = vec![parsed(PublicSource::Portfolio, "2026-08-12", "14:30")];
        let response = response_for("2026-08-12", &probes);
        assert_eq!(response["data"]["status"], "ready");
        assert_eq!(response["data"]["source"], "portfolio");
        assert_eq!(response["data"]["snapshotAt"], "2026-08-12 14:30");
        assert_eq!(response["meta"]["degraded"], false);
    }

    #[test]
    fn stale_primary_falls_back_to_same_day_raw() {
        let probes = vec![
            parsed(PublicSource::Portfolio, "2026-08-11", "14:30"),
            parsed(PublicSource::GithubRaw, "2026-08-12", "14:31"),
        ];
        let response = response_for("2026-08-12", &probes);
        assert_eq!(response["data"]["status"], "ready");
        assert_eq!(response["data"]["source"], "github-raw");
        assert_eq!(response["meta"]["degraded"], true);
    }

    #[test]
    fn two_old_snapshots_return_latest_as_not_ready_without_html() {
        let probes = vec![
            parsed(PublicSource::Portfolio, "2026-08-10", "14:30"),
            parsed(PublicSource::GithubRaw, "2026-08-11", "14:31"),
        ];
        let response = response_for("2026-08-12", &probes);
        assert_eq!(response["success"], true);
        assert_eq!(response["data"]["status"], "not_ready");
        assert_eq!(response["data"]["latestPublishedAt"], "2026-08-11 14:31");
        assert_eq!(response["data"]["moduleHtml"], "");
        assert!(response["data"].get("snapshotAt").is_none());
    }

    #[test]
    fn malformed_primary_can_fall_back_to_same_day_raw() {
        let probes = vec![
            failed(PublicSource::Portfolio, ProbeFailureKind::Structure),
            parsed(PublicSource::GithubRaw, "2026-08-12", "14:30"),
        ];
        assert_eq!(
            choose_source("2026-08-12", &probes),
            SourceDecision::Ready(1)
        );
    }

    #[test]
    fn no_parseable_source_is_an_error() {
        let probes = vec![
            failed(PublicSource::Portfolio, ProbeFailureKind::Network),
            failed(PublicSource::GithubRaw, ProbeFailureKind::Structure),
        ];
        let response = response_for("2026-08-12", &probes);
        assert_eq!(response["success"], false);
        assert_eq!(response["meta"]["stale"], false);
        assert_eq!(
            response["meta"]["sources"]["intradayScreening"]["status"],
            "error"
        );
    }

    #[test]
    fn two_network_failures_return_an_error() {
        let probes = vec![
            failed(PublicSource::Portfolio, ProbeFailureKind::Network),
            failed(PublicSource::GithubRaw, ProbeFailureKind::Network),
        ];
        let response = response_for("2026-08-12", &probes);
        assert_eq!(response["success"], false);
        assert_eq!(response["errorCode"], "upstream_error");
        assert_eq!(
            response["meta"]["sources"]["intradayScreening"]["attempts"][0]["status"],
            "network_error"
        );
        assert_eq!(
            response["meta"]["sources"]["intradayScreening"]["attempts"][1]["status"],
            "network_error"
        );
    }

    #[test]
    fn rejects_missing_or_unsafe_module_structure() {
        assert!(extract_intraday_snapshot(
            "<section><h2 id=\"intraday-title\">盘中推荐</h2></section>"
        )
        .is_err());
        let unsafe_html = html("2026-08-12", "14:30", "<script>alert(1)</script>");
        assert!(extract_intraday_snapshot(&unsafe_html).is_err());
    }
}

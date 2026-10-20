//! Shanghai/Shenzhen annual closure calendar. Unknown years never authorize jobs.
use chrono::{Datelike, NaiveDate};

// Source: SSE notices 2024-12-23 (10767108), 2025-12-22 (10802507).
// Annual data is deliberately bounded; do not infer unpublished weekdays.
pub const SOURCES: &[&str] = &[
    "https://www.sse.com.cn/disclosure/announcement/general/c/c_20241223_10767108.shtml",
    "https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml",
];
pub fn is_trading_day(day: NaiveDate) -> Option<bool> {
    let closures: &[(u32, u32)] = match day.year() {
        2025 => &[
            (101, 101),
            (128, 204),
            (404, 406),
            (501, 505),
            (531, 602),
            (1001, 1008),
        ],
        2026 => &[
            (101, 103),
            (215, 223),
            (404, 406),
            (501, 505),
            (619, 621),
            (925, 927),
            (1001, 1007),
        ],
        _ => return None,
    };
    let md = day.month() * 100 + day.day();
    Some(
        day.weekday().num_days_from_monday() < 5
            && !closures.iter().any(|(a, b)| (*a..=*b).contains(&md)),
    )
}
pub fn previous_trading_day(day: NaiveDate) -> Option<NaiveDate> {
    let mut previous = day.pred_opt()?;
    for _ in 0..20 {
        if is_trading_day(previous)? {
            return Some(previous);
        }
        previous = previous.pred_opt()?;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    fn date(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }
    #[test]
    fn annual_holidays_and_makeup_weekends_are_closed() {
        assert_eq!(is_trading_day(date("2026-10-01")), Some(false));
        assert_eq!(is_trading_day(date("2026-10-10")), Some(false));
        assert_eq!(is_trading_day(date("2026-10-20")), Some(true));
        assert_eq!(is_trading_day(date("2027-01-04")), None);
    }
    #[test]
    fn premarket_uses_previous_exchange_day() {
        assert_eq!(
            previous_trading_day(date("2026-10-08")),
            Some(date("2026-09-30"))
        );
        assert_eq!(
            previous_trading_day(date("2026-02-24")),
            Some(date("2026-02-13"))
        );
        assert_eq!(
            previous_trading_day(date("2026-01-05")),
            Some(date("2025-12-31"))
        );
    }
}

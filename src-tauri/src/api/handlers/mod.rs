//! Route handlers grouped by data domain.  The gateway policy/cache wrapper lives in
//! `routes.rs`; this module only keeps path dispatch separate from handler logic.

mod detail;
mod market;
mod news;
mod signals;
mod stock;

use super::http::Gateway;
use crate::api::endpoints::Query;
use serde_json::Value;
use std::sync::Arc;

pub(crate) async fn dispatch_raw(gateway: Arc<Gateway>, path: &str, query: Query) -> Value {
    match path.trim_start_matches('/') {
        "stock" => stock::handle(gateway, query).await,
        "stock-search" => stock::search(gateway, query).await,
        "hot-rank" => market::hot_rank(gateway, query).await,
        "limit-up" => market::limit_up(gateway, query).await,
        "cls-news" => news::cls(gateway, query).await,
        "global-news" => news::global(gateway, query).await,
        "news" => news::jin10(gateway, query).await,
        "stock-news" => news::stock(gateway, query).await,
        "stock-risk" => detail::risk(gateway, query).await,
        "dragon-tiger" => signals::dragon_tiger(gateway, query).await,
        "fund-flow-120d" => detail::fund_flow(gateway, query).await,
        "market-data" => market::data(gateway, query).await,
        "stock-kline" => detail::kline(gateway, query).await,
        "stock-minute" => detail::minute(gateway, query).await,
        "opportunity-radar" => signals::opportunity(gateway, query).await,
        "market-warnings" => signals::market_warnings(gateway, query).await,
        "intraday-screening" => signals::intraday_screening(gateway, query).await,
        _ => super::policy::failure("API not found", "unknown route", None),
    }
}

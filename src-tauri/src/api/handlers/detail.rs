use super::super::endpoints::Query;
use super::super::{endpoints, http::Gateway};
use serde_json::Value;
use std::sync::Arc;

pub(crate) async fn risk(gateway: Arc<Gateway>, query: Query) -> Value {
    endpoints::stock_risk(gateway, query).await
}

pub(crate) async fn fund_flow(gateway: Arc<Gateway>, query: Query) -> Value {
    endpoints::fund_flow(gateway, query).await
}

pub(crate) async fn kline(gateway: Arc<Gateway>, query: Query) -> Value {
    endpoints::stock_kline(gateway, query).await
}

pub(crate) async fn minute(gateway: Arc<Gateway>, query: Query) -> Value {
    endpoints::stock_minute(gateway, query).await
}

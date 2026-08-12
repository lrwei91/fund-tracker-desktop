use super::super::endpoints::Query;
use super::super::{endpoints, http::Gateway};
use serde_json::Value;
use std::sync::Arc;

pub(crate) async fn dragon_tiger(gateway: Arc<Gateway>, query: Query) -> Value {
    endpoints::dragon_tiger(gateway, query).await
}

pub(crate) async fn opportunity(gateway: Arc<Gateway>, query: Query) -> Value {
    endpoints::opportunity_radar(gateway, query).await
}

pub(crate) async fn intraday_screening(gateway: Arc<Gateway>, _query: Query) -> Value {
    super::super::intraday::handle(gateway).await
}

use super::super::endpoints::Query;
use super::super::{endpoints, http::Gateway};
use serde_json::Value;
use std::sync::Arc;

pub(crate) async fn hot_rank(gateway: Arc<Gateway>, query: Query) -> Value {
    endpoints::hot_rank(gateway, query).await
}

pub(crate) async fn limit_up(gateway: Arc<Gateway>, query: Query) -> Value {
    endpoints::limit_up(gateway, query).await
}

pub(crate) async fn data(gateway: Arc<Gateway>, query: Query) -> Value {
    endpoints::market_data(gateway, query).await
}

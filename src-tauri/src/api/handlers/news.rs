use super::super::endpoints::Query;
use super::super::{endpoints, http::Gateway};
use serde_json::Value;
use std::sync::Arc;

pub(crate) async fn cls(gateway: Arc<Gateway>, query: Query) -> Value {
    endpoints::cls_news(gateway, query).await
}

pub(crate) async fn global(gateway: Arc<Gateway>, query: Query) -> Value {
    endpoints::global_news(gateway, query).await
}

pub(crate) async fn jin10(gateway: Arc<Gateway>, query: Query) -> Value {
    endpoints::news(gateway, query).await
}

pub(crate) async fn stock(gateway: Arc<Gateway>, query: Query) -> Value {
    endpoints::stock_news(gateway, query).await
}

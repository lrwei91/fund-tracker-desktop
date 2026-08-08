use super::super::endpoints::Query;
use super::super::{endpoints, http::Gateway};
use serde_json::Value;
use std::sync::Arc;

pub(crate) async fn handle(gateway: Arc<Gateway>, query: Query) -> Value {
    endpoints::stock(gateway, query).await
}

pub(crate) async fn search(gateway: Arc<Gateway>, query: Query) -> Value {
    endpoints::stock_search(gateway, query).await
}

use atomicwrites::{AtomicFile, OverwriteBehavior};
use serde_json::{json, Map, Value};
use std::{fs, path::PathBuf, sync::Mutex};

const KEYS: &[&str] = &[
    "fund_tracker_settings",
    "fund_tracker_active_main_tab",
    "fund_tracker_news_source",
    "fund_tracker_collapse_state",
    "fund_tracker_sector_tab",
    "fund_tracker_alert_settings",
    "fund_tracker_watch_alert_state",
    "fund_tracker_custom_indices",
    "fund_tracker_watchlist_cost",
    "fund_tracker_watchlist_remarks",
    "fund_tracker_watchlist",
    "fund_tracker_watchlist_tabs",
    "fund_tracker_active_watch_tab",
    "fund_tracker_hot_rank_source",
    "fund_tracker_limit_up_tab",
    "fund_tracker_holding_clown_mode",
    "fund_tracker_fund_watchlist",
];
pub const SENSITIVE_KEYS: &[&str] = &[
    "fund_tracker_watchlist_cost",
    "fund_tracker_watchlist_remarks",
    "fundIntradayCollectorToken",
];
const STORAGE_ENCODING: &str = "utf8-json";
const JSON_KEYS: &[&str] = &[
    "fund_tracker_settings",
    "fund_tracker_collapse_state",
    "fund_tracker_alert_settings",
    "fund_tracker_watch_alert_state",
    "fund_tracker_custom_indices",
    "fund_tracker_watchlist_cost",
    "fund_tracker_watchlist_remarks",
    "fund_tracker_watchlist",
    "fund_tracker_watchlist_tabs",
    "fund_tracker_fund_watchlist",
];

pub struct ConfigStore {
    path: PathBuf,
    value: Mutex<Value>,
    load_error: Option<String>,
}

fn empty() -> Value {
    json!({"version": 2, "storageEncoding": STORAGE_ENCODING, "updatedAt": null, "data": {}, "private": {}})
}

impl ConfigStore {
    pub fn product_path() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("恭喜发财")
            .join("config.json")
    }

    pub fn new(path: PathBuf) -> Self {
        let (value, load_error) = match fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(raw) if raw.is_object() => (normalize(raw), None),
                Ok(_) => (
                    empty(),
                    Some("配置文件格式异常：根节点必须是对象".to_string()),
                ),
                Err(error) => (empty(), Some(format!("配置文件解析失败：{error}"))),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (empty(), None),
            Err(error) => (empty(), Some(format!("配置文件读取失败：{error}"))),
        };
        Self {
            path,
            value: Mutex::new(value),
            load_error,
        }
    }

    pub fn path(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }

    pub fn load(&self) -> Value {
        let mut result = snapshot(&self.value.lock().expect("config lock"));
        if let Some(error) = &self.load_error {
            result["configError"] = json!({"message": error});
        }
        result
    }

    pub fn patch(&self, changes: Map<String, Value>) -> Result<Value, String> {
        if self.load_error.is_some() {
            return Err("配置文件损坏，未覆盖原文件；请修复配置文件后重试".to_string());
        }
        let mut value = self.value.lock().map_err(|_| "配置锁不可用".to_string())?;
        let mut candidate = value.clone();
        let data = candidate
            .get_mut("data")
            .and_then(Value::as_object_mut)
            .ok_or("配置格式异常")?;
        for (key, raw) in changes {
            if !KEYS.contains(&key.as_str()) {
                continue;
            }
            if raw.is_null() {
                data.remove(&key);
                continue;
            }
            let encoded =
                if SENSITIVE_KEYS.contains(&key.as_str()) || JSON_KEYS.contains(&key.as_str()) {
                    match raw
                        .as_str()
                        .and_then(|text| serde_json::from_str::<Value>(text).ok())
                    {
                        Some(parsed) => parsed,
                        None => raw,
                    }
                } else {
                    Value::String(
                        raw.as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| raw.to_string()),
                    )
                };
            data.insert(key, encoded);
        }
        candidate["version"] = json!(2);
        candidate["storageEncoding"] = json!(STORAGE_ENCODING);
        candidate["updatedAt"] = json!(chrono::Utc::now().to_rfc3339());
        persist(&self.path, &candidate)?;
        *value = candidate;
        Ok(snapshot(&value))
    }

    pub fn private_collector_token(&self) -> Option<String> {
        self.value
            .lock()
            .ok()?
            .get("private")?
            .get("fundIntradayCollectorToken")?
            .as_str()
            .filter(|token| !token.is_empty())
            .map(str::to_owned)
    }

    pub fn set_private_collector_token(&self, token: &str) -> Result<(), String> {
        if !SENSITIVE_KEYS.contains(&"fundIntradayCollectorToken") {
            return Err("私有配置键未登记".to_string());
        }
        if self.load_error.is_some() {
            return Err("配置文件损坏，未覆盖原文件；请修复配置文件后重试".to_string());
        }
        let mut value = self.value.lock().map_err(|_| "配置锁不可用".to_string())?;
        let mut candidate = value.clone();
        if !candidate.get("private").is_some_and(Value::is_object) {
            candidate["private"] = json!({});
        }
        candidate["private"]["fundIntradayCollectorToken"] = json!(token);
        candidate["updatedAt"] = json!(chrono::Utc::now().to_rfc3339());
        persist(&self.path, &candidate)?;
        *value = candidate;
        Ok(())
    }

    pub fn clear_private_collector_token(&self) -> Result<(), String> {
        self.set_private_collector_token("")
    }
}

fn normalize(raw: Value) -> Value {
    let updated = raw
        .get("updatedAt")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let data = raw
        .get("data")
        .or_else(|| raw.get("values"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let private = raw
        .get("private")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    json!({"version": 2, "storageEncoding": STORAGE_ENCODING, "updatedAt": updated, "data": data, "private": private})
}

fn snapshot(value: &Value) -> Value {
    let mut data = Map::new();
    if let Some(source) = value.get("data").and_then(Value::as_object) {
        for (key, raw) in source {
            if !KEYS.contains(&key.as_str()) {
                continue;
            }
            let decoded = if JSON_KEYS.contains(&key.as_str()) && !raw.is_string() {
                Value::String(raw.to_string())
            } else {
                raw.clone()
            };
            data.insert(key.clone(), decoded);
        }
    }
    json!({"version": 2, "storageEncoding": value.get("storageEncoding").cloned().unwrap_or_else(|| json!(STORAGE_ENCODING)), "updatedAt": value.get("updatedAt").cloned().unwrap_or(Value::Null), "data": data})
}

fn persist(path: &PathBuf, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = format!(
        "{}\n",
        serde_json::to_string_pretty(value).map_err(|e| e.to_string())?
    );
    AtomicFile::new(path, OverwriteBehavior::AllowOverwrite)
        .write(|file| std::io::Write::write_all(file, body.as_bytes()))
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn patches_and_deletes_config() {
        let path = std::env::temp_dir().join(format!("fund-tracker-{}.json", uuid::Uuid::new_v4()));
        let store = ConfigStore::new(path.clone());
        store
            .patch(
                serde_json::from_value(
                    json!({"fund_tracker_active_main_tab":"signals","unknown":"x"}),
                )
                .unwrap(),
            )
            .unwrap();
        assert_eq!(
            store.load()["data"]["fund_tracker_active_main_tab"],
            "signals"
        );
        assert_eq!(store.load()["storageEncoding"], STORAGE_ENCODING);
        store
            .patch(serde_json::from_value(json!({"fund_tracker_active_main_tab":null})).unwrap())
            .unwrap();
        assert!(store.load()["data"]
            .get("fund_tracker_active_main_tab")
            .is_none());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn legacy_values_are_migrated_without_exposing_unknown_keys() {
        let path =
            std::env::temp_dir().join(format!("fund-tracker-legacy-{}.json", uuid::Uuid::new_v4()));
        fs::write(
            &path,
            r#"{"values":{"fund_tracker_active_main_tab":"market","unknown":"secret"}}"#,
        )
        .unwrap();
        let store = ConfigStore::new(path.clone());
        assert_eq!(
            store.load()["data"]["fund_tracker_active_main_tab"],
            "market"
        );
        assert!(store.load()["data"].get("unknown").is_none());
        assert_eq!(store.load()["storageEncoding"], STORAGE_ENCODING);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn collector_token_is_persisted_but_not_exposed_in_snapshot() {
        let path =
            std::env::temp_dir().join(format!("fund-tracker-secret-{}.json", uuid::Uuid::new_v4()));
        let store = ConfigStore::new(path.clone());
        store.set_private_collector_token("TOKEN.secret").unwrap();
        assert_eq!(
            store.private_collector_token().as_deref(),
            Some("TOKEN.secret")
        );
        assert!(store.load().get("private").is_none());
        let restored = ConfigStore::new(path.clone());
        assert_eq!(
            restored.private_collector_token().as_deref(),
            Some("TOKEN.secret")
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn failed_persist_does_not_change_memory() {
        let path = std::env::temp_dir().join(format!("fund-tracker-dir-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        let store = ConfigStore::new(path.clone());
        let result = store.patch(
            serde_json::from_value(json!({
                "fund_tracker_active_main_tab": "signals"
            }))
            .unwrap(),
        );
        assert!(result.is_err());
        assert!(store.load()["data"]
            .get("fund_tracker_active_main_tab")
            .is_none());
        assert!(store.set_private_collector_token("secret").is_err());
        assert!(store.private_collector_token().is_none());
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn corrupt_config_is_reported_and_original_file_is_preserved() {
        let path = std::env::temp_dir().join(format!(
            "fund-tracker-corrupt-{}.json",
            uuid::Uuid::new_v4()
        ));
        let original = "{ this is not json";
        fs::write(&path, original).unwrap();
        let store = ConfigStore::new(path.clone());
        assert!(store.load().get("configError").is_some());
        assert!(store
            .patch(
                serde_json::from_value(json!({
                    "fund_tracker_active_main_tab": "signals"
                }))
                .unwrap()
            )
            .is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        fs::remove_file(path).unwrap();
    }
}

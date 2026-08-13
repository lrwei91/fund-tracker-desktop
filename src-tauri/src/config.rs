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
}

fn empty() -> Value {
    json!({"version": 2, "updatedAt": null, "data": {}})
}

impl ConfigStore {
    pub fn product_path() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("恭喜发财")
            .join("config.json")
    }

    pub fn new(path: PathBuf) -> Self {
        let value = fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .map(normalize)
            .unwrap_or_else(empty);
        Self {
            path,
            value: Mutex::new(value),
        }
    }

    pub fn path(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }

    pub fn load(&self) -> Value {
        snapshot(&self.value.lock().expect("config lock"))
    }

    pub fn patch(&self, changes: Map<String, Value>) -> Result<Value, String> {
        let mut value = self.value.lock().map_err(|_| "配置锁不可用".to_string())?;
        let data = value
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
            let encoded = if JSON_KEYS.contains(&key.as_str()) {
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
        value["version"] = json!(2);
        value["updatedAt"] = json!(chrono::Utc::now().to_rfc3339());
        persist(&self.path, &value)?;
        Ok(snapshot(&value))
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
    json!({"version": 2, "updatedAt": updated, "data": data})
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
    json!({"version": 2, "updatedAt": value.get("updatedAt").cloned().unwrap_or(Value::Null), "data": data})
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
        store
            .patch(serde_json::from_value(json!({"fund_tracker_active_main_tab":null})).unwrap())
            .unwrap();
        assert!(store.load()["data"]
            .get("fund_tracker_active_main_tab")
            .is_none());
        let _ = fs::remove_file(path);
    }
}

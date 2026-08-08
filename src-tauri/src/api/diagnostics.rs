use serde::Serialize;
use serde_json::Value;
use std::{
    collections::VecDeque,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_ENTRIES: usize = 200;
const MAX_FILE_BYTES: u64 = 512 * 1024;

#[derive(Clone, Debug, Serialize)]
pub struct DiagnosticEvent {
    pub at: String,
    pub route: String,
    pub provider: String,
    pub outcome: String,
    pub cache: String,
    pub status: Option<u16>,
    #[serde(rename = "durationMs")]
    pub duration_ms: u128,
    #[serde(rename = "errorCode", skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[derive(Clone)]
pub struct DiagnosticStore {
    entries: Arc<Mutex<VecDeque<DiagnosticEvent>>>,
    path: PathBuf,
}

impl DiagnosticStore {
    pub fn new(path: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            entries: Arc::new(Mutex::new(VecDeque::with_capacity(MAX_ENTRIES))),
            path,
        })
    }

    pub fn product_path() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("恭喜发财")
            .join("diagnostics.log")
    }

    pub fn record(&self, event: DiagnosticEvent) {
        if event.outcome == "success" && matches!(event.cache.as_str(), "hit" | "coalesced") {
            return;
        }
        if let Ok(mut entries) = self.entries.lock() {
            if entries.len() >= MAX_ENTRIES {
                entries.pop_front();
            }
            entries.push_back(event.clone());
        }
        if let Err(error) = self.append(&event) {
            eprintln!("[fund-tracker] diagnostics write failed: {error}");
        }
    }

    pub fn snapshot(&self) -> Vec<DiagnosticEvent> {
        self.entries
            .lock()
            .map(|entries| entries.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn clear(&self) -> Result<(), String> {
        if let Ok(mut entries) = self.entries.lock() {
            entries.clear();
        }
        for path in [&self.path, &self.path.with_extension("log.1")] {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        Ok(())
    }

    fn append(&self, event: &DiagnosticEvent) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        if fs::metadata(&self.path)
            .map(|metadata| metadata.len() >= MAX_FILE_BYTES)
            .unwrap_or(false)
        {
            rotate(&self.path)?;
        }
        let body = serde_json::to_string(event).map_err(|error| error.to_string())?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|error| error.to_string())?;
        writeln!(file, "{body}").map_err(|error| error.to_string())
    }
}

fn rotate(path: &Path) -> Result<(), String> {
    let rotated = path.with_extension("log.1");
    match fs::remove_file(&rotated) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    fs::rename(path, rotated).map_err(|error| error.to_string())
}

pub fn now_iso() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    chrono::DateTime::<chrono::Utc>::from_timestamp(seconds as i64, 0)
        .map(|time| time.to_rfc3339())
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339())
}

pub fn redacted_diagnostic_payload(events: Vec<DiagnosticEvent>) -> Value {
    serde_json::to_value(events).unwrap_or_else(|_| Value::Array(Vec::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_and_clears_bounded_events() {
        let path = std::env::temp_dir().join(format!(
            "fund-tracker-diagnostics-{}.log",
            uuid::Uuid::new_v4()
        ));
        let store = DiagnosticStore::new(path.clone());
        store.record(DiagnosticEvent {
            at: now_iso(),
            route: "stock".into(),
            provider: "tencent".into(),
            outcome: "error".into(),
            cache: "miss".into(),
            status: Some(503),
            duration_ms: 12,
            error_code: Some("upstream_5xx".into()),
        });
        assert_eq!(store.snapshot().len(), 1);
        assert!(path.exists());
        fs::copy(&path, path.with_extension("log.1")).unwrap();
        store.clear().unwrap();
        assert!(store.snapshot().is_empty());
        assert!(!path.exists());
        assert!(!path.with_extension("log.1").exists());
    }
}

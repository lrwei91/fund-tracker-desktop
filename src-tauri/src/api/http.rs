use encoding_rs::GBK;
use futures::future::{BoxFuture, FutureExt, Shared};
use rand::Rng;
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue},
    Client, Method,
};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};

#[derive(Clone, Debug)]
pub struct ApiError {
    pub message: String,
    pub status: Option<u16>,
}
impl ApiError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status: None,
        }
    }
}
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

#[derive(Clone)]
pub struct RequestSpec {
    pub url: String,
    pub method: Method,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    pub timeout: Duration,
    pub cache_ttl: Duration,
    pub eastmoney: bool,
}
impl RequestSpec {
    pub fn get(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            method: Method::GET,
            headers: vec![],
            body: None,
            timeout: Duration::from_secs(10),
            cache_ttl: Duration::from_secs(5),
            eastmoney: false,
        }
    }
    pub fn header(mut self, key: &str, value: impl Into<String>) -> Self {
        self.headers.push((key.into(), value.into()));
        self
    }
    pub fn body(mut self, body: String) -> Self {
        self.method = Method::POST;
        self.body = Some(body);
        self
    }
    pub fn timeout(mut self, seconds: u64) -> Self {
        self.timeout = Duration::from_secs(seconds);
        self
    }
    pub fn cache(mut self, seconds: u64) -> Self {
        self.cache_ttl = Duration::from_secs(seconds);
        self
    }
    pub fn em(mut self) -> Self {
        self.eastmoney = true;
        self.cache_ttl = Duration::from_secs(10);
        self
    }
}

#[derive(Default)]
struct Circuit {
    failures: u8,
    until: Option<Instant>,
    last_started: Option<Instant>,
}
type SharedRequest = Shared<BoxFuture<'static, Result<Arc<Vec<u8>>, ApiError>>>;
type ResponseCache = Arc<Mutex<HashMap<String, (Instant, Arc<Vec<u8>>)>>>;

pub struct Gateway {
    client: Client,
    inflight: Arc<AsyncMutex<HashMap<String, SharedRequest>>>,
    cache: ResponseCache,
    eastmoney: Arc<Semaphore>,
    tencent: Arc<Semaphore>,
    default: Arc<Semaphore>,
    circuit: Arc<AsyncMutex<Circuit>>,
}

impl Gateway {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            client: Client::builder()
                .user_agent("Mozilla/5.0 fund-tracker/1.0")
                .build()
                .expect("HTTP client"),
            inflight: Arc::new(AsyncMutex::new(HashMap::new())),
            cache: Arc::new(Mutex::new(HashMap::new())),
            eastmoney: Arc::new(Semaphore::new(1)),
            tencent: Arc::new(Semaphore::new(4)),
            default: Arc::new(Semaphore::new(3)),
            circuit: Arc::new(AsyncMutex::new(Circuit::default())),
        })
    }

    pub async fn bytes(self: &Arc<Self>, spec: RequestSpec) -> Result<Arc<Vec<u8>>, ApiError> {
        let key = format!(
            "{}:{}:{}",
            spec.method,
            spec.url,
            spec.body.as_deref().unwrap_or("")
        );
        if let Some((expires, value)) = self.cache.lock().expect("cache").get(&key).cloned() {
            if expires > Instant::now() {
                return Ok(value);
            }
        }
        let mut inflight = self.inflight.lock().await;
        if let Some(work) = inflight.get(&key) {
            let work = work.clone();
            drop(inflight);
            return work.await;
        }
        let gateway = self.clone();
        let request_key = key.clone();
        let work = async move { gateway.perform(spec, request_key).await }
            .boxed()
            .shared();
        inflight.insert(key.clone(), work.clone());
        drop(inflight);
        let result = work.await;
        self.inflight.lock().await.remove(&key);
        result
    }

    async fn perform(
        self: &Arc<Self>,
        spec: RequestSpec,
        key: String,
    ) -> Result<Arc<Vec<u8>>, ApiError> {
        let host = url::Url::parse(&spec.url)
            .ok()
            .and_then(|u| u.host_str().map(str::to_owned))
            .unwrap_or_default();
        let provider = if spec.eastmoney || host.ends_with("eastmoney.com") {
            "eastmoney"
        } else if host.ends_with("gtimg.cn") || host.ends_with("qq.com") {
            "tencent"
        } else {
            "default"
        };
        let semaphore = match provider {
            "eastmoney" => self.eastmoney.clone(),
            "tencent" => self.tencent.clone(),
            _ => self.default.clone(),
        };
        let _permit = semaphore
            .acquire_owned()
            .await
            .map_err(|e| ApiError::new(e.to_string()))?;
        if provider == "eastmoney" {
            let mut circuit = self.circuit.lock().await;
            if circuit.until.is_some_and(|until| until > Instant::now()) {
                return Err(ApiError::new("eastmoney 数据源熔断中"));
            }
            if let Some(last) = circuit.last_started {
                let target = Duration::from_millis(1000 + rand::rng().random_range(0..=300));
                if let Some(wait) = target.checked_sub(last.elapsed()) {
                    drop(circuit);
                    tokio::time::sleep(wait).await;
                    circuit = self.circuit.lock().await;
                }
            }
            circuit.last_started = Some(Instant::now());
        }
        let attempts = if provider == "eastmoney" { 3 } else { 1 };
        let mut last = ApiError::new("请求失败");
        for attempt in 0..attempts {
            let mut headers = HeaderMap::new();
            headers.insert(
                "user-agent",
                HeaderValue::from_static("Mozilla/5.0 fund-tracker/1.0"),
            );
            headers.insert(
                "referer",
                HeaderValue::from_static("https://finance.eastmoney.com/"),
            );
            for (name, value) in &spec.headers {
                if let (Ok(name), Ok(value)) = (
                    HeaderName::from_bytes(name.as_bytes()),
                    HeaderValue::from_str(value),
                ) {
                    headers.insert(name, value);
                }
            }
            let mut request = self
                .client
                .request(spec.method.clone(), &spec.url)
                .headers(headers)
                .timeout(spec.timeout);
            if let Some(body) = &spec.body {
                request = request.body(body.clone());
            }
            match request.send().await {
                Ok(response) if response.status().is_success() => {
                    let body = Arc::new(
                        response
                            .bytes()
                            .await
                            .map_err(|e| ApiError::new(e.to_string()))?
                            .to_vec(),
                    );
                    if provider == "eastmoney" {
                        let mut c = self.circuit.lock().await;
                        c.failures = 0;
                        c.until = None;
                    }
                    if !spec.cache_ttl.is_zero() {
                        self.cache
                            .lock()
                            .expect("cache")
                            .insert(key, (Instant::now() + spec.cache_ttl, body.clone()));
                    }
                    return Ok(body);
                }
                Ok(response) => {
                    let status = response.status().as_u16();
                    last = ApiError {
                        message: format!("HTTP {status}"),
                        status: Some(status),
                    };
                    if status != 429 && status < 500 {
                        break;
                    }
                }
                Err(error) => last = ApiError::new(error.to_string()),
            }
            if attempt + 1 < attempts {
                let jitter = rand::rng().random_range(0..100);
                tokio::time::sleep(Duration::from_millis(
                    300 * 2u64.pow(attempt as u32) + jitter,
                ))
                .await;
            }
        }
        if provider == "eastmoney" {
            let mut c = self.circuit.lock().await;
            if last.status == Some(403) {
                c.failures = 3;
            } else if last.status.is_none()
                || last.status == Some(429)
                || last.status.is_some_and(|s| s >= 500)
            {
                c.failures += 1;
            } else {
                c.failures = 0;
            }
            if c.failures >= 3 {
                c.until = Some(Instant::now() + Duration::from_secs(300));
            }
        }
        Err(last)
    }

    pub async fn json(self: &Arc<Self>, spec: RequestSpec) -> Result<Value, ApiError> {
        serde_json::from_slice(&self.bytes(spec).await?).map_err(|e| ApiError::new(e.to_string()))
    }
    pub async fn text(self: &Arc<Self>, spec: RequestSpec) -> Result<String, ApiError> {
        String::from_utf8(self.bytes(spec).await?.as_ref().clone())
            .map_err(|e| ApiError::new(e.to_string()))
    }
    pub async fn gbk(self: &Arc<Self>, spec: RequestSpec) -> Result<String, ApiError> {
        Ok(GBK.decode(&self.bytes(spec).await?).0.into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::atomic::{AtomicUsize, Ordering},
    };

    fn fixture_server(status: u16, body: Vec<u8>, delay: Duration) -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                count.fetch_add(1, Ordering::SeqCst);
                let mut request = [0_u8; 1024];
                let _ = stream.read(&mut request);
                std::thread::sleep(delay);
                let reason = if status == 200 { "OK" } else { "Forbidden" };
                let head = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        (format!("http://{address}/fixture"), calls)
    }

    #[tokio::test]
    async fn coalesces_inflight_and_reuses_cache() {
        let (url, calls) =
            fixture_server(200, br#"{"value":1}"#.to_vec(), Duration::from_millis(60));
        let gateway = Gateway::new();
        let spec = RequestSpec::get(url).cache(5);
        let (first, second) = tokio::join!(gateway.json(spec.clone()), gateway.json(spec.clone()));
        assert_eq!(first.unwrap()["value"], 1);
        assert_eq!(second.unwrap()["value"], 1);
        assert_eq!(gateway.json(spec).await.unwrap()["value"], 1);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn decodes_gbk_fixture() {
        let encoded = GBK.encode("行情正常").0.into_owned();
        let (url, _) = fixture_server(200, encoded, Duration::ZERO);
        assert_eq!(
            Gateway::new().gbk(RequestSpec::get(url)).await.unwrap(),
            "行情正常"
        );
    }

    #[tokio::test]
    async fn reports_timeout_without_caching_failure() {
        let (url, _) = fixture_server(200, b"late".to_vec(), Duration::from_millis(100));
        let mut spec = RequestSpec::get(url);
        spec.timeout = Duration::from_millis(10);
        spec.cache_ttl = Duration::ZERO;
        assert!(Gateway::new().bytes(spec).await.is_err());
    }

    #[tokio::test]
    async fn eastmoney_403_opens_circuit() {
        let (url, calls) = fixture_server(403, vec![], Duration::ZERO);
        let gateway = Gateway::new();
        assert_eq!(
            gateway
                .bytes(RequestSpec::get(&url).em())
                .await
                .unwrap_err()
                .status,
            Some(403)
        );
        let error = gateway.bytes(RequestSpec::get(url).em()).await.unwrap_err();
        assert!(error.message.contains("熔断"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}

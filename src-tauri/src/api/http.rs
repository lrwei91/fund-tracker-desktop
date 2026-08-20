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

use super::{
    diagnostics::{now_iso, DiagnosticEvent, DiagnosticStore},
    policy,
};

const MAX_RAW_CACHE_ENTRIES: usize = 256;
const MAX_RAW_CACHE_BYTES: usize = 8 * 1024 * 1024;
const MAX_ENDPOINT_CACHE_ENTRIES: usize = 128;
const MAX_ENDPOINT_CACHE_BYTES: usize = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";
const ALLOWED_UPSTREAM_HOSTS: &[&str] = &[
    "sq.deepq.tech",
    "fundsuggest.eastmoney.com",
    "hq.sinajs.cn",
    "web.ifzq.gtimg.cn",
    "qt.gtimg.cn",
    "push2.eastmoney.com",
    "vip.stock.finance.sina.com.cn",
    "data.hexin.cn",
    "www.hkex.com.hk",
    "push2his.eastmoney.com",
    "searchapi.eastmoney.com",
    "dq.10jqka.com.cn",
    "emappdata.eastmoney.com",
    "push2ex.eastmoney.com",
    "www.cls.cn",
    "np-weblist.eastmoney.com",
    "flash-api.jin10.com",
    "search-api-web.eastmoney.com",
    "so.eastmoney.com",
    "datacenter-web.eastmoney.com",
    "www.szse.cn",
    "disc.static.szse.cn",
    "np-anotice-stock.eastmoney.com",
    "pdf.dfcfw.com",
    "query.sse.com.cn",
    "mobappconfig.securities.eastmoney.com",
    "dycalchis.eastmoney.com",
    "portfolio.lrwei91.cn",
];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CacheMode {
    #[default]
    Normal,
    BypassFresh,
}

#[derive(Clone)]
struct RawCacheEntry {
    fetched_at: Instant,
    expires_at: Instant,
    value: Arc<Vec<u8>>,
}

#[derive(Clone)]
struct EndpointCacheEntry {
    stored_at: Instant,
    fetched_at: String,
    stale_until: Instant,
    value: Value,
}

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

    pub fn with_status(status: u16) -> Self {
        Self {
            message: format!("HTTP {status}"),
            status: Some(status),
        }
    }

    pub fn parse(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status: None,
        }
    }

    pub fn error_code(&self) -> (&'static str, bool) {
        policy::error_code(&self.message, self.status)
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
    pub shared_circuit: bool,
    pub cache_mode: CacheMode,
    pub allowed_host: Option<String>,
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
            shared_circuit: true,
            cache_mode: CacheMode::Normal,
            allowed_host: None,
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
    pub fn method(mut self, method: Method) -> Self {
        self.method = method;
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
    pub fn independent_circuit(mut self) -> Self {
        self.shared_circuit = false;
        self
    }
    pub fn allow_host(mut self, host: &str) -> Self {
        self.allowed_host = Some(host.to_ascii_lowercase());
        self
    }
}

#[derive(Default)]
struct Circuit {
    failures: u8,
    until: Option<Instant>,
    last_started: Option<Instant>,
    half_open_probe: bool,
}
type SharedRequest = Shared<BoxFuture<'static, Result<Arc<Vec<u8>>, ApiError>>>;
type RawResponseCache = Arc<Mutex<HashMap<String, RawCacheEntry>>>;
type EndpointResponseCache = Arc<Mutex<HashMap<String, EndpointCacheEntry>>>;

pub struct Gateway {
    client: Client,
    inflight: Arc<AsyncMutex<HashMap<String, SharedRequest>>>,
    cache: RawResponseCache,
    endpoint_cache: EndpointResponseCache,
    eastmoney: Arc<Semaphore>,
    tencent: Arc<Semaphore>,
    deepq: Arc<Semaphore>,
    default: Arc<Semaphore>,
    circuits: Arc<AsyncMutex<HashMap<String, Circuit>>>,
    diagnostics: Arc<DiagnosticStore>,
    route: String,
    cache_mode: CacheMode,
    cycle_id: Option<u64>,
    trace_id: String,
}

impl Gateway {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            client: Client::builder()
                .user_agent(BROWSER_USER_AGENT)
                .redirect(reqwest::redirect::Policy::custom(|attempt| {
                    if validate_upstream_url(attempt.url().as_str(), None).is_ok() {
                        attempt.follow()
                    } else {
                        attempt.error("redirect target rejected by upstream policy")
                    }
                }))
                .build()
                .expect("HTTP client"),
            inflight: Arc::new(AsyncMutex::new(HashMap::new())),
            cache: Arc::new(Mutex::new(HashMap::new())),
            endpoint_cache: Arc::new(Mutex::new(HashMap::new())),
            eastmoney: Arc::new(Semaphore::new(1)),
            tencent: Arc::new(Semaphore::new(4)),
            deepq: Arc::new(Semaphore::new(2)),
            default: Arc::new(Semaphore::new(3)),
            circuits: Arc::new(AsyncMutex::new(HashMap::new())),
            diagnostics: DiagnosticStore::new(DiagnosticStore::product_path()),
            route: "unknown".into(),
            cache_mode: CacheMode::Normal,
            cycle_id: None,
            trace_id: uuid::Uuid::new_v4().to_string(),
        })
    }

    pub fn scoped(self: &Arc<Self>, route: &str) -> Arc<Self> {
        Arc::new(Self {
            client: self.client.clone(),
            inflight: self.inflight.clone(),
            cache: self.cache.clone(),
            endpoint_cache: self.endpoint_cache.clone(),
            eastmoney: self.eastmoney.clone(),
            tencent: self.tencent.clone(),
            deepq: self.deepq.clone(),
            default: self.default.clone(),
            circuits: self.circuits.clone(),
            diagnostics: self.diagnostics.clone(),
            route: route.trim_start_matches('/').to_string(),
            cache_mode: self.cache_mode,
            cycle_id: self.cycle_id,
            trace_id: uuid::Uuid::new_v4().to_string(),
        })
    }

    pub fn with_context(
        self: &Arc<Self>,
        cache_mode: CacheMode,
        cycle_id: Option<u64>,
    ) -> Arc<Self> {
        Arc::new(Self {
            client: self.client.clone(),
            inflight: self.inflight.clone(),
            cache: self.cache.clone(),
            endpoint_cache: self.endpoint_cache.clone(),
            eastmoney: self.eastmoney.clone(),
            tencent: self.tencent.clone(),
            deepq: self.deepq.clone(),
            default: self.default.clone(),
            circuits: self.circuits.clone(),
            diagnostics: self.diagnostics.clone(),
            route: self.route.clone(),
            cache_mode,
            cycle_id,
            trace_id: self.trace_id.clone(),
        })
    }

    pub fn diagnostics(&self) -> Arc<DiagnosticStore> {
        self.diagnostics.clone()
    }

    pub fn trace_id(&self) -> &str {
        &self.trace_id
    }

    pub fn clear_diagnostics(&self) -> Result<(), String> {
        self.diagnostics.clear()
    }

    pub fn endpoint_key(path: &str, query: &HashMap<String, String>) -> String {
        let mut pairs: Vec<_> = query.iter().collect();
        pairs.sort_by(|a, b| a.0.cmp(b.0).then_with(|| a.1.cmp(b.1)));
        let query = pairs
            .into_iter()
            .map(|(key, value)| format!("{key}={}", normalize_query_value(key, value)))
            .collect::<Vec<_>>()
            .join("&");
        format!("{}?{query}", path.trim_start_matches('/'))
    }

    pub fn normalize_query(query: &mut HashMap<String, String>) {
        for (key, value) in query.iter_mut() {
            *value = normalize_query_value(key, value);
        }
    }

    pub fn remember_endpoint(&self, key: String, value: Value, stale_for: Duration) {
        if stale_for.is_zero() || value.get("success") != Some(&Value::Bool(true)) {
            return;
        }
        let now = Instant::now();
        let mut cache = self.endpoint_cache.lock().expect("endpoint cache");
        cache.insert(
            key,
            EndpointCacheEntry {
                stored_at: now,
                fetched_at: now_iso(),
                stale_until: now + stale_for,
                value,
            },
        );
        prune_endpoint_cache(&mut cache);
    }

    pub fn stale_endpoint(&self, key: &str) -> Option<(Value, u64, String)> {
        let now = Instant::now();
        let mut cache = self.endpoint_cache.lock().expect("endpoint cache");
        let entry = cache.get(key).cloned()?;
        if entry.stale_until <= now {
            cache.remove(key);
            return None;
        }
        Some((
            entry.value,
            now.duration_since(entry.stored_at).as_secs(),
            entry.fetched_at,
        ))
    }

    pub fn record_marker(
        &self,
        provider: &str,
        outcome: &str,
        cache: &str,
        status: Option<u16>,
        error_code: Option<&str>,
        duration_ms: u128,
    ) {
        self.record_marker_with_queue(
            provider,
            outcome,
            cache,
            status,
            error_code,
            duration_ms,
            None,
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn record_marker_with_queue(
        &self,
        provider: &str,
        outcome: &str,
        cache: &str,
        status: Option<u16>,
        error_code: Option<&str>,
        duration_ms: u128,
        queue_ms: Option<u128>,
    ) {
        self.diagnostics.record(DiagnosticEvent {
            at: now_iso(),
            route: self.route.clone(),
            provider: provider.to_string(),
            outcome: outcome.to_string(),
            cache: cache.to_string(),
            status,
            duration_ms,
            error_code: error_code.map(str::to_owned),
            cycle_id: self.cycle_id,
            queue_ms,
            trace_id: self.trace_id.clone(),
            tenant_id: "local".to_string(),
        });
    }

    pub async fn bytes(self: &Arc<Self>, spec: RequestSpec) -> Result<Arc<Vec<u8>>, ApiError> {
        let key = format!(
            "{}:{}:{}",
            spec.method,
            spec.url,
            spec.body.as_deref().unwrap_or("")
        );
        let now = Instant::now();
        let cached = {
            let mut cache = self.cache.lock().expect("cache");
            if self.cache_mode != CacheMode::BypassFresh
                && spec.cache_mode != CacheMode::BypassFresh
            {
                if let Some(entry) = cache.get(&key).cloned() {
                    if entry.expires_at > now {
                        Some(entry.value)
                    } else {
                        cache.remove(&key);
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            }
        };
        if let Some(value) = cached {
            self.record_marker("cache", "success", "hit", None, None, 0);
            return Ok(value);
        }
        let mut inflight = self.inflight.lock().await;
        if let Some(work) = inflight.get(&key) {
            let work = work.clone();
            drop(inflight);
            self.record_marker("coalesced", "success", "coalesced", None, None, 0);
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
        let host = validate_upstream_url(&spec.url, spec.allowed_host.as_deref())?;
        let provider = if spec.eastmoney || host.ends_with("eastmoney.com") {
            "eastmoney"
        } else if host.ends_with("gtimg.cn") || host.ends_with("qq.com") {
            "tencent"
        } else if host == "sq.deepq.tech" {
            "deepq"
        } else {
            "default"
        };
        let use_eastmoney_circuit = provider == "eastmoney" && spec.shared_circuit;
        let semaphore = match provider {
            "eastmoney" => self.eastmoney.clone(),
            "tencent" => self.tencent.clone(),
            "deepq" => self.deepq.clone(),
            _ => self.default.clone(),
        };
        let started = Instant::now();
        let _permit = semaphore
            .acquire_owned()
            .await
            .map_err(|e| ApiError::new(e.to_string()))?;
        let queue_ms = Some(started.elapsed().as_millis());
        if provider == "eastmoney" {
            let mut circuits = self.circuits.lock().await;
            let circuit = circuits.entry(host.clone()).or_default();
            let now = Instant::now();
            if use_eastmoney_circuit && circuit.until.is_some_and(|until| until > now) {
                let error = ApiError::new("eastmoney 数据源熔断中");
                let (code, _) = error.error_code();
                self.record_marker_with_queue(
                    provider,
                    "circuit_open",
                    "miss",
                    None,
                    Some(code),
                    started.elapsed().as_millis(),
                    queue_ms,
                );
                return Err(error);
            }
            if use_eastmoney_circuit && circuit.until.is_some() {
                if circuit.half_open_probe {
                    let error = ApiError::new("eastmoney 数据源半开探测中");
                    let (code, _) = error.error_code();
                    self.record_marker_with_queue(
                        provider,
                        "half_open",
                        "miss",
                        None,
                        Some(code),
                        started.elapsed().as_millis(),
                        queue_ms,
                    );
                    return Err(error);
                }
                circuit.half_open_probe = true;
            }
            if let Some(last) = circuit.last_started {
                let target = Duration::from_millis(1000 + rand::rng().random_range(0..=300));
                if let Some(wait) = target.checked_sub(last.elapsed()) {
                    drop(circuits);
                    tokio::time::sleep(wait).await;
                    circuits = self.circuits.lock().await;
                }
            }
            circuits.entry(host.clone()).or_default().last_started = Some(Instant::now());
        }
        let attempts = if provider == "eastmoney" { 3 } else { 1 };
        let mut last = ApiError::new("请求失败");
        for attempt in 0..attempts {
            let mut headers = HeaderMap::new();
            headers.insert("user-agent", HeaderValue::from_static(BROWSER_USER_AGENT));
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
                    let status = response.status().as_u16();
                    if response
                        .content_length()
                        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
                    {
                        last = ApiError::new("响应体超过大小限制");
                        break;
                    }
                    let body = response
                        .bytes()
                        .await
                        .map_err(|e| ApiError::new(e.to_string()))?;
                    if body.len() > MAX_RESPONSE_BYTES {
                        last = ApiError::new("响应体超过大小限制");
                        break;
                    }
                    let body = Arc::new(body.to_vec());
                    if use_eastmoney_circuit {
                        let mut circuits = self.circuits.lock().await;
                        let c = circuits.entry(host.clone()).or_default();
                        c.failures = 0;
                        c.until = None;
                        c.half_open_probe = false;
                    }
                    if !spec.cache_ttl.is_zero() {
                        let mut cache = self.cache.lock().expect("cache");
                        cache.insert(
                            key.clone(),
                            RawCacheEntry {
                                fetched_at: Instant::now(),
                                expires_at: Instant::now() + spec.cache_ttl,
                                value: body.clone(),
                            },
                        );
                        prune_raw_cache(&mut cache);
                    }
                    let duration_ms = started.elapsed().as_millis();
                    if duration_ms >= 2_000 {
                        self.record_marker_with_queue(
                            provider,
                            "slow_success",
                            "miss",
                            Some(status),
                            None,
                            duration_ms,
                            queue_ms,
                        );
                    }
                    return Ok(body);
                }
                Ok(response) => {
                    let status = response.status().as_u16();
                    last = ApiError::with_status(status);
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
        if use_eastmoney_circuit {
            let mut circuits = self.circuits.lock().await;
            let c = circuits.entry(host).or_default();
            c.half_open_probe = false;
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
        let (code, _) = last.error_code();
        self.record_marker_with_queue(
            provider,
            "error",
            "miss",
            last.status,
            Some(code),
            started.elapsed().as_millis(),
            queue_ms,
        );
        Err(last)
    }

    pub async fn json(self: &Arc<Self>, spec: RequestSpec) -> Result<Value, ApiError> {
        serde_json::from_slice(&self.bytes(spec).await?).map_err(|e| ApiError::parse(e.to_string()))
    }
    pub async fn text(self: &Arc<Self>, spec: RequestSpec) -> Result<String, ApiError> {
        String::from_utf8(self.bytes(spec).await?.as_ref().clone())
            .map_err(|e| ApiError::new(e.to_string()))
    }
    pub async fn gbk(self: &Arc<Self>, spec: RequestSpec) -> Result<String, ApiError> {
        Ok(GBK.decode(&self.bytes(spec).await?).0.into_owned())
    }
}

fn validate_upstream_url(raw: &str, allowed_host: Option<&str>) -> Result<String, ApiError> {
    let parsed = url::Url::parse(raw).map_err(|_| ApiError::new("上游地址无效"))?;
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    #[cfg(any(test, debug_assertions))]
    if parsed.scheme() == "http" && matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1") {
        return Ok(host);
    }
    if parsed.scheme() != "https" || parsed.port().is_some() {
        return Err(ApiError::new("上游地址未通过 HTTPS 与端口策略"));
    }
    if host.parse::<std::net::IpAddr>().is_ok()
        || !(ALLOWED_UPSTREAM_HOSTS.contains(&host.as_str()) || allowed_host == Some(host.as_str()))
    {
        return Err(ApiError::new("上游地址未登记"));
    }
    Ok(host)
}

fn normalize_query_value(key: &str, value: &str) -> String {
    if key != "codes" {
        return value.trim().to_string();
    }
    let mut codes = value
        .split(',')
        .map(str::trim)
        .filter(|code| !code.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    codes.sort();
    codes.dedup();
    codes.join(",")
}

fn prune_raw_cache(cache: &mut HashMap<String, RawCacheEntry>) {
    let now = Instant::now();
    cache.retain(|_, entry| entry.expires_at > now);
    let mut total = cache.values().map(|entry| entry.value.len()).sum::<usize>();
    while cache.len() > MAX_RAW_CACHE_ENTRIES || total > MAX_RAW_CACHE_BYTES {
        let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, entry)| entry.fetched_at)
            .map(|(key, entry)| (key.clone(), entry.value.len()))
        else {
            break;
        };
        cache.remove(&oldest.0);
        total = total.saturating_sub(oldest.1);
    }
}

fn prune_endpoint_cache(cache: &mut HashMap<String, EndpointCacheEntry>) {
    let now = Instant::now();
    cache.retain(|_, entry| entry.stale_until > now);
    let mut total = cache
        .values()
        .map(|entry| entry.value.to_string().len())
        .sum::<usize>();
    while cache.len() > MAX_ENDPOINT_CACHE_ENTRIES || total > MAX_ENDPOINT_CACHE_BYTES {
        let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, entry)| entry.stored_at)
            .map(|(key, entry)| (key.clone(), entry.value.to_string().len()))
        else {
            break;
        };
        cache.remove(&oldest.0);
        total = total.saturating_sub(oldest.1);
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
        fixture_server_n(status, body, delay, 1)
    }

    fn fixture_server_n(
        status: u16,
        body: Vec<u8>,
        delay: Duration,
        max_requests: usize,
    ) -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        std::thread::spawn(move || {
            for _ in 0..max_requests {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                count.fetch_add(1, Ordering::SeqCst);
                let mut request = [0_u8; 1024];
                let _ = stream.read(&mut request);
                std::thread::sleep(delay);
                let reason = if status == 200 { "OK" } else { "Fixture" };
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

    #[test]
    fn upstream_policy_rejects_unregistered_and_insecure_targets() {
        assert_eq!(
            validate_upstream_url("https://push2.eastmoney.com/api", None).unwrap(),
            "push2.eastmoney.com"
        );
        assert!(validate_upstream_url("http://push2.eastmoney.com/api", None).is_err());
        assert!(validate_upstream_url("https://push2.eastmoney.com:8443/api", None).is_err());
        assert!(validate_upstream_url("https://evil.example/api", None).is_err());
        assert!(validate_upstream_url("https://127.0.0.1/api", None).is_err());
    }

    #[tokio::test]
    async fn expired_circuit_allows_only_one_half_open_probe() {
        let (url, calls) = fixture_server(200, b"ok".to_vec(), Duration::ZERO);
        let host = url::Url::parse(&url)
            .unwrap()
            .host_str()
            .unwrap()
            .to_string();
        let gateway = Gateway::new();
        gateway.circuits.lock().await.insert(
            host,
            Circuit {
                until: Some(Instant::now() - Duration::from_millis(1)),
                half_open_probe: true,
                ..Default::default()
            },
        );
        let error = gateway.bytes(RequestSpec::get(url).em()).await.unwrap_err();
        assert!(error.message.contains("半开探测"));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
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
    async fn bypass_fresh_reuses_inflight_but_skips_short_cache() {
        let (url, calls) = fixture_server_n(200, br#"{"value":1}"#.to_vec(), Duration::ZERO, 2);
        let gateway = Gateway::new();
        let spec = RequestSpec::get(&url).cache(30);
        assert_eq!(gateway.json(spec.clone()).await.unwrap()["value"], 1);
        let bypass = gateway.with_context(CacheMode::BypassFresh, Some(7));
        assert_eq!(bypass.json(spec).await.unwrap()["value"], 1);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn rejects_oversized_response_body() {
        let (url, _) = fixture_server(200, vec![b'x'; MAX_RESPONSE_BYTES + 1], Duration::ZERO);
        let error = Gateway::new()
            .bytes(RequestSpec::get(url))
            .await
            .unwrap_err();
        assert_eq!(error.error_code().0, "upstream_error");
        assert!(error.message.contains("大小限制"));
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

    #[tokio::test]
    async fn independent_eastmoney_source_bypasses_shared_circuit() {
        let (blocked_url, _) = fixture_server(403, vec![], Duration::ZERO);
        let gateway = Gateway::new();
        gateway
            .bytes(RequestSpec::get(blocked_url).em())
            .await
            .unwrap_err();

        let (healthy_url, calls) = fixture_server(200, b"ok".to_vec(), Duration::ZERO);
        let body = gateway
            .bytes(RequestSpec::get(healthy_url).em().independent_circuit())
            .await
            .unwrap();
        assert_eq!(body.as_slice(), b"ok");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn eastmoney_circuit_is_isolated_by_host() {
        let (blocked_url, _) = fixture_server(403, vec![], Duration::ZERO);
        let gateway = Gateway::new();
        gateway
            .bytes(RequestSpec::get(blocked_url).em())
            .await
            .unwrap_err();

        let (healthy_url, calls) = fixture_server(200, b"ok".to_vec(), Duration::ZERO);
        let healthy_url = healthy_url.replacen("127.0.0.1", "localhost", 1);
        let body = gateway
            .bytes(RequestSpec::get(healthy_url).em())
            .await
            .unwrap();
        assert_eq!(body.as_slice(), b"ok");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn classifies_rate_limit_and_server_errors() {
        let (rate_url, _) = fixture_server_n(429, vec![], Duration::ZERO, 3);
        let rate_error = Gateway::new()
            .bytes(RequestSpec::get(rate_url).em())
            .await
            .unwrap_err();
        assert_eq!(rate_error.error_code().0, "rate_limited");

        let (server_url, _) = fixture_server_n(503, vec![], Duration::ZERO, 3);
        let server_error = Gateway::new()
            .bytes(RequestSpec::get(server_url).em())
            .await
            .unwrap_err();
        assert_eq!(server_error.error_code().0, "upstream_5xx");
    }

    #[tokio::test]
    async fn classifies_empty_json_fixture_as_parse_error() {
        let (url, _) = fixture_server(200, vec![], Duration::ZERO);
        let error = Gateway::new()
            .json(RequestSpec::get(url))
            .await
            .unwrap_err();
        assert_eq!(error.error_code().0, "parse_error");
    }

    #[test]
    fn raw_cache_is_bounded_by_entries_and_bytes() {
        let now = Instant::now();
        let mut cache = HashMap::new();
        for index in 0..(MAX_RAW_CACHE_ENTRIES + 8) {
            cache.insert(
                format!("fixture-{index}"),
                RawCacheEntry {
                    fetched_at: now + Duration::from_millis(index as u64),
                    expires_at: now + Duration::from_secs(60),
                    value: Arc::new(vec![0_u8; 1024]),
                },
            );
        }
        prune_raw_cache(&mut cache);
        assert!(cache.len() <= MAX_RAW_CACHE_ENTRIES);
        assert!(
            cache.values().map(|entry| entry.value.len()).sum::<usize>() <= MAX_RAW_CACHE_BYTES
        );
    }

    #[test]
    fn endpoint_cache_is_bounded_by_entries() {
        let gateway = Gateway::new();
        for index in 0..(MAX_ENDPOINT_CACHE_ENTRIES + 8) {
            gateway.remember_endpoint(
                format!("route-{index}"),
                serde_json::json!({"success":true,"data":{"index":index}}),
                Duration::from_secs(60),
            );
        }
        assert!(gateway.endpoint_cache.lock().unwrap().len() <= MAX_ENDPOINT_CACHE_ENTRIES);
    }

    #[test]
    fn endpoint_cache_keeps_stale_metadata_separate_from_live_policy() {
        let gateway = Gateway::new();
        let key = "stock-news?code=600000".to_string();
        let response = serde_json::json!({
            "success": true,
            "data": {"items": []},
            "meta": {"degraded": false, "stale": false}
        });
        gateway.remember_endpoint(key.clone(), response.clone(), Duration::from_secs(30));
        let (cached, age, fetched_at) = gateway.stale_endpoint(&key).expect("stale window");
        assert_eq!(cached, response);
        assert!(age < 2);
        assert!(!fetched_at.is_empty());

        let live_key = "stock?codes=600000".to_string();
        gateway.remember_endpoint(live_key.clone(), response, Duration::ZERO);
        assert!(gateway.stale_endpoint(&live_key).is_none());
    }
}

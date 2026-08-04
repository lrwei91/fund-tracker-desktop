// 公共工具集 — 所有 api/*.js 共享的工具函数、常量与 eastmoney 重试 helper
// (保持纯函数 / 纯常量, 不放任何业务状态)

const { TextDecoder } = require('util');
const gateway = require('./_gateway');

function providerFor(url) {
    var host = new URL(url).hostname;
    if (host.endsWith('eastmoney.com')) return 'eastmoney';
    if (host.endsWith('gtimg.cn') || host.endsWith('qq.com')) return 'tencent';
    return 'default';
}

function requestKey(url, options) {
    return `${(options && options.method) || 'GET'}:${url}:${(options && options.body) || ''}`;
}

// 交易时段常量 (上海时区分钟数, 9:15=555, 11:30=690, 13:00=780, 15:00=900, 15:05=905, 16:00=960, 21:00=1260)
// 业务时间判断函数 (isIntradayRefreshWindow 等) 在 app.js 里维护, 此处只放静态常量备以后用
const TRADING_HOURS = {
    morningOpen:    9 * 60 + 15,
    morningClose:  11 * 60 + 30,
    afternoonOpen: 13 * 60,
    afternoonClose:15 * 60 + 5,
    postClose:     16 * 60,
    lateHours:     21 * 60,
};

// API 请求超时 (ms)
const API_TIMEOUTS = {
    fast:   8 * 1000,    // 轻量查询 (quote, 名称)
    normal: 10 * 1000,   // 通用
    push2:  12 * 1000,   // push2.eastmoney.com
    heavy:  15 * 1000,   // 全市场 6000 条等
};

function sendJson(res, status, body) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=45');
    res.end(JSON.stringify(body));
}

function ok(res, data, extra) {
    sendJson(res, 200, Object.assign({ success: true, data }, extra || {}));
}

function fail(res, status, message, extra) {
    sendJson(res, status, Object.assign({ success: false, message }, extra || {}));
}

async function fetchJson(url, options) {
    return gateway.request(providerFor(url), requestKey(url, options), async () => {
        const response = await fetch(url, {
            method: (options && options.method) || 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 fund-tracker/1.0',
                Referer: 'https://finance.eastmoney.com/',
                ...(options && options.headers ? options.headers : {}),
            },
            body: options && options.body,
            signal: AbortSignal.timeout((options && options.timeout) || 10000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
    }, { cacheTtl: (options && options.cacheTtl) || 5000 });
}

// 东财统一请求 helper(指数退避重试 + 串行限流防封):
//  - 最多 3 次,指数退避(300ms * 2^n) + 0~100ms 随机抖动
//  - 重试:HTTP 429 / 5xx,以及网络层错误(AbortError / fetch failed / DNS / 连接重置/超时)
//  - 不重试:HTTP 403(靠降频/换网络应对,403 重试只会更快触发风控)
//           其它 4xx(客户端错误,重试无意义)
//  - 接收东财 6 个子域(push2 / push2his / push2ex / np-weblist / datacenter / searchapi / reportapi)
//  - 之所以单独抽出:东财 IP 级风控(>5 QPS / 并发≥10 / 1分≥200 / 5分≥300)主要落在调用层,
//    helper 把"重试策略"集中维护,新增端点直接复用即可。
async function emRequest(url, options, responseType) {
    const maxRetries = 3;
    const baseDelay = 300;
    const timeout = (options && options.timeout) || 10000;

    return gateway.request('eastmoney', requestKey(url, options), async () => {
      let lastError;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        let response;
        try {
            response = await fetch(url, {
                method: (options && options.method) || 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 fund-tracker/1.0',
                    Referer: 'https://finance.eastmoney.com/',
                    ...(options && options.headers ? options.headers : {}),
                },
                body: options && options.body,
                signal: AbortSignal.timeout(timeout),
            });
        } catch (error) {
            // 网络层错误(AbortError / fetch failed / DNS / ECONNRESET / ETIMEDOUT 等)
            lastError = error;
            if (attempt < maxRetries - 1) {
                await sleep(baseDelay * Math.pow(2, attempt) + Math.floor(Math.random() * 100));
                continue;
            }
            throw error;
        }

        if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
            lastError = new Error(`HTTP ${response.status}`);
            lastError.status = response.status;
            if (attempt < maxRetries - 1) {
                await sleep(baseDelay * Math.pow(2, attempt) + Math.floor(Math.random() * 100));
                continue;
            }
            throw lastError;
        }
        if (!response.ok) {
            // 4xx(除 429)不重试,直接抛
            const error = new Error(`HTTP ${response.status}`);
            error.status = response.status;
            throw error;
        }
          return responseType === 'text' ? response.text() : response.json();
      }
      throw lastError || new Error('emGet 重试耗尽');
    }, { cacheTtl: (options && options.cacheTtl) || 10000 });
}

function emGet(url, options) {
    return emRequest(url, options, 'json');
}

function emGetText(url, options) {
    return emRequest(url, options, 'text');
}

async function runSources(sources) {
    const attempts = [];
    for (const source of sources || []) {
        try {
            const value = await source.load();
            if (source.validate && !source.validate(value)) throw new Error('数据为空或格式异常');
            return {
                value,
                meta: {
                    actual: source.id,
                    actualLabel: source.label || source.id,
                    attempts,
                    degraded: attempts.length > 0,
                    fallbackReason: attempts.map((item) => `${item.label}: ${item.reason}`).join('; '),
                },
            };
        } catch (error) {
            attempts.push({
                source: source.id,
                label: source.label || source.id,
                reason: error && error.message ? error.message : String(error),
            });
        }
    }
    const error = new Error(attempts.map((item) => `${item.label}: ${item.reason}`).join('; ') || '所有数据源均不可用');
    error.attempts = attempts;
    throw error;
}

function sourceMeta(key, result, extra) {
    return {
        asOf: extra && extra.asOf ? extra.asOf : new Date().toISOString(),
        degraded: !!(result && result.meta && result.meta.degraded),
        sources: {
            [key]: Object.assign({}, result && result.meta ? result.meta : {}, extra || {}),
        },
    };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url, options) {
    return gateway.request(providerFor(url), requestKey(url, options), async () => {
      const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 fund-tracker/1.0',
            Referer: 'https://finance.eastmoney.com/',
            ...(options && options.headers ? options.headers : {}),
        },
        signal: AbortSignal.timeout((options && options.timeout) || 10000),
    });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    }, { cacheTtl: (options && options.cacheTtl) || 5000 });
}

async function fetchGbkText(url, options) {
    return gateway.request('tencent', requestKey(url, options), async () => {
      const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 fund-tracker/1.0',
            Referer: 'https://finance.qq.com/',
            ...(options && options.headers ? options.headers : {}),
        },
        signal: AbortSignal.timeout((options && options.timeout) || 10000),
    });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      return new TextDecoder('gbk').decode(buffer);
    }, { cacheTtl: (options && options.cacheTtl) || 5000 });
}

function toNumber(value) {
    if (value === undefined || value === null || value === '-' || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function formatPct(value) {
    const number = toNumber(value);
    if (number === null) return '--';
    return `${number > 0 ? '+' : ''}${number.toFixed(2)}%`;
}

function formatYi(value) {
    const number = toNumber(value);
    if (number === null) return '--';
    const yi = number / 100000000;
    return `${yi > 0 ? '+' : ''}${yi.toFixed(2)}亿`;
}

function tencentSymbol(code) {
    return `${/^(5|6|9)/.test(code) ? 'sh' : 'sz'}${code}`;
}

module.exports = {
    API_TIMEOUTS,
    TRADING_HOURS,
    emGet,
    emGetText,
    fail,
    fetchGbkText,
    fetchJson,
    fetchText,
    formatPct,
    formatYi,
    ok,
    runSources,
    sendJson,
    sleep,
    sourceMeta,
    tencentSymbol,
    toNumber,
};

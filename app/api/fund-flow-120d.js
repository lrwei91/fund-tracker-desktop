// 自选股日级资金流。东财主源，新浪独立备用源。

const { API_TIMEOUTS, emGet, fail, fetchGbkText, fetchText, ok, runSources, toNumber } = require('./_utils');

const MAX_CODES = 10;
const MAX_DAYS = 120;
const MIN_DAYS = 5;
const PER_REQUEST_SLEEP_MS = 200;

function marketCode(code) {
    return (code.startsWith('6') || code.startsWith('9')) ? 1 : 0;
}

function sinaSymbol(code) {
    if (code.startsWith('6') || code.startsWith('9')) return `sh${code}`;
    if (code.startsWith('8') || code.startsWith('4')) return `bj${code}`;
    return `sz${code}`;
}

function tencentQuoteSymbol(code) {
    return `${/^(5|6|9)/.test(code) ? 'sh' : 'sz'}${code}`;
}

async function fetchNames(codes) {
    if (!codes.length) return {};
    const symbols = codes.map(tencentQuoteSymbol).join(',');
    let text;
    try {
        text = await fetchGbkText(`https://qt.gtimg.cn/q=${symbols}`, {
            headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: API_TIMEOUTS.fast,
        });
    } catch (error) {
        return {};
    }
    const map = {};
    text.split(';').filter(Boolean).forEach((rawLine) => {
        const line = rawLine.trim();
        const eq = line.indexOf('=');
        if (eq < 0) return;
        const key = line.slice(2, eq);
        const code = key.startsWith('sh') || key.startsWith('sz') ? key.slice(2) : key;
        const quoteMatch = line.match(/="([\s\S]+?)"/);
        if (!quoteMatch) return;
        const parts = quoteMatch[1].split('~');
        if (parts.length >= 2 && /^\d{6}$/.test(code)) map[code] = parts[1];
    });
    return map;
}

function parseEastmoneyRows(klines) {
    return (Array.isArray(klines) ? klines : []).map((line) => {
        const parts = String(line || '').split(',');
        return {
            date: parts[0] || '',
            mainNet: toNumber(parts[1]),
            smallNet: toNumber(parts[2]),
            midNet: toNumber(parts[3]),
            largeNet: toNumber(parts[4]),
            superNet: toNumber(parts[5]),
            pct: toNumber(parts[6]),
        };
    }).filter((row) => row.date);
}

function parseSinaRows(payload) {
    return (Array.isArray(payload) ? payload : []).map((row) => ({
        date: String(row.opendate || ''),
        mainNet: toNumber(row.netamount),
        smallNet: null,
        midNet: null,
        largeNet: null,
        superNet: null,
        pct: toNumber(row.changeratio) === null ? null : toNumber(row.changeratio) * 100,
    })).filter((row) => row.date).sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchEastmoneyRows(code, days) {
    const secid = `${marketCode(code)}.${code}`;
    const params = new URLSearchParams({
        secid,
        klt: '101',
        lmt: String(days),
        fields1: 'f1,f2,f3,f7',
        fields2: 'f51,f52,f53,f54,f55,f56,f57',
    });
    const endpoints = [`https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?${params.toString()}`];
    let lastError = null;
    for (const url of endpoints) {
        try {
            const json = await emGet(url, {
                cacheTtl: 10 * 60 * 1000,
                headers: { Referer: 'https://quote.eastmoney.com/' },
                timeout: API_TIMEOUTS.push2,
            });
            const rows = parseEastmoneyRows(json && json.data && json.data.klines);
            if (rows.length) return rows;
            lastError = new Error('东财资金流为空');
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError || new Error('东财资金流不可用');
}

async function fetchSinaRows(code, days) {
    const url = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/'
        + `MoneyFlow.ssl_qsfx_zjlrqs?page=1&num=${days}&sort=opendate&asc=0&daima=${sinaSymbol(code)}`;
    const text = await fetchText(url, {
        cacheTtl: 10 * 60 * 1000,
        headers: { Referer: 'https://finance.sina.com.cn/' },
        timeout: API_TIMEOUTS.normal,
    });
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start < 0 || end <= start) throw new Error('新浪资金流格式异常');
    return parseSinaRows(JSON.parse(text.slice(start, end + 1)));
}

function sumWindow(recent, key, window) {
    return recent.slice(-Math.min(window, recent.length)).reduce((sum, row) => {
        const value = toNumber(row[key]);
        return value === null ? sum : sum + value;
    }, 0);
}

function summarize(recent, code, name, source) {
    const last = recent[recent.length - 1];
    return {
        available: true,
        code,
        name: name || '',
        source: source.meta.actual,
        sourceLabel: source.meta.actualLabel,
        fallbackReason: source.meta.fallbackReason || '',
        recent: recent.slice(-10),
        summary: {
            main_5d: sumWindow(recent, 'mainNet', 5),
            main_20d: sumWindow(recent, 'mainNet', 20),
            main_60d: sumWindow(recent, 'mainNet', 60),
            today: last ? {
                main: last.mainNet,
                large: last.largeNet,
                medium: last.midNet,
                small: last.smallNet,
            } : null,
        },
        latestDate: last ? last.date : null,
    };
}

function unavailableItem(code, name, error) {
    return {
        available: false,
        code,
        name: name || '',
        source: null,
        sourceLabel: '',
        fallbackReason: error && error.message ? error.message : '资金流不可用',
        recent: [],
        summary: { main_5d: null, main_20d: null, main_60d: null, today: null },
        latestDate: null,
    };
}

module.exports = async function handler(req, res) {
    try {
        const codesRaw = String(req.query.codes || '').split(',').map((item) => item.trim()).filter((item) => /^\d{6}$/.test(item));
        if (!codesRaw.length) return fail(res, 400, '缺少股票代码');
        const codes = codesRaw.slice(0, MAX_CODES);
        const days = Math.max(MIN_DAYS, Math.min(MAX_DAYS, parseInt(req.query.days, 10) || 60));
        const nameMap = await fetchNames(codes);
        const items = [];
        for (const code of codes) {
            try {
                const result = await runSources([
                    { id: 'eastmoney', label: '东方财富', load: () => fetchEastmoneyRows(code, days), validate: (rows) => rows.length > 0 },
                    { id: 'sina', label: '新浪财经', load: () => fetchSinaRows(code, days), validate: (rows) => rows.length > 0 },
                ]);
                items.push(summarize(result.value, code, nameMap[code], result));
            } catch (error) {
                items.push(unavailableItem(code, nameMap[code], error));
            }
            if (codes.length > 1) await new Promise((resolve) => setTimeout(resolve, PER_REQUEST_SLEEP_MS));
        }
        const actualSources = Array.from(new Set(items.filter((item) => item.source).map((item) => item.source)));
        return ok(res, { days, count: items.length, items }, {
            meta: {
                asOf: new Date().toISOString(),
                degraded: items.some((item) => !item.available || item.source !== 'eastmoney'),
                sources: {
                    fundFlow: {
                        actual: actualSources.length === 1 ? actualSources[0] : (actualSources.length ? 'mixed' : null),
                        unavailable: items.filter((item) => !item.available).map((item) => item.code),
                    },
                },
            },
        });
    } catch (error) {
        return fail(res, 502, '真实 120 日资金流接口不可用', { error: error.message });
    }
};

module.exports.parseEastmoneyRows = parseEastmoneyRows;
module.exports.parseSinaRows = parseSinaRows;
module.exports.summarize = summarize;
module.exports.unavailableItem = unavailableItem;

// 自选股日 K 技术面分析（A 股）
// 用日 K 数据在本地计算趋势评分、支撑压力和成交量筹码估算。

const { execFile } = require('child_process');
const { promisify } = require('util');

const { API_TIMEOUTS, emGet, fail, fetchJson, ok, tencentSymbol, toNumber } = require('./_utils');
const tdxrsCapability = require('./_tdxrs');

const execFileAsync = promisify(execFile);

const DEFAULT_DAYS = 260;
const MIN_DAYS = 60;
const MAX_DAYS = 520;

function marketCode(code) {
    return (code.startsWith('6') || code.startsWith('9')) ? 1 : 0;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function round(value, digits) {
    const number = toNumber(value);
    if (number === null) return null;
    const base = Math.pow(10, digits ?? 2);
    return Math.round(number * base) / base;
}

function parseKline(line) {
    const parts = String(line || '').split(',');
    return {
        date: parts[0] || '',
        open: toNumber(parts[1]),
        close: toNumber(parts[2]),
        high: toNumber(parts[3]),
        low: toNumber(parts[4]),
        volume: toNumber(parts[5]),
        amount: toNumber(parts[6]),
        amplitude: toNumber(parts[7]),
        pct: toNumber(parts[8]),
        change: toNumber(parts[9]),
        turnover: toNumber(parts[10]),
    };
}

async function fetchEastmoneyDailyKlines(code, days) {
    const params = new URLSearchParams({
        secid: `${marketCode(code)}.${code}`,
        klt: '101',
        fqt: '1',
        lmt: String(days),
        fields1: 'f1,f2,f3,f4,f5,f6',
        fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
    });
    const json = await emGet(`https://push2his.eastmoney.com/api/qt/stock/kline/get?${params.toString()}`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 fund-tracker/1.0',
            Referer: 'https://quote.eastmoney.com/',
        },
        timeout: API_TIMEOUTS.push2,
    });
    const data = json && json.data ? json.data : {};
    const klines = Array.isArray(data.klines) ? data.klines : [];
    const bars = klines.map(parseKline)
        .filter((bar) => bar.date && bar.open !== null && bar.close !== null && bar.high !== null && bar.low !== null)
        .sort((a, b) => a.date.localeCompare(b.date));
    return {
        name: data.name || '',
        bars,
        source: 'eastmoney',
        sourceLabel: '东方财富日K',
    };
}

async function fetchTencentDailyKlines(code, days) {
    const symbol = tencentSymbol(code);
    const json = await fetchJson(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${days},qfq`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 fund-tracker/1.0',
            Referer: 'https://gu.qq.com/',
        },
        timeout: API_TIMEOUTS.normal,
    });
    const data = json && json.data && json.data[symbol] ? json.data[symbol] : {};
    const rows = Array.isArray(data.qfqday) ? data.qfqday : (Array.isArray(data.day) ? data.day : []);
    const qt = data.qt && Array.isArray(data.qt[symbol]) ? data.qt[symbol] : [];
    const bars = rows.map((row) => ({
        date: row[0] || '',
        open: toNumber(row[1]),
        close: toNumber(row[2]),
        high: toNumber(row[3]),
        low: toNumber(row[4]),
        volume: toNumber(row[5]),
        amount: toNumber(row[6]),
        amplitude: null,
        pct: null,
        change: null,
        turnover: null,
    })).filter((bar) => bar.date && bar.open !== null && bar.close !== null && bar.high !== null && bar.low !== null)
        .sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 0; i < bars.length; i++) {
        const prev = i > 0 ? bars[i - 1].close : null;
        if (prev && prev > 0) {
            bars[i].change = bars[i].close - prev;
            bars[i].pct = (bars[i].close - prev) / prev * 100;
        }
    }
    return {
        name: qt[1] || '',
        bars,
        source: 'tencent',
        sourceLabel: '腾讯复权日K',
    };
}

// tdxrs 日 K 数据（通达信直连，安装 tdxrs 后可用）
function tdxrsBarsArgs(days) {
    const count = Math.max(60, Math.min(800, days));
    const timeout = '8';
    const commands = [];
    if (process.env.TDXRS_BIN) {
        commands.push({
            label: process.env.TDXRS_BIN,
            command: process.env.TDXRS_BIN,
            args: ['bars', '--count', String(count), '--fq', '1', '--category', 'day', '--format', 'json', '--timeout', timeout],
        });
    }
    commands.push({
        label: 'tdxrs',
        command: 'tdxrs',
        args: ['bars', '--count', String(count), '--fq', '1', '--category', 'day', '--format', 'json', '--timeout', timeout],
    });
    ['python3', 'python'].filter(Boolean).forEach((python) => {
        commands.push({
            label: `${python} -m tdxrs`,
            command: python,
            args: ['-m', 'tdxrs', 'bars', '--count', String(count), '--fq', '1', '--category', 'day', '--format', 'json', '--timeout', timeout],
        });
    });
    const seen = new Set();
    return commands.filter((item) => {
        const key = `${item.command}\0${item.args.join('\0')}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function fetchTdxrsDailyKlines(code, days) {
    const count = Math.max(60, Math.min(800, days));
    const errors = [];
    const timeoutMs = API_TIMEOUTS.normal + 3000;

    for (const candidate of tdxrsBarsArgs(count)) {
        try {
            const { stdout } = await execFileAsync(candidate.command, candidate.args.concat(code), {
                encoding: 'utf8',
                timeout: timeoutMs,
                maxBuffer: 1024 * 1024,
                windowsHide: true,
                env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
            });
            const text = String(stdout || '').trim();
            const start = text.indexOf('[');
            const end = text.lastIndexOf(']');
            if (start === -1 || end === -1 || end < start) throw new Error('JSON 输出为空');
            const rows = JSON.parse(text.slice(start, end + 1));
            if (!Array.isArray(rows) || !rows.length) throw new Error('K 线数据为空');

            const numeric = (v) => {
                const n = toNumber(String(v || '').replace(/,/g, ''));
                return n === null ? null : n;
            };
            const bars = rows.map((row) => {
                const open = numeric(row['开盘']);
                const close = numeric(row['收盘']);
                const high = numeric(row['最高']);
                const low = numeric(row['最低']);
                const volume = numeric(row['成交量']);
                const amount = numeric(row['成交额']);
                return {
                    date: String(row['日期'] || '').trim(),
                    open, close, high, low,
                    volume: volume === null ? 0 : volume,
                    amount: amount === null ? 0 : amount,
                    amplitude: null,
                    pct: null,
                    change: null,
                    turnover: null,
                };
            }).filter((bar) => bar.date && bar.open !== null && bar.close !== null && bar.high !== null && bar.low !== null)
                .sort((a, b) => a.date.localeCompare(b.date));

            // 计算涨跌幅和涨跌额
            for (let i = 0; i < bars.length; i++) {
                const prev = i > 0 ? bars[i - 1].close : null;
                if (prev && prev > 0) {
                    bars[i].change = bars[i].close - prev;
                    bars[i].pct = (bars[i].close - prev) / prev * 100;
                }
            }

            return {
                name: '',
                bars,
                source: 'tdxrs',
                sourceLabel: '通达信日K(tdxrs)',
            };
        } catch (error) {
            errors.push(`${candidate.label}: ${error.message}`);
        }
    }
    const error = new Error(errors.join(' | ') || 'tdxrs K 线不可用');
    error.details = errors;
    throw error;
}

function average(values) {
    const nums = values.filter((value) => Number.isFinite(value));
    if (!nums.length) return null;
    return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function sum(values) {
    return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function sma(values, window) {
    if (!Array.isArray(values) || values.length < window) return null;
    return average(values.slice(-window));
}

function emaSeries(values, period) {
    if (!Array.isArray(values) || !values.length) return [];
    const k = 2 / (period + 1);
    const result = [];
    let prev = values[0];
    result.push(prev);
    for (let i = 1; i < values.length; i++) {
        prev = values[i] * k + prev * (1 - k);
        result.push(prev);
    }
    return result;
}

function rsi(values, period) {
    if (!Array.isArray(values) || values.length <= period) return null;
    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= period; i++) {
        const diff = values[i] - values[i - 1];
        if (diff >= 0) gain += diff;
        else loss -= diff;
    }
    gain /= period;
    loss /= period;
    for (let i = period + 1; i < values.length; i++) {
        const diff = values[i] - values[i - 1];
        gain = (gain * (period - 1) + Math.max(diff, 0)) / period;
        loss = (loss * (period - 1) + Math.max(-diff, 0)) / period;
    }
    if (loss === 0) return 100;
    const rs = gain / loss;
    return 100 - (100 / (1 + rs));
}

function macd(values) {
    if (!Array.isArray(values) || values.length < 35) return null;
    const ema12 = emaSeries(values, 12);
    const ema26 = emaSeries(values, 26);
    const diffs = values.map((_value, index) => ema12[index] - ema26[index]);
    const signal = emaSeries(diffs, 9);
    const last = diffs.length - 1;
    return {
        dif: diffs[last],
        dea: signal[last],
        hist: (diffs[last] - signal[last]) * 2,
    };
}

function bollinger(values, window) {
    if (!Array.isArray(values) || values.length < window) return null;
    const slice = values.slice(-window);
    const mid = average(slice);
    if (mid === null) return null;
    const variance = average(slice.map((value) => Math.pow(value - mid, 2)));
    const sd = Math.sqrt(variance || 0);
    return {
        upper: mid + sd * 2,
        mid,
        lower: mid - sd * 2,
    };
}

function addSignal(signals, scoreState, title, detail, weight) {
    scoreState.value += weight;
    signals.push({
        title,
        detail,
        weight: round(weight, 0),
        type: weight > 0 ? 'positive' : (weight < 0 ? 'negative' : 'neutral'),
    });
}

function computeTechnicalAnalysis(bars) {
    const closes = bars.map((bar) => bar.close).filter((value) => value !== null);
    const volumes = bars.map((bar) => bar.volume || 0);
    const latest = bars[bars.length - 1];
    const close = latest.close;
    const ma20 = sma(closes, 20);
    const ma50 = sma(closes, 50);
    const ma200 = sma(closes, 200);
    const rsi14 = rsi(closes, 14);
    const macdValue = macd(closes);
    const boll = bollinger(closes, 20);
    const highWindow = bars.slice(-Math.min(250, bars.length)).map((bar) => bar.high).filter((value) => value !== null);
    const lowWindow = bars.slice(-Math.min(250, bars.length)).map((bar) => bar.low).filter((value) => value !== null);
    const high52w = highWindow.length ? Math.max.apply(Math, highWindow) : null;
    const low52w = lowWindow.length ? Math.min.apply(Math, lowWindow) : null;
    const close21 = closes.length > 21 ? closes[closes.length - 22] : null;
    const momentum21 = close21 ? (close - close21) / close21 * 100 : null;
    const volume20 = average(volumes.slice(-20));
    const volumeRatio = volume20 ? latest.volume / volume20 : null;
    const position52w = high52w !== null && low52w !== null && high52w > low52w
        ? (close - low52w) / (high52w - low52w) * 100
        : null;
    const scoreState = { value: 0 };
    const signals = [];

    if (ma20 !== null) {
        addSignal(signals, scoreState, close >= ma20 ? '站上 MA20' : '跌破 MA20',
            `收盘 ${close >= ma20 ? '高于' : '低于'} 20 日均线 ${round(ma20, 2)}`, close >= ma20 ? 8 : -8);
    }
    if (ma20 !== null && ma50 !== null) {
        addSignal(signals, scoreState, ma20 >= ma50 ? '中期均线偏强' : '中期均线偏弱',
            `MA20 ${ma20 >= ma50 ? '高于' : '低于'} MA50`, ma20 >= ma50 ? 10 : -10);
    }
    if (ma50 !== null && ma200 !== null) {
        addSignal(signals, scoreState, ma50 >= ma200 ? '长期趋势向上' : '长期趋势承压',
            `MA50 ${ma50 >= ma200 ? '高于' : '低于'} MA200`, ma50 >= ma200 ? 12 : -12);
    }
    if (rsi14 !== null) {
        if (rsi14 >= 70) addSignal(signals, scoreState, 'RSI 过热', `RSI14 ${round(rsi14, 1)}`, -6);
        else if (rsi14 >= 55) addSignal(signals, scoreState, 'RSI 动能偏强', `RSI14 ${round(rsi14, 1)}`, 8);
        else if (rsi14 <= 30) addSignal(signals, scoreState, 'RSI 超卖', `RSI14 ${round(rsi14, 1)}`, 6);
        else if (rsi14 < 45) addSignal(signals, scoreState, 'RSI 动能偏弱', `RSI14 ${round(rsi14, 1)}`, -6);
    }
    if (macdValue) {
        addSignal(signals, scoreState, macdValue.dif >= macdValue.dea ? 'MACD 金叉区' : 'MACD 死叉区',
            `DIF ${round(macdValue.dif, 3)} / DEA ${round(macdValue.dea, 3)}`, macdValue.dif >= macdValue.dea ? 8 : -8);
        if (macdValue.hist > 0) scoreState.value += 4;
        else if (macdValue.hist < 0) scoreState.value -= 4;
    }
    if (momentum21 !== null) {
        if (momentum21 >= 5) addSignal(signals, scoreState, '近 21 日走强', `${round(momentum21, 2)}%`, 8);
        else if (momentum21 <= -5) addSignal(signals, scoreState, '近 21 日走弱', `${round(momentum21, 2)}%`, -8);
    }
    if (position52w !== null) {
        if (position52w >= 65) addSignal(signals, scoreState, '接近区间高位', `52 周位置 ${round(position52w, 1)}%`, 6);
        else if (position52w <= 35) addSignal(signals, scoreState, '处于区间低位', `52 周位置 ${round(position52w, 1)}%`, -6);
    }
    if (boll) {
        if (close > boll.upper) addSignal(signals, scoreState, '突破布林上轨', `上轨 ${round(boll.upper, 2)}`, -4);
        else if (close < boll.lower) addSignal(signals, scoreState, '跌破布林下轨', `下轨 ${round(boll.lower, 2)}`, 4);
    }
    if (volumeRatio !== null && volumeRatio >= 1.5 && latest.pct !== null) {
        addSignal(signals, scoreState, latest.pct >= 0 ? '放量上涨' : '放量下跌',
            `量比约 ${round(volumeRatio, 2)}x`, latest.pct >= 0 ? 5 : -5);
    }

    const score = clamp(Math.round(scoreState.value), -100, 100);
    const verdict = score >= 35 ? '强势'
        : (score >= 15 ? '偏多'
            : (score > -15 ? '中性'
                : (score > -35 ? '偏弱' : '弱势')));
    return {
        score,
        verdict,
        latestDate: latest.date,
        indicators: {
            close: round(close, 2),
            ma20: round(ma20, 2),
            ma50: round(ma50, 2),
            ma200: round(ma200, 2),
            rsi14: round(rsi14, 1),
            position52w: round(position52w, 1),
            momentum21: round(momentum21, 2),
            volumeRatio: round(volumeRatio, 2),
        },
        signals: signals.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 6),
    };
}

function percentileFromDistribution(levels, ratio) {
    const total = sum(levels.map((level) => level.weight));
    if (!total) return null;
    const target = total * ratio;
    let acc = 0;
    for (const level of levels) {
        acc += level.weight;
        if (acc >= target) return level.price;
    }
    return levels.length ? levels[levels.length - 1].price : null;
}

function computeChipDistribution(bars) {
    const source = bars.slice(-Math.min(180, bars.length));
    const valid = source.filter((bar) => bar.high !== null && bar.low !== null && bar.close !== null && (bar.volume || 0) > 0);
    if (valid.length < 20) return null;
    const latest = bars[bars.length - 1];
    const close = latest.close;
    const low = Math.min.apply(Math, valid.map((bar) => bar.low));
    const high = Math.max.apply(Math, valid.map((bar) => bar.high));
    if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return null;
    const binCount = 48;
    const step = (high - low) / binCount;
    const weights = Array.from({ length: binCount }, () => 0);
    valid.forEach((bar, index) => {
        const age = valid.length - 1 - index;
        const weight = (bar.volume || 0) * Math.pow(0.5, age / 60);
        const start = clamp(Math.floor((Math.min(bar.low, bar.high) - low) / step), 0, binCount - 1);
        const end = clamp(Math.floor((Math.max(bar.low, bar.high) - low) / step), 0, binCount - 1);
        const span = Math.max(1, end - start + 1);
        for (let i = start; i <= end; i++) weights[i] += weight / span;
    });
    const levels = weights.map((weight, index) => ({ price: low + step * (index + 0.5), weight }));
    const total = sum(weights);
    const maxWeight = Math.max.apply(Math, weights);
    const avgCost = total ? sum(levels.map((level) => level.price * level.weight)) / total : null;
    const profitRatio = total ? sum(levels.filter((level) => level.price <= close).map((level) => level.weight)) / total * 100 : null;
    const support = levels.filter((level) => level.price < close).sort((a, b) => b.weight - a.weight || b.price - a.price)[0];
    const resistance = levels.filter((level) => level.price > close).sort((a, b) => b.weight - a.weight || a.price - b.price)[0];
    const p5 = percentileFromDistribution(levels, 0.05);
    const p95 = percentileFromDistribution(levels, 0.95);
    return {
        windowDays: valid.length,
        avgCost: round(avgCost, 2),
        profitRatio: round(profitRatio, 1),
        support: support ? round(support.price, 2) : null,
        resistance: resistance ? round(resistance.price, 2) : null,
        concentration90: p5 !== null && p95 !== null ? {
            low: round(p5, 2),
            high: round(p95, 2),
            widthPct: avgCost ? round((p95 - p5) / avgCost * 100, 1) : null,
        } : null,
        levels: levels.map((level) => ({
            price: round(level.price, 2),
            weightPct: total ? round(level.weight / total * 100, 2) : 0,
            height: maxWeight ? round(level.weight / maxWeight * 100, 1) : 0,
            inProfit: level.price <= close,
        })),
        note: '按近 180 个交易日成交量在日内价格区间均匀分布估算',
    };
}

async function handler(req, res) {
    try {
        const code = String(req.query.code || '').trim();
        if (!/^\d{6}$/.test(code)) return fail(res, 400, '缺少股票代码');
        const days = Math.max(MIN_DAYS, Math.min(MAX_DAYS, parseInt(req.query.days, 10) || DEFAULT_DAYS));
        let result;
        let fallbackReason = '';

        // 开发环境首次探测 tdxrs；打包环境未显式配置时直接走纯 HTTP 数据源。
        const sources = [];
        if (tdxrsCapability.shouldTry()) {
            sources.push({
                label: '通达信',
                fn: async () => {
                    try {
                        const value = await fetchTdxrsDailyKlines(code, days);
                        tdxrsCapability.markAvailable();
                        return value;
                    } catch (error) {
                        tdxrsCapability.markUnavailable();
                        throw error;
                    }
                },
            });
        }
        sources.push(
            { label: '腾讯', fn: () => fetchTencentDailyKlines(code, days) },
            { label: '东方财富', fn: () => fetchEastmoneyDailyKlines(code, days) },
        );
        for (const s of sources) {
            try {
                result = await s.fn();
                if (result && result.bars && result.bars.length >= MIN_DAYS) break;
                if (result && result.bars && result.bars.length) {
                    fallbackReason = `${s.label}: 数据不足(${result.bars.length}条)`;
                } else {
                    fallbackReason = `${s.label}: 无数据`;
                }
                result = null;
            } catch (error) {
                fallbackReason = `${s.label}: ${error.message}`;
                result = null;
            }
        }
        if (!result || !result.bars.length) return fail(res, 404, '暂无日 K 数据');
        const analysis = computeTechnicalAnalysis(result.bars);
        const chips = computeChipDistribution(result.bars);
        return ok(res, {
            code,
            name: result.name,
            days,
            source: result.source,
            sourceLabel: result.sourceLabel,
            fallbackReason,
            latestDate: analysis.latestDate,
            count: result.bars.length,
            analysis,
            chips,
            bars: result.bars.slice(-60).map((bar) => ({
                date: bar.date,
                close: round(bar.close, 2),
                pct: round(bar.pct, 2),
                volume: bar.volume || 0,
            })),
        });
    } catch (error) {
        return fail(res, 502, 'A 股日 K 技术面接口不可用', { error: error.message });
    }
}

// 纯函数导出（供单测使用，不影响 handler 行为）
module.exports = handler;
module.exports.computeTechnicalAnalysis = computeTechnicalAnalysis;
module.exports.computeChipDistribution = computeChipDistribution;
module.exports.marketCode = marketCode;
module.exports.clamp = clamp;
module.exports.round = round;
module.exports.parseKline = parseKline;
module.exports.average = average;
module.exports.sum = sum;
module.exports.sma = sma;
module.exports.emaSeries = emaSeries;
module.exports.rsi = rsi;
module.exports.macd = macd;
module.exports.bollinger = bollinger;
module.exports.percentileFromDistribution = percentileFromDistribution;

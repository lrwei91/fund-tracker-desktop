const { execFile } = require('child_process');
const { promisify } = require('util');
const {
    API_TIMEOUTS,
    emGet,
    fail,
    fetchJson,
    ok,
    tencentSymbol,
    toNumber,
} = require('./_utils');

const execFileAsync = promisify(execFile);
const MAX_POINTS = 240;

function marketOf(code) {
    return /^(5|6|9)/.test(code) ? 1 : 0;
}

function clampCount(value) {
    const count = Number(value);
    if (!Number.isFinite(count)) return MAX_POINTS;
    return Math.max(1, Math.min(MAX_POINTS, Math.floor(count)));
}

function parseNumeric(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    return toNumber(String(value == null ? '' : value).replace(/[,%]/g, '').trim());
}

function normalizeTime(value) {
    const match = String(value || '').match(/(\d{2}:\d{2})/);
    return match ? match[1] : '';
}

function sortMinutePoints(points) {
    return points
        .filter((point) => point && point.time && point.price !== null)
        .sort((a, b) => a.time.localeCompare(b.time));
}

function inferPreClose(points) {
    for (let i = points.length - 1; i >= 0; i -= 1) {
        const point = points[i];
        if (!point || point.price === null || point.changePercent === null) continue;
        const base = point.price / (1 + point.changePercent / 100);
        if (Number.isFinite(base) && base > 0) return Number(base.toFixed(4));
    }
    return null;
}

function shanghaiTime() {
    return new Date().toLocaleTimeString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}

function tdxrsCandidates(count) {
    const timeout = '5';
    const commands = [];
    if (process.env.TDXRS_BIN) {
        commands.push({
            label: process.env.TDXRS_BIN,
            command: process.env.TDXRS_BIN,
            args: ['minutes', '--count', String(count), '--format', 'json', '--timeout', timeout],
        });
    }
    commands.push({
        label: 'tdxrs',
        command: 'tdxrs',
        args: ['minutes', '--count', String(count), '--format', 'json', '--timeout', timeout],
    });
    [process.env.TDXRS_PYTHON, 'python3', 'python'].filter(Boolean).forEach((python) => {
        commands.push({
            label: `${python} -m tdxrs`,
            command: python,
            args: ['-m', 'tdxrs', 'minutes', '--count', String(count), '--format', 'json', '--timeout', timeout],
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

function parseTdxrsRows(rows, count) {
    const points = sortMinutePoints((Array.isArray(rows) ? rows : []).map((row) => {
        const price = parseNumeric(row.price ?? row['价格']);
        const avgPrice = parseNumeric(row.avg_price ?? row.avgPrice ?? row['均价']);
        return {
            time: normalizeTime(row.time ?? row['时间']),
            price,
            avgPrice: avgPrice === null ? price : avgPrice,
            volume: parseNumeric(row.vol ?? row.volume ?? row['成交量']),
            amount: parseNumeric(row.amount ?? row['成交额']),
            changePercent: parseNumeric(row.changePercent ?? row.change_pct ?? row['涨跌幅%']),
        };
    }));
    return points.slice(-count);
}

async function loadTdxrsMinute(code, count) {
    const errors = [];
    const timeoutMs = API_TIMEOUTS.fast + 2000;

    for (const candidate of tdxrsCandidates(count)) {
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
            const points = parseTdxrsRows(JSON.parse(text.slice(start, end + 1)), count);
            if (!points.length) throw new Error('分时数据为空');
            return {
                source: 'tdxrs',
                sourceLabel: 'tdxrs',
                command: candidate.label,
                preClose: inferPreClose(points),
                points,
            };
        } catch (error) {
            errors.push(`${candidate.label}: ${error.message}`);
        }
    }

    const error = new Error(errors.join(' | ') || 'tdxrs 不可用');
    error.details = errors;
    throw error;
}

// 腾讯分时 API: web.ifzq.gtimg.cn/appstock/app/minute/query
// 返回格式: { data: { [symbol]: { data: { data: ["0930 1188.77 173 20565721.00", ...] } } } }
// 每行: "HHMM price volume amount"
async function loadTencentMinute(code, count) {
    const symbol = tencentSymbol(code);
    const json = await fetchJson(`https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${symbol}`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 fund-tracker/1.0',
            Referer: 'https://gu.qq.com/',
        },
        timeout: API_TIMEOUTS.normal,
    });
    const rawData = json && json.data && json.data[symbol] && json.data[symbol].data;
    const lines = Array.isArray(rawData && rawData.data) ? rawData.data : [];
    const qt = json && json.data && json.data[symbol] && json.data[symbol].qt;
    const preClose = parseNumeric(Array.isArray(qt) ? qt[4] : null);
    // 腾讯分钟数据: "HHMM price volume amount"
    const points = sortMinutePoints(lines.map((lineRaw) => {
        const parts = String(lineRaw || '').trim().split(/\s+/);
        if (parts.length < 3) return null;
        const timeRaw = parts[0] || '';
        const price = parseNumeric(parts[1]);
        const volume = parseNumeric(parts[2]);
        const amount = parseNumeric(parts[3]);
        const changePercent = preClose && preClose > 0 && price !== null
            ? (price - preClose) / preClose * 100
            : null;
        return {
            time: normalizeTime(timeRaw),
            price,
            avgPrice: price,
            volume,
            amount,
            changePercent,
        };
    })).slice(-count);
    if (!points.length) throw new Error('腾讯分时数据为空');
    return {
        source: 'tencent',
        sourceLabel: '腾讯分时',
        preClose,
        points,
    };
}

function parseEastmoneyTrend(raw, preClose) {
    const fields = String(raw || '').split(',');
    if (fields.length < 3) return null;
    const timeText = fields[0] || '';
    const price = parseNumeric(fields[2]);
    if (price === null) return null;
    const avgPrice = parseNumeric(fields[7]);
    const changePercent = preClose && preClose > 0
        ? (price - preClose) / preClose * 100
        : null;
    return {
        date: timeText.slice(0, 10),
        time: normalizeTime(timeText),
        open: parseNumeric(fields[1]),
        price,
        high: parseNumeric(fields[3]),
        low: parseNumeric(fields[4]),
        volume: parseNumeric(fields[5]),
        amount: parseNumeric(fields[6]),
        avgPrice: avgPrice === null ? price : avgPrice,
        changePercent,
    };
}

async function loadEastmoneyMinute(code, count) {
    const params = new URLSearchParams({
        secid: `${marketOf(code)}.${code}`,
        fields1: 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11',
        fields2: 'f51,f52,f53,f54,f55,f56,f57,f58',
        iscr: '0',
        iscca: '0',
        ndays: '1',
    });
    const json = await emGet(`https://push2his.eastmoney.com/api/qt/stock/trends2/get?${params.toString()}`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 fund-tracker/1.0',
            Referer: 'https://quote.eastmoney.com/',
        },
        timeout: API_TIMEOUTS.normal,
    });
    const data = json && json.data ? json.data : null;
    const trends = data && Array.isArray(data.trends) ? data.trends : [];
    const preClose = parseNumeric(data && data.preClose);
    const points = sortMinutePoints(trends.map((line) => parseEastmoneyTrend(line, preClose))).slice(-count);
    if (!points.length) throw new Error('东方财富分时数据为空');
    const latest = points[points.length - 1] || {};
    return {
        source: 'eastmoney',
        sourceLabel: '东方财富',
        name: data.name || '',
        preClose,
        tradeDate: latest.date || '',
        latestTime: latest.time || '',
        points,
    };
}

module.exports = async function handler(req, res) {
    const code = String(req.query.code || '').trim();
    if (!/^\d{6}$/.test(code)) return fail(res, 400, '缺少股票代码');

    const count = clampCount(req.query.count);
    const source = String(req.query.source || 'auto').trim().toLowerCase();
    if (!['auto', 'tdxrs', 'tencent', 'eastmoney'].includes(source)) {
        return fail(res, 400, '未知分时数据源');
    }

    try {
        let data;
        let fallbackReason = '';
        if (source === 'eastmoney') {
            data = await loadEastmoneyMinute(code, count);
        } else if (source === 'tencent') {
            data = await loadTencentMinute(code, count);
        } else {
            // auto / tdxrs: 优先 tdxrs -> 腾讯 -> 东财
            const trySources = [
                { label: 'tdxrs', fn: () => loadTdxrsMinute(code, count) },
                { label: '腾讯', fn: () => loadTencentMinute(code, count) },
                { label: '东财', fn: () => loadEastmoneyMinute(code, count) },
            ];
            const tdxrOnly = source === 'tdxrs' ? trySources.slice(0, 1) : trySources;
            for (const s of tdxrOnly) {
                try {
                    data = await s.fn();
                    break;
                } catch (error) {
                    fallbackReason = fallbackReason
                        ? `${fallbackReason}; ${s.label}: ${error.message}`
                        : `${s.label}: ${error.message}`;
                    if (source === 'tdxrs') throw error;
                }
            }
            if (!data) throw new Error(fallbackReason || '所有分时数据源均不可用');
        }

        return ok(res, {
            code,
            market: marketOf(code),
            count: data.points.length,
            source: data.source,
            sourceLabel: data.sourceLabel,
            command: data.command || '',
            name: data.name || '',
            preClose: data.preClose,
            tradeDate: data.tradeDate || '',
            latestTime: data.latestTime || (data.points[data.points.length - 1] && data.points[data.points.length - 1].time) || '',
            fallbackReason,
            points: data.points,
        }, { time: shanghaiTime() });
    } catch (error) {
        return fail(res, 502, '分时数据接口不可用', { error: error.message });
    }
};

const {
    API_TIMEOUTS,
    emGet,
    fail,
    fetchGbkText,
    fetchJson,
    fetchText,
    formatPct,
    formatYi,
    ok,
    toNumber,
} = require('./_utils');

const INDEXES = {
    shangzhi: { symbol: 's_sh000001', minuteSymbol: 'sh000001', name: '上证指数' },
    shengzheng: { symbol: 's_sz399001', minuteSymbol: 'sz399001', name: '深证成指' },
    chuangye: { symbol: 's_sz399006', minuteSymbol: 'sz399006', name: '创业板指' },
    zhuanke50: { symbol: 's_sh000688', minuteSymbol: 'sh000688', name: '科创50' },
};

const dailyCache = {
    multidayFlow: null,
};

async function loadIndexes() {
    const symbols = Object.values(INDEXES).map((item) => item.symbol).join(',');
    const [text, minuteRows] = await Promise.all([
        fetchGbkText(`https://qt.gtimg.cn/q=${symbols}`),
        Promise.all(Object.values(INDEXES).map((item) => loadIndexMinute(item.minuteSymbol).catch(() => ({ date: '', points: [] })))),
    ]);
    const lines = text.split(';').filter(Boolean);
    const bySymbol = {};
    lines.forEach((rawLine) => {
        const line = rawLine.trim();
        const nameMatch = line.match(/^v_(.+?)="/);
        if (!nameMatch) return;
        const key = line.slice(2, line.indexOf('='));
        bySymbol[key] = line.slice(line.indexOf('"') + 1, line.lastIndexOf('"')).split('~');
    });
    const entries = Object.entries(INDEXES).map(([id, item], index) => {
        const data = bySymbol[item.symbol];
        if (!data || data.length < 6) throw new Error(`指数无数据 ${item.symbol}`);
        const value = toNumber(data[3]);
        const change = toNumber(data[4]);
        const changePercent = toNumber(data[5]);
        return [id, {
            name: item.name,
            value: value === null ? '--' : value.toFixed(2),
            priceValue: value, // 数值型价格,前端 trend-arrow 用它做对比
            change: `${change > 0 ? '+' : ''}${change === null ? '--' : change.toFixed(2)} / ${formatPct(changePercent)}`,
            changePercent: changePercent || 0,
            sparkline: minuteRows[index].points,
            sparklineDate: minuteRows[index].date,
        }];
    });
    return Object.fromEntries(entries);
}

async function loadIndexMinute(symbol) {
    const json = await fetchJson(`https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${symbol}`, {
        cacheTtl: 60 * 1000,
        headers: { Referer: 'https://gu.qq.com/' },
        timeout: API_TIMEOUTS.normal,
    });
    const data = json && json.data && json.data[symbol] && json.data[symbol].data;
    const rows = data && Array.isArray(data.data) ? data.data : [];
    return {
        date: String(data && data.date || '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
        points: parseIndexMinuteRows(rows),
    };
}

function parseIndexMinuteRows(rows) {
    return (Array.isArray(rows) ? rows : []).map((line) => {
        const parts = String(line || '').trim().split(/\s+/);
        const price = toNumber(parts[1]);
        return price === null ? null : price;
    }).filter((price) => price !== null);
}

async function loadCapital() {
    const [mainFund, northHgtIntraday, northboundDaily] = await Promise.all([
        loadMarketMainFund(),
        loadNorthHgtIntraday(),
        loadHkexNorthboundDaily(),
    ]);
    return {
        data: { mainFund, northHgtIntraday, northboundDaily },
        meta: {
            asOf: new Date().toISOString(),
            degraded: !mainFund.available || !northHgtIntraday.available || !northboundDaily.available,
            sources: {
                marketFund: { actual: mainFund.source, status: mainFund.available ? 'live' : 'unavailable' },
                northHgtIntraday: { actual: 'hexin', status: northHgtIntraday.available ? 'live' : 'unavailable' },
                northboundDaily: { actual: 'hkex', status: northboundDaily.available ? 'live' : 'unavailable' },
            },
        },
    };
}

async function loadSector() {
    const rows = await loadIndustryRows();
    const mapRow = (row) => ({
        name: row.name,
        value: formatYi(row.mainFundYuan),
        mainFundYuan: row.mainFundYuan,  // 原始数值,前端 bar 长度归一化用
        changePct: row.changePct,
        leader: row.leader,
    });
    return {
        inflow: rows.filter((row) => row.mainFundYuan > 0).sort((a, b) => b.mainFundYuan - a.mainFundYuan).slice(0, 10).map(mapRow),
        outflow: rows.filter((row) => row.mainFundYuan < 0).sort((a, b) => a.mainFundYuan - b.mainFundYuan).slice(0, 10).map(mapRow),
    };
}

async function loadMultiDayFlow() {
    const cacheKey = shanghaiDateKey();
    if (dailyCache.multidayFlow && dailyCache.multidayFlow.key === cacheKey) {
        return dailyCache.multidayFlow.data;
    }

    const sector = await loadSector();
    const today = new Date().toLocaleDateString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: 'numeric',
        day: 'numeric',
    });
    function mapRows(rows, trend) {
        return rows.map((row) => ({
            name: row.name,
            data: [row.value],
            consecutiveDays: 1,
            trend,
        }));
    }
    const data = {
        dates: [today],
        inflowSectors: mapRows(sector.inflow, 'up'),
        outflowSectors: mapRows(sector.outflow, 'down'),
    };
    dailyCache.multidayFlow = { key: cacheKey, data };
    return data;
}

function shanghaiDateKey() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date());
}

function eastmoneyMarketFs() {
    return 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';
}

async function loadMarketMainFund() {
    // 同花顺源只有"行业净流入"无法做全市场总额,这里走 push2 全市场 4 档拆分
    // 注意: push2 域名可能受代理/网络环境影响不可用,此时降级返回空主力数据
    const params = new URLSearchParams({
        pn: '1',
        pz: '6000',
        po: '1',
        np: '1',
        fltt: '2',
        invt: '2',
        fs: eastmoneyMarketFs(),
        // f62=主力(超大单+大单), f66=超大单(≥100万), f72=大单(≥20万<100万),
        // f78=中单(≥4万<20万), f84=小单(<4万)
        fields: 'f12,f14,f62,f66,f72,f78,f84',
    });
    let rows = [];
    try {
        const json = await emGet(`https://push2.eastmoney.com/api/qt/clist/get?${params.toString()}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36',
                Referer: 'https://quote.eastmoney.com/',
            },
            timeout: API_TIMEOUTS.heavy,
        });
        rows = json && json.data && Array.isArray(json.data.diff) ? json.data.diff : [];
    } catch (error) {
        // push2 不可用时返回空数据
        return {
            available: false,
            source: null,
            value: '--',
            isPositive: null,
            note: 'push2 不可用',
            breakdown: {
                superLarge: { value: '--', isPositive: null },
                large:      { value: '--', isPositive: null },
                medium:     { value: '--', isPositive: null },
                small:      { value: '--', isPositive: null },
            },
        };
    }
    if (!rows.length) {
        return {
            available: false,
            source: null,
            value: '--',
            isPositive: null,
            note: '暂无数据',
            breakdown: {
                superLarge: { value: '--', isPositive: null },
                large:      { value: '--', isPositive: null },
                medium:     { value: '--', isPositive: null },
                small:      { value: '--', isPositive: null },
            },
        };
    }

    // 全市场合计:对每档做 sum
    const sum = (key) => rows.reduce((s, r) => {
        const v = toNumber(r[key]);
        return v === null ? s : s + v;
    }, 0);
    const totalMain = sum('f62');   // 主力 = 超大单+大单
    const totalSuper = sum('f66');  // 超大单
    const totalLarge = sum('f72');  // 大单
    const totalMedium = sum('f78'); // 中单
    const totalSmall = sum('f84');  // 小单

    // 主力 + 大单/中单/小单 共 4 档给到前端
    // 这里"主力"用 f62 (超大单+大单), "大单"=f66 超大单 (按金额大小排列),
    // "中单"=f78, "小单"=f84, 跟散户最关心的层级一致
    return {
        available: true,
        source: 'eastmoney',
        value: formatYi(totalMain),
        isPositive: totalMain >= 0,
        breakdown: {
            superLarge: { value: formatYi(totalSuper), isPositive: totalSuper >= 0 },
            large:      { value: formatYi(totalLarge), isPositive: totalLarge >= 0 },
            medium:     { value: formatYi(totalMedium), isPositive: totalMedium >= 0 },
            small:      { value: formatYi(totalSmall),  isPositive: totalSmall >= 0  },
        },
    };
}

async function loadNorthHgtIntraday() {
    let json;
    try {
        json = await fetchJson('https://data.hexin.cn/market/hsgtApi/method/dayChart/', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/117.0.0.0 Safari/537.36',
                Host: 'data.hexin.cn',
                Referer: 'https://data.hexin.cn/',
            },
        });
    } catch (error) {
        // hexin 不可用时返回空数据
        return {
            available: false,
            value: '--',
            isPositive: null,
            time: '',
        };
    }
    const times = Array.isArray(json.time) ? json.time : [];
    let latest = null;
    times.forEach((time, index) => {
        const hgt = toNumber(json.hgt && json.hgt[index]);
        if (hgt === null) return;
        latest = { time, hgt };
    });
    if (!latest) {
        return {
            available: false,
            value: '--',
            isPositive: null,
            time: '',
        };
    }
    return {
        available: true,
        value: `${latest.hgt > 0 ? '+' : ''}${latest.hgt.toFixed(2)}亿`,
        isPositive: latest.hgt >= 0,
        time: latest.time,
    };
}

function parseHkexDaily(text) {
    const raw = String(text || '');
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start < 0 || end <= start) throw new Error('HKEX 数据格式异常');
    const rows = JSON.parse(raw.slice(start, end + 1));
    const markets = rows.filter((item) => /Northbound/.test(String(item.market || '')));
    let turnoverMillion = 0;
    markets.forEach((market) => {
        const value = market && market.content && market.content[0]
            && market.content[0].table && market.content[0].table.tr
            && market.content[0].table.tr[0] && market.content[0].table.tr[0].td
            && market.content[0].table.tr[0].td[0] && market.content[0].table.tr[0].td[0][0];
        const number = toNumber(String(value || '').replace(/,/g, ''));
        if (number !== null) turnoverMillion += number;
    });
    return {
        date: markets[0] && markets[0].date || '',
        turnoverYi: turnoverMillion / 100,
    };
}

async function loadHkexNorthboundDaily() {
    for (let offset = 0; offset < 7; offset += 1) {
        const date = new Date(Date.now() - offset * 86400000);
        const key = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(date).replace(/-/g, '');
        try {
            const text = await fetchText(`https://www.hkex.com.hk/chi/csm/DailyStat/data_tab_daily_${key}c.js`, {
                cacheTtl: 30 * 60 * 1000,
                headers: { Referer: 'https://www.hkex.com.hk/' },
                timeout: API_TIMEOUTS.normal,
            });
            const data = parseHkexDaily(text);
            if (data.turnoverYi > 0) {
                return { available: true, value: `${data.turnoverYi.toFixed(2)}亿`, isPositive: null, date: data.date };
            }
        } catch (error) {}
    }
    return { available: false, value: '--', isPositive: null, date: '' };
}

async function loadIndustryRows() {
    const thsRows = await loadThsIndustryRows();
    if (thsRows.length) {
        return thsRows.map((row) => ({
            name: row.name,
            code: row.code,
            changePct: row.changePct,
            mainFundYuan: row.netYi * 100000000,
            upCount: 0,
            downCount: 0,
            leader: row.leader,
            leaderChange: row.leaderChangePct,
        }));
    }

    const params = new URLSearchParams({
        pn: '1',
        pz: '100',
        po: '1',
        np: '1',
        fltt: '2',
        invt: '2',
        fid: 'f62',
        fs: 'm:90+t:2',
        fields: 'f3,f12,f14,f62,f104,f105,f136,f140',
    });
    const json = await emGet(`https://push2.eastmoney.com/api/qt/clist/get?${params.toString()}`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36',
            Referer: 'https://quote.eastmoney.com/center/boardlist.html',
        },
        timeout: API_TIMEOUTS.heavy,
    });
    const rows = json && json.data && Array.isArray(json.data.diff) ? json.data.diff : [];
    return rows.map((item) => ({
        name: item.f14 || item.f12 || '',
        code: item.f12 || '',
        changePct: toNumber(item.f3) || 0,
        mainFundYuan: toNumber(item.f62) || 0,
        upCount: toNumber(item.f104) || 0,
        downCount: toNumber(item.f105) || 0,
        leader: item.f140 || '',
        leaderChange: toNumber(item.f136) || 0,
    })).filter((item) => item.name && item.mainFundYuan !== 0);
}

async function loadThsIndustryRows() {
    const html = await fetchGbkText('https://data.10jqka.com.cn/funds/hyzjl/', {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36',
            Referer: 'https://data.10jqka.com.cn/',
        },
        timeout: API_TIMEOUTS.push2,
    });
    const tbody = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
    if (!tbody) return [];

    const rows = [];
    const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let trMatch;
    while ((trMatch = trRegex.exec(tbody[1]))) {
        const cells = [];
        const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        let tdMatch;
        while ((tdMatch = tdRegex.exec(trMatch[1]))) {
            cells.push(stripHtml(tdMatch[1]));
        }
        if (cells.length < 11) continue;
        const codeMatch = trMatch[1].match(/\/thshy\/detail\/code\/(\d+)\//);
        rows.push({
            rank: toNumber(cells[0]) || rows.length + 1,
            code: codeMatch ? codeMatch[1] : '',
            name: cells[1],
            changePct: parsePercent(cells[3]),
            inflowYi: toNumber(cells[4]) || 0,
            outflowYi: toNumber(cells[5]) || 0,
            netYi: toNumber(cells[6]) || 0,
            stockCount: toNumber(cells[7]) || 0,
            leader: cells[8],
            leaderChangePct: parsePercent(cells[9]),
        });
    }
    return rows.filter((row) => row.name && row.netYi !== 0);
}

function stripHtml(text) {
    return String(text || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
}

function parsePercent(value) {
    const number = toNumber(String(value || '').replace('%', ''));
    return number === null ? 0 : number;
}

module.exports = async function handler(req, res) {
    try {
        const type = req.query.type;
        if (type === 'index') return ok(res, await loadIndexes());
        if (type === 'capital') {
            const result = await loadCapital();
            return ok(res, result.data, { meta: result.meta });
        }
        if (type === 'sector') return ok(res, await loadSector());
        if (type === 'multiday-flow') return ok(res, await loadMultiDayFlow());
        return fail(res, 400, '未知 market-data 类型');
    } catch (error) {
        return fail(res, 502, '真实行情接口不可用', { error: error.message });
    }
};

module.exports.loadIndexMinute = loadIndexMinute;
module.exports.parseHkexDaily = parseHkexDaily;
module.exports.parseIndexMinuteRows = parseIndexMinuteRows;

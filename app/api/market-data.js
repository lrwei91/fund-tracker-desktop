const {
    API_TIMEOUTS,
    emGet,
    fail,
    fetchGbkText,
    fetchJson,
    formatPct,
    formatYi,
    ok,
    toNumber,
} = require('./_utils');

const INDEXES = {
    shangzhi: { symbol: 's_sh000001', name: '上证指数' },
    shengzheng: { symbol: 's_sz399001', name: '深证成指' },
    chuangye: { symbol: 's_sz399006', name: '创业板指' },
    zhuanke50: { symbol: 's_sh000688', name: '科创50' },
};

const dailyCache = {
    multidayFlow: null,
};

async function loadIndexes() {
    const symbols = Object.values(INDEXES).map((item) => item.symbol).join(',');
    const text = await fetchGbkText(`https://qt.gtimg.cn/q=${symbols}`);
    const lines = text.split(';').filter(Boolean);
    const bySymbol = {};
    lines.forEach((rawLine) => {
        const line = rawLine.trim();
        const nameMatch = line.match(/^v_(.+?)="/);
        if (!nameMatch) return;
        const key = line.slice(2, line.indexOf('='));
        bySymbol[key] = line.slice(line.indexOf('"') + 1, line.lastIndexOf('"')).split('~');
    });
    const entries = Object.entries(INDEXES).map(([id, item]) => {
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
        }];
    });
    return Object.fromEntries(entries);
}

async function loadCapital() {
    const [mainFund, northFund] = await Promise.all([
        loadMarketMainFund(),
        loadNorthFund(),
    ]);
    // northFund 内嵌了 northHgt / northSgt, 提一层方便前端 6 格子渲染
    return {
        mainFund,
        northFund: { value: northFund.value, isPositive: northFund.isPositive, time: northFund.time },
        northHgt: northFund.northHgt,
        northSgt: northFund.northSgt,
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
            value: '--',
            isPositive: true,
            note: 'push2 不可用',
            breakdown: {
                superLarge: { value: '--', isPositive: true },
                large:      { value: '--', isPositive: true },
                medium:     { value: '--', isPositive: true },
                small:      { value: '--', isPositive: true },
            },
        };
    }
    if (!rows.length) {
        return {
            value: '--',
            isPositive: true,
            note: '暂无数据',
            breakdown: {
                superLarge: { value: '--', isPositive: true },
                large:      { value: '--', isPositive: true },
                medium:     { value: '--', isPositive: true },
                small:      { value: '--', isPositive: true },
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

async function loadNorthFund() {
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
            value: '--',
            isPositive: true,
            time: '',
            northHgt: { value: '--', isPositive: true },
            northSgt: { value: '--', isPositive: true },
        };
    }
    const times = Array.isArray(json.time) ? json.time : [];
    let latest = null;
    times.forEach((time, index) => {
        const hgt = toNumber(json.hgt && json.hgt[index]);
        const sgt = toNumber(json.sgt && json.sgt[index]);
        if (hgt === null || sgt === null) return;
        latest = { time, hgt, sgt, value: hgt + sgt };
    });
    if (!latest) {
        return {
            value: '--',
            isPositive: true,
            time: '',
            northHgt: { value: '--', isPositive: true },
            northSgt: { value: '--', isPositive: true },
        };
    }
    return {
        value: `${latest.value > 0 ? '+' : ''}${latest.value.toFixed(2)}亿`,
        isPositive: latest.value >= 0,
        time: latest.time,
        northHgt: {
            value: `${latest.hgt > 0 ? '+' : ''}${latest.hgt.toFixed(2)}亿`,
            isPositive: latest.hgt >= 0,
        },
        northSgt: {
            value: `${latest.sgt > 0 ? '+' : ''}${latest.sgt.toFixed(2)}亿`,
            isPositive: latest.sgt >= 0,
        },
    };
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
        if (type === 'capital') return ok(res, await loadCapital());
        if (type === 'sector') return ok(res, await loadSector());
        if (type === 'multiday-flow') return ok(res, await loadMultiDayFlow());
        return fail(res, 400, '未知 market-data 类型');
    } catch (error) {
        return fail(res, 502, '真实行情接口不可用', { error: error.message });
    }
};

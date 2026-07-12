const { emGet, fail, fetchJson, fetchText, ok, runSources, sourceMeta, toNumber } = require('./_utils');

function shanghaiDate(offsetDays) {
    const date = new Date(Date.now() - (offsetDays || 0) * 86400000);
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date);
}

function normalizeEastmoney(payload) {
    const rows = payload && payload.result && Array.isArray(payload.result.data) ? payload.result.data : [];
    const stocks = rows.map((row) => ({
        code: row.SECURITY_CODE,
        name: row.SECURITY_NAME_ABBR,
        reason: row.EXPLANATION || row.EXPLAIN || '',
        netBuyWan: toNumber(row.BILLBOARD_NET_AMT) === null ? null : toNumber(row.BILLBOARD_NET_AMT) / 10000,
    })).filter((item) => /^\d{6}$/.test(String(item.code || '')));
    const date = rows[0] ? String(rows[0].TRADE_DATE || '').slice(0, 10) : '';
    return { date, stocks };
}

function normalizeSzse(rows) {
    return (Array.isArray(rows) ? rows : []).map((row) => ({
        code: row.zqdm,
        name: row.zqjc,
        reason: row.plyy || '深交所公开交易信息',
        netBuyWan: null,
    })).filter((item) => /^\d{6}$/.test(String(item.code || '')));
}

function normalizeSse(lines) {
    const seen = new Set();
    const stocks = [];
    (Array.isArray(lines) ? lines : []).forEach((line) => {
        const match = String(line || '').match(/证券代码:\s*(\d{6}).*证券简称:\s*([^\s]+)/);
        if (!match || seen.has(match[1])) return;
        seen.add(match[1]);
        stocks.push({ code: match[1], name: match[2].trim(), reason: '上交所公开交易信息', netBuyWan: null });
    });
    return stocks;
}

async function loadEastmoney() {
    const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=TRADE_DATE&sortTypes=-1&pageSize=40&pageNumber=1&reportName=RPT_DAILYBILLBOARD_DETAILS&columns=ALL';
    return normalizeEastmoney(await emGet(url, { cacheTtl: 30 * 60 * 1000 }));
}

async function loadOfficialForDate(date) {
    const szseUrl = 'https://www.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON'
        + `&CATALOGID=1842_xxpl&TABKEY=tab1&txtStart=${date}&txtEnd=${date}&random=0.9`;
    const sseUrl = 'https://query.sse.com.cn/infodisplay/showTradePublicFile.do'
        + `?jsonCallBack=cb&isPagination=false&dateTx=${date}`;
    const [szseResult, sseResult] = await Promise.allSettled([
        fetchJson(szseUrl, {
            cacheTtl: 30 * 60 * 1000,
            headers: { Referer: 'https://www.szse.cn/disclosure/supervision/dealinfo/index.html' },
        }),
        fetchText(sseUrl, {
            cacheTtl: 30 * 60 * 1000,
            headers: { Referer: 'https://www.sse.com.cn/disclosure/diclosure/public/' },
        }),
    ]);
    let szse = [];
    let sse = [];
    if (szseResult.status === 'fulfilled') {
        const body = szseResult.value;
        szse = normalizeSzse(body && body[0] && body[0].data);
    }
    if (sseResult.status === 'fulfilled') {
        const text = sseResult.value;
        const start = text.indexOf('(');
        const end = text.lastIndexOf(')');
        if (start >= 0 && end > start) {
            const body = JSON.parse(text.slice(start + 1, end));
            sse = normalizeSse(body.fileContents);
        }
    }
    return { date, stocks: szse.concat(sse) };
}

async function loadOfficial() {
    for (let offset = 0; offset < 7; offset += 1) {
        const data = await loadOfficialForDate(shanghaiDate(offset));
        if (data.stocks.length) return data;
    }
    return { date: '', stocks: [] };
}

module.exports = async function handler(req, res) {
    try {
        const result = await runSources([
            { id: 'eastmoney', label: '东方财富', load: loadEastmoney, validate: (data) => data && data.stocks.length > 0 },
            { id: 'official-exchange', label: '沪深交易所', load: loadOfficial, validate: (data) => data && data.stocks.length > 0 },
        ]);
        return ok(res, result.value, { meta: sourceMeta('dragonTiger', result) });
    } catch (error) {
        return fail(res, 502, '真实龙虎榜接口不可用', { error: error.message });
    }
};

module.exports.loadOfficialForDate = loadOfficialForDate;
module.exports.normalizeEastmoney = normalizeEastmoney;
module.exports.normalizeSse = normalizeSse;
module.exports.normalizeSzse = normalizeSzse;

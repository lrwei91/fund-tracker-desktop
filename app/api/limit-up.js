// 打板层 — 涨停 / 炸板 / 跌停 / 昨涨停 四池
//   走 push2ex.eastmoney.com, 与现有 push2 同源, 走 emGet 限流防封
//   date 必须是交易日 (YYYYMMDD), 非交易日 data 返回 null
// 端点统一参数: ut, dpt=wz.ztzt, Pageindex, pagesize, sort, date
// 不同 sort 区分四池

const { API_TIMEOUTS, emGet, fail, ok } = require('./_utils');

const ZTB_UT = '7eea3edcaed734bea9cbfc24409ed989';

const POOL_ENDPOINTS = {
    zt:  { endpoint: 'getTopicZTPool',     sort: 'fbt:asc' },   // 涨停池
    zb:  { endpoint: 'getTopicZBPool',     sort: 'fbt:asc' },   // 炸板池
    dt:  { endpoint: 'getTopicDTPool',     sort: 'fund:asc' },  // 跌停池
    yzt: { endpoint: 'getYesterdayZTPool', sort: 'zs:desc' },   // 昨涨停今表现
};

function fmtZtTime(t) {
    if (t === undefined || t === null) return '';
    const s = String(t).padStart(6, '0');
    return s.slice(0, 2) + ':' + s.slice(2, 4) + ':' + s.slice(4, 6);
}

function todayStr() {
    // YYYYMMDD (Asia/Shanghai 今日)
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    return fmt.format(new Date()).replace(/-/g, '');
}

async function fetchPool(type, date, limit) {
    const cfg = POOL_ENDPOINTS[type];
    if (!cfg) throw new Error('未知池类型: ' + type);
    const dateStr = (date || todayStr()).toString().replace(/-/g, '');
    const url = `https://push2ex.eastmoney.com/${cfg.endpoint}`;
    const params = new URLSearchParams({
        ut: ZTB_UT,
        dpt: 'wz.ztzt',
        Pageindex: '0',
        pagesize: String(Math.max(1, Math.min(100, limit || 50))),
        sort: cfg.sort,
        date: dateStr,
    });
    const json = await emGet(`${url}?${params.toString()}`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            Referer: 'https://quote.eastmoney.com/',
        },
        timeout: API_TIMEOUTS.push2,
    });
    return (json && json.data && Array.isArray(json.data.pool)) ? json.data.pool : [];
}

function mapZt(p) {
    const zttj = p.zttj || {};
    return {
        code: p.c,
        name: p.n,
        market: p.m,                  // 0=深 1=沪
        price: (p.p || 0) / 1000,
        pct: typeof p.zdp === 'number' ? Math.round(p.zdp * 100) / 100 : 0,
        amount: p.amount || 0,        // 成交额,元
        floatCap: p.ltsz || 0,        // 流通市值,亿
        turnover: typeof p.hs === 'number' ? Math.round(p.hs * 100) / 100 : 0,
        limitDays: p.lbc || 0,         // 连板数
        firstSeal: fmtZtTime(p.fbt),
        lastSeal: fmtZtTime(p.lbt),
        sealFund: p.fund || 0,         // 封板资金,元
        breakTimes: p.zbc || 0,        // 炸板次数
        industry: p.hybk || '',
        ztStat: (zttj.days != null && zttj.ct != null) ? `${zttj.days}天${zttj.ct}板` : '',
    };
}

function mapZb(p) {
    const zttj = p.zttj || {};
    return {
        code: p.c,
        name: p.n,
        market: p.m,
        price: (p.p || 0) / 1000,
        limitPrice: (p.ztp || 0) / 1000,
        pct: typeof p.zdp === 'number' ? Math.round(p.zdp * 100) / 100 : 0,
        turnover: typeof p.hs === 'number' ? Math.round(p.hs * 100) / 100 : 0,
        firstSeal: fmtZtTime(p.fbt),
        breakTimes: p.zbc || 0,
        amplitude: typeof p.zf === 'number' ? Math.round(p.zf * 100) / 100 : 0,
        speed: typeof p.zs === 'number' ? Math.round(p.zs * 100) / 100 : 0,
        industry: p.hybk || '',
        ztStat: (zttj.days != null && zttj.ct != null) ? `${zttj.days}天${zttj.ct}板` : '',
    };
}

function mapDt(p) {
    return {
        code: p.c,
        name: p.n,
        market: p.m,
        price: (p.p || 0) / 1000,
        pct: typeof p.zdp === 'number' ? Math.round(p.zdp * 100) / 100 : 0,
        turnover: typeof p.hs === 'number' ? Math.round(p.hs * 100) / 100 : 0,
        sealFund: p.fund || 0,
        lastSeal: fmtZtTime(p.lbt),
        boardAmount: p.fba || 0,
        dtDays: p.days || 0,
        openTimes: p.oc || 0,
        industry: p.hybk || '',
    };
}

function mapYzt(p) {
    const zttj = p.zttj || {};
    return {
        code: p.c,
        name: p.n,
        market: p.m,
        price: (p.p || 0) / 1000,
        pct: typeof p.zdp === 'number' ? Math.round(p.zdp * 100) / 100 : 0,
        turnover: typeof p.hs === 'number' ? Math.round(p.hs * 100) / 100 : 0,
        amplitude: typeof p.zf === 'number' ? Math.round(p.zf * 100) / 100 : 0,
        speed: typeof p.zs === 'number' ? Math.round(p.zs * 100) / 100 : 0,
        yFirstSeal: fmtZtTime(p.yfbt),
        yLimitDays: p.ylbc || 0,
        industry: p.hybk || '',
        ztStat: (zttj.days != null && zttj.ct != null) ? `${zttj.days}天${zttj.ct}板` : '',
    };
}

const POOL_MAPPER = { zt: mapZt, zb: mapZb, dt: mapDt, yzt: mapYzt };

async function handler(req, res) {
    try {
        const type = String(req.query.type || 'zt').toLowerCase();
        const date = req.query.date || null;
        const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 30));
        if (!POOL_ENDPOINTS[type] && type !== 'summary') {
            return fail(res, 400, '未知 type（支持 zt/zb/dt/yzt/summary）');
        }

        if (type === 'summary') {
            // 打板情绪速算: 调 4 池 (zt/zb/dt) 计算连板梯队 / 炸板率 / 最高板
            const [ztPool, zbPool, dtPool, yztPool] = await Promise.all([
                fetchPool('zt', date, 100),
                fetchPool('zb', date, 100),
                fetchPool('dt', date, 100),
                fetchPool('yzt', date, 100),
            ]);
            const ladder = {};
            ztPool.forEach((p) => {
                const ld = p.lbc || 0;
                if (ld > 0) ladder[ld] = (ladder[ld] || 0) + 1;
            });
            const ztN = ztPool.length, zbN = zbPool.length, dtN = dtPool.length;
            const breakRate = (ztN + zbN) > 0 ? Math.round(zbN / (ztN + zbN) * 1000) / 10 : 0;
            const maxHeight = ztPool.reduce((m, p) => Math.max(m, p.lbc || 0), 0);
            // 晋级率: 昨涨停今仍 ≥ 9.8% 的家数 / 昨涨停总数
            const promote = yztPool.filter((p) => (p.zdp || 0) >= 9.8).length;
            const promoteRate = yztPool.length > 0 ? Math.round(promote / yztPool.length * 1000) / 10 : 0;
            return ok(res, {
                date: (date || todayStr()).toString().replace(/-/g, ''),
                ztCount: ztN,
                zbCount: zbN,
                dtCount: dtN,
                yztCount: yztPool.length,
                breakRate,
                maxHeight,
                promoteRate,
                ladder: Object.fromEntries(Object.entries(ladder).sort((a, b) => a[0] - b[0])),
            });
        }

        const raw = await fetchPool(type, date, limit);
        const items = raw.map(POOL_MAPPER[type]);
        return ok(res, { type, date: (date || todayStr()).toString().replace(/-/g, ''), count: items.length, items });
    } catch (error) {
        return fail(res, 502, '真实打板接口不可用', { error: error.message });
    }
}

// 纯函数导出（供单测使用，不影响 handler 行为）
module.exports = handler;
module.exports.fmtZtTime = fmtZtTime;
module.exports.todayStr = todayStr;
module.exports.fetchPool = fetchPool;
module.exports.mapZt = mapZt;
module.exports.mapZb = mapZb;
module.exports.mapDt = mapDt;
module.exports.mapYzt = mapYzt;
module.exports.POOL_MAPPER = POOL_MAPPER;

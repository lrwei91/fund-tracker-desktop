// 市场热度（同花顺热榜 + 东财人气榜）
//   - ths: GET  dq.10jqka.com.cn/fuyao/hot_list_data/v1/stock (同花顺,非东财,不走 emGet)
//   - em:  POST emappdata.eastmoney.com/stockrank/getAllCurrentList (东财,走 emGet + push2 ulist 补名称)

const { API_TIMEOUTS, emGet, fail, fetchJson, ok } = require('./_utils');

const THS_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const EM_HOT_BODY = {
    appId: 'appId01',
    globalId: '786e4c21-70dc-435a-93bb-38',
};

async function loadThsHotRank(period) {
    // 实测:接口对 period 取值敏感 — 'hour' 返回小时榜(人气值高), 'day' 返回日榜
    const url = `https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock?stock_type=a&type=${period || 'hour'}&list_type=normal`;
    const json = await fetchJson(url, {
        headers: { 'User-Agent': THS_UA },
        timeout: API_TIMEOUTS.normal,
    });
    const stockList = json && json.data && Array.isArray(json.data.stock_list) ? json.data.stock_list : [];
    return stockList.slice(0, 30).map((item) => {
        const tag = item.tag || {};
        return {
            rank: item.order,
            code: item.code,
            name: item.name,
            // rate 是人气值(原始数量级很大),除 10000 显示为"万"
            heat: Math.round(Number(item.rate) / 10000),
            pct: Number(item.rise_and_fall) || 0,
            rankChg: item.hot_rank_chg || 0,
            concepts: tag.concept_tag || [],
            tag: tag.popularity_tag || '',
        };
    });
}

async function loadEmHotRank(limit) {
    const topN = Math.max(1, Math.min(30, limit || 20));
    // 1) POST 拿带前缀代码 + 排名 + 变化
    const mainJson = await emGet('https://emappdata.eastmoney.com/stockrank/getAllCurrentList', {
        method: 'POST',
        headers: {
            'User-Agent': THS_UA,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...EM_HOT_BODY, marketType: '', pageNo: 1, pageSize: topN }),
    });
    const data = Array.isArray(mainJson && mainJson.data) ? mainJson.data : [];
    if (!data.length) return [];
    // 2) 用 push2 ulist.np 批量补全名称/价格
    const secids = data.map((it) => {
        const sc = it.sc || '';
        return (sc.startsWith('SZ') ? '0.' : '1.') + sc.slice(2);
    });
    const params = new URLSearchParams({
        ut: 'f057cbcbce2a86e2866ab8877db1d059',
        fltt: '2',
        invt: '2',
        fields: 'f14,f3,f12,f2',
        secids: secids.join(','),
    });
    const uJson = await emGet(`https://push2.eastmoney.com/api/qt/ulist.np/get?${params.toString()}`, {
        headers: {
            'User-Agent': THS_UA,
            Referer: 'https://quote.eastmoney.com/',
        },
    });
    const diff = uJson && uJson.data && uJson.data.diff;
    const diffList = Array.isArray(diff) ? diff
        : (diff && typeof diff === 'object' ? Object.values(diff) : []);
    const nm = {};
    diffList.forEach((x) => {
        if (x && x.f12) nm[x.f12] = { name: x.f14, price: x.f2, pct: x.f3 };
    });
    return data.slice(0, topN).map((it) => {
        const sc = it.sc || '';
        const code = sc.slice(2);
        const info = nm[code] || {};
        return {
            rank: it.rk,
            code,
            name: info.name || '',
            price: typeof info.price === 'number' ? info.price : null,
            pct: typeof info.pct === 'number' ? info.pct : null,
            rankChg: it.hisRc || 0,
        };
    });
}

module.exports = async function handler(req, res) {
    try {
        const source = String(req.query.source || 'ths').toLowerCase();
        if (source === 'ths') {
            const period = String(req.query.period || 'hour');
            const items = await loadThsHotRank(period);
            return ok(res, { source, period, items });
        }
        if (source === 'em') {
            const limit = Math.max(1, Math.min(30, parseInt(req.query.limit, 10) || 20));
            const items = await loadEmHotRank(limit);
            return ok(res, { source, items });
        }
        return fail(res, 400, '未知 source（支持 ths / em）');
    } catch (error) {
        return fail(res, 502, '真实市场热度接口不可用', { error: error.message });
    }
};

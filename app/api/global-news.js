const crypto = require('crypto');

const { emGet, fail, ok, runSources, sourceMeta } = require('./_utils');
const { loadClsTelegraph } = require('./cls-news');

async function loadEastmoneyFastNews(cursor, limit) {
    const params = new URLSearchParams({
        client: 'web',
        biz: 'web_724',
        fastColumn: '102',
        sortEnd: cursor || '',
        pageSize: String(limit || 20),
        req_trace: crypto.randomUUID(),
    });
    const json = await emGet(`https://np-weblist.eastmoney.com/comm/web/getFastNewsList?${params.toString()}`, {
        cacheTtl: 30000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36',
            Referer: 'https://kuaixun.eastmoney.com/',
        },
    });
    const rows = json && json.data && Array.isArray(json.data.fastNewsList) ? json.data.fastNewsList : [];
    return rows.map((item) => ({
        id: String(item.seq || item.id || item.url || ''),
        title: item.title || '',
        summary: item.summary || '',
        time: item.showTime || '',
        url: item.url || 'https://kuaixun.eastmoney.com/',
    })).filter((item) => item.title || item.summary);
}

async function loadClsFallback(limit) {
    const items = await loadClsTelegraph('', limit);
    return items.map((item) => ({
        id: item.id,
        title: item.title,
        summary: item.summary,
        time: item.time,
        url: item.url,
    }));
}

module.exports = async function handler(req, res) {
    try {
        const limit = Math.max(1, Math.min(40, parseInt(req.query.limit, 10) || 20));
        const cursor = String(req.query.cursor || '').trim();
        const sources = [{
            id: 'eastmoney',
            label: '东方财富',
            load: () => loadEastmoneyFastNews(cursor, limit),
            validate: (items) => Array.isArray(items) && items.length > 0,
        }];
        if (!cursor) {
            sources.push({
                id: 'cls',
                label: '财联社',
                load: () => loadClsFallback(limit),
                validate: (items) => Array.isArray(items) && items.length > 0,
            });
        }
        const result = await runSources(sources);
        const items = result.value.slice(0, limit);
        const last = items[items.length - 1];
        const nextCursor = result.meta.actual === 'eastmoney' && last && last.time ? last.time : null;
        return ok(res, {
            data: items,
            nextCursor: items.length >= limit ? nextCursor : null,
            hasMore: Boolean(nextCursor && items.length >= limit),
            source: result.meta.actual,
            sourceLabel: result.meta.actualLabel,
        }, { meta: sourceMeta('news', result, { requested: 'eastmoney' }) });
    } catch (error) {
        return fail(res, 502, '真实东财资讯接口不可用', { error: error.message });
    }
};

module.exports.loadEastmoneyFastNews = loadEastmoneyFastNews;

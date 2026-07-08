// A 股个股新闻催化 / 风险词扫描（东方财富搜索）

const { API_TIMEOUTS, fail, fetchText, ok } = require('./_utils');

const POSITIVE_WORDS = [
    '订单',
    '增长',
    '预增',
    '扭亏',
    '回购',
    '合作',
    '中标',
    '突破',
    '量产',
    '扩产',
    '涨价',
    '政策',
    '获批',
    '创新高',
    '机构调研',
    '出海',
    '投产',
    '回升',
];

const RISK_WORDS = [
    '减持',
    '亏损',
    '处罚',
    '问询',
    '立案',
    '下滑',
    '诉讼',
    '终止',
    '风险',
    '解禁',
    '质押',
    '退市',
    '暴雷',
    '商誉',
];

function stripHtml(text) {
    return String(text || '')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<\/p\s*>/gi, ' ')
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

function scoreNews(items) {
    const text = (Array.isArray(items) ? items : [])
        .map((item) => `${item.title || ''} ${item.summary || ''}`)
        .join(' ');
    const positiveHits = POSITIVE_WORDS.filter((word) => text.includes(word));
    const riskHits = RISK_WORDS.filter((word) => text.includes(word));
    const score = positiveHits.length * 0.8 - riskHits.length * 1.1;
    return {
        score: Math.round(score * 10) / 10,
        positiveHits: Array.from(new Set(positiveHits)),
        riskHits: Array.from(new Set(riskHits)),
    };
}

function parseJsonp(text) {
    const match = String(text || '').match(/^[^(]*\(([\s\S]*)\);?$/);
    if (!match) throw new Error('东财新闻返回格式异常');
    return JSON.parse(match[1]);
}

function normalizeRows(payload, limit) {
    const rows = payload && payload.result && Array.isArray(payload.result.cmsArticleWebOld)
        ? payload.result.cmsArticleWebOld
        : [];
    return rows.slice(0, limit).map((item) => {
        const articleCode = item.code || '';
        return {
            title: stripHtml(item.title || ''),
            summary: stripHtml(item.content || item.summary || ''),
            time: item.date || '',
            source: item.mediaName || '',
            url: articleCode ? `https://finance.eastmoney.com/a/${articleCode}.html` : '',
        };
    }).filter((item) => item.title);
}

async function loadEastmoneyStockNews(code, name, limit) {
    const keyword = String(name || code || '').trim() || code;
    const callback = 'jQuery_fund_tracker_stock_news';
    const param = {
        uid: '',
        keyword,
        type: ['cmsArticleWebOld'],
        client: 'web',
        clientType: 'web',
        clientVersion: 'curr',
        param: {
            cmsArticleWebOld: {
                searchScope: 'default',
                sort: 'default',
                pageIndex: 1,
                pageSize: Math.max(1, Math.min(20, limit || 6)),
                preTag: '<em>',
                postTag: '</em>',
            },
        },
    };
    const params = new URLSearchParams({
        cb: callback,
        param: JSON.stringify(param),
        _: String(Date.now()),
    });
    const text = await fetchText(`https://search-api-web.eastmoney.com/search/jsonp?${params.toString()}`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 fund-tracker/1.0',
            Referer: `https://so.eastmoney.com/news/s?keyword=${encodeURIComponent(keyword)}`,
        },
        timeout: API_TIMEOUTS.normal,
    });
    return normalizeRows(parseJsonp(text), limit);
}

module.exports = async function handler(req, res) {
    try {
        const code = String(req.query.code || '').trim();
        if (!/^\d{6}$/.test(code)) return fail(res, 400, '缺少股票代码');
        const name = String(req.query.name || '').trim().slice(0, 24);
        const limit = Math.max(1, Math.min(10, parseInt(req.query.limit, 10) || 6));
        const items = await loadEastmoneyStockNews(code, name, limit);
        const score = scoreNews(items);
        return ok(res, {
            code,
            name,
            source: 'eastmoney',
            sourceLabel: '东方财富新闻',
            count: items.length,
            items,
            score,
        });
    } catch (error) {
        return fail(res, 502, '个股新闻接口不可用', { error: error.message });
    }
};

module.exports.POSITIVE_WORDS = POSITIVE_WORDS;
module.exports.RISK_WORDS = RISK_WORDS;
module.exports.stripHtml = stripHtml;
module.exports.scoreNews = scoreNews;
module.exports.parseJsonp = parseJsonp;
module.exports.normalizeRows = normalizeRows;

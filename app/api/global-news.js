const crypto = require('crypto');

const { emGet, fail, fetchText, ok } = require('./_utils');

function decodeEntities(text) {
    return String(text || '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

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
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36',
            Referer: 'https://kuaixun.eastmoney.com/',
        },
    });
    const rows = json && json.data && Array.isArray(json.data.fastNewsList) ? json.data.fastNewsList : [];
    return rows.map((item) => ({
        title: item.title || '',
        summary: item.summary || '',
        time: item.showTime || '',
        url: item.url || 'https://kuaixun.eastmoney.com/',
    })).filter((item) => item.title || item.summary);
}

async function loadEastmoneyFinanceFallback(limit) {
    const html = await fetchText('https://finance.eastmoney.com/', {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36',
            Referer: 'https://finance.eastmoney.com/',
        },
    });
    const seen = new Set();
    const items = [];
    const regex = /<a[^>]+href="(https:\/\/finance\.eastmoney\.com\/a\/[^"]+\.html)"[^>]*>([\s\S]*?)<\/a>/g;
    let match;
    const cap = limit || 20;
    while ((match = regex.exec(html)) && items.length < cap) {
        const url = match[1];
        const title = decodeEntities(match[2].replace(/<[^>]*>/g, '').trim());
        if (!title || title.length < 8 || seen.has(url)) continue;
        seen.add(url);
        items.push({ title, summary: '', time: '', url });
    }
    return items;
}

module.exports = async function handler(req, res) {
    try {
        const limit = Math.max(1, Math.min(40, parseInt(req.query.limit, 10) || 20));
        const cursor = (req.query.cursor || '').trim();
        let items = [];
        let nextCursor = null;
        let hasMore = false;

        try {
            items = await loadEastmoneyFastNews(cursor, limit);
            // 下一页 cursor:用最后一条的 showTime(东财 sortEnd 是 showTime 时间戳字符串)
            if (items.length > 0) {
                const last = items[items.length - 1];
                if (last && last.time) {
                    nextCursor = last.time;
                    hasMore = items.length >= limit; // 不足一页说明到底了
                }
            }
        } catch (error) {
            // 兜底源(只有首屏用,无 cursor 时)
            if (!cursor) {
                items = await loadEastmoneyFinanceFallback(limit);
            } else {
                throw error;
            }
        }
        if (!items.length) throw new Error('东财全球资讯为空');

        return ok(res, {
            data: items.slice(0, limit),
            nextCursor: hasMore ? nextCursor : null,
            hasMore,
        });
    } catch (error) {
        return fail(res, 502, '真实东财资讯接口不可用', { error: error.message });
    }
};

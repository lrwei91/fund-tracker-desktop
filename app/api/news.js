const crypto = require('crypto');

const { emGet, fail, fetchJson, ok } = require('./_utils');

function stripHtml(text) {
    return String(text || '')
        // <br> 改成空格,避免字面换行符破坏 JSON 字符串
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

function parseCursor(raw) {
    if (!raw) return null;
    try {
        const obj = JSON.parse(raw);
        if (obj && (obj.maxTime || obj.lastId)) return obj;
    } catch (e) { /* ignore */ }
    return null;
}

async function fetchJin10Page(cursor) {
    const params = new URLSearchParams({
        channel: '-8200',
        vip: '1',
    });
    if (cursor && cursor.maxTime) params.set('max_time', cursor.maxTime);
    if (cursor && cursor.lastId) params.set('last_id', cursor.lastId);

    return fetchJson(`https://flash-api.jin10.com/get_flash_list?${params.toString()}`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36',
            'x-app-id': 'bVBF4FyRTn5NJF5n',
            'x-version': '1.0.0',
            Referer: 'https://www.jin10.com/',
            Origin: 'https://www.jin10.com/',
        },
    });
}

// 东财快讯 fallback（金十不可用时）
async function fetchEastmoneyFastNewsFallback(limit) {
    const params = new URLSearchParams({
        client: 'web',
        biz: 'web_724',
        fastColumn: '102',
        sortEnd: '',
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
    if (!rows.length) throw new Error('东财快讯为空');
    return rows.map((item) => ({
        id: String(item.seq || item.id || item.url || Math.random()),
        time: item.showTime || item.createTime || '',
        data: { content: (item.title || item.summary || stripHtml(item.content || '')).trim() },
        url: item.url || 'https://kuaixun.eastmoney.com/',
    }));
}

module.exports = async function handler(req, res) {
    try {
        const limit = Math.max(1, Math.min(40, parseInt(req.query.limit, 10) || 20));
        const cursor = parseCursor(req.query.cursor);
        // 分页模式:沿 cursor 取一页(默认 20),返回 nextCursor 给前端继续拉
        const seen = new Set();
        const rows = [];
        let nextCursor = null;
        let exhausted = false;

        let json;
        let usedFallback = false;
        try {
            json = await fetchJin10Page(cursor);
        } catch (error) {
            // 首屏无可用缓存,直接报错
            if (!rows.length && cursor) throw error;
            // 首屏:尝试东财快讯 fallback
            if (!cursor) {
                try {
                    const emItems = await fetchEastmoneyFastNewsFallback(limit);
                    emItems.forEach((item) => {
                        if (!seen.has(item.id)) {
                            seen.add(item.id);
                            rows.push(item);
                        }
                    });
                    usedFallback = true;
                } catch (emError) {
                    throw error; // 抛出原始 jin10 错误
                }
            }
        }
        if (!usedFallback && (!json || json.status !== 200 || !Array.isArray(json.data))) {
            throw new Error(`金十返回异常 ${json && json.status}`);
        }

        if (!usedFallback) {
            json.data.forEach((item) => {
                const id = String(item.id || '');
                if (!id || seen.has(id)) return;
                seen.add(id);

                const data = item.data || {};
                const content = stripHtml(data.content || data.title || '');
                if (!content || data.lock || /VIP专享|解锁直达|升级/.test(content)) return;

                rows.push({
                    id,
                    time: item.time || '',
                    data: { content },
                    url: data.link || 'https://www.jin10.com/flash',
                });
            });
        }

        // 用"过滤后最后一条"作为下一页 cursor
        const sliced = rows.slice(0, limit);
        const last = sliced[sliced.length - 1];
        if (last && (last.time || last.id)) {
            nextCursor = JSON.stringify({ maxTime: last.time, lastId: last.id });
        } else {
            exhausted = true;
        }
        if (!usedFallback && json && json.data && json.data.length === 0) exhausted = true;

        if (!rows.length && !cursor) throw new Error('金十公开快讯为空');

        return ok(res, {
            data: sliced,
            nextCursor: exhausted ? null : nextCursor,
            hasMore: !exhausted && rows.length > 0,
        });
    } catch (error) {
        return fail(res, 502, '真实金十快讯接口不可用', { error: error.message });
    }
};

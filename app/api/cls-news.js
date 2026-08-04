const crypto = require('crypto');

const { emGet, fail, fetchJson, ok, runSources, sourceMeta } = require('./_utils');

function buildClsRequest(cursor, limit) {
    const params = {
        appName: 'CailianpressWeb',
        last_time: cursor || '',
        os: 'web',
        refresh_type: '1',
        rn: String(limit || 20),
        sv: '7.7.5',
    };
    const query = Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join('&');
    const sha1 = crypto.createHash('sha1').update(query).digest('hex');
    const sign = crypto.createHash('md5').update(sha1).digest('hex');
    return { query, sign };
}

function formatTimestamp(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
    return new Date(timestamp * 1000).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function normalizeClsRows(payload) {
    const rows = payload && payload.data && Array.isArray(payload.data.roll_data) ? payload.data.roll_data : [];
    return rows.map((item) => {
        const content = String(item.content || item.brief || item.title || '').trim();
        const title = String(item.title || item.brief || content).trim();
        const timestamp = Number(item.ctime) || 0;
        const fallbackId = crypto.createHash('sha1').update(`${timestamp}:${title}:${content}`).digest('hex').slice(0, 16);
        return {
            id: String(item.id || item.telegraph_id || fallbackId),
            timestamp,
            time: formatTimestamp(timestamp),
            title,
            summary: content,
            url: item.shareurl || item.url || 'https://www.cls.cn/telegraph',
        };
    }).filter((item) => item.title || item.summary);
}

async function loadClsTelegraph(cursor, limit) {
    const request = buildClsRequest(cursor, limit);
    const json = await fetchJson(`https://www.cls.cn/v1/roll/get_roll_list?${request.query}&sign=${request.sign}`, {
        cacheTtl: 30000,
        headers: { Referer: 'https://www.cls.cn/' },
    });
    if (json && json.errno !== undefined && Number(json.errno) !== 0) {
        throw new Error(json.msg || `财联社返回异常 ${json.errno}`);
    }
    return normalizeClsRows(json);
}

async function loadEastmoneyFallback(limit) {
    const params = new URLSearchParams({
        client: 'web',
        biz: 'web_724',
        fastColumn: '102',
        sortEnd: '',
        pageSize: String(limit || 20),
        req_trace: crypto.randomUUID(),
    });
    const json = await emGet(`https://np-weblist.eastmoney.com/comm/web/getFastNewsList?${params.toString()}`, {
        cacheTtl: 30000,
        headers: { Referer: 'https://kuaixun.eastmoney.com/' },
    });
    const rows = json && json.data && Array.isArray(json.data.fastNewsList) ? json.data.fastNewsList : [];
    return rows.map((item) => ({
        id: String(item.seq || item.id || item.url || ''),
        timestamp: 0,
        time: item.showTime || item.createTime || '',
        title: item.title || item.summary || '',
        summary: item.summary || item.title || '',
        url: item.url || 'https://kuaixun.eastmoney.com/',
    })).filter((item) => item.title || item.summary);
}

async function handler(req, res) {
    try {
        const limit = Math.max(1, Math.min(40, parseInt(req.query.limit, 10) || 20));
        const cursor = String(req.query.cursor || '').trim();
        const sources = [{
            id: 'cls',
            label: '财联社',
            load: () => loadClsTelegraph(cursor, limit),
            validate: (items) => Array.isArray(items) && items.length > 0,
        }];
        if (!cursor) {
            sources.push({
                id: 'eastmoney',
                label: '东方财富',
                load: () => loadEastmoneyFallback(limit),
                validate: (items) => Array.isArray(items) && items.length > 0,
            });
        }
        const result = await runSources(sources);
        const items = result.value.slice(0, limit);
        const last = items[items.length - 1];
        const nextCursor = result.meta.actual === 'cls' && last && last.timestamp ? String(last.timestamp) : null;
        return ok(res, {
            data: items,
            nextCursor,
            hasMore: Boolean(nextCursor && items.length >= limit),
            source: result.meta.actual,
            sourceLabel: result.meta.actualLabel,
        }, { meta: sourceMeta('news', result, { requested: 'cls' }) });
    } catch (error) {
        return fail(res, 502, '财联社快讯接口不可用', { error: error.message });
    }
}

module.exports = handler;
module.exports.buildClsRequest = buildClsRequest;
module.exports.formatTimestamp = formatTimestamp;
module.exports.loadClsTelegraph = loadClsTelegraph;
module.exports.normalizeClsRows = normalizeClsRows;

const { API_TIMEOUTS, emGet, fail, fetchJson, ok, runSources, toNumber } = require('./_utils');

function shanghaiDate() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
}

function ratioPercent(value) {
    const number = toNumber(value);
    if (number === null) return null;
    return Math.abs(number) <= 1 ? number * 100 : number;
}

function normalizeLockupRows(rows, today) {
    const normalized = (Array.isArray(rows) ? rows : []).map((row) => ({
        date: String(row.FREE_DATE || '').slice(0, 10),
        type: row.FREE_SHARES_TYPE || '',
        shares: toNumber(row.FREE_SHARES),
        ableShares: toNumber(row.ABLE_FREE_SHARES),
        ratioPct: ratioPercent(row.FREE_RATIO),
    })).filter((item) => item.date);
    return {
        history: normalized.filter((item) => item.date < today).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10),
        upcoming: normalized.filter((item) => item.date >= today).sort((a, b) => a.date.localeCompare(b.date)),
    };
}

async function loadLockup(code) {
    const today = shanghaiDate();
    const end = new Date(`${today}T00:00:00+08:00`);
    end.setUTCDate(end.getUTCDate() + 90);
    const endDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(end);
    const filter = encodeURIComponent(`(SECURITY_CODE="${code}")(FREE_DATE<='${endDate}')`);
    const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
        + `?reportName=RPT_LIFT_STAGE&columns=ALL&filter=${filter}&pageSize=60&pageNumber=1&sortColumns=FREE_DATE&sortTypes=-1`;
    const json = await emGet(url, {
        cacheTtl: 30 * 60 * 1000,
        headers: { Referer: 'https://data.eastmoney.com/' },
        timeout: API_TIMEOUTS.normal,
    });
    const rows = json && json.result && Array.isArray(json.result.data) ? json.result.data : [];
    return normalizeLockupRows(rows, today);
}

function normalizeSzseAnnouncements(payload) {
    const rows = payload && Array.isArray(payload.data) ? payload.data : [];
    return rows.map((item) => ({
        title: item.title || '',
        time: String(item.publishTime || '').slice(0, 10),
        pdf: item.attachPath ? `https://disc.static.szse.cn/download${item.attachPath}` : '',
    })).filter((item) => item.title);
}

function normalizeEastmoneyAnnouncements(payload) {
    const rows = payload && payload.data && Array.isArray(payload.data.list) ? payload.data.list : [];
    return rows.map((item) => ({
        title: item.title || '',
        time: String(item.notice_date || '').slice(0, 10),
        pdf: item.art_code ? `https://pdf.dfcfw.com/pdf/H2_${item.art_code}_1.pdf` : '',
    })).filter((item) => item.title);
}

async function loadSzseAnnouncements(code, limit) {
    const body = JSON.stringify({ channelCode: ['listedNotice_disc'], pageSize: limit, pageNum: 1, stock: [code] });
    const json = await fetchJson('https://www.szse.cn/api/disc/announcement/annList', {
        method: 'POST',
        body,
        cacheTtl: 30 * 60 * 1000,
        headers: {
            'Content-Type': 'application/json',
            Referer: 'https://www.szse.cn/disclosure/listed/notice/index.html',
        },
        timeout: API_TIMEOUTS.normal,
    });
    return normalizeSzseAnnouncements(json);
}

async function loadEastmoneyAnnouncements(code, limit) {
    const url = 'https://np-anotice-stock.eastmoney.com/api/security/ann'
        + `?sr=-1&page_size=${limit}&page_index=1&ann_type=A&client_source=web&stock_list=${code}&f_node=0&s_node=0`;
    return normalizeEastmoneyAnnouncements(await emGet(url, {
        cacheTtl: 30 * 60 * 1000,
        headers: { Referer: 'https://data.eastmoney.com/' },
        timeout: API_TIMEOUTS.normal,
    }));
}

async function loadAnnouncements(code, limit) {
    const sources = [];
    if (/^[03]/.test(code)) {
        sources.push({
            id: 'szse', label: '深交所', load: () => loadSzseAnnouncements(code, limit),
            validate: (items) => Array.isArray(items) && items.length > 0,
        });
    }
    sources.push({
        id: 'eastmoney', label: '东方财富', load: () => loadEastmoneyAnnouncements(code, limit),
        validate: (items) => Array.isArray(items) && items.length > 0,
    });
    return runSources(sources);
}

module.exports = async function handler(req, res) {
    const code = String(req.query.code || '').trim();
    if (!/^\d{6}$/.test(code)) return fail(res, 400, '缺少股票代码');
    const limit = Math.max(1, Math.min(20, parseInt(req.query.limit, 10) || 8));
    const [announcementResult, lockupResult] = await Promise.allSettled([
        loadAnnouncements(code, limit),
        loadLockup(code),
    ]);
    const announcements = announcementResult.status === 'fulfilled'
        ? { available: true, items: announcementResult.value.value, source: announcementResult.value.meta.actual }
        : { available: false, items: [], source: null, error: announcementResult.reason.message };
    const lockup = lockupResult.status === 'fulfilled'
        ? { available: true, ...lockupResult.value }
        : { available: false, history: [], upcoming: [], error: lockupResult.reason.message };
    return ok(res, { code, announcements, lockup }, {
        meta: {
            asOf: new Date().toISOString(),
            degraded: !announcements.available || !lockup.available || (announcementResult.status === 'fulfilled' && announcementResult.value.meta.degraded),
            sources: {
                announcements: announcementResult.status === 'fulfilled' ? announcementResult.value.meta : { actual: null, error: announcementResult.reason.message },
                lockup: lockupResult.status === 'fulfilled' ? { actual: 'eastmoney', actualLabel: '东方财富' } : { actual: null, error: lockupResult.reason.message },
            },
        },
    });
};

module.exports.normalizeEastmoneyAnnouncements = normalizeEastmoneyAnnouncements;
module.exports.normalizeLockupRows = normalizeLockupRows;
module.exports.normalizeSzseAnnouncements = normalizeSzseAnnouncements;
module.exports.ratioPercent = ratioPercent;

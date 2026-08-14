import {
    DEEPQ_REALTIME_URL, MAX_INSTALLATION_FUNDS, isCollectionMinute,
    normalizeCodes, normalizeRealtime, shanghaiClock, splitBatches,
} from './core.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

function response(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
}

function randomToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function authenticate(request, env) {
    const header = request.headers.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return null;
    const tokenHash = await sha256(token);
    const now = Date.now();
    const installation = await env.DB.prepare(
        'SELECT id, last_seen_at, expires_at, subscription_hash FROM installations WHERE token_hash = ? AND expires_at > ?',
    ).bind(tokenHash, now).first();
    return installation ? {
        id: installation.id,
        token,
        lastSeenAt: Number(installation.last_seen_at),
        expiresAt: Number(installation.expires_at),
        subscriptionHash: installation.subscription_hash || '',
    } : null;
}

async function rateLimit(binding, key) {
    if (!binding || typeof binding.limit !== 'function') return true;
    return (await binding.limit({ key })).success;
}

async function createInstallation(request, env) {
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    if (!await rateLimit(env.INSTALL_RATE_LIMITER, ip)) return response({ success: false, errorCode: 'rate_limited' }, 429);
    const id = crypto.randomUUID();
    const token = `${id}.${randomToken()}`;
    const now = Date.now();
    const ttl = Number(env.SUBSCRIPTION_TTL_DAYS || 7) * DAY_MS;
    await env.DB.prepare(
        'INSERT INTO installations(id, token_hash, created_at, last_seen_at, expires_at) VALUES(?, ?, ?, ?, ?)',
    ).bind(id, await sha256(token), now, now, now + ttl).run();
    return response({ success: true, data: { token, expiresAt: new Date(now + ttl).toISOString() } }, 201);
}

async function parseJson(request) {
    const length = Number(request.headers.get('content-length') || 0);
    if (length > 4096) throw new Error('request_too_large');
    return request.json();
}

async function updateSubscriptions(request, env, auth) {
    let body;
    try { body = await parseJson(request); } catch (error) { return response({ success: false, errorCode: error.message }, 400); }
    const rawCodes = Array.isArray(body && body.codes) ? body.codes : [];
    if (rawCodes.length > MAX_INSTALLATION_FUNDS) return response({ success: false, errorCode: 'too_many_codes' }, 400);
    const codes = normalizeCodes(rawCodes);
    const now = Date.now();
    const ttl = Number(env.SUBSCRIPTION_TTL_DAYS || 7) * DAY_MS;
    const expiresAt = now + ttl;
    const activeRows = await env.DB.prepare(
        'SELECT code, COUNT(*) AS subscription_count FROM subscriptions WHERE expires_at > ? GROUP BY code',
    ).bind(now).all();
    const active = new Set((activeRows.results || []).map((row) => row.code));
    const counts = new Map((activeRows.results || []).map((row) => [row.code, Number(row.subscription_count)]));
    const ownRows = await env.DB.prepare('SELECT code FROM subscriptions WHERE installation_id = ?').bind(auth.id).all();
    const own = new Set((ownRows.results || []).map((row) => row.code));
    const subscriptionHash = await sha256(codes.join(','));
    if (auth.subscriptionHash === subscriptionHash && now - auth.lastSeenAt < DAY_MS) {
        const acceptedCodes = codes.filter((code) => own.has(code));
        const rejectedCodes = codes.filter((code) => !own.has(code)).map((code) => ({ code, reason: 'pool_full' }));
        return response({ success: true, data: {
            acceptedCodes, rejectedCodes, expiresAt: new Date(auth.expiresAt).toISOString(),
        } });
    }
    own.forEach((code) => {
        if (!codes.includes(code) && counts.get(code) === 1) active.delete(code);
    });
    const maxActive = Math.max(1, Number(env.MAX_ACTIVE_FUNDS || 300));
    const acceptedCodes = [];
    const rejectedCodes = [];
    for (const code of codes) {
        if (active.has(code) || own.has(code) || active.size < maxActive) {
            acceptedCodes.push(code);
            active.add(code);
        } else rejectedCodes.push({ code, reason: 'pool_full' });
    }
    const statements = [
        env.DB.prepare('DELETE FROM subscriptions WHERE installation_id = ?').bind(auth.id),
        env.DB.prepare('UPDATE installations SET last_seen_at = ?, expires_at = ?, subscription_hash = ? WHERE id = ?')
            .bind(now, expiresAt, subscriptionHash, auth.id),
        ...acceptedCodes.map((code) => env.DB.prepare(
            'INSERT INTO subscriptions(installation_id, code, updated_at, expires_at) VALUES(?, ?, ?, ?)',
        ).bind(auth.id, code, now, expiresAt)),
    ];
    await env.DB.batch(statements);
    return response({ success: true, data: { acceptedCodes, rejectedCodes, expiresAt: new Date(expiresAt).toISOString() } });
}

async function readIntraday(request, env, auth) {
    const url = new URL(request.url);
    const rawCodes = url.searchParams.get('codes') || '';
    const codes = normalizeCodes(rawCodes);
    if (rawCodes.split(',').filter(Boolean).length > MAX_INSTALLATION_FUNDS) return response({ success: false, errorCode: 'too_many_codes' }, 400);
    const today = shanghaiClock().date;
    const date = url.searchParams.get('date') || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return response({ success: false, errorCode: 'invalid_date' }, 400);
    const owned = codes.length ? await env.DB.prepare(
        `SELECT code FROM subscriptions WHERE installation_id = ? AND expires_at > ? AND code IN (${codes.map(() => '?').join(',')})`,
    ).bind(auth.id, Date.now(), ...codes).all() : { results: [] };
    const accepted = new Set((owned.results || []).map((row) => row.code));
    const allowed = codes.filter((code) => accepted.has(code));
    let rows = [];
    if (allowed.length) {
        const result = await env.DB.prepare(
            `SELECT code, minute_at, estimate_percent, source FROM fund_intraday_points WHERE trade_date = ? AND code IN (${allowed.map(() => '?').join(',')}) ORDER BY minute_at`,
        ).bind(date, ...allowed).all();
        rows = result.results || [];
    }
    const data = {};
    for (const code of allowed) data[code] = { tradeDate: date, points: [], latestAt: null, coverageStart: null, source: 'deepq-star' };
    for (const row of rows) {
        const item = data[row.code];
        if (!item) continue;
        item.points.push({ time: Number(row.minute_at), value: Number(row.estimate_percent) });
        item.coverageStart ||= new Date(Number(row.minute_at)).toISOString();
        item.latestAt = new Date(Number(row.minute_at)).toISOString();
    }
    const missingCodes = allowed.filter((code) => !data[code] || !data[code].points.length);
    return response({ success: true, data, meta: { updatedAt: new Date().toISOString(), missingCodes, source: 'DeepQ 盘中估值 · 共享采集' } });
}

async function collect(env, scheduledAt) {
    const nowDate = new Date(scheduledAt || Date.now());
    const now = nowDate.getTime();
    const retention = Number(env.POINT_RETENTION_DAYS || 7) * DAY_MS;
    await env.DB.batch([
        env.DB.prepare('DELETE FROM subscriptions WHERE expires_at <= ?').bind(now),
        env.DB.prepare('DELETE FROM installations WHERE expires_at <= ?').bind(now),
        env.DB.prepare('DELETE FROM fund_intraday_points WHERE collected_at < ?').bind(now - retention),
    ]);
    if (!isCollectionMinute(nowDate)) return { skipped: true };
    const result = await env.DB.prepare('SELECT DISTINCT code FROM subscriptions WHERE expires_at > ? ORDER BY code').bind(now).all();
    const codes = normalizeCodes((result.results || []).map((row) => row.code), 300);
    const clock = shanghaiClock(nowDate);
    const minuteAt = Math.floor(now / 60000) * 60000;
    let written = 0;
    for (const batch of splitBatches(codes, 100)) {
        try {
            const upstream = await fetch(`${DEEPQ_REALTIME_URL}?codes=${batch.join(',')}`, { headers: { accept: 'application/json' } });
            if (!upstream.ok) continue;
            const values = normalizeRealtime(await upstream.json(), batch);
            if (!values.length) continue;
            await env.DB.batch(values.map(({ code, value }) => env.DB.prepare(
                'INSERT INTO fund_intraday_points(code, trade_date, minute_at, estimate_percent, source, collected_at) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(code, trade_date, minute_at) DO UPDATE SET estimate_percent=excluded.estimate_percent, collected_at=excluded.collected_at',
            ).bind(code, clock.date, minuteAt, value, 'deepq-star', now)));
            written += values.length;
        } catch (error) { /* 下一个批次继续采集 */ }
    }
    return { skipped: false, codes: codes.length, written };
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (request.method === 'POST' && url.pathname === '/v1/installations') return createInstallation(request, env);
        const auth = await authenticate(request, env);
        if (!auth) return response({ success: false, errorCode: 'unauthorized' }, 401);
        if (!await rateLimit(env.API_RATE_LIMITER, auth.id)) return response({ success: false, errorCode: 'rate_limited' }, 429);
        if (request.method === 'PUT' && url.pathname === '/v1/subscriptions') return updateSubscriptions(request, env, auth);
        if (request.method === 'GET' && url.pathname === '/v1/funds/intraday') return readIntraday(request, env, auth);
        return response({ success: false, errorCode: 'not_found' }, 404);
    },
    async scheduled(controller, env, ctx) {
        ctx.waitUntil(collect(env, controller.scheduledTime));
    },
};

export { collect };

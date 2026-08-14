export const MAX_INSTALLATION_FUNDS = 30;
export const DEEPQ_REALTIME_URL = 'https://sq.deepq.tech/star/api/fund_realtime';

export function normalizeCodes(input, limit = MAX_INSTALLATION_FUNDS) {
    const seen = new Set();
    return (Array.isArray(input) ? input : String(input || '').split(','))
        .map((code) => String(code).trim())
        .filter((code) => /^\d{6}$/.test(code))
        .filter((code) => !seen.has(code) && seen.add(code))
        .slice(0, limit);
}

export function shanghaiClock(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', weekday: 'short', year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).reduce((out, part) => {
        if (part.type !== 'literal') out[part.type] = part.value;
        return out;
    }, {});
    return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        weekday: parts.weekday,
        minutes: Number(parts.hour) * 60 + Number(parts.minute),
    };
}

export function isCollectionMinute(date = new Date()) {
    const clock = shanghaiClock(date);
    if (!['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(clock.weekday)) return false;
    return (clock.minutes >= 9 * 60 + 15 && clock.minutes <= 11 * 60 + 30)
        || (clock.minutes >= 13 * 60 && clock.minutes <= 15 * 60 + 30);
}

export function normalizeRealtime(payload, codes) {
    const data = payload && typeof payload === 'object' ? payload : {};
    return normalizeCodes(codes, 300).flatMap((code) => {
        const raw = data[code];
        if (raw === null || raw === undefined || raw === '') return [];
        const value = Number(raw);
        return Number.isFinite(value) && Math.abs(value) <= 30 ? [{ code, value }] : [];
    });
}

export function splitBatches(items, size = 100) {
    const batches = [];
    for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
    return batches;
}

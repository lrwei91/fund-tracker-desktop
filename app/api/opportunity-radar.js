// A 股机会雷达 — 聚合热榜 / 涨停池 / 板块资金 / 龙虎榜 / 技术面 / 新闻风险

const { fail, ok, toNumber } = require('./_utils');

const hotRankHandler = require('./hot-rank');
const limitUpHandler = require('./limit-up');
const dragonTigerHandler = require('./dragon-tiger');
const marketDataHandler = require('./market-data');
const stockHandler = require('./stock');
const fundFlowHandler = require('./fund-flow-120d');
const stockKlineHandler = require('./stock-kline');
const stockNewsHandler = require('./stock-news');

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const ENRICH_MAX = MAX_LIMIT;
const LIMIT_BOARD_PCT = 9.2;

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function round(value, digits) {
    const number = toNumber(value);
    if (number === null) return null;
    const base = Math.pow(10, digits ?? 1);
    return Math.round(number * base) / base;
}

function createMemoryResponse() {
    const chunks = [];
    return {
        statusCode: 200,
        headers: {},
        setHeader(name, value) {
            this.headers[String(name).toLowerCase()] = String(value);
        },
        getHeader(name) {
            return this.headers[String(name).toLowerCase()];
        },
        write(chunk) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || '')));
        },
        end(chunk) {
            if (chunk !== undefined) this.write(chunk);
        },
        json() {
            const raw = Buffer.concat(chunks).toString('utf8');
            return raw ? JSON.parse(raw) : {};
        },
    };
}

async function invokeHandler(handler, query) {
    const res = createMemoryResponse();
    await Promise.resolve(handler({ query: query || {} }, res));
    return res.json();
}

async function mapLimit(items, concurrency, mapper) {
    const result = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            try {
                result[index] = await mapper(items[index], index);
            } catch (error) {
                result[index] = { error: error.message };
            }
        }
    });
    await Promise.all(workers);
    return result;
}

function emptyCandidate(code, name) {
    return {
        code,
        name: name || code,
        pct: null,
        price: null,
        topicTags: [],
        signals: [],
        sourceScore: 0,
        industry: '',
        hotRank: null,
        limitType: '',
        dragonNetWan: null,
        dragonReason: '',
        isLimitDown: false,
        sourceTypes: [],
    };
}

function upsertCandidate(map, code, name) {
    if (!/^\d{6}$/.test(String(code || ''))) return null;
    if (!map.has(code)) map.set(code, emptyCandidate(code, name));
    const item = map.get(code);
    if (name && (!item.name || item.name === code)) item.name = name;
    return item;
}

function addUnique(list, value) {
    const text = String(value || '').trim();
    if (text && !list.includes(text)) list.push(text);
}

function addSourceType(candidate, type) {
    if (!candidate || !type) return;
    if (!candidate.sourceTypes.includes(type)) candidate.sourceTypes.push(type);
}

function hasNonLimitSource(candidate) {
    return !!(candidate && Array.isArray(candidate.sourceTypes)
        && candidate.sourceTypes.some((type) => type !== 'limit'));
}

function isCurrentLimitBoard(candidate) {
    if (!candidate) return false;
    const pct = toNumber(candidate.pct);
    return candidate.limitType === 'zt' || (pct !== null && pct >= LIMIT_BOARD_PCT);
}

function radarSeedScore(candidate) {
    let score = candidate.sourceScore || 0;
    if (hasNonLimitSource(candidate)) score += 8;
    if (isCurrentLimitBoard(candidate)) score -= 28;
    if (candidate.isLimitDown) score -= 40;
    return score;
}

function orderRadarSeeds(list) {
    return list.slice().sort((a, b) => radarSeedScore(b) - radarSeedScore(a));
}

function selectRadarPool(candidates, count) {
    const eligible = candidates
        .filter((item) => item && item.code && item.sourceScore > -25 && !item.isLimitDown);
    const primary = eligible.filter((item) => hasNonLimitSource(item) && !isCurrentLimitBoard(item));
    const secondary = eligible.filter((item) => !hasNonLimitSource(item) && !isCurrentLimitBoard(item));
    const hotLimitFallback = eligible.filter((item) => hasNonLimitSource(item) && isCurrentLimitBoard(item));
    const boardFallback = eligible.filter((item) => !hasNonLimitSource(item) && isCurrentLimitBoard(item));
    return []
        .concat(orderRadarSeeds(primary))
        .concat(orderRadarSeeds(secondary))
        .concat(orderRadarSeeds(hotLimitFallback))
        .concat(orderRadarSeeds(boardFallback))
        .slice(0, count);
}

function addSignal(candidate, label, points, detail) {
    candidate.sourceScore += points || 0;
    candidate.signals.push({
        label,
        points: round(points || 0, 1),
        detail: detail || '',
    });
}

function absorbHotRank(map, payload, source) {
    const items = payload && payload.data && Array.isArray(payload.data.items) ? payload.data.items : [];
    items.slice(0, 24).forEach((item) => {
        const candidate = upsertCandidate(map, item.code, item.name);
        if (!candidate) return;
        const rank = toNumber(item.rank) || 30;
        const points = clamp(22 - rank * 0.65, 5, 21);
        candidate.hotRank = candidate.hotRank === null ? rank : Math.min(candidate.hotRank, rank);
        candidate.pct = candidate.pct === null ? toNumber(item.pct) : candidate.pct;
        candidate.price = candidate.price === null ? toNumber(item.price) : candidate.price;
        if (Array.isArray(item.concepts)) item.concepts.slice(0, 3).forEach((tag) => addUnique(candidate.topicTags, tag));
        addUnique(candidate.topicTags, item.tag);
        addSourceType(candidate, 'hot');
        addSignal(candidate, source === 'ths' ? '同花顺热榜' : '东财人气榜', points, `热度排名 ${rank}`);
    });
}

function absorbLimitPool(map, payload, type) {
    const items = payload && payload.data && Array.isArray(payload.data.items) ? payload.data.items : [];
    const labelMap = { zt: '涨停池', yzt: '昨涨停', zb: '炸板池', dt: '跌停池' };
    const scoreMap = { zt: 4, yzt: 8, zb: 5, dt: -24 };
    items.slice(0, 40).forEach((item) => {
        const candidate = upsertCandidate(map, item.code, item.name);
        if (!candidate) return;
        candidate.limitType = type;
        candidate.isLimitDown = candidate.isLimitDown || type === 'dt';
        candidate.pct = candidate.pct === null ? toNumber(item.pct) : candidate.pct;
        candidate.price = candidate.price === null ? toNumber(item.price) : candidate.price;
        candidate.industry = candidate.industry || item.industry || '';
        addUnique(candidate.topicTags, item.industry);
        addSourceType(candidate, 'limit');
        const detail = type === 'zt'
            ? (item.ztStat || `${item.limitDays || 1}板`)
            : (type === 'zb' ? `${item.breakTimes || 0}次开板` : `${round(item.pct, 2)}%`);
        addSignal(candidate, labelMap[type] || '异动池', scoreMap[type] || 0, detail);
    });
}

function absorbDragonTiger(map, payload) {
    const stocks = payload && payload.data && Array.isArray(payload.data.stocks) ? payload.data.stocks : [];
    stocks.slice(0, 24).forEach((stock) => {
        const candidate = upsertCandidate(map, stock.code, stock.name);
        if (!candidate) return;
        const netWan = toNumber(stock.netBuyWan) || 0;
        candidate.dragonNetWan = netWan;
        candidate.dragonReason = stock.reason || '';
        addSourceType(candidate, 'dragon');
        addSignal(candidate, '龙虎榜', clamp(netWan / 2500, -10, 13), netWan >= 0 ? '净买入' : '净卖出');
    });
}

function sectorScoreFor(candidate, sectorData) {
    const inflow = sectorData && Array.isArray(sectorData.inflow) ? sectorData.inflow : [];
    const outflow = sectorData && Array.isArray(sectorData.outflow) ? sectorData.outflow : [];
    const text = [candidate.industry].concat(candidate.topicTags).join(' ');
    const matchIn = inflow.find((row) => row && row.name && (text.includes(row.name) || row.leader === candidate.name));
    const matchOut = outflow.find((row) => row && row.name && (text.includes(row.name) || row.leader === candidate.name));
    if (matchIn) return { points: 8, label: matchIn.name, value: matchIn.value };
    if (matchOut) return { points: -6, label: matchOut.name, value: matchOut.value };
    return null;
}

function mergeQuote(candidate, quote) {
    if (!quote) return;
    candidate.name = quote.name || candidate.name;
    candidate.pct = toNumber(quote.changePercent);
    candidate.price = toNumber(quote.priceValue);
}

function fundMetrics(flowItem) {
    const summary = flowItem && flowItem.summary ? flowItem.summary : {};
    const today = summary.today || {};
    return {
        todayMain: toNumber(today.main),
        main5d: toNumber(summary.main_5d),
        main20d: toNumber(summary.main_20d),
    };
}

function historyWinRate(klineData) {
    const bars = klineData && Array.isArray(klineData.bars) ? klineData.bars : [];
    const valid = bars.filter((bar) => toNumber(bar.pct) !== null);
    if (!valid.length) return null;
    const positive = valid.filter((bar) => (toNumber(bar.pct) || 0) > 0).length;
    return round(positive / valid.length * 100, 1);
}

function componentScores(candidate, enrich) {
    enrich = enrich || {};
    const pct = toNumber(candidate.pct) || 0;
    const analysis = enrich.kline && enrich.kline.analysis ? enrich.kline.analysis : {};
    const indicators = analysis.indicators || {};
    const techScore = toNumber(analysis.score);
    const momentum21 = toNumber(indicators.momentum21);
    const volumeRatio = toNumber(indicators.volumeRatio);
    const flow = fundMetrics(enrich.fund);
    const newsScore = enrich.news && enrich.news.score ? toNumber(enrich.news.score.score) : null;

    const topic = clamp(48 + candidate.sourceScore + (candidate.topicTags.length ? 4 : 0), 0, 100);
    const momentum = clamp(50 + pct * 3.2 + (momentum21 || 0) * 0.75 + (volumeRatio && volumeRatio > 1.4 ? 6 : 0), 0, 100);
    const fund = clamp(50
        + (flow.todayMain || 0) / 100000000 * 11
        + (flow.main5d || 0) / 300000000 * 8
        + ((candidate.dragonNetWan || 0) / 10000) * 3, 0, 100);
    const technical = techScore === null ? 50 : clamp(50 + techScore * 0.5, 0, 100);
    const news = newsScore === null ? 50 : clamp(50 + newsScore * 9, 0, 100);
    return {
        topic: round(topic, 0),
        momentum: round(momentum, 0),
        fund: round(fund, 0),
        technical: round(technical, 0),
        news: round(news, 0),
    };
}

function riskState(candidate, enrich) {
    enrich = enrich || {};
    const points = [];
    const name = String(candidate.name || '');
    const pct = toNumber(candidate.pct);
    const analysis = enrich.kline && enrich.kline.analysis ? enrich.kline.analysis : {};
    const techScore = toNumber(analysis.score);
    const flow = fundMetrics(enrich.fund);
    const newsScore = enrich.news && enrich.news.score ? enrich.news.score : {};
    const risks = Array.isArray(newsScore.riskHits) ? newsScore.riskHits : [];

    if (/ST|退/.test(name.toUpperCase())) points.push({ value: 30, reason: '特殊风险' });
    if (candidate.isLimitDown) points.push({ value: 22, reason: '跌停池' });
    if (candidate.limitType === 'zt') points.push({ value: 18, reason: '已涨停' });
    else if (pct !== null && pct >= LIMIT_BOARD_PCT) points.push({ value: 12, reason: '涨幅过热' });
    if (pct !== null && pct <= -7) points.push({ value: 7, reason: '跌幅过大' });
    if (techScore !== null && techScore <= -35) points.push({ value: 8, reason: '技术弱势' });
    if ((flow.todayMain || 0) <= -100000000) points.push({ value: 6, reason: '主力流出' });
    if (risks.length) points.push({ value: Math.min(14, risks.length * 4), reason: risks.slice(0, 3).join('/') });

    const total = points.reduce((sum, item) => sum + item.value, 0);
    const status = total >= 16 ? 'block' : (total >= 7 ? 'watch' : 'pass');
    return {
        status,
        label: status === 'block' ? '回避' : (status === 'watch' ? '观察' : '可跟踪'),
        points: total,
        reasons: points.map((item) => item.reason).slice(0, 4),
    };
}

function scoreRadarCandidate(candidate, enrich) {
    const components = componentScores(candidate, enrich);
    const risk = riskState(candidate, enrich);
    const riskControl = clamp(100 - risk.points * 4.5, 0, 100);
    const score = clamp(
        components.topic * 0.22
        + components.momentum * 0.20
        + components.fund * 0.20
        + components.technical * 0.20
        + components.news * 0.12
        + riskControl * 0.06
        - Math.max(0, risk.points - 8) * 0.8,
        0,
        100,
    );
    const topic = candidate.topicTags.filter(Boolean).slice(0, 3);
    if (!topic.length && candidate.dragonReason) topic.push(candidate.dragonReason);
    return {
        code: candidate.code,
        name: candidate.name,
        price: candidate.price,
        pct: round(candidate.pct, 2),
        score: round(score, 0),
        topic: topic.join(' / ') || '--',
        components,
        risk,
        signals: candidate.signals
            .sort((a, b) => Math.abs(b.points || 0) - Math.abs(a.points || 0))
            .slice(0, 5),
        historyWinRate: historyWinRate(enrich.kline),
        newsHits: enrich.news && enrich.news.score ? (enrich.news.score.positiveHits || []) : [],
        newsRisks: enrich.news && enrich.news.score ? (enrich.news.score.riskHits || []) : [],
        latestDate: enrich.kline ? enrich.kline.latestDate : '',
    };
}

async function enrichCandidates(candidates) {
    const codes = candidates.map((item) => item.code);
    const quoteJson = await invokeHandler(stockHandler, { codes: codes.join(',') }).catch(() => null);
    const quoteMap = quoteJson && quoteJson.success && quoteJson.data ? quoteJson.data : {};
    candidates.forEach((candidate) => mergeQuote(candidate, quoteMap[candidate.code]));

    const fundItems = {};
    for (let i = 0; i < codes.length; i += 10) {
        const chunk = codes.slice(i, i + 10);
        const fundJson = await invokeHandler(fundFlowHandler, { codes: chunk.join(','), days: '60' }).catch(() => null);
        const items = fundJson && fundJson.success && fundJson.data && Array.isArray(fundJson.data.items) ? fundJson.data.items : [];
        items.forEach((item) => { fundItems[item.code] = item; });
    }

    const detailRows = await mapLimit(candidates, 3, async (candidate) => {
        const [klineJson, newsJson] = await Promise.all([
            invokeHandler(stockKlineHandler, { code: candidate.code, days: '260' }).catch(() => null),
            invokeHandler(stockNewsHandler, { code: candidate.code, name: candidate.name, limit: '4' }).catch(() => null),
        ]);
        return {
            fund: fundItems[candidate.code] || null,
            kline: klineJson && klineJson.success ? klineJson.data : null,
            news: newsJson && newsJson.success ? newsJson.data : null,
        };
    });

    return candidates.map((candidate, index) => scoreRadarCandidate(candidate, detailRows[index] || {}));
}

async function handler(req, res) {
    try {
        const limit = Math.max(1, Math.min(MAX_LIMIT, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
        const candidates = new Map();
        const [
            thsHot,
            emHot,
            ztPool,
            yztPool,
            zbPool,
            dtPool,
            dragonTiger,
            sector,
        ] = await Promise.allSettled([
            invokeHandler(hotRankHandler, { source: 'ths', limit: '24' }),
            invokeHandler(hotRankHandler, { source: 'em', limit: '18' }),
            invokeHandler(limitUpHandler, { type: 'zt', limit: '40' }),
            invokeHandler(limitUpHandler, { type: 'yzt', limit: '30' }),
            invokeHandler(limitUpHandler, { type: 'zb', limit: '24' }),
            invokeHandler(limitUpHandler, { type: 'dt', limit: '20' }),
            invokeHandler(dragonTigerHandler, {}),
            invokeHandler(marketDataHandler, { type: 'sector' }),
        ]);

        if (thsHot.status === 'fulfilled') absorbHotRank(candidates, thsHot.value, 'ths');
        if (emHot.status === 'fulfilled') absorbHotRank(candidates, emHot.value, 'em');
        if (ztPool.status === 'fulfilled') absorbLimitPool(candidates, ztPool.value, 'zt');
        if (yztPool.status === 'fulfilled') absorbLimitPool(candidates, yztPool.value, 'yzt');
        if (zbPool.status === 'fulfilled') absorbLimitPool(candidates, zbPool.value, 'zb');
        if (dtPool.status === 'fulfilled') absorbLimitPool(candidates, dtPool.value, 'dt');
        if (dragonTiger.status === 'fulfilled') absorbDragonTiger(candidates, dragonTiger.value);

        const sectorData = sector.status === 'fulfilled' && sector.value && sector.value.success ? sector.value.data : null;
        candidates.forEach((candidate) => {
            const match = sectorScoreFor(candidate, sectorData);
            if (!match) return;
            addUnique(candidate.topicTags, match.label);
            addSourceType(candidate, 'sector');
            addSignal(candidate, '板块资金', match.points, `${match.label} ${match.value || ''}`.trim());
        });

        const enrichCount = Math.min(ENRICH_MAX, limit);
        const pool = selectRadarPool(Array.from(candidates.values()), enrichCount);
        const items = await enrichCandidates(pool);
        items.sort((a, b) => b.score - a.score);

        return ok(res, {
            generatedAt: new Date().toISOString(),
            sourceStatus: {
                hotRank: thsHot.status === 'fulfilled' || emHot.status === 'fulfilled',
                limitUp: ztPool.status === 'fulfilled' || yztPool.status === 'fulfilled' || zbPool.status === 'fulfilled',
                dragonTiger: dragonTiger.status === 'fulfilled',
                sector: sector.status === 'fulfilled',
            },
            items: items.slice(0, limit),
        });
    } catch (error) {
        return fail(res, 502, '机会雷达接口不可用', { error: error.message });
    }
}

module.exports = handler;
module.exports.componentScores = componentScores;
module.exports.riskState = riskState;
module.exports.scoreRadarCandidate = scoreRadarCandidate;
module.exports.historyWinRate = historyWinRate;
module.exports.sectorScoreFor = sectorScoreFor;
module.exports.isCurrentLimitBoard = isCurrentLimitBoard;
module.exports.hasNonLimitSource = hasNonLimitSource;
module.exports.selectRadarPool = selectRadarPool;

// ================================================================
// 市场信号 — 机会雷达 / 市场热度 / 打板情绪 (涨停 / 炸板 / 跌停 / 昨涨停)
// 暴露到 window.AppSignals;
// 直接 script 引入,无需 import/require
// 依赖:window.AppState, window.AppUtils, window.AppCache
// ================================================================

(function () {
    var state = window.AppState;
    var utils = window.AppUtils;
    var cache = window.AppCache;
    var dataStatus = window.AppDataStatus || { label: function (_meta, fallback) { return fallback || ''; } };
    var KEYS = state.KEYS;

    function toFiniteNumber(value) {
        if (value === null || value === undefined || value === '') return null;
        var number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function formatSignedPercent(value) {
        var number = toFiniteNumber(value);
        if (number === null) return '--';
        return (number > 0 ? '+' : '') + number.toFixed(2) + '%';
    }

    function trendClass(value) {
        var number = toFiniteNumber(value);
        return number > 0 ? 'positive' : number < 0 ? 'negative' : 'neutral';
    }

    function scoreClass(value) {
        var number = toFiniteNumber(value);
        if (number === null) return 'neutral';
        return number >= 70 ? 'positive' : (number < 45 ? 'negative' : 'neutral');
    }

    function shouldBypassDailySignalCache(force) {
        return !!force || (utils.isAfterCloseForDailyUpdate && utils.isAfterCloseForDailyUpdate());
    }

    // ============================================================
    // 机会雷达
    // ============================================================

    var OPPORTUNITY_RADAR_CACHE_KEY = 'fund_tracker_opportunity_radar_cache';
    var OPPORTUNITY_RADAR_TTL_MS = 5 * 60 * 1000;

    async function loadOpportunityRadarData(force) {
        var container = document.getElementById('opportunity-radar-list');
        var timeEl = document.getElementById('opportunity-radar-update-time');
        if (!container) return;

        var cached = cache.readJson(OPPORTUNITY_RADAR_CACHE_KEY, null);
        var todayKey = utils.getShanghaiDateKey();
        if (!force && cached && cached.date === todayKey && cached.data
            && Date.now() - (cached.updatedAt || 0) < OPPORTUNITY_RADAR_TTL_MS) {
            renderOpportunityRadar(cached.data, false);
            return;
        }
        if (!cached || !cached.data || !Array.isArray(cached.data.items)) {
            container.innerHTML = '<div class="opportunity-radar-empty">扫描中...</div>';
        }

        try {
            var res = await window.AppDataClient.fetch('/opportunity-radar', { limit: 8 });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var json = await res.json();
            if (!json.success || !json.data || !Array.isArray(json.data.items)) throw new Error('数据异常');
            json.data.meta = json.meta || null;
            cache.writeJson(OPPORTUNITY_RADAR_CACHE_KEY, {
                date: todayKey,
                data: json.data,
                updatedAt: Date.now(),
            });
            renderOpportunityRadar(json.data, true);
            if (timeEl) {
                var prefix = dataStatus.label(json.meta, json.meta && json.meta.degraded ? '部分数据源不可用' : '更新');
                timeEl.textContent = prefix + utils.formatShanghaiTime(json.data.generatedAt || new Date().toISOString());
            }
        } catch (e) {
            console.error('机会雷达获取失败:', e);
            if (cached && cached.data && Array.isArray(cached.data.items)) {
                renderOpportunityRadar(cached.data, false);
                if (timeEl) timeEl.textContent = '缓存';
                return;
            }
            renderOpportunityRadarError();
            if (window.AppAlerts && typeof window.AppAlerts.showStatusToast === 'function') {
                window.AppAlerts.showStatusToast('机会雷达接口暂不可用', 'error');
            }
        }
    }

    function renderOpportunityRadar(data, fresh) {
        var container = document.getElementById('opportunity-radar-list');
        var timeEl = document.getElementById('opportunity-radar-update-time');
        if (!container) return;
        var items = data && Array.isArray(data.items) ? data.items : [];
        if (timeEl && fresh) {
            var prefix = dataStatus.label(data.meta, data.meta && data.meta.degraded ? '部分数据源不可用' : '更新');
            timeEl.textContent = prefix + utils.formatShanghaiTime(data.generatedAt || new Date().toISOString());
        } else if (timeEl && !fresh) {
            timeEl.textContent = '缓存数据';
        }
        if (!items.length) {
            container.innerHTML = '<div class="opportunity-radar-empty">暂无候选信号</div>';
            return;
        }
        container.innerHTML = items.map(renderOpportunityRadarItem).join('');
        container.querySelectorAll('[data-radar-code]').forEach(function (row) {
            row.addEventListener('click', function () {
                var code = row.getAttribute('data-radar-code');
                if (code && window.AppWatchlist && typeof window.AppWatchlist.showStockFundFlow === 'function') {
                    window.AppWatchlist.showStockFundFlow(code);
                }
            });
        });
    }

    function renderOpportunityRadarItem(item) {
        var pct = formatSignedPercent(item.pct);
        var pctCls = trendClass(item.pct);
        var scoreCls = scoreClass(item.score);
        var risk = item.risk || {};
        var riskStatus = risk.status || 'watch';
        var components = item.components || {};
        var tags = [item.topic].concat(item.newsHits || []).filter(Boolean)
            .map(function (tag) { return '<span>' + utils.escapeHtml(tag) + '</span>'; }).join('');
        var signals = (Array.isArray(item.signals) ? item.signals : [])
            .map(function (signal) { return utils.escapeHtml(signal.label || '信号'); }).join(' · ');
        var coverageText = '数据覆盖 ' + utils.escapeHtml(item.coverage == null ? '--' : item.coverage + '%');
        if (Array.isArray(item.missingSources) && item.missingSources.length) {
            var missingLabels = { topic: '题材', momentum: '动量', fund: '资金', technical: '技术', news: '新闻' };
            coverageText += ' · 缺 ' + utils.escapeHtml(item.missingSources.map(function (key) { return missingLabels[key] || key; }).join('/'));
        }
        return '<div class="opportunity-radar-item" data-radar-code="' + utils.escapeHtml(item.code || '') + '">' +
            '<div class="opportunity-radar-head">' +
                '<div class="opportunity-radar-stock">' +
                    '<span class="opportunity-radar-name">' + utils.escapeHtml(item.name || item.code || '--') + '</span>' +
                    '<span class="opportunity-radar-code">' + utils.escapeHtml(item.code || '') + '</span>' +
                '</div>' +
                '<div class="opportunity-radar-score ' + scoreCls + '">' +
                    '<strong>' + utils.escapeHtml(item.score == null ? '--' : String(item.score)) + '</strong>' +
                    '<span>综合分</span>' +
                '</div>' +
                '<div class="opportunity-radar-pct ' + pctCls + '">' + utils.escapeHtml(pct) + '</div>' +
                '<div class="opportunity-radar-risk ' + utils.escapeHtml(riskStatus) + '">' + utils.escapeHtml(risk.label || '--') + '</div>' +
            '</div>' +
            '<div class="opportunity-radar-tags">' + (tags || '<span>题材待确认</span>') + '</div>' +
            '<div class="opportunity-radar-components">' +
                renderRadarMetric('题材', components.topic) +
                renderRadarMetric('动量', components.momentum) +
                renderRadarMetric('资金', components.fund) +
                renderRadarMetric('技术', components.technical) +
                renderRadarMetric('新闻', components.news) +
            '</div>' +
            '<div class="opportunity-radar-foot">' +
                '<span>' + utils.escapeHtml(signals || '等待更多信号确认') + '</span>' +
                '<span>近60日上涨日占比 ' + utils.escapeHtml(item.upDayRate60 == null ? '--' : item.upDayRate60 + '%') + '</span>' +
                '<span>' + coverageText + '</span>' +
            '</div>' +
        '</div>';
    }

    function renderRadarMetric(label, value) {
        var cls = scoreClass(value);
        return '<div class="opportunity-radar-metric">' +
            '<span>' + utils.escapeHtml(label) + '</span>' +
            '<strong class="' + cls + '">' + utils.escapeHtml(value == null ? '--' : String(value)) + '</strong>' +
        '</div>';
    }

    function renderOpportunityRadarError() {
        var container = document.getElementById('opportunity-radar-list');
        if (container) container.innerHTML = '<div class="opportunity-radar-empty">机会雷达加载失败</div>';
    }

    // ============================================================
    // 市场热度 (同花顺热榜 + 东财人气榜)
    // ============================================================

    function getActiveHotRankSource() {
        try { return window.AppStorage.getItem(KEYS.HOT_RANK_SOURCE_KEY) || 'ths'; } catch (e) { return 'ths'; }
    }
    function hotRankCacheKey(source) {
        return source === 'em' ? KEYS.HOT_RANK_CACHE_EM_KEY : KEYS.HOT_RANK_CACHE_THS_KEY;
    }

    async function loadHotRankData(source, force) {
        source = source || 'ths';
        var todayKey = utils.getShanghaiDateKey();
        var cacheKey = hotRankCacheKey(source);
        var cached = cache.readDailyDataCache(cacheKey);
        if (!force && cached && cached.date === todayKey && cached.data && Array.isArray(cached.data.items)) {
            renderHotRank(cached.data.items, source, false);
            return;
        }
        try {
            var res = await window.AppDataClient.fetch('/hot-rank', { source: source, limit: 30 });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var result = await res.json();
            if (!result.success || !result.data || !Array.isArray(result.data.items)) throw new Error('数据异常');
            cache.writeDailyDataCache(cacheKey, todayKey, { source: source, items: result.data.items });
            renderHotRank(result.data.items, source, true, result.meta || null);
        } catch (e) {
            console.error('市场热度获取失败:', e);
            if (cached && cached.date === todayKey && cached.data && Array.isArray(cached.data.items)) {
                renderHotRank(cached.data.items, source, false);
                return;
            }
            renderHotRankError(source);
            // 关键 fetch 失败 → toast 提示
            if (window.AppAlerts && typeof window.AppAlerts.showStatusToast === 'function') {
                window.AppAlerts.showStatusToast('市场热度接口暂不可用', 'error');
            }
        }
    }

    function renderHotRank(items, source, fresh, meta) {
        var listId = source === 'em' ? 'hot-rank-list-em' : 'hot-rank-list-ths';
        var listEl = document.getElementById(listId);
        var timeEl = document.getElementById('hot-rank-update-time');
        if (!listEl) return;
        if (!items.length) { listEl.innerHTML = '<li class="list-empty">暂无数据</li>'; return; }
        if (timeEl && fresh) {
            timeEl.textContent = dataStatus.label(meta, '更新 ') + utils.formatShanghaiTime(new Date().toISOString());
        } else if (timeEl && !fresh) {
            timeEl.textContent = '缓存数据';
        }
        listEl.innerHTML = items.map(function (it) {
            it = it || {};
            var pctStr = formatSignedPercent(it.pct);
            var pctCls = trendClass(it.pct);
            var rankChg = toFiniteNumber(it.rankChg);
            var chgArrow = rankChg > 0 ? '↑' + rankChg : rankChg < 0 ? '↓' + Math.abs(rankChg) : '-';
            var chgCls = trendClass(rankChg);
            if (source === 'ths') {
                var concepts = (Array.isArray(it.concepts) ? it.concepts : [])
                    .map(function (c) { return '<span class="hot-rank-concept">' + utils.escapeHtml(c) + '</span>'; }).join('');
                var tag = it.tag ? '<span class="hot-rank-tag">' + utils.escapeHtml(it.tag) + '</span>' : '';
                return '<li class="hot-rank-item">' +
                    '<span class="hot-rank-rank">' + utils.escapeHtml(it.rank || '--') + '</span>' +
                    '<span class="hot-rank-stock"><span class="hot-rank-name">' + utils.escapeHtml(it.name || it.code || '--') + '</span><span class="hot-rank-code">' + utils.escapeHtml(it.code || '') + '</span></span>' +
                    '<span class="hot-rank-pct ' + pctCls + '">' + pctStr + '</span>' +
                    '<span class="hot-rank-heat">人气 ' + utils.escapeHtml(it.heat || '--') + '</span>' +
                    '<span class="hot-rank-chg ' + chgCls + '">' + chgArrow + '</span>' +
                    '<span class="hot-rank-concepts">' + concepts + tag + '</span>' +
                '</li>';
            } else {
                var price = toFiniteNumber(it.price);
                var priceStr = price === null ? '--' : price.toFixed(2);
                return '<li class="hot-rank-item">' +
                    '<span class="hot-rank-rank">' + utils.escapeHtml(it.rank || '--') + '</span>' +
                    '<span class="hot-rank-stock"><span class="hot-rank-name">' + utils.escapeHtml(it.name || it.code || '--') + '</span><span class="hot-rank-code">' + utils.escapeHtml(it.code || '') + '</span></span>' +
                    '<span class="hot-rank-price">' + priceStr + '</span>' +
                    '<span class="hot-rank-pct ' + pctCls + '">' + pctStr + '</span>' +
                    '<span class="hot-rank-chg ' + chgCls + '">' + chgArrow + '</span>' +
                '</li>';
            }
        }).join('');
    }

    function renderHotRankError(source) {
        var listId = source === 'em' ? 'hot-rank-list-em' : 'hot-rank-list-ths';
        var listEl = document.getElementById(listId);
        if (listEl) listEl.innerHTML = '<li class="list-empty">市场热度接口暂不可用</li>';
    }

    function initHotRankTabs() {
        var saved = getActiveHotRankSource();
        activateHotRankTab(saved);
        var tabs = document.querySelectorAll('.hot-rank-tab');
        tabs.forEach(function (tab) {
            tab.addEventListener('click', function () {
                var source = tab.getAttribute('data-source');
                activateHotRankTab(source);
                try { window.AppStorage.setItem(KEYS.HOT_RANK_SOURCE_KEY, source); } catch (e) {}
                loadHotRankData(source);
            });
        });
        // 启动时不主动拉,等 dashboard tab 切到或 loadAllData 触发
    }

    function activateHotRankTab(source) {
        var tab = document.querySelector('.hot-rank-tab[data-source="' + source + '"]');
        if (!tab) return;
        var parent = tab.parentElement;
        parent.querySelectorAll('.hot-rank-tab').forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        var cardBody = tab.closest('.card-body');
        if (cardBody) {
            cardBody.querySelectorAll('.hot-rank-panel').forEach(function (p) { p.classList.remove('active'); });
            var panel = cardBody.querySelector('#hot-rank-panel-' + source);
            if (panel) panel.classList.add('active');
        }
    }

    // ============================================================
    // 打板情绪 (涨停 / 炸板 / 跌停 / 昨涨停)
    // ============================================================

    function getActiveLimitUpType() {
        try {
            var t = window.AppStorage.getItem(KEYS.LIMIT_UP_TAB_KEY);
            return KEYS.LIMIT_UP_TYPES.indexOf(t) >= 0 ? t : 'zt';
        } catch (e) { return 'zt'; }
    }
    function setActiveLimitUpType(t) {
        try { window.AppStorage.setItem(KEYS.LIMIT_UP_TAB_KEY, t); } catch (e) {}
    }

    async function loadLimitUpData(force) {
        var list = document.getElementById('limit-up-list');
        var summary = document.getElementById('limit-up-summary');
        if (!list || !summary) return;
        var activeType = getActiveLimitUpType();

        function fmtPct(p) {
            if (typeof p !== 'number' || !p) return '--';
            return (p > 0 ? '+' : '') + p.toFixed(2) + '%';
        }
        function cls(p) { return p > 0 ? 'positive' : p < 0 ? 'negative' : 'neutral'; }

        function renderRow(type, item) {
            var pct = item.pct || 0;
            var pctC = cls(pct);
            var nameCode = '<div class="limit-up-name-cell">' +
                '<span class="limit-up-name">' + utils.escapeHtml(item.name || item.code) + '</span>' +
                '<span class="limit-up-code">' + utils.escapeHtml(item.code) + '</span>' +
                '</div>';
            if (type === 'zt') {
                return '<div class="limit-up-row">' +
                    nameCode +
                    '<span class="limit-up-pct ' + pctC + '">' + utils.escapeHtml(fmtPct(pct)) + '</span>' +
                    '<span class="limit-up-stat">' + utils.escapeHtml(item.ztStat || (item.limitDays + '板')) + '</span>' +
                    '<span class="limit-up-seal">' + utils.escapeHtml(utils.formatYuan(item.sealFund)) + '</span>' +
                    '<span class="limit-up-ind">' + utils.escapeHtml(item.industry || '--') + '</span>' +
                '</div>';
            }
            if (type === 'zb') {
                return '<div class="limit-up-row">' +
                    nameCode +
                    '<span class="limit-up-pct ' + pctC + '">' + utils.escapeHtml(fmtPct(pct)) + '</span>' +
                    '<span class="limit-up-stat">' + utils.escapeHtml(item.ztStat || (item.breakTimes + '次开板')) + '</span>' +
                    '<span class="limit-up-seal">振幅' + (item.amplitude || 0).toFixed(2) + '%</span>' +
                    '<span class="limit-up-ind">' + utils.escapeHtml(item.industry || '--') + '</span>' +
                '</div>';
            }
            if (type === 'dt') {
                return '<div class="limit-up-row">' +
                    nameCode +
                    '<span class="limit-up-pct ' + pctC + '">' + utils.escapeHtml(fmtPct(pct)) + '</span>' +
                    '<span class="limit-up-stat">连续' + (item.dtDays || 0) + '板</span>' +
                    '<span class="limit-up-seal">封单' + utils.escapeHtml(utils.formatYuan(item.sealFund)) + '</span>' +
                    '<span class="limit-up-ind">' + utils.escapeHtml(item.industry || '--') + '</span>' +
                '</div>';
            }
            // yzt
            return '<div class="limit-up-row">' +
                nameCode +
                '<span class="limit-up-pct ' + pctC + '">' + utils.escapeHtml(fmtPct(pct)) + '</span>' +
                '<span class="limit-up-stat">' + utils.escapeHtml(item.ztStat || (item.yLimitDays + '板')) + '</span>' +
                '<span class="limit-up-seal">涨速' + (item.speed || 0).toFixed(2) + '%</span>' +
                '<span class="limit-up-ind">' + utils.escapeHtml(item.industry || '--') + '</span>' +
            '</div>';
        }

        function renderItems(type, data) {
            if (!data || !Array.isArray(data.items) || data.items.length === 0) {
                list.innerHTML = '<div class="limit-up-empty">暂无' + KEYS.LIMIT_UP_TAB_LABELS[type] + '数据 (非交易日或接口暂不可用)</div>';
                return;
            }
            list.innerHTML = data.items.map(function (it) { return renderRow(type, it); }).join('');
        }

        function renderSummary(s) {
            if (!s) { summary.innerHTML = ''; return; }
            // 顶部: 涨停 N | 炸板 N (炸板率 X%) | 跌停 N | 昨涨停晋级率 X% | 最高 N 板 | 连板梯队
            var ladder = s.ladder || {};
            var ladderStr = Object.keys(ladder).sort(function (a, b) { return a - b; })
                .map(function (k) { return k + '板' + ladder[k]; }).join(' / ') || '--';
            summary.innerHTML =
                '<div class="limit-up-stat-card">' +
                    '<div class="limit-up-stat-cell"><span class="limit-up-stat-label">涨停</span><span class="limit-up-stat-val positive">' + s.ztCount + '</span></div>' +
                    '<div class="limit-up-stat-cell"><span class="limit-up-stat-label">炸板</span><span class="limit-up-stat-val">' + s.zbCount + '<span class="limit-up-stat-sub"> ' + s.breakRate + '%</span></span></div>' +
                    '<div class="limit-up-stat-cell"><span class="limit-up-stat-label">跌停</span><span class="limit-up-stat-val negative">' + s.dtCount + '</span></div>' +
                    '<div class="limit-up-stat-cell"><span class="limit-up-stat-label">最高</span><span class="limit-up-stat-val">' + s.maxHeight + '板</span></div>' +
                '</div>' +
                '<div class="limit-up-stat-ladder">连板梯队: ' + utils.escapeHtml(ladderStr) +
                ' · 昨涨停晋级率 ' + s.promoteRate + '%</div>';
        }

        // 1) summary 永远先拉 (顶部卡片) — 日级持久
        var todayKey = utils.getShanghaiDateKey();
        var bypassCache = shouldBypassDailySignalCache(force);
        var sumKey = KEYS.SHORT_CACHE_KEYS.limitUpSummary;
        var sumCached = cache.readDailyDataCache(sumKey);
        if (!bypassCache && sumCached && sumCached.date === todayKey && sumCached.data) {
            renderSummary(sumCached.data);
        } else {
            try {
                var sumRes = await window.AppDataClient.fetch('/limit-up', { type: 'summary' });
                var sumJson = await sumRes.json();
                if (sumJson.success) {
                    cache.writeDailyDataCache(sumKey, todayKey, sumJson.data);
                    renderSummary(sumJson.data);
                } else if (sumCached && sumCached.data) {
                    renderSummary(sumCached.data);
                }
            } catch (e) {
                console.error('打板情绪 summary 获取失败:', e);
                if (sumCached && sumCached.data) renderSummary(sumCached.data);
            }
        }

        // 2) 当前 active type 拉详情 — 日级持久
        var typeCacheKey = ({
            zt:  KEYS.SHORT_CACHE_KEYS.limitUpZt,
            zb:  KEYS.SHORT_CACHE_KEYS.limitUpZb,
            dt:  KEYS.SHORT_CACHE_KEYS.limitUpDt,
            yzt: KEYS.SHORT_CACHE_KEYS.limitUpYzt,
        })[activeType];
        var typeCached = cache.readDailyDataCache(typeCacheKey);
        if (!bypassCache && typeCached && typeCached.date === todayKey && typeCached.data) {
            renderItems(activeType, typeCached.data);
        } else {
            list.innerHTML = '<div class="limit-up-empty">加载中...</div>';
            try {
                var r = await window.AppDataClient.fetch('/limit-up', { type: activeType, limit: 100 });
                var j = await r.json();
                if (j.success) {
                    cache.writeDailyDataCache(typeCacheKey, todayKey, j.data);
                    renderItems(activeType, j.data);
                } else if (typeCached && typeCached.date === todayKey && typeCached.data) {
                    renderItems(activeType, typeCached.data);
                } else {
                    renderItems(activeType, null);
                    // 关键 fetch 失败 → toast 提示
                    if (window.AppAlerts && typeof window.AppAlerts.showStatusToast === 'function') {
                        window.AppAlerts.showStatusToast(
                            '打板情绪' + KEYS.LIMIT_UP_TAB_LABELS[activeType] + '接口暂不可用', 'error');
                    }
                }
            } catch (e) {
                console.error('打板情绪' + activeType + '获取失败:', e);
                if (typeCached && typeCached.date === todayKey && typeCached.data) {
                    renderItems(activeType, typeCached.data);
                } else {
                    renderItems(activeType, null);
                    // 关键 fetch 失败 → toast 提示
                    if (window.AppAlerts && typeof window.AppAlerts.showStatusToast === 'function') {
                        window.AppAlerts.showStatusToast(
                            '打板情绪' + KEYS.LIMIT_UP_TAB_LABELS[activeType] + '接口暂不可用', 'error');
                    }
                }
            }
        }
        activateLimitUpTab(activeType);
    }

    function activateLimitUpTab(type) {
        var tab = document.querySelector('.limit-up-tab[data-type="' + type + '"]');
        if (!tab) return;
        var parent = tab.parentElement;
        parent.querySelectorAll('.limit-up-tab').forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        var body = tab.closest('.card-body');
        if (body) {
            body.querySelectorAll('.limit-up-panel').forEach(function (p) { p.classList.remove('active'); });
            var panel = body.querySelector('#limit-up-panel-' + type);
            if (panel) panel.classList.add('active');
        }
    }

    function initLimitUpTabs() {
        var saved = getActiveLimitUpType();
        activateLimitUpTab(saved);
        var tabs = document.querySelectorAll('.limit-up-tab');
        tabs.forEach(function (tab) {
            tab.addEventListener('click', function () {
                var t = tab.getAttribute('data-type');
                if (!t || KEYS.LIMIT_UP_TYPES.indexOf(t) < 0) return;
                setActiveLimitUpType(t);
                // 切换 tab 时按需加载 (cache 命中直接渲染,否则 fetch)
                loadLimitUpData();
            });
        });
    }

    window.AppSignals = {
        // opportunity radar
        loadOpportunityRadarData: loadOpportunityRadarData,
        renderOpportunityRadar: renderOpportunityRadar,
        renderOpportunityRadarError: renderOpportunityRadarError,
        // market heat
        getActiveHotRankSource: getActiveHotRankSource,
        hotRankCacheKey: hotRankCacheKey,
        loadHotRankData: loadHotRankData,
        renderHotRank: renderHotRank,
        renderHotRankError: renderHotRankError,
        initHotRankTabs: initHotRankTabs,
        activateHotRankTab: activateHotRankTab,
        // limit up
        getActiveLimitUpType: getActiveLimitUpType,
        setActiveLimitUpType: setActiveLimitUpType,
        loadLimitUpData: loadLimitUpData,
        activateLimitUpTab: activateLimitUpTab,
        initLimitUpTabs: initLimitUpTabs,
    };
})();

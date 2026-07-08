// ================================================================
// 自选股 — 行情加载 / 列表渲染 / 迷你图 / 增删股 / 涨跌快照持久化
// 跨模块调用统一走 window.__watch(W)
// ================================================================

(function () {
    var W = window.__watch;
    var state = W.state;
    var utils = W.utils;
    var KEYS = W.KEYS;

    var watchSparkCache = {};
    var watchSparkPending = {};
    var WATCH_SPARK_TTL_MS = 2 * 60 * 1000;

    async function resolveStockInput(input) {
        var value = input.trim();
        if (/^\d{6}$/.test(value)) return { code: value, name: '' };
        var res = await fetch(utils.apiUrl('/stock-search', { q: value }));
        if (!res.ok) throw new Error('搜索失败 ' + res.status);
        var json = await res.json();
        if (!json.success || !json.data || json.data.length === 0) throw new Error('未找到股票');
        return json.data[0];
    }

    async function addStockToWatchlist() {
        var input = document.getElementById('stock-code-input');
        var button = document.getElementById('add-stock-btn');
        var rawValue = input.value.trim();
        if (!rawValue) { W.showWatchStatus('请输入股票代码或名称', 'error'); return; }
        button.disabled = true;
        button.textContent = '查询中';
        try {
            var match = await resolveStockInput(rawValue);
            var code = match.code;
            var list = W.getWatchlist();
            if (list.includes(code)) { W.showWatchStatus('已在当前分组中', 'error'); return; }
            list.push(code);
            W.saveActiveWatchlist(list);
            input.value = '';
            state.watchAlertState[code] = {
                openDate: utils.getShanghaiDateKey(),
                openPrice: null,
                addedPrice: null,
                addedAt: null,
                pendingAdd: true,
                lastTriggerPrice: null,
                lastTriggerTime: null,
            };
            if (window.AppAlerts) window.AppAlerts.saveWatchAlertState();
            W.showWatchStatus((match.name || code) + ' 已添加');
            W.renderWatchlist();
            W.loadSingleWatchQuote(code);
        } catch (e) {
            W.showWatchStatus(e.message || '没有找到匹配股票', 'error');
        } finally {
            button.disabled = false;
            button.textContent = '添加';
        }
    }

    function removeStockFromWatchlist(code) {
        var list = W.getWatchlist().filter(function (c) { return c !== code; });
        W.saveActiveWatchlist(list);
        var stillReferenced = W.getAllWatchCodes().includes(code);
        if (!stillReferenced && state.watchQuoteCache[code]) {
            delete state.watchQuoteCache[code];
            W.persistWatchQuoteCache();
        }
        if (!stillReferenced && watchSparkCache[code]) delete watchSparkCache[code];
        if (!stillReferenced && watchSparkPending[code]) delete watchSparkPending[code];
        if (!stillReferenced && state.watchAlertState[code]) {
            delete state.watchAlertState[code];
            if (window.AppAlerts) window.AppAlerts.saveWatchAlertState();
        }
        if (!stillReferenced && state.watchlistRemarks && state.watchlistRemarks[code]) {
            delete state.watchlistRemarks[code];
            W.saveWatchlistRemarks();
        }
        W.renderWatchlist();
        W.showWatchStatus('已移除');
    }

    function renderWatchlist() {
        var grid = document.getElementById('watchlist-grid');
        var updateTimeEl = document.getElementById('watchlist-update-time');
        var codes = W.getWatchlist();
        var activeTab = W.getActiveWatchTab();
        var showCost = W.isHoldingTab();
        if (codes.length === 0) {
            grid.innerHTML = '<div class="watchlist-empty">“' + utils.escapeHtml(activeTab.name) + '”暂无股票</div>';
            if (updateTimeEl) updateTimeEl.textContent = '';
            return;
        }

        var prevMap = W.getPrevChangePct();
        grid.innerHTML = codes.map(function (code) {
            var data = state.watchQuoteCache[code];
            var rawName = data ? data.name : code + '（待刷新）';
            var prev = Object.prototype.hasOwnProperty.call(prevMap, code) ? prevMap[code] : undefined;
            return renderWatchItem(
                code,
                W.getDisplayStockName(code, rawName),
                data ? data.price : '--',
                data ? data.changePercent : 0,
                data ? data.volume : '--',
                prev,
                showCost,
            );
        }).join('');
        bindWatchRemove();
        grid.classList.toggle('with-cost', showCost);
        document.querySelector('.watchlist-header-row')?.classList.toggle('with-cost', showCost);
        bindWatchItemClick();
        hydrateWatchSparklines(codes);
        grid.querySelectorAll('.watchlist-fund-fill[data-w]').forEach(function (fill) {
            fill.style.width = fill.getAttribute('data-w') + '%';
        });
        if (updateTimeEl) updateTimeEl.textContent = state.watchQuoteUpdateTime || '';
    }

    function persistWatchQuoteCache() {
        try { localStorage.setItem(KEYS.WATCH_QUOTE_CACHE_KEY, JSON.stringify(state.watchQuoteCache)); } catch (e) {}
    }

    function persistWatchQuoteUpdateTime(value) {
        try { localStorage.setItem(KEYS.WATCH_QUOTE_UPDATE_TIME_KEY, value || ''); } catch (e) {}
    }

    async function loadWatchlistData() {
        var updateTimeEl = document.getElementById('watchlist-update-time');
        var codes = W.getAllWatchCodes();
        if (codes.length === 0) {
            renderWatchlist();
            return;
        }
        try {
            var res = await fetch(utils.apiUrl('/stock', { codes: codes.join(',') }));
            if (!res.ok) throw new Error('请求失败 ' + res.status);
            var result = await res.json();
            if (!result.success || !result.data) throw new Error('数据异常');
            Object.keys(result.data).forEach(function (code) {
                var d = result.data[code];
                if (d && d.price !== '0.00') state.watchQuoteCache[code] = d;
            });
            if (result.time) {
                state.watchQuoteUpdateTime = result.time;
                persistWatchQuoteUpdateTime(result.time);
                if (updateTimeEl) updateTimeEl.textContent = result.time;
            }
            persistWatchQuoteCache();
            renderWatchlist();
            W.persistCurrentChangePct();
            if (window.AppAlerts && typeof window.AppAlerts.checkAlerts === 'function') {
                window.AppAlerts.checkAlerts(result.data);
            }
        } catch (e) {
            console.error('自选股失败:', e);
            W.showWatchStatus('自选股行情加载失败', 'error');
            utils.setLastUpdated('加载失败');
            renderWatchlist();
        }
    }

    async function loadSingleWatchQuote(code) {
        var updateTimeEl = document.getElementById('watchlist-update-time');
        try {
            var res = await fetch(utils.apiUrl('/stock', { codes: code }));
            if (!res.ok) throw new Error('请求失败 ' + res.status);
            var result = await res.json();
            if (!result.success || !result.data) throw new Error('数据异常');
            var data = result.data[code];
            if (data && data.price !== '0.00') state.watchQuoteCache[code] = data;
            if (result.time) {
                state.watchQuoteUpdateTime = result.time;
                persistWatchQuoteUpdateTime(result.time);
                if (updateTimeEl) updateTimeEl.textContent = result.time;
            }
            persistWatchQuoteCache();
            renderWatchlist();
            W.persistCurrentChangePct();
            if (window.AppAlerts && typeof window.AppAlerts.checkAlerts === 'function') {
                window.AppAlerts.checkAlerts(result.data);
            }
        } catch (e) {
            console.error('新增股票行情获取失败:', e);
            W.showWatchStatus('已添加,行情稍后自动刷新', 'error');
            utils.setLastUpdated('加载失败');
            renderWatchlist();
        }
    }

    function renderWatchItem(code, name, price, changePercent, volume, prev, showCost) {
        var cls = changePercent > 0 ? 'positive' : changePercent < 0 ? 'negative' : 'neutral';
        var pt = changePercent !== 0
            ? (changePercent > 0 ? '+' + Number(changePercent).toFixed(2) : Number(changePercent).toFixed(2)) + '%'
            : '0.00%';
        var arrow = (window.AppMarket && typeof window.AppMarket.trendArrow === 'function')
            ? window.AppMarket.trendArrow(changePercent, prev)
            : '─';
        var data = state.watchQuoteCache[code];
        var priceValue = data && typeof data.priceValue === 'number' ? data.priceValue : null;
        var costCell = showCost ? renderCostCell(code, priceValue) : '';
        var spark = renderWatchSparklineCell(code, cls);
        return '<div class="watchlist-item clickable" data-code="' + utils.escapeHtml(code) + '" data-pct="' + utils.escapeHtml(changePercent) + '">' +
            '<div class="watchlist-item-main">' +
            '<div class="watchlist-stock-name">' + utils.escapeHtml(name) + '</div>' +
            '<div class="watchlist-stock-code">' + utils.escapeHtml(code) + '</div></div>' +
            spark +
            costCell +
            '<div class="watchlist-stock-price ' + cls + '">' + utils.escapeHtml(price) + '</div>' +
            '<div class="watchlist-stock-change ' + cls + '">' + utils.escapeHtml(pt) + ' <span class="trend-arrow">' + utils.escapeHtml(arrow) + '</span></div>' +
            '<button class="watchlist-remove-btn" data-code="' + utils.escapeHtml(code) + '" aria-label="删除 ' + utils.escapeHtml(code) + '">✕</button></div>';
    }

    function renderWatchSparklineCell(code, cls) {
        var cached = watchSparkCache[code];
        var svg = cached && Array.isArray(cached.points)
            ? renderWatchSparkline(cached.points, cls, cached.preClose)
            : '';
        return '<div class="watchlist-stock-sparkline ' + cls + '" data-watch-spark="' + utils.escapeHtml(code) + '">' + svg + '</div>';
    }

    function hydrateWatchSparklines(codes) {
        W.sanitizeCodes(codes).forEach(function (code) {
            var cached = watchSparkCache[code];
            if (cached && Date.now() - cached.ts < WATCH_SPARK_TTL_MS) {
                updateWatchSparklineDom(code);
                return;
            }
            if (watchSparkPending[code]) return;
            watchSparkPending[code] = true;
            W.loadStockMinuteData(code)
                .then(function (data) {
                    var points = data && Array.isArray(data.points) ? data.points.filter(function (point) {
                        return point && W.readFiniteNumber(point.price) !== null;
                    }) : [];
                    watchSparkCache[code] = { ts: Date.now(), points: points, preClose: W.readFiniteNumber(data && data.preClose) };
                    updateWatchSparklineDom(code);
                })
                .catch(function () {
                    watchSparkCache[code] = { ts: Date.now(), points: [], preClose: null };
                })
                .finally(function () {
                    delete watchSparkPending[code];
                });
        });
    }

    function updateWatchSparklineDom(code) {
        var cell = document.querySelector('.watchlist-stock-sparkline[data-watch-spark="' + code + '"]');
        if (!cell) return;
        var item = cell.closest('.watchlist-item');
        var pct = item ? Number(item.getAttribute('data-pct')) : 0;
        var cls = pct > 0 ? 'positive' : pct < 0 ? 'negative' : 'neutral';
        cell.className = 'watchlist-stock-sparkline ' + cls;
        var cached = watchSparkCache[code] || {};
        cell.innerHTML = renderWatchSparkline(cached.points || [], cls, cached.preClose);
    }

    function renderWatchSparkline(points, cls, preClose) {
        var values = (Array.isArray(points) ? points : []).map(function (point) {
            return W.readFiniteNumber(point.price);
        }).filter(function (value) {
            return value !== null;
        });
        if (values.length < 2) return '';
        var width = 96;
        var height = 34;
        var pad = 1.5;
        var base = W.readFiniteNumber(preClose);
        var scaleValues = values.slice();
        if (base !== null && base > 0) scaleValues.push(base);
        var min = Math.min.apply(Math, scaleValues);
        var max = Math.max.apply(Math, scaleValues);
        if (!Number.isFinite(min) || !Number.isFinite(max)) return '';
        if (min === max) {
            min -= Math.max(0.01, Math.abs(min) * 0.001);
            max += Math.max(0.01, Math.abs(max) * 0.001);
        }
        var yScale = function (value) {
            return pad + (max - value) / (max - min) * (height - pad * 2);
        };
        var d = values.map(function (value, index) {
            var x = pad + index / Math.max(1, values.length - 1) * (width - pad * 2);
            var y = yScale(value);
            return (index === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2);
        }).join(' ');
        var zeroAxis = '';
        if (base !== null && base > 0) {
            var zeroY = yScale(base);
            zeroAxis = '<line class="watchlist-stock-sparkline-zero" x1="' + pad + '" y1="' + zeroY.toFixed(2) + '" x2="' + (width - pad) + '" y2="' + zeroY.toFixed(2) + '"></line>' +
                '<text class="watchlist-stock-sparkline-zero-label" x="' + (width - 1) + '" y="' + Math.max(7, zeroY - 2).toFixed(2) + '">0%</text>';
        }
        return '<svg viewBox="0 0 ' + width + ' ' + height + '" aria-label="当日走势" role="img" focusable="false">' +
            zeroAxis +
            '<path class="watchlist-stock-sparkline-path ' + utils.escapeHtml(cls) + '" d="' + d + '"></path>' +
        '</svg>';
    }

    function renderCostCell(code, priceValue) {
        var entry = state.watchlistCost[code];
        if (!entry || typeof entry.cost !== 'number' || !Number.isFinite(entry.cost)) {
            return '<div class="watchlist-stock-cost">' +
                '<div class="cost-value empty">--</div>' +
                '<div class="cost-pnl">未设成本</div>' +
                '</div>';
        }
        var cost = entry.cost;
        var shares = typeof entry.shares === 'number' && Number.isFinite(entry.shares) ? entry.shares : 0;
        var pnl = null;
        if (priceValue !== null && Number.isFinite(priceValue)) {
            pnl = (priceValue - cost) * shares;
        }
        var pnlCls = pnl === null ? '' : (pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : '');
        var pnlText = pnl === null
            ? '--'
            : (pnl > 0 ? '+' : '') + pnl.toFixed(2);
        return '<div class="watchlist-stock-cost">' +
            '<div class="cost-value">' + cost.toFixed(2) + '</div>' +
            '<div class="cost-pnl ' + pnlCls + '">' + pnlText + '</div>' +
            '</div>';
    }

    function saveWatchlistCost() {
        try { localStorage.setItem(KEYS.WATCHLIST_COST_KEY, JSON.stringify(state.watchlistCost)); } catch (e) {}
    }

    function saveWatchlistRemarks() {
        try { localStorage.setItem(KEYS.WATCHLIST_REMARKS_KEY, JSON.stringify(state.watchlistRemarks || {})); } catch (e) {}
    }

    function bindWatchRemove() {
        document.querySelectorAll('.watchlist-remove-btn').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                removeStockFromWatchlist(this.getAttribute('data-code'));
            });
        });
    }

    function bindWatchItemClick() {
        var grid = document.getElementById('watchlist-grid');
        if (!grid || grid.dataset.clickBound === 'true') return;
        grid.dataset.clickBound = 'true';
        grid.addEventListener('click', function (e) {
            if (e.target.closest('.watchlist-remove-btn')) return;
            var item = e.target.closest('.watchlist-item');
            if (!item) return;
            var code = item.getAttribute('data-code');
            if (code) W.showStockFundFlow(code);
        });
    }

    function refreshStaleWatchQuotes() {
        var codes = W.getAllWatchCodes();
        if (codes.length === 0) return;
        var stale = codes.filter(function (c) { return !state.watchQuoteCache[c]; });
        if (stale.length === 0) return;
        var lastPull = 0;
        try { lastPull = parseInt(localStorage.getItem(KEYS.WATCH_REFRESH_THROTTLE_KEY) || '0', 10) || 0; } catch (e) {}
        if (Date.now() - lastPull < KEYS.WATCH_REFRESH_THROTTLE_MS) return;
        fetch(utils.apiUrl('/stock', { codes: stale.join(',') }))
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (result) {
                if (!result || !result.success || !result.data) return;
                Object.keys(result.data).forEach(function (code) {
                    var d = result.data[code];
                    if (d && d.price !== '0.00') state.watchQuoteCache[code] = d;
                });
                if (result.time) {
                    state.watchQuoteUpdateTime = result.time;
                    persistWatchQuoteUpdateTime(result.time);
                }
                persistWatchQuoteCache();
                renderWatchlist();
                try { localStorage.setItem(KEYS.WATCH_REFRESH_THROTTLE_KEY, String(Date.now())); } catch (e) {}
            })
            .catch(function () { /* 非交易时段拉取失败属正常,静默 */ });
    }

    W.resolveStockInput = resolveStockInput;
    W.addStockToWatchlist = addStockToWatchlist;
    W.removeStockFromWatchlist = removeStockFromWatchlist;
    W.renderWatchlist = renderWatchlist;
    W.persistWatchQuoteCache = persistWatchQuoteCache;
    W.persistWatchQuoteUpdateTime = persistWatchQuoteUpdateTime;
    W.loadWatchlistData = loadWatchlistData;
    W.loadSingleWatchQuote = loadSingleWatchQuote;
    W.renderWatchItem = renderWatchItem;
    W.renderCostCell = renderCostCell;
    W.saveWatchlistCost = saveWatchlistCost;
    W.saveWatchlistRemarks = saveWatchlistRemarks;
    W.bindWatchRemove = bindWatchRemove;
    W.bindWatchItemClick = bindWatchItemClick;
    W.refreshStaleWatchQuotes = refreshStaleWatchQuotes;
})();

// ================================================================
// 自选股 — 自选股多分组 / 行情 / 持仓成本 / 单股资金流弹窗 / 自选指数
// 暴露到 window.AppWatchlist;
// 直接 script 引入,无需 import/require
// 依赖:window.AppState, window.AppUtils, window.AppCache
// 跨模块依赖:window.AppAlerts (toast), window.AppMarket (prev bucket, snapshotIndexPrice)
// ================================================================

(function () {
    var state = window.AppState;
    var utils = window.AppUtils;
    var cache = window.AppCache;
    var KEYS = state.KEYS;

    // ============================================================
    // helpers
    // ============================================================

    function isFixedWatchTab(tabId) {
        return KEYS.FIXED_WATCH_TAB_IDS.indexOf(tabId) !== -1;
    }

    function sanitizeCodes(codes) {
        return Array.isArray(codes)
            ? codes.map(function (item) {
                if (item && typeof item === 'object') return item.code || item.id || '';
                return item;
            }).map(function (code) {
                return String(code || '').trim();
            }).filter(function (code, index, arr) { return /^\d{6}$/.test(code) && arr.indexOf(code) === index; })
            : [];
    }

    function getLegacyWatchlist() {
        try {
            var data = localStorage.getItem(KEYS.STORAGE_KEY);
            var parsed = data ? JSON.parse(data) : [];
            return sanitizeCodes(parsed);
        } catch (e) { return []; }
    }

    function defaultWatchTabs() {
        return [
            { id: 'default', name: '持仓股', codes: getLegacyWatchlist() },
            { id: 'candidate', name: '候选股', codes: [] },
        ];
    }

    function normalizeWatchTabName(name, index) {
        if (!name || name === '自选') return index === 0 ? '持仓股' : '分组' + (index + 1);
        return name;
    }

    function getWatchTabs() {
        try {
            var data = localStorage.getItem(KEYS.WATCH_TABS_KEY);
            var parsed = data ? JSON.parse(data) : null;
            if (!Array.isArray(parsed) || parsed.length === 0) return defaultWatchTabs();

            // 升级:补齐缺失的 fixed tabs,保证 fixed tabs 排在最前
            var fixedBuckets = KEYS.FIXED_WATCH_TAB_IDS.map(function () { return null; });
            var userTabs = [];
            parsed.forEach(function (tab) {
                var idx = KEYS.FIXED_WATCH_TAB_IDS.indexOf(tab.id);
                if (idx !== -1) fixedBuckets[idx] = tab;
                else userTabs.push(tab);
            });
            var needsUpgrade = false;
            KEYS.FIXED_WATCH_TAB_IDS.forEach(function (id, idx) {
                if (!fixedBuckets[idx]) {
                    fixedBuckets[idx] = { id: id, name: KEYS.FIXED_WATCH_TAB_NAMES[id], codes: [] };
                    needsUpgrade = true;
                }
            });
            var merged = fixedBuckets.concat(userTabs);
            if (needsUpgrade) saveWatchTabs(merged);

            return merged.map(function (tab, index) {
                return {
                    id: tab.id || 'tab-' + index,
                    name: normalizeWatchTabName(tab.name, index),
                    codes: sanitizeCodes(tab.codes),
                };
            });
        } catch (e) {
            return defaultWatchTabs();
        }
    }

    function saveWatchTabs(tabs) {
        var cleanTabs = tabs.map(function (tab, index) {
            return {
                id: tab.id || 'tab-' + index,
                name: normalizeWatchTabName(tab.name, index),
                codes: sanitizeCodes(tab.codes),
            };
        });
        try {
            localStorage.setItem(KEYS.WATCH_TABS_KEY, JSON.stringify(cleanTabs));
            localStorage.setItem(KEYS.STORAGE_KEY, JSON.stringify(cleanTabs[0] ? cleanTabs[0].codes : []));
        } catch (e) {
            console.error('保存失败', e);
        }
    }

    function normalizeImportedWatchTabs(rawTabs) {
        if (!Array.isArray(rawTabs) || rawTabs.length === 0) throw new Error('文件中没有自选股分组');
        if (rawTabs.every(function (item) { return /^\d{6}$/.test(String(item || '').trim()); })) {
            return [
                { id: 'default', name: '持仓股', codes: sanitizeCodes(rawTabs) },
                { id: 'candidate', name: '候选股', codes: [] },
            ];
        }
        return rawTabs.map(function (tab, index) {
            tab = tab && typeof tab === 'object' ? tab : {};
            var id = tab.id || (index === 0 ? 'default' : 'tab-import-' + index + '-' + Date.now().toString(36));
            return {
                id: String(id).slice(0, 48),
                name: normalizeWatchTabName(String(tab.name || ''), index).slice(0, 12),
                codes: sanitizeCodes(tab.codes || tab.stocks || tab.items),
            };
        });
    }

    function getCodesFromTabs(tabs) {
        var codeMap = {};
        tabs.forEach(function (tab) {
            sanitizeCodes(tab.codes).forEach(function (code) {
                codeMap[code] = true;
            });
        });
        return codeMap;
    }

    function readNumberFromFields(entry, fields) {
        for (var i = 0; i < fields.length; i++) {
            var value = Number(entry[fields[i]]);
            if (Number.isFinite(value)) return value;
        }
        return NaN;
    }

    function normalizeImportedCostEntry(entry) {
        if (typeof entry === 'number' || typeof entry === 'string') {
            return { cost: Number(entry), shares: 0 };
        }
        if (!entry || typeof entry !== 'object') return null;
        return {
            cost: readNumberFromFields(entry, ['cost', 'costPrice', 'avgCost', 'averageCost', 'buyPrice', 'price']),
            shares: readNumberFromFields(entry, ['shares', 'quantity', 'qty', 'amount', 'count']),
        };
    }

    function normalizeImportedWatchlistCost(rawCost, tabs) {
        var clean = {};
        var codeMap = getCodesFromTabs(tabs);
        if (!rawCost || typeof rawCost !== 'object') return clean;
        var entries = Array.isArray(rawCost)
            ? rawCost.map(function (entry) {
                return {
                    code: entry && typeof entry === 'object' ? String(entry.code || entry.id || '').trim() : '',
                    value: entry,
                };
            })
            : Object.keys(rawCost).map(function (code) {
                return { code: String(code).trim(), value: rawCost[code] };
            });
        entries.forEach(function (item) {
            var code = item.code;
            var normalized = normalizeImportedCostEntry(item.value);
            if (!/^\d{6}$/.test(code) || !codeMap[code] || !normalized) return;
            var cost = normalized.cost;
            var shares = normalized.shares;
            if (!Number.isFinite(cost) || cost <= 0) return;
            clean[code] = {
                cost: cost,
                shares: Number.isFinite(shares) && shares > 0 ? shares : 0,
            };
        });
        return clean;
    }

    function normalizeImportedWatchlistRemarks(rawRemarks, tabs) {
        var clean = {};
        var codeMap = getCodesFromTabs(tabs);
        if (!rawRemarks || typeof rawRemarks !== 'object') return clean;
        var entries = Array.isArray(rawRemarks)
            ? rawRemarks.map(function (entry) {
                return {
                    code: entry && typeof entry === 'object' ? String(entry.code || entry.id || '').trim() : '',
                    value: entry && typeof entry === 'object' ? (entry.remark || entry.alias || entry.name || entry.displayName) : '',
                };
            })
            : Object.keys(rawRemarks).map(function (code) {
                return { code: String(code).trim(), value: rawRemarks[code] };
            });
        entries.forEach(function (item) {
            var code = item.code;
            var value = String(item.value || '').trim().slice(0, 16);
            if (!/^\d{6}$/.test(code) || !codeMap[code] || !value) return;
            clean[code] = value;
        });
        return clean;
    }

    function collectWatchlistCostFromTabs(rawTabs) {
        var costMap = {};
        if (!Array.isArray(rawTabs)) return costMap;
        rawTabs.forEach(function (tab) {
            var items = tab && typeof tab === 'object' ? (tab.codes || tab.stocks || tab.items) : null;
            if (!Array.isArray(items)) return;
            items.forEach(function (item) {
                if (!item || typeof item !== 'object') return;
                var code = String(item.code || item.id || '').trim();
                if (/^\d{6}$/.test(code)) costMap[code] = item;
            });
        });
        return costMap;
    }

    function normalizeImportedCustomIndexCodes(rawCodes) {
        return sanitizeCodes(rawCodes).slice(0, KEYS.CUSTOM_INDEX_MAX);
    }

    function hasOwn(obj, key) {
        return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
    }

    function getRawWatchTabsFromJson(json) {
        if (Array.isArray(json)) return json;
        return json.watchTabs || json.tabs || json.watchlistTabs || json.watchlist || json.groups;
    }

    function getRawCustomIndexCodesFromJson(json) {
        if (hasOwn(json, 'customIndexCodes')) return json.customIndexCodes;
        if (hasOwn(json, 'customIndices')) return json.customIndices;
        if (hasOwn(json, 'customIndex')) return json.customIndex;
        if (hasOwn(json, 'indices')) return json.indices;
        return null;
    }

    function getImportedActiveWatchTabId(rawId, tabs) {
        if (typeof rawId === 'string' && tabs.some(function (tab) { return tab.id === rawId; })) return rawId;
        return tabs[0].id;
    }

    function getExportPayload() {
        var tabs = getWatchTabs();
        var activeWatchTabId = getImportedActiveWatchTabId(state.activeWatchTabId, tabs);
        return {
            version: 3,
            exportedAt: new Date().toISOString(),
            watchTabs: tabs,
            activeWatchTabId: activeWatchTabId,
            watchlistCost: normalizeImportedWatchlistCost(state.watchlistCost, tabs),
            watchlistRemarks: normalizeImportedWatchlistRemarks(state.watchlistRemarks, tabs),
            customIndexCodes: normalizeImportedCustomIndexCodes(state.customIndexCodes),
        };
    }

    function showDataStatus(message, type) {
        if (window.AppAlerts) window.AppAlerts.showStatusToast(message, type);
    }

    function exportWatchlistData() {
        var payload = JSON.stringify(getExportPayload(), null, 2);
        var blob = new Blob([payload], { type: 'application/json;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        var date = new Date().toISOString().slice(0, 10);
        link.href = url;
        link.download = 'fund-tracker-watchlist-' + date + '.json';
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        showDataStatus('已导出自选数据');
    }

    function importWatchlistData(e) {
        var file = e.target.files && e.target.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
            try {
                var json = JSON.parse(String(reader.result || ''));
                var rawTabs = getRawWatchTabsFromJson(json);
                var tabs = normalizeImportedWatchTabs(rawTabs);
                var rawCost = json.watchlistCost || json.holdingCosts || json.costs || json.costMap || json.positions || json.holdings || collectWatchlistCostFromTabs(rawTabs);
                var watchlistCost = normalizeImportedWatchlistCost(rawCost, tabs);
                var rawRemarks = json.watchlistRemarks || json.holdingRemarks || json.remarks || json.aliases || json.aliasMap;
                var watchlistRemarks = normalizeImportedWatchlistRemarks(rawRemarks, tabs);
                var activeWatchTabId = getImportedActiveWatchTabId(json.activeWatchTabId, tabs);
                var rawCustomIndexCodes = getRawCustomIndexCodesFromJson(json);
                var customIndexCodes = rawCustomIndexCodes ? normalizeImportedCustomIndexCodes(rawCustomIndexCodes) : null;
                saveWatchTabs(tabs);
                state.watchlistCost = watchlistCost;
                saveWatchlistCost();
                state.watchlistRemarks = watchlistRemarks;
                saveWatchlistRemarks();
                state.activeWatchTabId = activeWatchTabId;
                localStorage.setItem(KEYS.ACTIVE_WATCH_TAB_KEY, state.activeWatchTabId);
                if (customIndexCodes) {
                    state.customIndexCodes = customIndexCodes;
                    state.customIndexCache = {};
                    state.customIndexUpdateTime = '';
                    saveCustomIndices();
                    persistCustomIndexCache();
                    persistCustomIndexUpdateTime('');
                }
                state.watchQuoteCache = {};
                state.watchQuoteUpdateTime = '';
                state.watchAlertState = {};
                persistWatchQuoteCache();
                persistWatchQuoteUpdateTime('');
                if (window.AppAlerts) window.AppAlerts.saveWatchAlertState();
                renderWatchTabs();
                renderWatchlist();
                renderCustomIndex();
                loadWatchlistData();
                if (customIndexCodes) loadCustomIndexData();
                showDataStatus('已导入 ' + tabs.length + ' 个分组' + (customIndexCodes ? '、' + customIndexCodes.length + ' 个自选指数' : ''));
            } catch (err) {
                showDataStatus(err.message || '导入失败', 'error');
            } finally {
                e.target.value = '';
            }
        };
        reader.onerror = function () {
            showDataStatus('读取文件失败', 'error');
            e.target.value = '';
        };
        reader.readAsText(file);
    }

    // ============================================================
    // 自选股 prev change pct (半小时对比箭头)
    // ============================================================

    function getPrevChangePct() {
        try { return JSON.parse(localStorage.getItem(KEYS.PREV_KEY)) || {}; } catch (e) { return {}; }
    }
    function savePrevChangePct(map) {
        try { localStorage.setItem(KEYS.PREV_KEY, JSON.stringify(map)); } catch (e) {}
    }
    function persistCurrentChangePct() {
        var map = {};
        Object.keys(state.watchQuoteCache).forEach(function (code) {
            var d = state.watchQuoteCache[code];
            if (d && typeof d.changePercent === 'number') map[code] = d.changePercent;
        });
        savePrevChangePct(map);
    }

    // ============================================================
    // 自选股多分组 tab 渲染 + 切换
    // ============================================================

    function getActiveWatchTab() {
        var tabs = getWatchTabs();
        var savedId = localStorage.getItem(KEYS.ACTIVE_WATCH_TAB_KEY);
        var tab = tabs.find(function (item) { return item.id === (state.activeWatchTabId || savedId); }) ||
            tabs.find(function (item) { return item.id === savedId; }) ||
            tabs[0];
        state.activeWatchTabId = tab.id;
        return tab;
    }

    function getWatchlist() {
        return getActiveWatchTab().codes;
    }

    function saveActiveWatchlist(codes) {
        var tabs = getWatchTabs();
        var tab = tabs.find(function (item) { return item.id === state.activeWatchTabId; }) || tabs[0];
        tab.codes = sanitizeCodes(codes);
        saveWatchTabs(tabs);
    }

    function initWatchlistTabs() {
        var savedId = localStorage.getItem(KEYS.ACTIVE_WATCH_TAB_KEY);
        state.activeWatchTabId = savedId || 'default';
        renderWatchTabs();
        initWatchTabScroller();
    }

    function renderWatchTabs() {
        var container = document.getElementById('watchlist-tabs');
        if (!container) return;
        var tabs = getWatchTabs();
        if (!tabs.some(function (tab) { return tab.id === state.activeWatchTabId; })) state.activeWatchTabId = tabs[0].id;
        container.innerHTML = tabs.map(function (tab) {
            var isActive = tab.id === state.activeWatchTabId;
            var removable = !isFixedWatchTab(tab.id);
            return '<button class="watchlist-tab' + (isActive ? ' active' : '') + '" data-watch-tab="' + utils.escapeHtml(tab.id) + '" type="button">' +
                '<span>' + utils.escapeHtml(tab.name) + '</span>' +
                (removable ? '<span class="watchlist-tab-remove" data-remove-watch-tab="' + utils.escapeHtml(tab.id) + '" aria-label="删除分组">×</span>' : '') +
                '</button>';
        }).join('');
        container.querySelectorAll('.watchlist-tab').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                if (container.dataset.suppressClick === 'true') {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                var removeBtn = e.target.closest('.watchlist-tab-remove');
                if (removeBtn) {
                    e.stopPropagation();
                    removeWatchTab(removeBtn.getAttribute('data-remove-watch-tab'));
                    return;
                }
                switchWatchTab(btn.getAttribute('data-watch-tab'));
            });
        });
    }

    function switchWatchTab(tabId) {
        if (!tabId || tabId === state.activeWatchTabId) return;
        state.activeWatchTabId = tabId;
        localStorage.setItem(KEYS.ACTIVE_WATCH_TAB_KEY, tabId);
        renderWatchTabs();
        renderWatchlist();
    }

    function initWatchTabScroller() {
        var container = document.getElementById('watchlist-tabs');
        if (!container || container.dataset.dragBound === 'true') return;
        container.dataset.dragBound = 'true';
        var isDown = false;
        var startX = 0;
        var startScrollLeft = 0;
        var startTabId = '';
        var didDrag = false;

        container.addEventListener('pointerdown', function (e) {
            if (e.target.closest('.watchlist-tab-remove')) return;
            var tab = e.target.closest('.watchlist-tab');
            isDown = true;
            startX = e.clientX;
            startScrollLeft = container.scrollLeft;
            startTabId = tab ? tab.getAttribute('data-watch-tab') : '';
            didDrag = false;
            container.classList.add('dragging');
            container.setPointerCapture(e.pointerId);
        });

        container.addEventListener('pointermove', function (e) {
            if (!isDown) return;
            var delta = e.clientX - startX;
            if (Math.abs(delta) > 6) {
                didDrag = true;
                e.preventDefault();
            }
            container.scrollLeft = startScrollLeft - delta;
        });

        function endDrag(e) {
            if (!isDown) return;
            isDown = false;
            container.classList.remove('dragging');
            try { container.releasePointerCapture(e.pointerId); } catch (err) {}
            if (didDrag) {
                container.dataset.suppressClick = 'true';
                setTimeout(function () { container.dataset.suppressClick = ''; }, 0);
                return;
            }
            switchWatchTab(startTabId);
        }

        container.addEventListener('pointerup', endDrag);
        container.addEventListener('pointercancel', endDrag);
    }

    function addWatchTab() {
        var tabs = getWatchTabs();
        var name = window.prompt('新分组名称', '分组' + (tabs.length + 1));
        if (!name) return;
        var cleanName = name.trim().slice(0, 12);
        if (!cleanName) return;
        var id = 'tab-' + Date.now().toString(36);
        tabs.push({ id: id, name: cleanName, codes: [] });
        state.activeWatchTabId = id;
        localStorage.setItem(KEYS.ACTIVE_WATCH_TAB_KEY, id);
        saveWatchTabs(tabs);
        renderWatchTabs();
        renderWatchlist();
    }

    function removeWatchTab(tabId) {
        if (isFixedWatchTab(tabId)) return;
        var tabs = getWatchTabs();
        var userTabsCount = tabs.filter(function (t) { return !isFixedWatchTab(t.id); }).length;
        if (userTabsCount <= 1) {
            showWatchStatus('至少保留一个自建分组', 'error');
            return;
        }
        var target = tabs.find(function (tab) { return tab.id === tabId; });
        if (!target) return;
        if (!window.confirm('删除分组“' + target.name + '”？分组内股票也会移除。')) return;
        var nextTabs = tabs.filter(function (tab) { return tab.id !== tabId; });
        if (state.activeWatchTabId === tabId) {
            state.activeWatchTabId = nextTabs[0].id;
            localStorage.setItem(KEYS.ACTIVE_WATCH_TAB_KEY, state.activeWatchTabId);
        }
        saveWatchTabs(nextTabs);
        renderWatchTabs();
        renderWatchlist();
        showWatchStatus('分组已删除');
    }

    // ============================================================
    // 加股 / 删股 / 搜索
    // ============================================================

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
        if (!rawValue) { showWatchStatus('请输入股票代码或名称', 'error'); return; }
        button.disabled = true;
        button.textContent = '查询中';
        try {
            var match = await resolveStockInput(rawValue);
            var code = match.code;
            var list = getWatchlist();
            if (list.includes(code)) { showWatchStatus('已在当前分组中', 'error'); return; }
            list.push(code);
            saveActiveWatchlist(list);
            input.value = '';
            // 同步写一条 pending alert state,首次拿到行情后由 checkAlerts 写入 addedPrice
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
            showWatchStatus((match.name || code) + ' 已添加');
            renderWatchlist();
            loadSingleWatchQuote(code);
        } catch (e) {
            showWatchStatus(e.message || '没有找到匹配股票', 'error');
        } finally {
            button.disabled = false;
            button.textContent = '添加';
        }
    }

    function removeStockFromWatchlist(code) {
        var list = getWatchlist().filter(function (c) { return c !== code; });
        saveActiveWatchlist(list);
        if (state.watchQuoteCache[code]) {
            delete state.watchQuoteCache[code];
            persistWatchQuoteCache();
        }
        if (state.watchAlertState[code]) {
            delete state.watchAlertState[code];
            if (window.AppAlerts) window.AppAlerts.saveWatchAlertState();
        }
        if (state.watchlistRemarks && state.watchlistRemarks[code] && !getAllWatchCodes().includes(code)) {
            delete state.watchlistRemarks[code];
            saveWatchlistRemarks();
        }
        renderWatchlist();
        showWatchStatus('已移除');
    }

    function showWatchStatus(msg, type) {
        if (window.AppAlerts) window.AppAlerts.showStatusToast(msg, type);
    }

    function getAllWatchCodes() {
        return sanitizeCodes(getWatchTabs().flatMap(function (tab) { return tab.codes || []; }));
    }

    // 持仓股 tab 的代码:仅第一个分组 (id === 'default')
    function getHoldingCodes() {
        var tabs = getWatchTabs();
        var holding = tabs.find(function (tab) { return tab.id === 'default'; });
        return sanitizeCodes(holding ? (holding.codes || []) : []);
    }

    // 持仓股 tab 是创建时的第一个 tab(id === 'default',name 固定为"持仓股")
    // 只有这个 tab 才显示成本价/盈亏列,避免对"候选股"等纯观察列造成干扰
    function isHoldingTab() {
        return state.activeWatchTabId === 'default';
    }

    // ============================================================
    // 渲染 + 持久化
    // ============================================================

    function renderWatchlist() {
        var grid = document.getElementById('watchlist-grid');
        var updateTimeEl = document.getElementById('watchlist-update-time');
        var codes = getWatchlist();
        var activeTab = getActiveWatchTab();
        var showCost = isHoldingTab();
        if (codes.length === 0) {
            grid.innerHTML = '<div class="watchlist-empty">“' + utils.escapeHtml(activeTab.name) + '”暂无股票</div>';
            if (updateTimeEl) updateTimeEl.textContent = '';
            return;
        }

        var prevMap = getPrevChangePct();
        grid.innerHTML = codes.map(function (code) {
            var data = state.watchQuoteCache[code];
            var rawName = data ? data.name : code + '（待刷新）';
            var prev = Object.prototype.hasOwnProperty.call(prevMap, code) ? prevMap[code] : undefined;
            return renderWatchItem(
                code,
                getDisplayStockName(code, rawName),
                data ? data.price : '--',
                data ? data.changePercent : 0,
                data ? data.volume : '--',
                prev,
                showCost,
            );
        }).join('');
        bindWatchRemove();
        // 切换列数:持仓股 5 列(带成本),其他 4 列
        grid.classList.toggle('with-cost', showCost);
        document.querySelector('.watchlist-header-row')?.classList.toggle('with-cost', showCost);
        bindWatchItemClick();
        // 持仓股 sub-row 的资金流 bar 宽度注入
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

    // ============================================================
    // loadWatchlistData / loadSingleWatchQuote
    // ============================================================

    async function loadWatchlistData() {
        var updateTimeEl = document.getElementById('watchlist-update-time');
        var codes = getAllWatchCodes();
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
            persistCurrentChangePct();
            if (window.AppAlerts && typeof window.AppAlerts.checkAlerts === 'function') {
                window.AppAlerts.checkAlerts(result.data);
            }
        } catch (e) {
            console.error('自选股失败:', e);
            showWatchStatus('自选股行情加载失败', 'error');
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
            persistCurrentChangePct();
            if (window.AppAlerts && typeof window.AppAlerts.checkAlerts === 'function') {
                window.AppAlerts.checkAlerts(result.data);
            }
        } catch (e) {
            console.error('新增股票行情获取失败:', e);
            showWatchStatus('已添加,行情稍后自动刷新', 'error');
            utils.setLastUpdated('加载失败');
            renderWatchlist();
        }
    }

    // ============================================================
    // 单元渲染
    // ============================================================

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
        return '<div class="watchlist-item clickable" data-code="' + utils.escapeHtml(code) + '" data-pct="' + utils.escapeHtml(changePercent) + '">' +
            '<div class="watchlist-item-main">' +
            '<div class="watchlist-stock-name">' + utils.escapeHtml(name) + '</div>' +
            '<div class="watchlist-stock-code">' + utils.escapeHtml(code) + '</div></div>' +
            costCell +
            '<div class="watchlist-stock-price ' + cls + '">' + utils.escapeHtml(price) + '</div>' +
            '<div class="watchlist-stock-change ' + cls + '">' + utils.escapeHtml(pt) + ' <span class="trend-arrow">' + utils.escapeHtml(arrow) + '</span></div>' +
            '<button class="watchlist-remove-btn" data-code="' + utils.escapeHtml(code) + '" aria-label="删除 ' + utils.escapeHtml(code) + '">✕</button></div>';
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

    function getDisplayStockName(code, fallbackName) {
        var remark = state.watchlistRemarks && state.watchlistRemarks[code];
        var cleanRemark = String(remark || '').trim();
        return cleanRemark || fallbackName || code;
    }

    function saveWatchlistRemarks() {
        try { localStorage.setItem(KEYS.WATCHLIST_REMARKS_KEY, JSON.stringify(state.watchlistRemarks || {})); } catch (e) {}
    }

    // ============================================================
    // 删除 / 点击绑定
    // ============================================================

    function bindWatchRemove() {
        document.querySelectorAll('.watchlist-remove-btn').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                removeStockFromWatchlist(this.getAttribute('data-code'));
            });
        });
    }

    // 点击持仓股某行 → 弹窗显示分时 + 今日 4 档资金流 (主力/大单/中单/小单)
    // 每次展开都重新 fetch 最新数据,不走本地 cache
    function bindWatchItemClick() {
        var grid = document.getElementById('watchlist-grid');
        if (!grid || grid.dataset.clickBound === 'true') return;
        grid.dataset.clickBound = 'true';
        grid.addEventListener('click', function (e) {
            if (e.target.closest('.watchlist-remove-btn')) return;
            var item = e.target.closest('.watchlist-item');
            if (!item) return;
            var code = item.getAttribute('data-code');
            if (code) showStockFundFlow(code);
        });
    }

    // ============================================================
    // 单股分时 / 资金流弹窗
    // ============================================================

    async function loadStockMinuteData(code) {
        var res = await fetch(utils.apiUrl('/stock-minute', { code: code, count: 240 }));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var json = await res.json();
        if (!json.success || !json.data || !Array.isArray(json.data.points)) throw new Error('分时数据异常');
        return json.data;
    }

    async function loadStockFundFlowData(code) {
        var res = await fetch(utils.apiUrl('/fund-flow-120d', { codes: code, days: 60 }));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var json = await res.json();
        if (!json.success || !json.data || !Array.isArray(json.data.items) || !json.data.items.length) {
            throw new Error('资金流数据异常');
        }
        var item = json.data.items[0];
        var recent = item.recent || [];
        var last = recent.length ? recent[recent.length - 1] : null;
        var prev = recent.length > 1 ? recent[recent.length - 2] : null;
        return {
            item: item,
            today: item.summary && item.summary.today,
            last: last,
            prevMain: prev ? prev.mainNet : null,
            lastDate: last ? last.date : (item.latestDate || ''),
        };
    }

    async function showStockFundFlow(code) {
        var panel = document.getElementById('stock-fund-panel');
        var overlay = document.getElementById('stock-fund-overlay');
        var body = document.getElementById('stock-fund-body');
        var title = document.getElementById('stock-fund-title');
        var timeEl = document.getElementById('stock-fund-time');
        if (!panel || !overlay || !body || !title) return;
        if (overlay.hidden) overlay.hidden = false;
        if (panel.hidden) panel.hidden = false;
        var cachedQuote = state.watchQuoteCache[code];
        title.textContent = getDisplayStockName(code, cachedQuote && cachedQuote.name) + ' (' + code + ')';
        body.innerHTML = '<div class="list-empty">加载中...</div>';
        if (timeEl) timeEl.textContent = '';

        var results = await Promise.allSettled([
            loadStockMinuteData(code),
            loadStockFundFlowData(code),
        ]);
        var minuteData = results[0].status === 'fulfilled' ? results[0].value : null;
        var minuteError = results[0].status === 'rejected' ? results[0].reason : null;
        var fundData = results[1].status === 'fulfilled' ? results[1].value : null;
        var fundError = results[1].status === 'rejected' ? results[1].reason : null;

        if (fundData && fundData.item) {
            title.textContent = getDisplayStockName(code, fundData.item.name || code) + ' (' + code + ')';
        } else if (minuteData && minuteData.name) {
            title.textContent = getDisplayStockName(code, minuteData.name || code) + ' (' + code + ')';
        }
        if (timeEl) timeEl.textContent = getStockModalTimeText(minuteData, fundData);
        body.innerHTML = renderStockModalBody(code, minuteData, minuteError, fundData, fundError);
        body.querySelectorAll('.watchlist-fund-fill[data-w]').forEach(function (fill) {
            fill.style.width = fill.getAttribute('data-w') + '%';
        });
    }

    function getStockModalTimeText(minuteData, fundData) {
        var parts = [];
        if (minuteData && (minuteData.tradeDate || minuteData.latestTime)) {
            parts.push('分时 ' + [minuteData.tradeDate, minuteData.latestTime].filter(Boolean).join(' '));
        }
        if (fundData && fundData.lastDate) parts.push('资金流 ' + fundData.lastDate);
        return parts.join(' · ');
    }

    function renderStockModalBody(code, minuteData, minuteError, fundData, fundError) {
        var html = renderStockCostEditor(code);
        html += renderStockMinuteSection(minuteData, minuteError);
        if (fundData && fundData.item) {
            html += renderStockFundFlowBody(fundData.item, fundData.today, fundData.last, fundData.prevMain, { includeEditor: false });
        } else {
            html += '<div class="stock-fund-summary">' +
                '<div class="stock-fund-section-title">资金流</div>' +
                '<div class="list-empty">资金流加载失败: ' + utils.escapeHtml(fundError && fundError.message ? fundError.message : '数据异常') + '</div>' +
            '</div>';
        }
        return html;
    }

    function renderStockCostEditor(code) {
        if (!getHoldingCodes().includes(code)) return '';
        var entry = state.watchlistCost[code] || {};
        var costVal = typeof entry.cost === 'number' && Number.isFinite(entry.cost) ? entry.cost : '';
        var sharesVal = typeof entry.shares === 'number' && Number.isFinite(entry.shares) ? entry.shares : '';
        var remarkVal = state.watchlistRemarks && state.watchlistRemarks[code] ? state.watchlistRemarks[code] : '';
        return '<form class="stock-cost-editor" data-stock-cost-form data-code="' + utils.escapeHtml(code) + '">' +
            '<div class="stock-fund-section-title">持仓设置</div>' +
            '<label class="stock-cost-field stock-remark-field">' +
                '<span>备注名</span>' +
                '<input type="text" maxlength="16" data-remark-input placeholder="为空显示原始股票名" value="' + utils.escapeHtml(String(remarkVal)) + '">' +
            '</label>' +
            '<div class="stock-cost-editor-row">' +
                '<label class="stock-cost-field">' +
                    '<span>成本价</span>' +
                    '<input type="number" step="0.01" min="0" data-cost-input placeholder="0.00" value="' + utils.escapeHtml(String(costVal)) + '">' +
                '</label>' +
                '<label class="stock-cost-field">' +
                    '<span>股数</span>' +
                    '<input type="number" step="1" min="0" data-shares-input placeholder="0" value="' + utils.escapeHtml(String(sharesVal)) + '">' +
                '</label>' +
            '</div>' +
            '<div class="stock-cost-actions">' +
                '<button type="submit" class="stock-cost-save-btn">保存设置</button>' +
            '</div>' +
        '</form>';
    }

    function saveStockCostFromForm(form) {
        if (!form) return;
        var code = form.getAttribute('data-code');
        var costInput = form.querySelector('[data-cost-input]');
        var sharesInput = form.querySelector('[data-shares-input]');
        var remarkInput = form.querySelector('[data-remark-input]');
        var cost = parseFloat(costInput ? costInput.value : '');
        var shares = parseFloat(sharesInput ? sharesInput.value : '');
        var remark = String(remarkInput ? remarkInput.value : '').trim().slice(0, 16);
        if (Number.isFinite(cost) && cost > 0) {
            state.watchlistCost[code] = {
                cost: cost,
                shares: Number.isFinite(shares) && shares > 0 ? shares : 0,
            };
        } else {
            delete state.watchlistCost[code];
        }
        if (!state.watchlistRemarks || typeof state.watchlistRemarks !== 'object') state.watchlistRemarks = {};
        if (remark) state.watchlistRemarks[code] = remark;
        else delete state.watchlistRemarks[code];
        saveWatchlistCost();
        saveWatchlistRemarks();
        renderWatchlist();
        showWatchStatus('持仓设置已保存');
    }

    function readFiniteNumber(value) {
        if (value === null || value === undefined || value === '') return null;
        var number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function formatPriceValue(value) {
        var number = readFiniteNumber(value);
        return number === null ? '--' : number.toFixed(2);
    }

    function formatPercentValue(value) {
        var number = readFiniteNumber(value);
        if (number === null) return '--';
        return (number > 0 ? '+' : '') + number.toFixed(2) + '%';
    }

    function pointChangePercent(point, preClose) {
        if (point && point.changePercent !== null && point.changePercent !== undefined && point.changePercent !== ''
            && Number.isFinite(Number(point.changePercent))) return Number(point.changePercent);
        var price = point ? readFiniteNumber(point.price) : null;
        var base = readFiniteNumber(preClose);
        if (price === null || base === null || base <= 0) return null;
        return (price - base) / base * 100;
    }

    function renderStockMinuteSection(data, error) {
        if (error) {
            return '<div class="stock-minute-card">' +
                '<div class="stock-minute-top">' +
                    '<div class="stock-fund-section-title">分时</div>' +
                '</div>' +
                '<div class="list-empty">分时加载失败: ' + utils.escapeHtml(error.message || '数据异常') + '</div>' +
            '</div>';
        }
        var points = data && Array.isArray(data.points) ? data.points.filter(function (point) {
            return point && readFiniteNumber(point.price) !== null && point.time;
        }) : [];
        if (!points.length) {
            return '<div class="stock-minute-card">' +
                '<div class="stock-minute-top">' +
                    '<div class="stock-fund-section-title">分时</div>' +
                '</div>' +
                '<div class="list-empty">暂无分时数据</div>' +
            '</div>';
        }
        var latest = points[points.length - 1];
        var first = points[0];
        var middle = points[Math.floor((points.length - 1) / 2)] || first;
        var stats = getMinuteChartStats(points, data.preClose);
        var pct = pointChangePercent(latest, data.preClose);
        var cls = pct > 0 ? 'positive' : pct < 0 ? 'negative' : 'neutral';
        var sourceLabel = data.source === 'tdxrs'
            ? '来源 tdxrs'
            : (data.fallbackReason ? '来源 东方财富备用' : '来源 ' + (data.sourceLabel || '东方财富'));
        var extremesHtml = stats.high && stats.low
            ? '<div class="stock-minute-extremes">' +
                '<span>高 ' + utils.escapeHtml(stats.high.time) + ' ' + utils.escapeHtml(formatPercentValue(stats.high.pct)) + '</span>' +
                '<span>低 ' + utils.escapeHtml(stats.low.time) + ' ' + utils.escapeHtml(formatPercentValue(stats.low.pct)) + '</span>' +
            '</div>'
            : '';
        return '<div class="stock-minute-card ' + cls + '">' +
            '<div class="stock-minute-top">' +
                '<div class="stock-fund-section-title">分时</div>' +
                '<div class="stock-minute-source">' + utils.escapeHtml(sourceLabel) + '</div>' +
            '</div>' +
            '<div class="stock-minute-summary">' +
                '<div class="stock-minute-price ' + cls + '">' + utils.escapeHtml(formatPriceValue(latest.price)) + '</div>' +
                '<div class="stock-minute-pct ' + cls + '">' + utils.escapeHtml(formatPercentValue(pct)) + '</div>' +
                '<div class="stock-minute-meta">均价 ' + utils.escapeHtml(formatPriceValue(latest.avgPrice)) + ' · ' + utils.escapeHtml(latest.time) + '</div>' +
            '</div>' +
            '<div class="stock-minute-chart">' + renderStockMinuteChart(points, data.preClose, stats) + '</div>' +
            '<div class="stock-minute-axis">' +
                '<span>' + utils.escapeHtml(first.time) + '</span>' +
                '<span>' + utils.escapeHtml(middle.time) + '</span>' +
                '<span>' + utils.escapeHtml(latest.time) + '</span>' +
            '</div>' +
            extremesHtml +
        '</div>';
    }

    function getMinuteChartStats(points, preClose) {
        var base = readFiniteNumber(preClose);
        var chartPoints = points.map(function (point) {
            var price = readFiniteNumber(point.price);
            var avgPrice = readFiniteNumber(point.avgPrice);
            return {
                time: point.time,
                price: price,
                avgPrice: avgPrice,
                pct: pointChangePercent(point, base),
                avgPct: base !== null && base > 0 && avgPrice !== null ? (avgPrice - base) / base * 100 : null,
            };
        }).filter(function (point) { return point.price !== null && point.time; });
        var pctValues = [];
        var high = null;
        var low = null;
        chartPoints.forEach(function (point) {
            if (point.pct !== null && Number.isFinite(point.pct)) {
                pctValues.push(point.pct);
                if (!high || point.pct > high.pct) high = point;
                if (!low || point.pct < low.pct) low = point;
            }
            if (point.avgPct !== null && Number.isFinite(point.avgPct)) pctValues.push(point.avgPct);
        });
        var maxAbsPct = pctValues.length
            ? Math.max.apply(Math, pctValues.map(function (value) { return Math.abs(value); }))
            : null;
        if (maxAbsPct !== null && Number.isFinite(maxAbsPct)) {
            maxAbsPct = Math.max(0.5, Math.ceil(maxAbsPct * 10) / 10);
        }
        return {
            base: base,
            points: chartPoints,
            high: high,
            low: low,
            maxAbsPct: maxAbsPct,
        };
    }

    function renderStockMinuteChart(points, preClose, stats) {
        var width = 360;
        var height = 128;
        var padX = 8;
        var padY = 10;
        var padRight = 50;
        var valid = stats && Array.isArray(stats.points) ? stats.points : getMinuteChartStats(points, preClose).points;
        var values = [];
        valid.forEach(function (point) {
            values.push(point.price);
            if (point.avgPrice !== null) values.push(point.avgPrice);
        });
        var base = stats && stats.base !== null && stats.base !== undefined ? stats.base : readFiniteNumber(preClose);
        if (base !== null && base > 0) values.push(base);
        var min = Math.min.apply(Math, values);
        var max = Math.max.apply(Math, values);
        if (!Number.isFinite(min) || !Number.isFinite(max)) return '';
        if (min === max) {
            min -= Math.max(0.01, min * 0.002);
            max += Math.max(0.01, max * 0.002);
        }
        var yScale = function (value) {
            return padY + (max - value) / (max - min) * (height - padY * 2);
        };
        var maxAbsPct = stats && typeof stats.maxAbsPct === 'number' ? stats.maxAbsPct : null;
        if (base !== null && base > 0 && maxAbsPct !== null) {
            yScale = function (value) {
                var pct = (value - base) / base * 100;
                return padY + (maxAbsPct - pct) / (maxAbsPct * 2) * (height - padY * 2);
            };
        }
        function clamp(value, minValue, maxValue) {
            return Math.max(minValue, Math.min(maxValue, value));
        }
        var xScale = function (index) {
            return padX + (valid.length <= 1 ? 0 : index / (valid.length - 1) * (width - padX - padRight));
        };
        var pricePath = valid.map(function (point, index) {
            return (index === 0 ? 'M' : 'L') + xScale(index).toFixed(2) + ' ' + yScale(point.price).toFixed(2);
        }).join(' ');
        var avgPath = valid.map(function (point, index) {
            var value = point.avgPrice === null ? point.price : point.avgPrice;
            return (index === 0 ? 'M' : 'L') + xScale(index).toFixed(2) + ' ' + yScale(value).toFixed(2);
        }).join(' ');
        var baselineY = base !== null && base > 0 ? yScale(base) : (height / 2);
        var scaleLabels = base !== null && base > 0 && maxAbsPct !== null
            ? '<text class="stock-minute-scale-label positive" x="' + (width - 4) + '" y="' + (padY + 3) + '">' + utils.escapeHtml(formatPercentValue(maxAbsPct)) + '</text>' +
                '<text class="stock-minute-scale-label zero" x="' + (width - 4) + '" y="' + (baselineY + 3).toFixed(2) + '">0.00%</text>' +
                '<text class="stock-minute-scale-label negative" x="' + (width - 4) + '" y="' + (height - padY + 3) + '">' + utils.escapeHtml(formatPercentValue(-maxAbsPct)) + '</text>'
            : '';
        var baseline = base !== null && base > 0
            ? '<line class="stock-minute-baseline" x1="' + padX + '" y1="' + baselineY.toFixed(2) + '" x2="' + (width - padRight) + '" y2="' + baselineY.toFixed(2) + '"></line>'
            : '';
        var hitPoints = valid.map(function (point, index) {
            var pctText = formatPercentValue(point.pct);
            return '<circle class="stock-minute-hit-point" cx="' + xScale(index).toFixed(2) + '" cy="' + yScale(point.price).toFixed(2) + '" r="5">' +
                '<title>' + utils.escapeHtml(point.time + ' 价格 ' + formatPriceValue(point.price) + ' 涨幅 ' + pctText) + '</title>' +
            '</circle>';
        }).join('');
        var latest = valid[valid.length - 1];
        var latestX = xScale(valid.length - 1);
        var latestY = yScale(latest.price);
        var latestLabelX = latestX > width * 0.68 ? latestX - 6 : latestX + 6;
        var latestAnchor = latestX > width * 0.68 ? 'end' : 'start';
        var latestLabelY = clamp(latestY - 8, padY + 8, height - padY - 4);
        var latestLabel = '<circle class="stock-minute-current-dot" cx="' + latestX.toFixed(2) + '" cy="' + latestY.toFixed(2) + '" r="2.8"></circle>' +
            '<text class="stock-minute-current-label" x="' + latestLabelX.toFixed(2) + '" y="' + latestLabelY.toFixed(2) + '" text-anchor="' + latestAnchor + '">' +
                utils.escapeHtml(latest.time + ' ' + formatPercentValue(latest.pct)) +
            '</text>';
        return '<svg class="stock-minute-svg" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="分时价格走势">' +
            '<line class="stock-minute-grid-line" x1="' + padX + '" y1="' + padY + '" x2="' + (width - padRight) + '" y2="' + padY + '"></line>' +
            '<line class="stock-minute-grid-line" x1="' + padX + '" y1="' + (height - padY) + '" x2="' + (width - padRight) + '" y2="' + (height - padY) + '"></line>' +
            baseline +
            scaleLabels +
            '<path class="stock-minute-avg-line" d="' + avgPath + '"></path>' +
            '<path class="stock-minute-price-line" d="' + pricePath + '"></path>' +
            latestLabel +
            hitPoints +
        '</svg>';
    }

    function renderStockFundFlowBody(item, today, last, prevMain, options) {
        var includeEditor = !(options && options.includeEditor === false);
        if (!today || !last) return (includeEditor ? renderStockCostEditor(item.code) : '') + '<div class="list-empty">暂无当日资金流数据</div>';

        // 注: 不显示涨跌幅 — 弹窗用的是 daykline 接口最近交易日的 pct,与列表实时报价对不上

        function cls(v) {
            return v > 0 ? 'positive' : v < 0 ? 'negative' : 'neutral';
        }

        function flowCls(v) {
            return v > 0 ? 'flow-positive' : v < 0 ? 'flow-negative' : 'flow-neutral';
        }

        function trendHtml(recent) {
            var bars = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇'];
            return (recent || []).map(function (r) {
                var abs = Math.abs(r.mainNet || 0);
                var level = 0;
                if (abs > 5e8) level = 7;
                else if (abs > 2e8) level = 6;
                else if (abs > 1e8) level = 5;
                else if (abs > 5e7) level = 4;
                else if (abs > 1e7) level = 3;
                else if (abs > 1e6) level = 2;
                else if (abs > 0) level = 1;
                return '<span class="' + flowCls(r.mainNet) + '" title="' +
                    utils.escapeHtml(r.date) + ' ' + utils.formatYuan(r.mainNet) + '">' + bars[level] + '</span>';
            }).join('');
        }

        var items = [
            { key: 'main',   label: '主力' },
            { key: 'large',  label: '大单' },
            { key: 'medium', label: '中单' },
            { key: 'small',  label: '小单' },
        ];
        var max = 1;
        items.forEach(function (it) {
            var a = Math.abs(today[it.key] || 0);
            if (a > max) max = a;
        });
        var mainNet = today.main || 0;
        var prevMainText = prevMain === null || prevMain === undefined
            ? ''
            : ' (昨 ' + utils.formatYuan(prevMain) + ')';
        var summary = item.summary || {};
        var rows = items.map(function (it) {
            var v = today[it.key] || 0;
            var w = (Math.abs(v) / max * 100).toFixed(1);
            var valueClass = cls(v);
            return '<div class="watchlist-fund-row">' +
                '<span class="watchlist-fund-label">' + it.label + '</span>' +
                '<span class="watchlist-fund-track"><span class="watchlist-fund-fill ' + valueClass + '" data-w="' + w + '"></span></span>' +
                '<span class="watchlist-fund-value ' + valueClass + '">' + utils.escapeHtml(utils.formatYuan(v)) + '</span>' +
            '</div>';
        }).join('');
        var summaryRows = [
            { label: '5日', value: summary.main_5d || 0 },
            { label: '20日', value: summary.main_20d || 0 },
            { label: '60日', value: summary.main_60d || 0 },
        ].map(function (row) {
            var valueClass = cls(row.value);
            return '<div class="stock-fund-summary-item">' +
                '<span class="stock-fund-summary-label">' + row.label + '</span>' +
                '<span class="stock-fund-summary-value ' + valueClass + '">' +
                    utils.escapeHtml(utils.formatYuan(row.value)) +
                '</span>' +
            '</div>';
        }).join('');
        var recentTrend = trendHtml(item.recent || []);

        return (includeEditor ? renderStockCostEditor(item.code) : '') +
            '<div class="stock-fund-header">' +
            '<div class="stock-fund-main">主力合计 ' + utils.escapeHtml(utils.formatYuan(mainNet)) + utils.escapeHtml(prevMainText) + '</div>' +
            '</div>' +
            '<div class="watchlist-fund-flow">' + rows + '</div>' +
            '<div class="stock-fund-summary">' +
                '<div class="stock-fund-section-title">主力净流入</div>' +
                '<div class="stock-fund-summary-grid">' + summaryRows + '</div>' +
                '<div class="stock-fund-trend-row">' +
                    '<span class="stock-fund-trend-label">近10日趋势</span>' +
                    '<span class="stock-fund-trend">' + recentTrend + '</span>' +
                '</div>' +
            '</div>';
    }

    function closeStockFundFlow() {
        var panel = document.getElementById('stock-fund-panel');
        var overlay = document.getElementById('stock-fund-overlay');
        if (panel) panel.hidden = true;
        if (overlay) overlay.hidden = true;
    }

    function initStockFundFlowModal() {
        var closeBtn = document.getElementById('stock-fund-close');
        var overlay = document.getElementById('stock-fund-overlay');
        if (closeBtn) closeBtn.addEventListener('click', closeStockFundFlow);
        if (overlay) overlay.addEventListener('click', closeStockFundFlow);
        var panel = document.getElementById('stock-fund-panel');
        if (panel) {
            panel.addEventListener('submit', function (e) {
                var form = e.target.closest('[data-stock-cost-form]');
                if (!form) return;
                e.preventDefault();
                saveStockCostFromForm(form);
            });
        }
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                var panel = document.getElementById('stock-fund-panel');
                if (panel && !panel.hidden) closeStockFundFlow();
            }
        });
    }

    // ============================================================
    // 自选指数(板块/ETF,最多 4 个)
    // ============================================================

    function saveCustomIndices() {
        try { localStorage.setItem(KEYS.CUSTOM_INDICES_KEY, JSON.stringify(state.customIndexCodes)); } catch (e) {}
    }
    function persistCustomIndexCache() {
        try { localStorage.setItem(KEYS.CUSTOM_INDEX_QUOTE_CACHE_KEY, JSON.stringify(state.customIndexCache)); } catch (e) {}
    }
    function persistCustomIndexUpdateTime(value) {
        try { localStorage.setItem(KEYS.CUSTOM_INDEX_UPDATE_TIME_KEY, value || ''); } catch (e) {}
    }

    function renderCustomIndex() {
        var grid = document.getElementById('custom-index-grid');
        var updateTimeEl = document.getElementById('custom-index-update-time');
        if (!grid) return;

        var items = state.customIndexCodes.map(function (code) {
            var d = state.customIndexCache[code];
            var name = d && d.name ? d.name : code + '（待刷新）';
            var price = d && d.price != null ? d.price : '--';
            var pct = d && typeof d.changePercent === 'number' ? d.changePercent : 0;
            var change = d && typeof d.change === 'number' ? d.change : null;
            return renderCustomIndexItem(code, name, price, pct, change);
        });

        // 满 4 个不显示加号;未满追加 1 个加号格子
        if (state.customIndexCodes.length < KEYS.CUSTOM_INDEX_MAX) {
            items.push(
                '<button type="button" class="custom-index-add" data-custom-index-add="1">' +
                '<span class="add-icon">+</span>' +
                '<span class="add-hint">添加指数</span>' +
                '</button>'
            );
        }

        grid.innerHTML = items.join('');
        bindCustomIndexRemove();
        bindCustomIndexAdd();
        if (updateTimeEl) updateTimeEl.textContent = state.customIndexUpdateTime || '';
    }

    function renderCustomIndexItem(code, name, price, changePercent, change) {
        var cls = changePercent > 0 ? 'positive' : changePercent < 0 ? 'negative' : 'neutral';
        var changeStr = '--';
        if (typeof change === 'number' && Number.isFinite(change)) {
            changeStr = (change > 0 ? '+' : '') + change.toFixed(2);
        }
        var pctStr = (typeof changePercent === 'number' && Number.isFinite(changePercent) && changePercent !== 0)
            ? (changePercent > 0 ? '+' : '') + changePercent.toFixed(2) + '%'
            : '0.00%';
        // 半小时对比箭头:跟大盘指数一致,挂在价格后面,从 custom bucket 取 prev 价格
        var cached = state.customIndexCache[code];
        var priceValue = cached && typeof cached.priceValue === 'number' ? cached.priceValue : null;
        var marketMod = window.AppMarket;
        var prevBucket = (marketMod && typeof marketMod.readIndexPrevBucket === 'function')
            ? marketMod.readIndexPrevBucket('custom').data
            : {};
        var prev = prevBucket[code];
        var arrow = (marketMod && typeof marketMod.trendArrow === 'function')
            ? marketMod.trendArrow(priceValue, typeof prev === 'number' ? prev : null)
            : '─';
        var arrowHtml = arrow ? ' <span class="trend-arrow">' + utils.escapeHtml(arrow) + '</span>' : '';
        return '<div class="index-item custom-index-data" data-code="' + utils.escapeHtml(code) + '">' +
            '<div class="index-name">' + utils.escapeHtml(name) + '</div>' +
            '<div class="index-value ' + cls + '">' + utils.escapeHtml(price) + arrowHtml + '</div>' +
            '<div class="index-change ' + cls + '">' + utils.escapeHtml(changeStr) + ' / ' + utils.escapeHtml(pctStr) + '</div>' +
            '<button type="button" class="custom-index-remove" data-remove-custom-index="' + utils.escapeHtml(code) + '" aria-label="删除 ' + utils.escapeHtml(code) + '">✕</button>' +
            '</div>';
    }

    function bindCustomIndexRemove() {
        document.querySelectorAll('[data-remove-custom-index]').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                var code = this.getAttribute('data-remove-custom-index');
                removeCustomIndex(code);
            });
        });
    }

    function bindCustomIndexAdd() {
        document.querySelectorAll('[data-custom-index-add]').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                openCustomIndexAddForm();
            });
        });
    }

    // 用 prompt 快速加;避免在卡片里塞输入框布局
    function openCustomIndexAddForm() {
        var raw = window.prompt('输入指数 / ETF / 板块代码(6 位数字)或名称', '');
        if (raw == null) return;
        var value = String(raw).trim();
        if (!value) return;
        addCustomIndexByInput(value);
    }

    async function addCustomIndexByInput(rawValue) {
        showCustomIndexStatus('查询中…');
        try {
            var match = await resolveStockInput(rawValue);
            var code = match.code;
            if (state.customIndexCodes.includes(code)) {
                showCustomIndexStatus('已在自选指数中', 'error');
                return;
            }
            if (state.customIndexCodes.length >= KEYS.CUSTOM_INDEX_MAX) {
                showCustomIndexStatus('自选指数最多 ' + KEYS.CUSTOM_INDEX_MAX + ' 个,请先删除', 'error');
                return;
            }
            state.customIndexCodes.push(code);
            saveCustomIndices();
            renderCustomIndex();
            showCustomIndexStatus((match.name || code) + ' 已添加');
            loadSingleCustomIndex(code);
        } catch (e) {
            showCustomIndexStatus(e.message || '未找到匹配指数', 'error');
        }
    }

    function removeCustomIndex(code) {
        state.customIndexCodes = state.customIndexCodes.filter(function (c) { return c !== code; });
        delete state.customIndexCache[code];
        if (window.AppMarket && typeof window.AppMarket.clearIndexPrevForCode === 'function') {
            window.AppMarket.clearIndexPrevForCode('custom', code);
        }
        saveCustomIndices();
        persistCustomIndexCache();
        renderCustomIndex();
        showCustomIndexStatus('已删除');
    }

    function showCustomIndexStatus(msg, type) {
        if (window.AppAlerts) window.AppAlerts.showStatusToast(msg, type);
    }

    async function loadCustomIndexData() {
        if (state.customIndexCodes.length === 0) {
            renderCustomIndex();
            return;
        }
        try {
            var res = await fetch(utils.apiUrl('/stock', { codes: state.customIndexCodes.join(',') }));
            if (!res.ok) throw new Error('请求失败 ' + res.status);
            var result = await res.json();
            if (!result.success || !result.data) throw new Error('数据异常');
            Object.keys(result.data).forEach(function (code) {
                var d = result.data[code];
                if (d && d.price !== '0.00') state.customIndexCache[code] = d;
            });
            if (result.time) {
                state.customIndexUpdateTime = result.time;
                persistCustomIndexUpdateTime(result.time);
            }
            persistCustomIndexCache();
            // 节流落盘 prev
            if (window.AppMarket && typeof window.AppMarket.persistIndexPrevIfDue === 'function'
                && typeof window.AppMarket.snapshotIndexPrice === 'function') {
                window.AppMarket.persistIndexPrevIfDue('custom', window.AppMarket.snapshotIndexPrice(result.data));
            }
            renderCustomIndex();
        } catch (e) {
            // 非交易时段拉取失败属正常,渲染缓存即可
            renderCustomIndex();
        }
    }

    async function loadSingleCustomIndex(code) {
        try {
            var res = await fetch(utils.apiUrl('/stock', { codes: code }));
            if (!res.ok) return;
            var result = await res.json();
            if (!result.success || !result.data) return;
            var d = result.data[code];
            if (d && d.price !== '0.00') state.customIndexCache[code] = d;
            if (result.time) {
                state.customIndexUpdateTime = result.time;
                persistCustomIndexUpdateTime(result.time);
            }
            persistCustomIndexCache();
            // 新增指数首屏拉一次时,直接给这个 code 写入 prev(等于自身,首渲染箭头为 '─')
            if (d && typeof d.priceValue === 'number'
                && window.AppMarket && typeof window.AppMarket.setIndexPrevForCode === 'function') {
                window.AppMarket.setIndexPrevForCode('custom', code, d.priceValue);
            }
            renderCustomIndex();
        } catch (e) { /* ignore */ }
    }

    // ============================================================
    // 非交易时段:补拉 stale 缓存
    // ============================================================

    function refreshStaleWatchQuotes() {
        var codes = getAllWatchCodes();
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

    // 自选指数版:复用同一个 5 分钟节流键
    function refreshStaleCustomIndex() {
        if (state.customIndexCodes.length === 0) return;
        var stale = state.customIndexCodes.filter(function (c) { return !state.customIndexCache[c]; });
        if (stale.length === 0) return;

        var lastPull = 0;
        try { lastPull = parseInt(localStorage.getItem(KEYS.WATCH_REFRESH_THROTTLE_KEY) || '0', 10) || 0; } catch (e) {}
        if (Date.now() - lastPull < KEYS.WATCH_REFRESH_THROTTLE_MS) return;

        fetch(utils.apiUrl('/stock', { codes: state.customIndexCodes.join(',') }))
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (result) {
                if (!result || !result.success || !result.data) return;
                Object.keys(result.data).forEach(function (code) {
                    var d = result.data[code];
                    if (d && d.price !== '0.00') state.customIndexCache[code] = d;
                });
                if (result.time) {
                    state.customIndexUpdateTime = result.time;
                    persistCustomIndexUpdateTime(result.time);
                }
                persistCustomIndexCache();
                renderCustomIndex();
            })
            .catch(function () { /* ignore */ });
    }

    window.AppWatchlist = {
        // tabs
        isFixedWatchTab: isFixedWatchTab,
        getWatchTabs: getWatchTabs,
        saveWatchTabs: saveWatchTabs,
        getActiveWatchTab: getActiveWatchTab,
        getWatchlist: getWatchlist,
        saveActiveWatchlist: saveActiveWatchlist,
        initWatchlistTabs: initWatchlistTabs,
        renderWatchTabs: renderWatchTabs,
        switchWatchTab: switchWatchTab,
        initWatchTabScroller: initWatchTabScroller,
        addWatchTab: addWatchTab,
        removeWatchTab: removeWatchTab,
        // import / export
        exportWatchlistData: exportWatchlistData,
        importWatchlistData: importWatchlistData,
        // add/remove
        resolveStockInput: resolveStockInput,
        addStockToWatchlist: addStockToWatchlist,
        removeStockFromWatchlist: removeStockFromWatchlist,
        getAllWatchCodes: getAllWatchCodes,
        getHoldingCodes: getHoldingCodes,
        isHoldingTab: isHoldingTab,
        // load + render
        loadWatchlistData: loadWatchlistData,
        loadSingleWatchQuote: loadSingleWatchQuote,
        renderWatchlist: renderWatchlist,
        renderWatchItem: renderWatchItem,
        renderCostCell: renderCostCell,
        saveWatchlistCost: saveWatchlistCost,
        getDisplayStockName: getDisplayStockName,
        saveWatchlistRemarks: saveWatchlistRemarks,
        persistWatchQuoteCache: persistWatchQuoteCache,
        persistWatchQuoteUpdateTime: persistWatchQuoteUpdateTime,
        persistCurrentChangePct: persistCurrentChangePct,
        getPrevChangePct: getPrevChangePct,
        bindWatchRemove: bindWatchRemove,
        bindWatchItemClick: bindWatchItemClick,
        // modal
        showStockFundFlow: showStockFundFlow,
        renderStockCostEditor: renderStockCostEditor,
        saveStockCostFromForm: saveStockCostFromForm,
        renderStockFundFlowBody: renderStockFundFlowBody,
        closeStockFundFlow: closeStockFundFlow,
        initStockFundFlowModal: initStockFundFlowModal,
        // custom index
        renderCustomIndex: renderCustomIndex,
        renderCustomIndexItem: renderCustomIndexItem,
        bindCustomIndexRemove: bindCustomIndexRemove,
        bindCustomIndexAdd: bindCustomIndexAdd,
        openCustomIndexAddForm: openCustomIndexAddForm,
        addCustomIndexByInput: addCustomIndexByInput,
        removeCustomIndex: removeCustomIndex,
        loadCustomIndexData: loadCustomIndexData,
        loadSingleCustomIndex: loadSingleCustomIndex,
        saveCustomIndices: saveCustomIndices,
        persistCustomIndexCache: persistCustomIndexCache,
        persistCustomIndexUpdateTime: persistCustomIndexUpdateTime,
        // non-trading stale refresh
        refreshStaleWatchQuotes: refreshStaleWatchQuotes,
        refreshStaleCustomIndex: refreshStaleCustomIndex,
        // status helpers
        showWatchStatus: showWatchStatus,
        showCustomIndexStatus: showCustomIndexStatus,
        showDataStatus: showDataStatus,
    };
})();

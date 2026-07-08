// ================================================================
// 自选股 — 导入 / 导出 + 各类 normalize
// 跨模块调用统一走 window.__watch(W)
// ================================================================

(function () {
    var W = window.__watch;
    var state = W.state;
    var utils = W.utils;
    var KEYS = W.KEYS;

    function normalizeImportedWatchTabs(rawTabs) {
        if (!Array.isArray(rawTabs) || rawTabs.length === 0) throw new Error('文件中没有自选股分组');
        if (rawTabs.every(function (item) { return /^\d{6}$/.test(String(item || '').trim()); })) {
            return [
                { id: 'default', name: '持仓股', codes: W.sanitizeCodes(rawTabs) },
                { id: 'candidate', name: '候选股', codes: [] },
            ];
        }
        return rawTabs.map(function (tab, index) {
            tab = tab && typeof tab === 'object' ? tab : {};
            var id = tab.id || (index === 0 ? 'default' : 'tab-import-' + index + '-' + Date.now().toString(36));
            return {
                id: String(id).slice(0, 48),
                name: W.normalizeWatchTabName(String(tab.name || ''), index).slice(0, 12),
                codes: W.sanitizeCodes(tab.codes || tab.stocks || tab.items),
            };
        });
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
        var codeMap = W.getCodesFromTabs(tabs);
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
        var codeMap = W.getCodesFromTabs(tabs);
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
        return W.sanitizeCodes(rawCodes).slice(0, KEYS.CUSTOM_INDEX_MAX);
    }

    function getRawWatchTabsFromJson(json) {
        if (Array.isArray(json)) return json;
        return json.watchTabs || json.tabs || json.watchlistTabs || json.watchlist || json.groups;
    }

    function getRawCustomIndexCodesFromJson(json) {
        if (W.hasOwn(json, 'customIndexCodes')) return json.customIndexCodes;
        if (W.hasOwn(json, 'customIndices')) return json.customIndices;
        if (W.hasOwn(json, 'customIndex')) return json.customIndex;
        if (W.hasOwn(json, 'indices')) return json.indices;
        return null;
    }

    function getImportedActiveWatchTabId(rawId, tabs) {
        if (typeof rawId === 'string' && tabs.some(function (tab) { return tab.id === rawId; })) return rawId;
        return tabs[0].id;
    }

    function getExportPayload() {
        var tabs = W.getWatchTabs();
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
        W.showDataStatus('已导出自选数据');
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
                W.saveWatchTabs(tabs);
                state.watchlistCost = watchlistCost;
                W.saveWatchlistCost();
                state.watchlistRemarks = watchlistRemarks;
                W.saveWatchlistRemarks();
                state.activeWatchTabId = activeWatchTabId;
                localStorage.setItem(KEYS.ACTIVE_WATCH_TAB_KEY, state.activeWatchTabId);
                if (customIndexCodes) {
                    state.customIndexCodes = customIndexCodes;
                    state.customIndexCache = {};
                    state.customIndexUpdateTime = '';
                    W.saveCustomIndices();
                    W.persistCustomIndexCache();
                    W.persistCustomIndexUpdateTime('');
                }
                state.watchQuoteCache = {};
                state.watchQuoteUpdateTime = '';
                state.watchAlertState = {};
                W.persistWatchQuoteCache();
                W.persistWatchQuoteUpdateTime('');
                if (window.AppAlerts) window.AppAlerts.saveWatchAlertState();
                W.renderWatchTabs();
                W.renderWatchlist();
                W.renderCustomIndex();
                W.loadWatchlistData();
                if (customIndexCodes) W.loadCustomIndexData();
                W.showDataStatus('已导入 ' + tabs.length + ' 个分组' + (customIndexCodes ? '、' + customIndexCodes.length + ' 个自选指数' : ''));
            } catch (err) {
                W.showDataStatus(err.message || '导入失败', 'error');
            } finally {
                e.target.value = '';
            }
        };
        reader.onerror = function () {
            W.showDataStatus('读取文件失败', 'error');
            e.target.value = '';
        };
        reader.readAsText(file);
    }

    W.normalizeImportedWatchTabs = normalizeImportedWatchTabs;
    W.exportWatchlistData = exportWatchlistData;
    W.importWatchlistData = importWatchlistData;
})();

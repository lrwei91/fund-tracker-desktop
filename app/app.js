// ================================================================
// 市场行情 — App 入口
// 职责:
//   1. DOM init / wiring (tabs / collapsible / sector tabs / settings / data panel)
//   2. 设置 + 事件绑定 (auto refresh / opacity / threshold / 添加按钮)
//   3. 自动刷新 (交易时段窗口触发各模块 load 函数)
//   4. 主入口 (DOMContentLoaded)
// 渲染 / load 逻辑在 modules/render-*.js,工具在 modules/utils.js,
// state 在 modules/state.js,缓存 helpers 在 modules/cache.js
// ================================================================

(function () {
    var state = window.AppState;
    var utils = window.AppUtils;
    var cache = window.AppCache;
    var KEYS = state.KEYS;
    var isBootstrapping = true;

    // ============================================================
    // Settings 持久化
    // ============================================================

    function normalizeOptionValue(value, allowedValues, fallback) {
        var stringValue = String(value);
        return allowedValues.includes(stringValue) ? stringValue : String(fallback);
    }

    function normalizePercentValue(value, fallback) {
        var numberValue = Number(value);
        if (!Number.isFinite(numberValue)) numberValue = Number(fallback);
        if (!Number.isFinite(numberValue)) numberValue = 100;
        return Math.max(0, Math.min(100, Math.round(numberValue)));
    }

    function getSettingsControls() {
        return {
            autoRefresh: document.getElementById('auto-refresh-toggle'),
            mainInterval: document.getElementById('refresh-interval-main'),
            signalInterval: document.getElementById('refresh-interval-signal'),
            newsInterval: document.getElementById('refresh-interval-news'),
            holdingColorMode: document.getElementById('holding-color-mode'),
            holdingOpacity: document.getElementById('holding-opacity-input'),
            holdingOpacityValue: document.getElementById('holding-opacity-value'),
            alertEnabled: document.getElementById('alert-enabled-toggle'),
            alertThreshold: document.getElementById('alert-threshold-input'),
            alertOpacity: document.getElementById('alert-opacity-input'),
            alertOpacityValue: document.getElementById('alert-opacity-value'),
            bullSoundEnabled: document.getElementById('bull-sound-toggle'),
            bearSoundEnabled: document.getElementById('bear-sound-toggle'),
        };
    }

    function readSettings() {
        try {
            return JSON.parse(window.AppStorage.getItem(KEYS.SETTINGS_KEY) || '{}') || {};
        } catch (e) {
            return {};
        }
    }

    function loadSettings() {
        var saved = readSettings();
        state.isAutoRefresh = typeof saved.autoRefresh === 'boolean' ? saved.autoRefresh : state.isAutoRefresh;
        state.refreshSecondsMain = parseInt(normalizeOptionValue(saved.mainInterval, ['10', '30', '60'], state.refreshSecondsMain), 10);
        state.refreshSecondsSignal = parseInt(normalizeOptionValue(saved.signalInterval, ['900', '1800', '3600', '7200'], state.refreshSecondsSignal), 10);
        state.refreshSecondsNews = parseInt(normalizeOptionValue(saved.newsInterval, ['60', '600', '1800'], state.refreshSecondsNews), 10);
        state.holdingColorMode = normalizeOptionValue(saved.holdingColorMode, ['market', 'white'], state.holdingColorMode);
        state.holdingOpacity = normalizePercentValue(saved.holdingOpacity, state.holdingOpacity);
    }

    function saveSettings() {
        try {
            window.AppStorage.setItem(KEYS.SETTINGS_KEY, JSON.stringify({
                autoRefresh: state.isAutoRefresh,
                mainInterval: state.refreshSecondsMain,
                signalInterval: state.refreshSecondsSignal,
                newsInterval: state.refreshSecondsNews,
                holdingColorMode: state.holdingColorMode,
                holdingOpacity: state.holdingOpacity,
            }));
        } catch (e) {}
    }

    function syncSettingsControls() {
        var controls = getSettingsControls();
        if (controls.autoRefresh) controls.autoRefresh.checked = state.isAutoRefresh;
        if (controls.mainInterval) controls.mainInterval.value = String(state.refreshSecondsMain);
        if (controls.signalInterval) controls.signalInterval.value = String(state.refreshSecondsSignal);
        if (controls.newsInterval) controls.newsInterval.value = String(state.refreshSecondsNews);
        if (controls.holdingColorMode) controls.holdingColorMode.value = state.holdingColorMode;
        if (controls.holdingOpacity) controls.holdingOpacity.value = String(state.holdingOpacity);
        if (controls.holdingOpacityValue) controls.holdingOpacityValue.textContent = state.holdingOpacity + '%';
        if (controls.alertEnabled) controls.alertEnabled.checked = state.alertEnabled;
        if (controls.alertThreshold) controls.alertThreshold.value = String(state.alertThreshold);
        if (controls.alertOpacity) controls.alertOpacity.value = String(Math.round(state.alertOpacity * 100));
        if (controls.alertOpacityValue) controls.alertOpacityValue.textContent = Math.round(state.alertOpacity * 100) + '%';
        if (controls.bullSoundEnabled) controls.bullSoundEnabled.checked = state.bullSoundEnabled;
        if (controls.bearSoundEnabled) controls.bearSoundEnabled.checked = state.bearSoundEnabled;
    }

    // ============================================================
    // 主 tab 路由 + 切换
    // ============================================================

    function initTabs() {
        var buttons = document.querySelectorAll('.tab-btn');
        buttons.forEach(function (btn) {
            btn.addEventListener('click', function () {
                switchTab(btn.getAttribute('data-tab'));
            });
        });

        window.addEventListener('hashchange', handleHash);
        handleHash();
    }

    function handleHash() {
        var hash = window.location.hash.replace('#', '');
        var savedTab = window.AppStorage.getItem(KEYS.ACTIVE_TAB_KEY);
        var tab = KEYS.VALID_TABS.includes(hash) ? hash : (KEYS.VALID_TABS.includes(savedTab) ? savedTab : 'dashboard');
        switchTab(tab, false);
    }

    function switchTab(tab, updateHash) {
        if (!KEYS.VALID_TABS.includes(tab)) return;
        state.currentTab = tab;
        try { window.AppStorage.setItem(KEYS.ACTIVE_TAB_KEY, tab); } catch (e) {}

        document.querySelectorAll('.tab-btn').forEach(function (btn) {
            btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
        });

        document.querySelectorAll('.tab-panel').forEach(function (panel) {
            panel.classList.toggle('active', panel.id === 'tab-' + tab);
        });

        document.getElementById('header-title').textContent = KEYS.TAB_TITLES[tab] || '市场行情';

        if (updateHash !== false) {
            window.location.hash = tab === 'dashboard' ? '' : '#' + tab;
        }

        // Load tab-specific data when switching panels.
        if (tab === 'signals') {
            if (!isBootstrapping && window.AppRefreshCoordinator) window.AppRefreshCoordinator.refreshTab(tab);
        }
        if (tab === 'news' && !isBootstrapping && window.AppRefreshCoordinator) {
            window.AppRefreshCoordinator.refreshTab(tab);
        }
    }

    // ============================================================
    // 折叠面板
    // ============================================================

    function initCollapsible() {
        document.querySelectorAll('.card[data-collapsible="true"]').forEach(function (card) {
            var header = card.querySelector('.card-header');
            var body = card.querySelector('.card-body');
            if (!header || !body) return;
            var collState = cache.readJson(KEYS.COLLAPSE_STATE_KEY, {});
            var key = getCollapsibleKey(card);
            var collapsed = typeof collState[key] === 'boolean'
                ? collState[key]
                : card.getAttribute('data-collapsed') === 'true';
            card.setAttribute('data-collapsed', collapsed ? 'true' : 'false');
            body.style.display = collapsed ? 'none' : '';

            header.addEventListener('click', function (event) {
                if (event.target.closest('button, input, select, textarea, a')) return;
                var isCollapsed = card.getAttribute('data-collapsed') === 'true';
                if (isCollapsed) {
                    card.setAttribute('data-collapsed', 'false');
                    body.style.display = '';
                    saveCollapsibleState(card, false);
                } else {
                    card.setAttribute('data-collapsed', 'true');
                    body.style.display = 'none';
                    saveCollapsibleState(card, true);
                }
            });
        });
    }

    function getCollapsibleKey(card) {
        return card.className.split(/\s+/).filter(function (name) {
            return name !== 'card' && name.indexOf('-section') > -1;
        })[0] || card.querySelector('h2').textContent.trim();
    }

    function saveCollapsibleState(card, collapsed) {
        var collState = cache.readJson(KEYS.COLLAPSE_STATE_KEY, {});
        collState[getCollapsibleKey(card)] = collapsed;
        cache.writeJson(KEYS.COLLAPSE_STATE_KEY, collState);
    }

    // ============================================================
    // 板块 tab
    // ============================================================

    function initSectorTabs() {
        if (window.AppMarket && typeof window.AppMarket.initSectorFilters === 'function') {
            window.AppMarket.initSectorFilters();
        }
    }

    function initSignalWorkspace() {
        var tabs = document.querySelectorAll('[data-signal-view]');
        var panels = document.querySelectorAll('[data-signal-panel]');
        if (!tabs.length || !panels.length) return;

        function selectSignalView(view) {
            tabs.forEach(function (tab) {
                var active = tab.getAttribute('data-signal-view') === view;
                tab.classList.toggle('active', active);
                tab.setAttribute('aria-selected', active ? 'true' : 'false');
                tab.tabIndex = active ? 0 : -1;
            });
            panels.forEach(function (panel) {
                var active = panel.getAttribute('data-signal-panel') === view;
                panel.classList.toggle('active', active);
                panel.hidden = !active;
            });
            try { window.AppStorage.setItem('fund_tracker_signal_view', view); } catch (e) {}
        }

        var savedView = 'radar';
        try { savedView = window.AppStorage.getItem('fund_tracker_signal_view') || savedView; } catch (e) {}
        if (!Array.from(tabs).some(function (tab) { return tab.getAttribute('data-signal-view') === savedView; })) {
            savedView = 'radar';
        }
        selectSignalView(savedView);
        tabs.forEach(function (tab) {
            tab.addEventListener('click', function () {
                selectSignalView(tab.getAttribute('data-signal-view'));
            });
        });
    }

    function initSettingsViews() {
        var tabs = document.querySelectorAll('[data-settings-view]');
        var panels = document.querySelectorAll('[data-settings-panel]');
        if (!tabs.length || !panels.length) return;

        tabs.forEach(function (tab) {
            tab.addEventListener('click', function () {
                var view = tab.getAttribute('data-settings-view');
                tabs.forEach(function (item) {
                    var active = item === tab;
                    item.classList.toggle('active', active);
                    item.setAttribute('aria-selected', active ? 'true' : 'false');
                    item.tabIndex = active ? 0 : -1;
                });
                panels.forEach(function (panel) {
                    var active = panel.getAttribute('data-settings-panel') === view;
                    panel.classList.toggle('active', active);
                    panel.hidden = !active;
                });
            });
        });
    }

    // ============================================================
    // 设置面板 + 数据面板
    // ============================================================

    function initSettings() {
        var overlay = document.getElementById('settings-overlay');
        var panel = document.getElementById('settings-panel');
        var openBtn = document.getElementById('settings-btn');
        var closeBtn = document.getElementById('settings-close');

        function openSettings() {
            overlay.classList.add('open');
            panel.classList.add('open');
            openBtn.setAttribute('aria-expanded', 'true');
            closeBtn.focus();
        }

        function closeSettings() {
            overlay.classList.remove('open');
            panel.classList.remove('open');
            openBtn.setAttribute('aria-expanded', 'false');
            openBtn.focus();
        }

        openBtn.setAttribute('aria-expanded', 'false');
        openBtn.addEventListener('click', openSettings);
        closeBtn.addEventListener('click', closeSettings);
        overlay.addEventListener('click', closeSettings);
        panel.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') closeSettings();
        });
    }

    function initDataPanel() {
        var overlay = document.getElementById('data-overlay');
        var panel = document.getElementById('data-panel');
        var openBtn = document.getElementById('watchlist-data-btn');
        var closeBtn = document.getElementById('data-close');
        var exportBtn = document.getElementById('export-watchlist-btn');
        var importBtn = document.getElementById('import-watchlist-btn');
        var fileInput = document.getElementById('import-watchlist-file');

        function openPanel() {
            overlay.classList.add('open');
            panel.classList.add('open');
            openBtn.setAttribute('aria-expanded', 'true');
            closeBtn.focus();
        }

        function closePanel() {
            overlay.classList.remove('open');
            panel.classList.remove('open');
            openBtn.setAttribute('aria-expanded', 'false');
            openBtn.focus();
        }

        openBtn.setAttribute('aria-expanded', 'false');
        openBtn.addEventListener('click', openPanel);
        closeBtn.addEventListener('click', closePanel);
        overlay.addEventListener('click', closePanel);
        exportBtn.addEventListener('click', function () {
            if (window.AppWatchlist) window.AppWatchlist.exportWatchlistData();
        });
        importBtn.addEventListener('click', function () { fileInput.click(); });
        fileInput.addEventListener('change', function (e) {
            if (window.AppWatchlist) window.AppWatchlist.importWatchlistData(e);
        });
        panel.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') closePanel();
        });
    }

    function initHoldingWindowButton() {
        var btn = document.getElementById('holding-window-btn');
        if (!btn || !window.shell || typeof window.shell.openHoldingWindow !== 'function') return;

        btn.hidden = false;
        btn.addEventListener('click', async function () {
            if (btn.disabled) return;
            var oldText = btn.textContent;
            btn.disabled = true;
            btn.textContent = '打开中';
            try {
                var result = await window.shell.openHoldingWindow();
                if (!result || !result.ok) throw new Error(result && result.error ? result.error : 'open failed');
                if (window.AppRefreshCoordinator && typeof window.AppRefreshCoordinator.syncCurrentHoldingWidget === 'function') {
                    await window.AppRefreshCoordinator.syncCurrentHoldingWidget();
                }
            } catch (e) {
                btn.textContent = '失败';
                setTimeout(function () { btn.textContent = oldText; }, 1200);
            } finally {
                btn.disabled = false;
                if (btn.textContent !== oldText && btn.textContent !== '失败') btn.textContent = oldText;
            }
        });
    }

    // ============================================================
    // 事件绑定 (settings 控件 + add 按钮 + 编辑按钮 + 刷新按钮)
    // ============================================================

    function bindEvents() {
        document.getElementById('auto-refresh-toggle').addEventListener('change', function (e) {
            state.isAutoRefresh = e.target.checked;
            saveSettings();
            if (state.isAutoRefresh) { startAllAutoRefresh(); } else { stopAllAutoRefresh(); }
        });

        document.getElementById('refresh-interval-main').addEventListener('change', function (e) {
            state.refreshSecondsMain = parseInt(e.target.value, 10);
            saveSettings();
            if (state.isAutoRefresh) { startMainAutoRefresh(); }
        });

        document.getElementById('refresh-interval-signal').addEventListener('change', function (e) {
            state.refreshSecondsSignal = parseInt(e.target.value, 10);
            saveSettings();
            if (state.isAutoRefresh) { startSignalAutoRefresh(); }
        });

        document.getElementById('refresh-interval-news').addEventListener('change', function (e) {
            state.refreshSecondsNews = parseInt(e.target.value, 10);
            saveSettings();
            if (state.isAutoRefresh) { startNewsAutoRefresh(); }
        });

        var holdingColorModeSelect = document.getElementById('holding-color-mode');
        if (holdingColorModeSelect) {
            holdingColorModeSelect.addEventListener('change', function (e) {
                state.holdingColorMode = normalizeOptionValue(e.target.value, ['market', 'white'], 'market');
                e.target.value = state.holdingColorMode;
                saveSettings();
            });
        }

        var holdingOpacityInput = document.getElementById('holding-opacity-input');
        var holdingOpacityValue = document.getElementById('holding-opacity-value');
        if (holdingOpacityInput) {
            var commitHoldingOpacity = function (e) {
                state.holdingOpacity = normalizePercentValue(e.target.value, 100);
                e.target.value = String(state.holdingOpacity);
                if (holdingOpacityValue) holdingOpacityValue.textContent = state.holdingOpacity + '%';
                saveSettings();
            };
            holdingOpacityInput.addEventListener('input', commitHoldingOpacity);
            holdingOpacityInput.addEventListener('change', commitHoldingOpacity);
        }

        document.getElementById('alert-enabled-toggle').addEventListener('change', function (e) {
            state.alertEnabled = !!e.target.checked;
            if (window.AppAlerts) window.AppAlerts.saveAlertSettings();
        });

        var alertOpacityInput = document.getElementById('alert-opacity-input');
        var alertOpacityValue = document.getElementById('alert-opacity-value');
        if (alertOpacityInput) {
            var commitAlertOpacity = function (e) {
                state.alertOpacity = Math.max(0.2, Math.min(1, Number(e.target.value) / 100));
                if (alertOpacityValue) alertOpacityValue.textContent = Math.round(state.alertOpacity * 100) + '%';
                if (window.AppAlerts) window.AppAlerts.saveAlertSettings();
            };
            alertOpacityInput.addEventListener('input', commitAlertOpacity);
            alertOpacityInput.addEventListener('change', commitAlertOpacity);
        }

        var bindAlertSoundToggle = function (id, stateKey) {
            var control = document.getElementById(id);
            if (!control) return;
            control.addEventListener('change', function (e) {
                state[stateKey] = !!e.target.checked;
                if (window.AppAlerts) window.AppAlerts.saveAlertSettings();
            });
        };
        bindAlertSoundToggle('bull-sound-toggle', 'bullSoundEnabled');
        bindAlertSoundToggle('bear-sound-toggle', 'bearSoundEnabled');

        var bindAlertPreview = function (id, direction) {
            var button = document.getElementById(id);
            if (!button) return;
            button.addEventListener('click', function () {
                if (window.AppAlerts && typeof window.AppAlerts.previewAlert === 'function') {
                    window.AppAlerts.previewAlert(direction);
                }
            });
        };
        bindAlertPreview('preview-bull-alert', 'rising');
        bindAlertPreview('preview-bear-alert', 'falling');

        var thresholdInput = document.getElementById('alert-threshold-input');
        if (thresholdInput) {
            var commitThreshold = function () {
                var v = parseFloat(thresholdInput.value);
                if (!isFinite(v) || v <= 0) v = 2;
                if (v > 50) v = 50;
                state.alertThreshold = v;
                thresholdInput.value = String(v);
                if (window.AppAlerts) window.AppAlerts.saveAlertSettings();
            };
            thresholdInput.addEventListener('change', commitThreshold);
            thresholdInput.addEventListener('blur', commitThreshold);
        }

        document.getElementById('add-stock-btn').addEventListener('click', function () {
            if (window.AppWatchlist) window.AppWatchlist.addStockToWatchlist();
        });
        document.getElementById('add-watch-tab-btn').addEventListener('click', function () {
            if (window.AppWatchlist) window.AppWatchlist.addWatchTab();
        });
        document.getElementById('stock-code-input').addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && window.AppWatchlist) window.AppWatchlist.addStockToWatchlist();
        });
        document.getElementById('refresh-btn').addEventListener('click', function () {
            manualRefreshAll();
        });

    }

    // ============================================================
    // 自动刷新
    // ============================================================

    function initAutoRefresh() {
        if (state.isAutoRefresh) startAllAutoRefresh();
    }

    function startAllAutoRefresh() {
        if (window.AppRefreshCoordinator) window.AppRefreshCoordinator.start();
    }

    function stopAllAutoRefresh() {
        if (window.AppRefreshCoordinator) window.AppRefreshCoordinator.stop();
    }

    function startMainAutoRefresh() {
        if (window.AppRefreshCoordinator) window.AppRefreshCoordinator.reschedule();
    }

    function startSignalAutoRefresh() {
        if (window.AppRefreshCoordinator) window.AppRefreshCoordinator.reschedule();
    }

    function startNewsAutoRefresh() {
        if (window.AppRefreshCoordinator) window.AppRefreshCoordinator.reschedule();
    }

    // ============================================================
    // 加载入口:按市场阶段分支
    // ============================================================

    // 只恢复用户界面结构和信息类缓存；实时行情必须等待 Rust gateway 返回新数据。
    function renderRealtimeFromCache() {
        var anyRendered = false;

        // 自选股名称可以从本地恢复，但价格和涨跌必须等本次 live 请求成功后才显示。
        if (window.AppWatchlist) {
            var codes = window.AppWatchlist.getAllWatchCodes();
            if (codes.length > 0) {
                state.watchQuoteFreshCodes = {};
                window.AppWatchlist.renderWatchlist();
                anyRendered = true;
            }
            if (state.customIndexCodes.length > 0) {
                state.customIndexFreshCodes = {};
                anyRendered = true;
            }
            window.AppWatchlist.renderCustomIndex();
        }

        if (!anyRendered) {
            utils.setLastUpdated('非交易时段 · 暂无缓存');
        }
    }

    // 手动刷新:无视交易时段,重新拉一遍所有数据
    function manualRefreshAll(label, options) {
        options = Object.assign({}, options || {}, { force: true });
        if (utils && typeof utils.setLastUpdated === 'function') utils.setLastUpdated(label || '手动刷新');
        return window.AppRefreshCoordinator
            ? window.AppRefreshCoordinator.refreshAll(options)
            : Promise.resolve();
    }

    // ============================================================
    // DOMContentLoaded — 启动入口
    // ============================================================

    function bootstrapApp() {
        loadSettings();
        initTabs();
        initCollapsible();
        initSectorTabs();
        initSignalWorkspace();
        initSettingsViews();
        if (window.AppSignals) window.AppSignals.initHotRankTabs();
        if (window.AppWatchlist) window.AppWatchlist.initWatchlistTabs();
        if (window.AppNews) {
            window.AppNews.initNewsSourceTabs();
            window.AppNews.initNewsScroll();
        }
        initSettings();
        syncSettingsControls();
        initDataPanel();
        initHoldingWindowButton();
        bindEvents();
        if (window.AppWatchlist) window.AppWatchlist.initStockFundFlowModal();
        if (window.AppSignals) window.AppSignals.initLimitUpTabs();
        initAutoRefresh();
        if (window.AppWatchlist) window.AppWatchlist.renderCustomIndex();
        // 页面初始化:先渲染本地缓存,再复用手动刷新入口请求一次最新数据。
        renderRealtimeFromCache();
        manualRefreshAll('启动刷新');
        state.hasInitialDataLoaded = true;
        isBootstrapping = false;
    }

    document.addEventListener('DOMContentLoaded', function () {
        var hydrate = window.AppStorage && typeof window.AppStorage.hydrate === 'function'
            ? window.AppStorage.hydrate()
            : Promise.resolve();
        hydrate.then(function () {
            if (window.AppState && typeof window.AppState.restorePersistentState === 'function') {
                window.AppState.restorePersistentState();
            }
            bootstrapApp();
        });
    });
})();

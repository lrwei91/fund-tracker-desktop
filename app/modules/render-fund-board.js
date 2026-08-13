// 基金筛选：按板块展示基金池，并提供组合筛选、排序与实时行情。
(function () {
    var VIEW_KEY = 'fund_tracker_fund_workspace_view';
    var funds = [];
    var etfInfo = {};
    var sectorTrends = {};
    var fundRealtime = {};
    var activeFilters = new Set();
    var searchTerm = '';
    var sortMode = 'desc';
    var loaded = false;
    var sourceDegraded = false;
    var realtimeStale = false;
    var loadError = null;
    var inflight = null;
    var utils = window.AppUtils;
    var uiState = window.AppUiState;

    function escapeHtml(value) {
        return utils && typeof utils.escapeHtml === 'function'
            ? utils.escapeHtml(value)
            : String(value == null ? '' : value)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function parseValue(value) {
        var number = parseFloat(String(value == null ? '' : value).replace(/[^\d.-]/g, ''));
        return Number.isFinite(number) ? number : 0;
    }

    function getStarCount(value) {
        return (String(value || '').match(/★/g) || []).length;
    }

    function prepareSearch(fund) {
        var target = [fund.name, fund.sector].join(' ');
        var pinyin = window.pinyinPro && window.pinyinPro.pinyin;
        var initials = '';
        var full = '';
        if (typeof pinyin === 'function') {
            initials = pinyin(target, { pattern: 'first', toneType: 'none', type: 'string' });
            full = pinyin(target, { toneType: 'none', type: 'string' });
        }
        fund._search = [fund.name, fund.code, fund.sector, initials, full]
            .join(' ').replace(/\s+/g, '').toLowerCase();
        return fund;
    }

    function normalizeFunds(items) {
        return (Array.isArray(items) ? items : []).filter(function (item) {
            return item && /^\d{6}$/.test(String(item.code || '')) && item.sector && item.name;
        }).map(function (item) {
            return prepareSearch({
                sector: String(item.sector),
                name: String(item.name),
                code: String(item.code),
                weekReturn: String(item.weekReturn || ''),
                yearReturn: String(item.yearReturn || ''),
                maxDrawdown: String(item.maxDrawdown || ''),
                scale: String(item.scale || ''),
                institutionHolding: String(item.institutionHolding || ''),
                managerHolding: String(item.managerHolding || ''),
                internalHolding: String(item.internalHolding || ''),
                stars: String(item.stars || ''),
                tags: String(item.tags || ''),
                redemptionFee: String(item.redemptionFee || ''),
            });
        });
    }

    function matchesFund(fund) {
        if (searchTerm && fund._search.indexOf(searchTerm.replace(/\s+/g, '')) === -1) return false;
        var starCount = getStarCount(fund.stars);
        return Array.from(activeFilters).every(function (filter) {
            return filter === '5star' ? starCount >= 5 : fund.tags.indexOf(filter) !== -1;
        });
    }

    function groupVisibleFunds() {
        var groups = new Map();
        funds.forEach(function (fund) {
            if (!matchesFund(fund)) return;
            if (!groups.has(fund.sector)) groups.set(fund.sector, []);
            groups.get(fund.sector).push(fund);
        });
        var entries = Array.from(groups.entries());
        entries.forEach(function (entry) {
            entry[1].sort(function (a, b) { return getStarCount(b.stars) - getStarCount(a.stars); });
        });
        if (sortMode !== 'default') {
            entries.sort(function (a, b) {
                var aValue = Number.isFinite(Number(sectorTrends[a[0]]))
                    ? Number(sectorTrends[a[0]]) : parseValue(a[1][0] && a[1][0].weekReturn);
                var bValue = Number.isFinite(Number(sectorTrends[b[0]]))
                    ? Number(sectorTrends[b[0]]) : parseValue(b[1][0] && b[1][0].weekReturn);
                if (aValue === bValue) return getStarCount(b[1][0].stars) - getStarCount(a[1][0].stars);
                return sortMode === 'desc' ? bValue - aValue : aValue - bValue;
            });
        }
        return entries;
    }

    function sectorTone(sector) {
        if (/黄金|金属|稀土|锂/.test(sector)) return 'amber';
        if (/半导体|电子|芯片/.test(sector)) return 'indigo';
        if (/CPO|AI|智|算力|软件|通信|科技/.test(sector)) return 'blue';
        if (/药|脑/.test(sector)) return 'pink';
        if (/光伏|碳/.test(sector)) return 'green';
        if (/机器人/.test(sector)) return 'purple';
        if (/航天|深海|核聚变/.test(sector)) return 'violet';
        if (/军/.test(sector)) return 'red';
        if (/消费|酒/.test(sector)) return 'orange';
        return 'gray';
    }

    function sectorEmoji(sector) {
        if (/黄金|金属|稀土|锂/.test(sector)) return '🪙';
        if (/半导体|芯片|电子/.test(sector)) return '🔌';
        if (/CPO|通信/.test(sector)) return '📡';
        if (/AI|人工智能/.test(sector)) return '🤖';
        if (/智|算力/.test(sector)) return '🧠';
        if (/软件|科技/.test(sector)) return '💻';
        if (/机器人/.test(sector)) return '🦾';
        if (/药|脑/.test(sector)) return '💊';
        if (/光伏|碳/.test(sector)) return '☀️';
        if (/能|电/.test(sector)) return '⚡';
        if (/航天|深海|核聚变/.test(sector)) return '🚀';
        if (/军/.test(sector)) return '🎖️';
        if (/消费|酒/.test(sector)) return '🛍️';
        if (/恒生|港/.test(sector)) return '🇭🇰';
        if (/农业|农/.test(sector)) return '🌾';
        if (/原油|油|能源/.test(sector)) return '🛢️';
        if (/游戏|传媒|娱/.test(sector)) return '🎮';
        if (/红利|利/.test(sector)) return '💰';
        return '📌';
    }

    function changeText(value) {
        var number = Number(value);
        if (!Number.isFinite(number)) return '--%';
        return (number > 0 ? '+' : '') + number.toFixed(2) + '%';
    }

    function changeClass(value) {
        var number = Number(value);
        return !Number.isFinite(number) ? 'neutral' : number >= 0 ? 'positive' : 'negative';
    }

    function renderStars(value) {
        var count = getStarCount(value);
        return '<span class="fund-board-stars" aria-label="' + count + ' 星">' +
            Array.from({ length: 5 }, function (_, index) {
                return '<span class="' + (index < count ? 'active' : '') + '">★</span>';
            }).join('') + '</span>';
    }

    function renderTags(value) {
        return String(value || '').split('、').filter(Boolean).map(function (tag) {
            var tone = /内部买|强势|涨得多/.test(tag) ? 'hot'
                : /跌|回撤|免/.test(tag) ? 'safe'
                    : /机构|规模/.test(tag) ? 'scale' : 'plain';
            var selected = activeFilters.has(tag) ? ' selected' : '';
            var faded = activeFilters.size && !activeFilters.has(tag) ? ' faded' : '';
            return '<span class="fund-board-tag ' + tone + selected + faded + '">' + escapeHtml(tag) + '</span>';
        }).join('');
    }

    function renderFund(fund) {
        var realtime = fundRealtime[fund.code];
        var fee = fund.redemptionFee
            ? '<span class="fund-board-tag fee">' + escapeHtml(fund.redemptionFee) + '</span>' : '';
        return '<article class="fund-board-fund' + (getStarCount(fund.stars) >= 5 ? ' top-pick' : '') + '">' +
            '<div class="fund-board-fund-title"><strong title="' + escapeHtml(fund.name) + '">' + escapeHtml(fund.name) + '</strong>' + renderStars(fund.stars) + '</div>' +
            '<div class="fund-board-fund-meta"><button type="button" class="fund-board-copy" data-copy-code="' + escapeHtml(fund.code) + '" title="复制基金代码">' + escapeHtml(fund.code) + '</button>' +
            '<div class="fund-board-tags">' + renderTags(fund.tags) + fee + '</div>' +
            '<span class="fund-board-realtime ' + changeClass(realtime) + '">' + (Number.isFinite(Number(realtime)) ? changeText(realtime) : '') + '</span></div>' +
            '</article>';
    }

    function renderSector(entry) {
        var sector = entry[0];
        var sectorFunds = entry[1];
        var etf = etfInfo[sector];
        var trend = sectorTrends[sector];
        var etfHtml = etf && etf.code
            ? '<button type="button" class="fund-board-etf" data-copy-code="' + escapeHtml(String(etf.code).split('.')[0]) + '"><span><b>场内</b>' + escapeHtml(etf.name || '场内ETF') + '</span><em>' + escapeHtml(String(etf.code).split('.')[0]) + '</em></button>'
            : '';
        return '<section class="fund-board-sector">' +
            '<header class="fund-board-sector-header tone-' + sectorTone(sector) + '"><span class="fund-board-sector-name"><i>' + sectorEmoji(sector) + '</i>' + escapeHtml(sector) + '</span>' +
            '<strong class="' + changeClass(trend) + '">' + changeText(trend) + '</strong></header>' +
            '<div class="fund-board-sector-body">' + etfHtml + sectorFunds.map(renderFund).join('') + '</div></section>';
    }

    function columnCount() {
        var container = document.getElementById('fund-board-grid');
        var width = container ? container.clientWidth : window.innerWidth;
        if (width >= 1450) return 6;
        if (width >= 1160) return 4;
        if (width >= 860) return 3;
        if (width >= 560) return 2;
        return 1;
    }

    function updateSummary(sectorCount, fundCount) {
        var element = document.getElementById('fund-board-summary');
        if (element) element.textContent = sectorCount + ' 个板块 · ' + fundCount + ' 只基金';
    }

    function renderBoard() {
        var container = document.getElementById('fund-board-grid');
        if (!container) return;
        if (!funds.length) {
            if (loadError) {
                container.innerHTML = uiState && typeof uiState.render === 'function'
                    ? uiState.render('error', { title: '基金数据加载失败', detail: loadError, retryScope: 'fund-board' })
                    : '<div class="ui-state">基金数据加载失败，请重新加载</div>';
            } else {
                container.innerHTML = uiState && typeof uiState.render === 'function'
                    ? uiState.render('loading', { title: '正在加载基金数据', detail: '基金池和板块数据返回后会在这里更新。' })
                    : '<div class="ui-state">正在加载</div>';
            }
            return;
        }
        var entries = groupVisibleFunds();
        if (!entries.length) {
            container.innerHTML = uiState && typeof uiState.render === 'function'
                ? uiState.render('empty', { title: '没有匹配的基金', detail: '调整搜索词或组合筛选条件后重试。' })
                : '<div class="ui-state">没有匹配的基金</div>';
            updateSummary(0, 0);
            return;
        }
        var columns = Array.from({ length: columnCount() }, function () { return []; });
        entries.forEach(function (entry, index) { columns[index % columns.length].push(renderSector(entry)); });
        container.classList.toggle('is-realtime-stale', realtimeStale);
        container.innerHTML = columns.map(function (items) {
            return '<div class="fund-board-column">' + items.join('') + '</div>';
        }).join('');
        updateSummary(entries.length, entries.reduce(function (sum, entry) { return sum + entry[1].length; }, 0));
    }

    function showStatus(message, kind) {
        var element = document.getElementById('fund-board-status');
        if (!element) return;
        element.textContent = message || '';
        element.className = 'fund-board-status' + (kind ? ' ' + kind : '');
    }

    function loadTrends(force) {
        var sectors = Array.from(new Set(funds.map(function (fund) { return fund.sector; })));
        if (!sectors.length) return Promise.resolve();
        return window.AppDataClient.fetchData('/fund-board-trends', { sectors: sectors.join(',') }, {
            force: !!force,
            cacheMode: force ? 'bypass_fresh' : 'normal',
        }).then(function (result) {
            if (!result || result.success === false || !result.data) throw new Error('板块行情为空');
            sectorTrends = Object.assign({}, sectorTrends, result.data);
            realtimeStale = false;
            renderBoard();
            return result;
        });
    }

    function loadRealtime(force) {
        var codes = Array.from(new Set(funds.map(function (fund) { return fund.code; })));
        if (!codes.length) return Promise.resolve();
        return window.AppDataClient.fetchData('/fund-board-realtime', { codes: codes.join(',') }, {
            force: !!force,
            cacheMode: force ? 'bypass_fresh' : 'normal',
        }).then(function (result) {
            if (!result || result.success === false || !result.data) throw new Error('基金实时估值为空');
            fundRealtime = Object.assign({}, fundRealtime, result.data);
            realtimeStale = false;
            renderBoard();
            return result;
        });
    }

    function loadBoard(force) {
        if (!window.AppDataClient) return Promise.resolve({ skipped: true });
        if (inflight) return inflight;
        loadError = null;
        renderBoard();
        showStatus('正在更新基金池与实时行情', 'loading');
        inflight = window.AppDataClient.fetchData('/fund-board', {}, {
            force: !!force,
            cacheMode: force ? 'bypass_fresh' : 'normal',
        }).then(function (result) {
            if (!result || result.success === false || !result.data) throw new Error('基金数据为空');
            var nextFunds = normalizeFunds(result.data.funds);
            if (!nextFunds.length) throw new Error('基金池为空');
            funds = nextFunds;
            etfInfo = result.data.etfInfo && typeof result.data.etfInfo === 'object' ? result.data.etfInfo : {};
            loaded = true;
            loadError = null;
            sourceDegraded = !!(result.meta && result.meta.degraded);
            renderBoard();
            return Promise.allSettled([loadTrends(force), loadRealtime(force)]).then(function (updates) {
                var failed = updates.filter(function (item) { return item.status === 'rejected'; }).length;
                realtimeStale = failed > 0;
                renderBoard();
                var degraded = sourceDegraded || failed > 0;
                var message = failed
                    ? '基金池已更新 · 实时行情更新失败，保留本次会话上次值'
                    : sourceDegraded ? '基金池已更新 · 场内 ETF 映射暂不可用' : '数据已更新';
                showStatus(message, degraded ? 'error' : 'ready');
                return result;
            });
        }).catch(function (error) {
            loadError = error && error.message ? error.message : '请检查网络后重新加载';
            renderBoard();
            showStatus(loaded ? '更新失败 · 显示本次会话上次数据' : '基金数据加载失败，请重新加载', 'error');
            throw error;
        }).finally(function () {
            inflight = null;
        });
        return inflight;
    }

    function copyCode(code, button) {
        var done = function () {
            var old = button.textContent;
            button.textContent = '已复制';
            window.setTimeout(function () { if (button.isConnected) button.textContent = old; }, 1200);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(code).then(done).catch(function () {});
            return;
        }
        var input = document.createElement('textarea');
        input.value = code;
        input.setAttribute('readonly', '');
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        try { if (document.execCommand('copy')) done(); } catch (error) {}
        input.remove();
    }

    function selectView(view) {
        var valid = view === 'board' ? 'board' : 'watch';
        document.querySelectorAll('[data-fund-view]').forEach(function (tab) {
            var active = tab.getAttribute('data-fund-view') === valid;
            tab.classList.toggle('active', active);
            tab.setAttribute('aria-selected', active ? 'true' : 'false');
            tab.tabIndex = active ? 0 : -1;
        });
        document.querySelectorAll('[data-fund-panel]').forEach(function (panel) {
            var active = panel.getAttribute('data-fund-panel') === valid;
            panel.classList.toggle('active', active);
            panel.hidden = !active;
        });
        try { window.AppStorage.setItem(VIEW_KEY, valid); } catch (error) {}
        var mainPanel = document.getElementById('tab-funds');
        if (valid === 'board' && !loaded && mainPanel && mainPanel.classList.contains('active')) {
            loadBoard(false).catch(function () {});
        }
    }

    function isActive() {
        var tab = document.querySelector('[data-fund-view="board"]');
        var panel = document.getElementById('tab-funds');
        return !!(tab && panel && tab.classList.contains('active') && panel.classList.contains('active'));
    }

    function ensureLoaded() {
        if (!isActive() || loaded) return Promise.resolve({ skipped: true });
        return loadBoard(false);
    }

    function isMarketActive() {
        var now = new Date();
        var day = now.getDay();
        var minutes = now.getHours() * 60 + now.getMinutes();
        return day > 0 && day < 6 && minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
    }

    function initFundBoard() {
        var saved = 'watch';
        try { saved = window.AppStorage.getItem(VIEW_KEY) || saved; } catch (error) {}
        document.querySelectorAll('[data-fund-view]').forEach(function (tab) {
            tab.addEventListener('click', function () { selectView(tab.getAttribute('data-fund-view')); });
        });
        var search = document.getElementById('fund-board-search');
        if (search) search.addEventListener('input', function () {
            searchTerm = search.value.trim().toLowerCase();
            renderBoard();
        });
        document.querySelectorAll('[data-fund-board-filter]').forEach(function (button) {
            button.addEventListener('click', function () {
                var filter = button.getAttribute('data-fund-board-filter');
                if (!filter) activeFilters.clear();
                else if (activeFilters.has(filter)) activeFilters.delete(filter);
                else activeFilters.add(filter);
                document.querySelectorAll('[data-fund-board-filter]').forEach(function (item) {
                    var value = item.getAttribute('data-fund-board-filter');
                    item.classList.toggle('active', value ? activeFilters.has(value) : activeFilters.size === 0);
                });
                renderBoard();
            });
        });
        var sort = document.getElementById('fund-board-sort');
        if (sort) sort.addEventListener('click', function () {
            var modes = ['desc', 'asc', 'default'];
            sortMode = modes[(modes.indexOf(sortMode) + 1) % modes.length];
            sort.textContent = sortMode === 'desc' ? '涨幅降序' : sortMode === 'asc' ? '涨幅升序' : '默认排序';
            sort.classList.toggle('active', sortMode !== 'default');
            renderBoard();
        });
        var grid = document.getElementById('fund-board-grid');
        if (grid) {
            grid.addEventListener('click', function (event) {
                var button = event.target.closest('[data-copy-code]');
                if (button) copyCode(button.getAttribute('data-copy-code'), button);
            });
            if (uiState && typeof uiState.bindRetries === 'function') {
                uiState.bindRetries(grid, function (scope) {
                    if (scope === 'fund-board') loadBoard(true).catch(function () {});
                });
            }
        }
        var help = document.getElementById('fund-board-help');
        var modal = document.getElementById('fund-board-help-modal');
        var close = document.getElementById('fund-board-help-close');
        if (help && modal) help.addEventListener('click', function () { modal.hidden = false; });
        if (close && modal) close.addEventListener('click', function () { modal.hidden = true; });
        if (modal) modal.addEventListener('click', function (event) { if (event.target === modal) modal.hidden = true; });
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && modal && !modal.hidden) modal.hidden = true;
        });
        var lastWidth = window.innerWidth;
        window.addEventListener('resize', function () {
            if (window.innerWidth === lastWidth) return;
            lastWidth = window.innerWidth;
            renderBoard();
        });
        selectView(saved);
        window.setInterval(function () {
            if (isActive() && !document.hidden && isMarketActive()) {
                Promise.allSettled([loadTrends(false), loadRealtime(false)]).then(function () {});
            }
        }, 60 * 1000);
    }

    window.AppFundBoard = {
        ensureLoaded: ensureLoaded,
        getStarCount: getStarCount,
        groupVisibleFunds: groupVisibleFunds,
        hasLoaded: function () { return loaded; },
        initFundBoard: initFundBoard,
        isActive: isActive,
        loadBoard: loadBoard,
        loadRealtime: loadRealtime,
        loadTrends: loadTrends,
        matchesFund: matchesFund,
        normalizeFunds: normalizeFunds,
        parseValue: parseValue,
        renderBoard: renderBoard,
        selectView: selectView,
    };
})();

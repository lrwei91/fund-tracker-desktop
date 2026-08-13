// 自选基金：基金增删、盘后净值、日涨跌与当日盘中估值采样。
(function () {
    var STORAGE_KEY = 'fund_tracker_fund_watchlist';
    var INTRADAY_CACHE_KEY = 'fund_tracker_fund_intraday_cache';
    var MAX_FUNDS = 30;
    var funds = [];
    var quotes = {};
    var freshCodes = {};
    var loaded = false;
    var inflight = null;
    var intradayInflight = null;
    var intradayTimer = null;
    var intradayDate = '';
    var intradayPoints = {};
    var utils = window.AppUtils;
    var uiState = window.AppUiState;

    function escapeHtml(value) {
        return utils && typeof utils.escapeHtml === 'function'
            ? utils.escapeHtml(value)
            : String(value == null ? '' : value)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function normalizeFund(entry) {
        if (typeof entry === 'string') entry = { code: entry };
        if (!entry || typeof entry !== 'object') return null;
        var code = String(entry.code || '').trim();
        if (!/^\d{6}$/.test(code)) return null;
        return {
            code: code,
            name: String(entry.name || code).trim().slice(0, 48) || code,
            type: String(entry.type || '').trim().slice(0, 24),
        };
    }

    function normalizeFunds(entries) {
        var seen = {};
        return (Array.isArray(entries) ? entries : []).map(normalizeFund).filter(function (entry) {
            if (!entry || seen[entry.code]) return false;
            seen[entry.code] = true;
            return true;
        }).slice(0, MAX_FUNDS);
    }

    function restoreFunds() {
        if (loaded) return;
        loaded = true;
        try {
            funds = normalizeFunds(JSON.parse(window.AppStorage.getItem(STORAGE_KEY) || '[]'));
        } catch (error) {
            funds = [];
        }
    }

    function persistFunds() {
        window.AppStorage.setItem(STORAGE_KEY, JSON.stringify(funds));
    }

    function getFunds() {
        restoreFunds();
        return funds.map(function (entry) { return Object.assign({}, entry); });
    }

    function getFundCodes() {
        return getFunds().map(function (entry) { return entry.code; });
    }

    function formatNav(value) {
        var number = Number(value);
        return Number.isFinite(number) ? number.toFixed(4) : '--';
    }

    function formatChange(value) {
        if (value === null || value === undefined || value === '') return '--';
        var number = Number(value);
        if (!Number.isFinite(number)) return '--';
        return (number > 0 ? '+' : '') + number.toFixed(2) + '%';
    }

    function changeClass(value) {
        if (value === null || value === undefined || value === '') return 'neutral';
        var number = Number(value);
        return number > 0 ? 'positive' : number < 0 ? 'negative' : 'neutral';
    }

    function restoreIntraday() {
        if (intradayDate) return;
        var today = currentDateKey();
        try {
            var cached = JSON.parse(window.AppStorage.getItem(INTRADAY_CACHE_KEY) || 'null');
            intradayDate = today;
            if (!cached || cached.date !== today || !cached.points || typeof cached.points !== 'object') return;
            Object.keys(cached.points).forEach(function (code) {
                if (!/^\d{6}$/.test(code) || !Array.isArray(cached.points[code])) return;
                intradayPoints[code] = cached.points[code].map(function (point) {
                    return { time: Number(point.time), value: normalizeIntradayValue(point.value) };
                }).filter(function (point) {
                    return Number.isFinite(point.time) && point.value !== null;
                }).slice(-242);
            });
        } catch (error) {
            intradayDate = today;
            intradayPoints = {};
        }
    }

    function persistIntraday() {
        try {
            window.AppStorage.setItem(INTRADAY_CACHE_KEY, JSON.stringify({ date: intradayDate, points: intradayPoints }));
        } catch (error) {}
    }

    function currentDateKey(date) {
        var value = date || new Date();
        return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
    }

    function resetIntradayIfNeeded() {
        restoreIntraday();
        var today = currentDateKey();
        if (intradayDate === today) return;
        intradayDate = today;
        intradayPoints = {};
        persistIntraday();
    }

    function normalizeIntradayValue(value) {
        var number = Number(value);
        return Number.isFinite(number) && Math.abs(number) <= 30 ? number : null;
    }

    function applyFundIntraday(result, requestedCodes, sampledAt) {
        if (!result || result.success === false || !result.data) return false;
        resetIntradayIfNeeded();
        var timestamp = sampledAt || Date.now();
        var minute = Math.floor(timestamp / 60000) * 60000;
        var received = 0;
        requestedCodes.forEach(function (code) {
            var value = normalizeIntradayValue(result.data[code]);
            if (value === null) return;
            var points = intradayPoints[code] || [];
            var point = { time: minute, value: value };
            if (points.length && points[points.length - 1].time === minute) points[points.length - 1] = point;
            else points.push(point);
            intradayPoints[code] = points.slice(-242);
            received += 1;
        });
        if (received) {
            persistIntraday();
            renderFunds();
        }
        return received > 0;
    }

    function renderFundIntraday(code) {
        resetIntradayIfNeeded();
        var points = intradayPoints[code] || [];
        if (!points.length) return '<div class="fund-watch-intraday is-empty" role="cell"><span>--</span><small>' +
            (isMarketActive() ? '等待盘中估值' : '非交易时段') + '</small></div>';
        var latest = points[points.length - 1].value;
        var tone = changeClass(latest);
        var chart = '';
        if (points.length > 1) {
            var width = 104;
            var height = 30;
            var padding = 2;
            var bound = Math.max(0.1, Math.max.apply(Math, points.map(function (point) { return Math.abs(point.value); })));
            var xStep = (width - padding * 2) / Math.max(1, points.length - 1);
            var coordinates = points.map(function (point, index) {
                var x = padding + index * xStep;
                var y = padding + (bound - point.value) / (bound * 2) * (height - padding * 2);
                return [x, y];
            });
            var path = coordinates.map(function (point, index) {
                return (index ? 'L' : 'M') + point[0].toFixed(2) + ',' + point[1].toFixed(2);
            }).join(' ');
            var last = coordinates[coordinates.length - 1];
            chart = '<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" aria-hidden="true">' +
                '<line class="fund-watch-intraday-base" x1="2" y1="15" x2="102" y2="15"></line>' +
                '<path class="fund-watch-intraday-line" d="' + path + '" vector-effect="non-scaling-stroke"></path>' +
                '<circle class="fund-watch-intraday-dot" cx="' + last[0].toFixed(2) + '" cy="' + last[1].toFixed(2) + '" r="1.8"></circle></svg>';
        }
        var time = new Date(points[points.length - 1].time);
        var timeText = String(time.getHours()).padStart(2, '0') + ':' + String(time.getMinutes()).padStart(2, '0');
        return '<div class="fund-watch-intraday ' + tone + '" role="cell" title="盘中估值采样 ' + escapeHtml(timeText) + '">' +
            chart + '<span>' + escapeHtml(formatChange(latest)) + '</span><small>' + escapeHtml(timeText) + '</small></div>';
    }

    function renderFundRow(fund) {
        var quote = quotes[fund.code] || null;
        var change = quote ? quote.dayChangePercent : null;
        var fresh = !!freshCodes[fund.code];
        var name = quote && quote.name ? quote.name : fund.name;
        return '<div class="fund-watch-row' + (quote && !fresh ? ' is-stale' : '') + '" data-fund-code="' + escapeHtml(fund.code) + '" role="row">' +
            '<div class="fund-watch-identity" role="cell"><strong>' + escapeHtml(name) + '</strong><span>' + escapeHtml(fund.code) + '</span></div>' +
            '<div class="fund-watch-type" role="cell">' + escapeHtml(fund.type || '基金') + '</div>' +
            renderFundIntraday(fund.code) +
            '<div class="fund-watch-nav" role="cell"><strong>' + escapeHtml(quote ? formatNav(quote.unitNav) : '--') + '</strong><span>单位净值</span></div>' +
            '<div class="fund-watch-date" role="cell">' + escapeHtml(quote && quote.navDate ? quote.navDate : '--') + '</div>' +
            '<div class="fund-watch-change ' + changeClass(change) + '" role="cell">' + escapeHtml(formatChange(change)) + '</div>' +
            '<button class="fund-watch-remove" type="button" data-remove-fund="' + escapeHtml(fund.code) + '" aria-label="移除 ' + escapeHtml(name) + '">✕</button>' +
            '</div>';
    }

    function renderFunds() {
        restoreFunds();
        var list = document.getElementById('fund-watch-list');
        if (!list) return;
        if (!funds.length) {
            list.innerHTML = uiState && typeof uiState.render === 'function'
                ? uiState.render('empty', { title: '暂无自选基金', detail: '通过上方输入框添加基金代码或名称。' })
                : '<div class="ui-state ui-state--empty">暂无自选基金</div>';
            return;
        }
        list.innerHTML = funds.map(renderFundRow).join('');
    }

    function showStatus(message, kind) {
        var element = document.getElementById('fund-watch-status');
        if (!element) return;
        element.textContent = message || '';
        element.classList.toggle('error', kind === 'error');
        element.classList.toggle('loading', kind === 'loading');
    }

    function updateStoredNames(data) {
        var changed = false;
        funds.forEach(function (fund) {
            var quote = data[fund.code];
            if (quote && quote.name && quote.name !== fund.name) {
                fund.name = String(quote.name).slice(0, 48);
                changed = true;
            }
        });
        if (changed) persistFunds();
    }

    function applyFundQuotes(result, requestedCodes) {
        if (!result || result.success === false || !result.data) return false;
        var incoming = result.data;
        var nextFresh = {};
        var receivedCount = 0;
        var endpointStale = !!(result.meta && result.meta.stale);
        requestedCodes.forEach(function (code) {
            var item = incoming[code];
            if (!item || !Number.isFinite(Number(item.unitNav))) return;
            quotes[code] = item;
            receivedCount += 1;
            if (!endpointStale) nextFresh[code] = true;
        });
        freshCodes = nextFresh;
        updateStoredNames(incoming);
        renderFunds();
        var time = result.time || '';
        var timeElement = document.getElementById('fund-watch-update-time');
        if (timeElement) timeElement.textContent = time ? '净值日期 ' + time : '';
        var missing = result.meta && Array.isArray(result.meta.missingCodes) ? result.meta.missingCodes.length : 0;
        if (endpointStale) {
            showStatus('数据源暂不可用 · 显示 30 分钟内缓存', 'error');
        } else {
            showStatus(missing ? '部分基金暂未返回净值' : '基金净值已更新', missing ? 'error' : 'ready');
        }
        return receivedCount > 0;
    }

    function loadFundIntraday(force) {
        restoreFunds();
        if (!funds.length || !window.AppDataClient) return Promise.resolve({ skipped: true });
        resetIntradayIfNeeded();
        if (!isMarketActive()) {
            renderFunds();
            return Promise.resolve({ skipped: true, reason: 'market_closed' });
        }
        if (intradayInflight) return intradayInflight;
        var codes = getFundCodes();
        intradayInflight = Promise.resolve(window.AppDataClient.fetchData('/fund-board-realtime', {
            codes: codes.join(','),
        }, {
            force: !!force,
            cacheMode: force ? 'bypass_fresh' : 'normal',
        })).then(function (result) {
            applyFundIntraday(result, codes);
            return result;
        }).finally(function () {
            intradayInflight = null;
        });
        return intradayInflight;
    }

    function isFundWatchActive() {
        var main = document.getElementById('tab-funds');
        var watch = document.querySelector('[data-fund-panel="watch"]');
        return !!(main && watch && main.classList.contains('active') && watch.classList.contains('active'));
    }

    function isMarketActive() {
        var now = new Date();
        var day = now.getDay();
        var minutes = now.getHours() * 60 + now.getMinutes();
        return day > 0 && day < 6 && minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
    }

    function loadFundQuotes(force) {
        restoreFunds();
        if (!funds.length || !window.AppDataClient) {
            renderFunds();
            return Promise.resolve({ skipped: true });
        }
        if (inflight) return inflight;
        var codes = getFundCodes();
        showStatus('正在更新基金净值', 'loading');
        inflight = window.AppDataClient.fetchData('/fund-quotes', {
            codes: codes.join(','),
        }, {
            force: !!force,
            cacheMode: force ? 'bypass_fresh' : 'normal',
        }).then(function (result) {
            if (!applyFundQuotes(result, codes)) throw new Error('基金净值数据为空');
            return result;
        }).catch(function (error) {
            freshCodes = {};
            renderFunds();
            var hasCurrentSessionData = Object.keys(quotes).some(function (code) { return codes.includes(code); });
            showStatus(hasCurrentSessionData ? '更新失败 · 显示本次会话上次数据' : '基金净值加载失败，请稍后重试', 'error');
            throw error;
        }).finally(function () {
            inflight = null;
            loadFundIntraday(force).catch(function () {});
        });
        return inflight;
    }

    function resolveFundInput(rawValue) {
        return window.AppDataClient.fetchData('/fund-search', { q: rawValue }, {
            cacheMode: 'normal',
        }).then(function (result) {
            var items = Array.isArray(result.data) ? result.data : [];
            var exact = items.find(function (item) { return item.code === rawValue; });
            var match = exact || items[0];
            if (!match) throw new Error('未找到匹配基金');
            return normalizeFund(match);
        });
    }

    async function addFund() {
        restoreFunds();
        var input = document.getElementById('fund-input');
        var button = document.getElementById('add-fund-btn');
        var rawValue = input ? input.value.trim() : '';
        if (!rawValue) {
            showStatus('请输入基金代码或名称', 'error');
            return;
        }
        if (funds.length >= MAX_FUNDS) {
            showStatus('最多添加 ' + MAX_FUNDS + ' 只基金', 'error');
            return;
        }
        button.disabled = true;
        button.textContent = '查询中';
        var addedFund = null;
        try {
            var fund = await resolveFundInput(rawValue);
            if (!fund) throw new Error('未找到匹配基金');
            if (funds.some(function (item) { return item.code === fund.code; })) {
                throw new Error('该基金已在列表中');
            }
            funds.push(fund);
            addedFund = fund;
            persistFunds();
            input.value = '';
            renderFunds();
            showStatus(fund.name + ' 已添加');
            await loadFundQuotes(true);
            if (!quotes[fund.code]) await loadFundQuotes(true);
        } catch (error) {
            showStatus(addedFund
                ? addedFund.name + ' 已添加，净值稍后自动刷新'
                : (error && error.message ? error.message : '基金添加失败'), 'error');
        } finally {
            button.disabled = false;
            button.textContent = '添加基金';
        }
    }

    function removeFund(code) {
        restoreFunds();
        funds = funds.filter(function (fund) { return fund.code !== code; });
        delete quotes[code];
        delete freshCodes[code];
        delete intradayPoints[code];
        persistFunds();
        persistIntraday();
        renderFunds();
        if (!funds.length) {
            var timeElement = document.getElementById('fund-watch-update-time');
            if (timeElement) timeElement.textContent = '';
        }
        showStatus('已移除基金');
    }

    function importFunds(entries) {
        loaded = true;
        funds = normalizeFunds(entries);
        quotes = {};
        freshCodes = {};
        intradayPoints = {};
        intradayDate = currentDateKey();
        persistFunds();
        persistIntraday();
        renderFunds();
        if (funds.length) loadFundQuotes(true).catch(function () {});
        return funds.length;
    }

    function initFunds() {
        restoreFunds();
        renderFunds();
        var addButton = document.getElementById('add-fund-btn');
        var input = document.getElementById('fund-input');
        var list = document.getElementById('fund-watch-list');
        if (addButton) addButton.addEventListener('click', addFund);
        if (input) input.addEventListener('keydown', function (event) {
            if (event.key === 'Enter') addFund();
        });
        if (list) list.addEventListener('click', function (event) {
            var button = event.target.closest('[data-remove-fund]');
            if (button) removeFund(button.getAttribute('data-remove-fund'));
        });
        if (!intradayTimer) {
            intradayTimer = window.setInterval(function () {
                if (isFundWatchActive() && !document.hidden && isMarketActive()) {
                    loadFundIntraday(false).catch(function () {});
                }
            }, 60 * 1000);
        }
    }

    window.AppFunds = {
        addFund: addFund,
        applyFundIntraday: applyFundIntraday,
        applyFundQuotes: applyFundQuotes,
        exportFunds: getFunds,
        getFundCodes: getFundCodes,
        importFunds: importFunds,
        initFunds: initFunds,
        loadFundIntraday: loadFundIntraday,
        loadFundQuotes: loadFundQuotes,
        removeFund: removeFund,
        renderFunds: renderFunds,
        resolveFundInput: resolveFundInput,
    };
})();

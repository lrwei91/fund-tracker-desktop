// Foreground-first refresh scheduler.
// Keeps the existing module loaders and data contracts, but gives them one
// non-overlapping queue so a manual refresh cannot fan out into duplicate work.
(function () {
    var state = window.AppState;
    var utils = window.AppUtils;
    var timer = null;
    var running = null;
    var cycleId = 0;
    var visible = document.visibilityState !== 'hidden';
    var started = false;
    var detailTail = Promise.resolve();
    var nextDue = { main: 0, signals: 0, funds: 0, news: 0, daily: 0 };
    var MAX_ACTIVE = 3;
    var QUOTE_BATCH_SIZE = 50;
    var FUND_REFRESH_SECONDS = 5 * 60;

    function uniqueCodes(values) {
        var seen = {};
        return (Array.isArray(values) ? values : []).map(function (value) {
            return String(value || '').trim();
        }).filter(function (value) {
            if (!/^\d{6}$/.test(value) || seen[value]) return false;
            seen[value] = true;
            return true;
        });
    }

    function now() { return Date.now(); }

    function statusText(text, busy) {
        var element = document.getElementById('refresh-status');
        var button = document.getElementById('refresh-btn');
        document.body.classList.toggle('is-refreshing', !!busy);
        if (element) {
            element.textContent = text || '';
            element.classList.toggle('is-busy', !!busy);
        }
        if (button) {
            button.setAttribute('aria-busy', busy ? 'true' : 'false');
            button.classList.toggle('is-busy', !!busy);
        }
    }

    function buildQuotesTask(force, id, codes) {
        return {
            name: '实时行情',
            priority: 100,
            run: function () {
                if (!codes.length || !window.AppDataClient) return Promise.resolve();
                return window.AppDataClient.fetchData('/stock', {
                    codes: codes.join(','),
                }, {
                    force: !!force,
                    cacheMode: force ? 'bypass_fresh' : 'normal',
                    cycleId: id,
                }).then(function (result) {
                    return { type: 'quotes', codes: codes, result: result };
                }).catch(function (error) {
                    return { type: 'quotes', codes: codes, error: error };
                });
            },
        };
    }

    function chunk(values, size) {
        var chunks = [];
        for (var index = 0; index < values.length; index += size) {
            chunks.push(values.slice(index, index + size));
        }
        return chunks;
    }

    function syncHoldingWidget(result, watchCodes) {
        if (!window.shell || typeof window.shell.syncHoldingWidget !== 'function') return;
        var holdingCodes = window.AppWatchlist && typeof window.AppWatchlist.getHoldingCodes === 'function'
            ? window.AppWatchlist.getHoldingCodes() : [];
        var allowed = {};
        uniqueCodes(watchCodes).forEach(function (code) { allowed[code] = true; });
        var quotes = {};
        var source = result && result.data && typeof result.data === 'object' ? result.data : {};
        var complete = holdingCodes.length > 0;
        holdingCodes.forEach(function (code) {
            if (!allowed[code] || !source[code]) {
                complete = false;
                return;
            }
            var quote = source[code];
            if (!Number.isFinite(Number(quote.priceValue)) || Number(quote.priceValue) <= 0) {
                complete = false;
                return;
            }
            quotes[code] = {
                code: code,
                name: quote.name,
                price: quote.price,
                priceValue: quote.priceValue,
                changePercent: quote.changePercent,
                change: quote.change,
            };
        });
        var meta = result && result.meta ? result.meta : {};
        window.shell.syncHoldingWidget({
            quotes: quotes,
            status: result && result.success === false ? 'unavailable' : (complete ? (meta.stale ? 'stale' : 'fresh') : 'unavailable'),
            updatedAt: result && (result.time || meta.updatedAt) || new Date().toISOString(),
        }).catch(function () {});
    }

    function syncCurrentHoldingWidget() {
        if (!window.AppWatchlist || !window.shell || typeof window.shell.syncHoldingWidget !== 'function') return Promise.resolve();
        var holdingCodes = typeof window.AppWatchlist.getHoldingCodes === 'function'
            ? window.AppWatchlist.getHoldingCodes() : [];
        var quotes = {};
        var cache = state.watchQuoteCache || {};
        var fresh = state.watchQuoteFreshCodes || {};
        holdingCodes.forEach(function (code) {
            if (!fresh[code] || !cache[code]) return;
            var quote = cache[code];
            quotes[code] = {
                code: code,
                name: quote.name,
                price: quote.price,
                priceValue: quote.priceValue,
                changePercent: quote.changePercent,
                change: quote.change,
            };
        });
        return window.shell.syncHoldingWidget({
            quotes: quotes,
            status: Object.keys(quotes).length === holdingCodes.length && holdingCodes.length ? 'fresh' : 'unavailable',
            updatedAt: state.watchQuoteUpdateTime || new Date().toISOString(),
        }).catch(function () {});
    }

    function tasksFor(kind, options, id) {
        options = options || {};
        var tasks = [];
        var quoteContext = null;
        if (kind === 'all' || kind === 'main') {
            var watchCodes = window.AppWatchlist && typeof window.AppWatchlist.getAllWatchCodes === 'function'
                ? uniqueCodes(window.AppWatchlist.getAllWatchCodes()) : [];
            var customCodes = uniqueCodes(state.customIndexCodes || []);
            var quoteCodes = uniqueCodes(watchCodes.concat(customCodes));
            var batches = chunk(quoteCodes, QUOTE_BATCH_SIZE);
            quoteContext = { watchCodes: watchCodes, customCodes: customCodes, batchCount: batches.length };
            batches.forEach(function (batch) {
                tasks.push(buildQuotesTask(!!options.force, id, batch));
            });
            if (watchCodes.length && window.AppWatchlist && typeof window.AppWatchlist.loadWatchMarketWarnings === 'function') {
                tasks.push({ name: '市场异动', priority: 88, run: function () {
                    return window.AppWatchlist.loadWatchMarketWarnings(watchCodes, !!options.force);
                } });
            }
            tasks.push({ name: '大盘指数', priority: 90, run: function () {
                return window.AppMarket ? window.AppMarket.loadIndexData(!!options.force) : null;
            } });
        }
        if (kind === 'all' || kind === 'signals') {
            tasks.push({ name: '资金流', priority: 60, run: function () {
                return window.AppMarket ? window.AppMarket.loadCapitalData(!!options.force) : null;
            } });
            tasks.push({ name: '板块', priority: 55, run: function () {
                return window.AppMarket ? window.AppMarket.loadSectorData(!!options.force) : null;
            } });
            if (!options.skipOpportunity && state.currentTab === 'signals') {
                tasks.push({ name: '机会雷达', priority: 80, run: function () {
                    return window.AppSignals ? window.AppSignals.loadOpportunityRadarData(!!options.force) : null;
                } });
            }
            if (!options.skipLimitUp) {
                tasks.push({ name: '打板情绪', priority: 45, run: function () {
                    return window.AppSignals ? window.AppSignals.loadLimitUpData(!!options.force) : null;
                } });
            }
            tasks.push({ name: '市场热度', priority: 70, run: function () {
                return window.AppSignals ? window.AppSignals.loadHotRankData(window.AppSignals.getActiveHotRankSource(), !!options.force) : null;
            } });
        }
        if (kind === 'all' || kind === 'funds') {
            var fundCodes = window.AppFunds && typeof window.AppFunds.getFundCodes === 'function'
                ? uniqueCodes(window.AppFunds.getFundCodes()) : [];
            if (fundCodes.length && typeof window.AppFunds.loadFundQuotes === 'function') {
                tasks.push({ name: '基金净值', priority: 65, run: function () {
                    return window.AppFunds.loadFundQuotes(!!options.force);
                } });
            }
            var shouldRefreshBoard = window.AppFundBoard && (
                (typeof window.AppFundBoard.isActive === 'function' && window.AppFundBoard.isActive()) ||
                (kind === 'all' && typeof window.AppFundBoard.hasLoaded === 'function' && window.AppFundBoard.hasLoaded())
            );
            if (shouldRefreshBoard && typeof window.AppFundBoard.loadBoard === 'function') {
                tasks.push({ name: '基金筛选', priority: 64, run: function () {
                    return window.AppFundBoard.loadBoard(!!options.force);
                } });
            }
        }
        if ((kind === 'all' || kind === 'news') && state.currentTab === 'news') {
            tasks.push({ name: '快讯', priority: 85, run: function () {
                return window.AppNews ? window.AppNews.refreshNewsData(!!options.force) : null;
            } });
        }
        return {
            tasks: tasks.sort(function (a, b) { return b.priority - a.priority; }),
            quoteContext: quoteContext,
        };
    }

    function runQueue(tasks) {
        var index = 0;
        var active = 0;
        var failures = [];
        var results = [];
        return new Promise(function (resolve) {
            function next() {
                if (index >= tasks.length && active === 0) {
                    resolve({ failures: failures, results: results });
                    return;
                }
                while (active < MAX_ACTIVE && index < tasks.length) {
                    var task = tasks[index++];
                    active += 1;
                    Promise.resolve().then(task.run).then(function (result) {
                        if (result) results.push(result);
                        if (result && result.type === 'quotes' && result.error) failures.push(result.error);
                    }).catch(function (error) {
                        failures.push(error);
                    }).finally(function () {
                        active -= 1;
                        next();
                    });
                }
            }
            next();
        });
    }

    function request(kind, options) {
        options = options || {};
        if (running) return running.promise;
        var id = ++cycleId;
        var plan = tasksFor(kind, options, id);
        var tasks = plan.tasks;
        if (!tasks.length) return Promise.resolve();
        var batchLabel = plan.quoteContext && plan.quoteContext.batchCount > 1 ? ' · 行情分批' : '';
        statusText('刷新中 · ' + tasks.length + ' 项' + batchLabel, true);
        var startedAt = now();
        var promise = runQueue(tasks).then(function (queue) {
            if (id === cycleId && plan.quoteContext && plan.quoteContext.batchCount) {
                applyQuoteResults(plan.quoteContext, queue.results, id);
            }
            var failures = queue.failures;
            var elapsed = now() - startedAt;
            if (failures.length) {
                statusText('部分更新失败 · ' + elapsed + 'ms' + batchLabel, false);
                if (utils && typeof utils.setLastUpdated === 'function') utils.setLastUpdated('部分数据更新失败');
            } else {
                statusText('已更新 · ' + elapsed + 'ms' + batchLabel, false);
            }
            return { cycleId: id, failures: failures, durationMs: elapsed };
        }).finally(function () {
            if (running && running.id === id) running = null;
        });
        running = { id: id, promise: promise };
        return promise;
    }

    function applyQuoteResults(context, results, id) {
        if (!context || id !== cycleId) return;
        var data = {};
        var latest = null;
        var meta = {};
        var failed = false;
        results.filter(function (item) { return item && item.type === 'quotes'; }).forEach(function (item) {
            if (item.error || !item.result || item.result.success === false) {
                failed = true;
                return;
            }
            if (item.result.data && typeof item.result.data === 'object') {
                Object.assign(data, item.result.data);
            }
            latest = item.result;
            meta = Object.assign(meta, item.result.meta || {});
        });
        var combined = {
            success: !failed || Object.keys(data).length > 0,
            data: data,
            time: latest && latest.time,
            meta: Object.assign(meta, { degraded: failed || !!meta.degraded, stale: false }),
        };
        if (window.AppWatchlist && typeof window.AppWatchlist.applyWatchQuoteBatch === 'function') {
            window.AppWatchlist.applyWatchQuoteBatch(combined, context.watchCodes);
        }
        if (window.AppWatchlist && typeof window.AppWatchlist.applyCustomIndexQuoteBatch === 'function') {
            window.AppWatchlist.applyCustomIndexQuoteBatch(combined, context.customCodes);
        }
        syncHoldingWidget(combined, context.watchCodes);
    }

    function runDetail(tasks) {
        var wrapped = (Array.isArray(tasks) ? tasks : []).map(function (task, index) {
            return {
                name: task.name || '详情数据',
                priority: task.priority || 50,
                run: function () {
                    return Promise.resolve().then(task.run).then(function (value) {
                        return { type: 'detail', index: index, value: value };
                    }).catch(function (error) {
                        return { type: 'detail', index: index, error: error };
                    });
                },
            };
        });
        var waitForRefresh = function () {
            var active = running ? running.promise.catch(function () {}) : Promise.resolve();
            return active.then(function () { return runQueue(wrapped); });
        };
        var work = detailTail.catch(function () {}).then(waitForRefresh);
        detailTail = work.catch(function () {});
        return work.then(function (queue) {
            return queue.results
                .filter(function (item) { return item && item.type === 'detail'; })
                .sort(function (a, b) { return a.index - b.index; })
                .map(function (item) {
                    return item.error
                        ? { status: 'rejected', reason: item.error }
                        : { status: 'fulfilled', value: item.value };
                });
        });
    }

    function schedule() {
        if (timer) clearTimeout(timer);
        if (!started) return;
        var dueValues = Object.keys(nextDue).map(function (key) { return nextDue[key] || now() + 60000; });
        var delay = Math.max(250, Math.min.apply(Math, dueValues) - now());
        timer = setTimeout(tick, delay);
    }

    function tick() {
        timer = null;
        if (started && state.isAutoRefresh && visible) {
            var current = now();
            var dueMain = current >= nextDue.main && utils.isIntradayRefreshWindow();
            var dueSignals = current >= nextDue.signals && utils.isIntradayRefreshWindow();
            var dueFunds = current >= nextDue.funds && state.currentTab === 'funds';
            var dueNews = current >= nextDue.news && state.currentTab === 'news';
            var dueDaily = current >= nextDue.daily && utils.isAfterCloseDailyWindow();
            if (dueMain) {
                nextDue.main = current + state.refreshSecondsMain * 1000;
            }
            if (dueSignals) {
                nextDue.signals = current + state.refreshSecondsSignal * 1000;
            }
            if (current >= nextDue.funds) {
                nextDue.funds = current + FUND_REFRESH_SECONDS * 1000;
            }
            if (dueNews) {
                nextDue.news = current + state.refreshSecondsNews * 1000;
            }
            if (dueDaily) {
                nextDue.daily = current + 30 * 60 * 1000;
            }
            var dueCount = [dueMain, dueSignals, dueFunds, dueNews, dueDaily].filter(Boolean).length;
            if (dueCount > 1) {
                request('all', { force: dueDaily, skipOpportunity: dueDaily });
            } else if (dueMain) {
                request('main');
            } else if (dueSignals || dueDaily) {
                request('signals', { force: dueDaily, skipOpportunity: dueDaily });
            } else if (dueFunds) {
                request('funds');
            } else if (dueNews) {
                request('news');
            }
        }
        schedule();
    }

    function start() {
        started = true;
        var current = now();
        nextDue.main = current + state.refreshSecondsMain * 1000;
        nextDue.signals = current + state.refreshSecondsSignal * 1000;
        nextDue.funds = current + FUND_REFRESH_SECONDS * 1000;
        nextDue.news = current + state.refreshSecondsNews * 1000;
        nextDue.daily = current + 30 * 60 * 1000;
        schedule();
    }

    function stop() {
        started = false;
        if (timer) clearTimeout(timer);
        timer = null;
    }

    function reschedule() {
        if (!started) return;
        var current = now();
        nextDue.main = current + state.refreshSecondsMain * 1000;
        nextDue.signals = current + state.refreshSecondsSignal * 1000;
        nextDue.funds = current + FUND_REFRESH_SECONDS * 1000;
        nextDue.news = current + state.refreshSecondsNews * 1000;
        schedule();
    }

    function refreshTab(tab) {
        if (tab === 'signals') return request('signals', { skipLimitUp: false });
        if (tab === 'funds') return request('funds');
        if (tab === 'news') return request('news');
        return request('main');
    }

    document.addEventListener('visibilitychange', function () {
        visible = document.visibilityState !== 'hidden';
        if (visible) {
            var current = now();
            nextDue.main = current + state.refreshSecondsMain * 1000;
            nextDue.signals = current + state.refreshSecondsSignal * 1000;
            nextDue.funds = current + FUND_REFRESH_SECONDS * 1000;
            nextDue.news = current + state.refreshSecondsNews * 1000;
            refreshTab(state.currentTab);
            schedule();
        } else if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    });

    window.AppRefreshCoordinator = {
        start: start,
        stop: stop,
        reschedule: reschedule,
        refreshAll: function (options) { return request('all', options || {}); },
        refreshMain: function (options) { return request('main', options || {}); },
        refreshSignals: function (options) { return request('signals', options || {}); },
        refreshFunds: function (options) { return request('funds', options || {}); },
        refreshNews: function (options) { return request('news', options || {}); },
        runDetail: runDetail,
        refreshTab: refreshTab,
        syncCurrentHoldingWidget: syncCurrentHoldingWidget,
        isRunning: function () { return !!running; },
        isVisible: function () { return visible; },
    };
})();

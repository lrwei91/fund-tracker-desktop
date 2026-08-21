/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function makeCodes(count) {
    return Array.from({ length: count }, (_, index) => String(600000 + index).padStart(6, '0'));
}

function mockVisibility(initial) {
    let current = initial || 'visible';
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => current,
    });
    return function setVisibility(next) {
        current = next;
        document.dispatchEvent(new Event('visibilitychange'));
    };
}

function installHarness() {
    const watchCodes = makeCodes(49);
    window.AppState = {
        currentTab: 'dashboard',
        isAutoRefresh: false,
        refreshSecondsMain: 10,
        refreshSecondsSignal: 1800,
        refreshSecondsNews: 60,
        customIndexCodes: [watchCodes[0], watchCodes[1], '000001'],
        watchQuoteCache: {},
        watchQuoteFreshCodes: {},
        watchQuoteUpdateTime: '',
    };
    window.AppUtils = {
        isIntradayRefreshWindow: () => true,
        isAfterCloseDailyWindow: () => false,
        setLastUpdated: vi.fn(),
    };
    window.AppDataClient = {
        fetchData: vi.fn().mockResolvedValue({
            success: true,
            data: {},
            time: '09:30:00',
            meta: { stale: false },
        }),
    };
    window.AppWatchlist = {
        getAllWatchCodes: () => watchCodes,
        getHoldingCodes: () => watchCodes.slice(0, 2),
        applyWatchQuoteBatch: vi.fn(),
        applyCustomIndexQuoteBatch: vi.fn(),
        markQuoteUnavailable: vi.fn(),
        loadWatchMarketWarnings: vi.fn().mockResolvedValue(true),
    };
    window.AppMarket = {
        loadIndexData: vi.fn().mockResolvedValue(undefined),
        loadMarketBreadthData: vi.fn().mockResolvedValue(undefined),
        loadCapitalData: vi.fn().mockResolvedValue(undefined),
        loadSectorData: vi.fn().mockResolvedValue(undefined),
    };
    window.AppSignals = {
        getActiveHotRankSource: () => 'tencent',
        loadOpportunityRadarData: vi.fn().mockResolvedValue(undefined),
        loadHotRankData: vi.fn().mockResolvedValue(undefined),
        loadLimitUpData: vi.fn().mockResolvedValue(undefined),
    };
    window.AppNews = { refreshNewsData: vi.fn().mockResolvedValue(undefined) };
    window.AppFunds = {
        getFundCodes: () => [],
        loadFundQuotes: vi.fn().mockResolvedValue(undefined),
    };
    window.AppFundBoard = {
        isActive: () => false,
        hasLoaded: () => false,
        loadBoard: vi.fn().mockResolvedValue(undefined),
    };
    window.shell = {
        syncHoldingWidget: vi.fn().mockResolvedValue({ ok: true }),
        onHoldingWidgetVisibility: vi.fn(),
    };
    document.body.innerHTML = '<button id="refresh-btn"></button><div id="refresh-status"></div>';
    return { watchCodes };
}

describe('AppRefreshCoordinator', () => {
    beforeEach(() => {
        vi.resetModules();
        mockVisibility('visible');
        installHarness();
    });

    afterEach(() => {
        if (window.AppRefreshCoordinator) window.AppRefreshCoordinator.stop();
        vi.useRealTimers();
    });

    it('把跨分组的 50 只自选股合并为一次行情请求并去重', async () => {
        const { watchCodes } = installHarness();
        await import('../app/modules/refresh-coordinator.js');

        await window.AppRefreshCoordinator.refreshAll({ skipLimitUp: true, skipOpportunity: true });

        expect(window.AppDataClient.fetchData).toHaveBeenCalledTimes(1);
        const params = window.AppDataClient.fetchData.mock.calls[0][1];
        const codes = params.codes.split(',');
        expect(codes).toHaveLength(50);
        expect(new Set(codes).size).toBe(50);
        expect(codes).toContain(watchCodes[48]);
        expect(codes).toContain('000001');
        expect(window.AppWatchlist.applyWatchQuoteBatch).toHaveBeenCalledWith(
            expect.any(Object),
            watchCodes,
        );
        expect(window.AppWatchlist.loadWatchMarketWarnings).toHaveBeenCalledWith(watchCodes, false);
    });

    it('超过 50 只时分批请求，但只做一次批量回填', async () => {
        const watchCodes = makeCodes(51);
        installHarness();
        window.AppWatchlist.getAllWatchCodes = () => watchCodes;
        await import('../app/modules/refresh-coordinator.js');

        await window.AppRefreshCoordinator.refreshAll({ skipLimitUp: true, skipOpportunity: true });

        expect(window.AppDataClient.fetchData).toHaveBeenCalledTimes(2);
        expect(window.AppDataClient.fetchData.mock.calls.map((call) => call[1].codes.split(',').length))
            .toEqual([50, 2]);
        expect(window.AppWatchlist.applyWatchQuoteBatch).toHaveBeenCalledTimes(1);
        expect(window.AppWatchlist.applyWatchQuoteBatch.mock.calls[0][1]).toHaveLength(51);
    });

    it('同一周期重复点击复用在途 Promise，不重叠刷新', async () => {
        let resolveQuotes;
        window.AppDataClient.fetchData.mockReturnValueOnce(new Promise((resolve) => {
            resolveQuotes = resolve;
        }));
        await import('../app/modules/refresh-coordinator.js');

        const first = window.AppRefreshCoordinator.refreshAll({ skipLimitUp: true, skipOpportunity: true });
        const second = window.AppRefreshCoordinator.refreshAll({ skipLimitUp: true, skipOpportunity: true });
        expect(first).toBe(second);
        await Promise.resolve();
        expect(window.AppDataClient.fetchData).toHaveBeenCalledTimes(1);
        resolveQuotes({ success: true, data: {}, meta: {} });
        await first;
        expect(window.AppRefreshCoordinator.isRunning()).toBe(false);
    });

    it('行情 Tab 刷新时市场涨跌家数与指数同周期更新', async () => {
        await import('../app/modules/refresh-coordinator.js');

        await window.AppRefreshCoordinator.refreshTab('dashboard');

        expect(window.AppMarket.loadIndexData).toHaveBeenCalledWith(false);
        expect(window.AppMarket.loadMarketBreadthData).toHaveBeenCalledWith(false);
        expect(window.AppMarket.loadCapitalData).not.toHaveBeenCalled();
    });

    it('切到基金 Tab 只刷新基金净值，且进入全量刷新任务', async () => {
        installHarness();
        window.AppFunds.getFundCodes = () => ['110022'];
        await import('../app/modules/refresh-coordinator.js');

        await window.AppRefreshCoordinator.refreshTab('funds');
        expect(window.AppFunds.loadFundQuotes).toHaveBeenCalledTimes(1);
        expect(window.AppMarket.loadIndexData).not.toHaveBeenCalled();
        expect(window.AppSignals.loadHotRankData).not.toHaveBeenCalled();

        await window.AppRefreshCoordinator.refreshAll({ skipLimitUp: true, skipOpportunity: true });
        expect(window.AppFunds.loadFundQuotes).toHaveBeenCalledTimes(2);
    });

    it('基金筛选子 Tab 激活时随基金刷新，未激活时不额外请求', async () => {
        installHarness();
        window.AppFundBoard.isActive = () => true;
        await import('../app/modules/refresh-coordinator.js');

        await window.AppRefreshCoordinator.refreshTab('funds');
        expect(window.AppFundBoard.loadBoard).toHaveBeenCalledWith(false);
    });

    it('普通刷新任务并发不超过 3 个', async () => {
        let active = 0;
        let maxActive = 0;
        const enter = () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            return new Promise((resolve) => setTimeout(() => {
                active -= 1;
                resolve();
            }, 0));
        };
        window.AppDataClient.fetchData.mockImplementation(enter);
        window.AppMarket.loadIndexData.mockImplementation(enter);
        window.AppMarket.loadMarketBreadthData.mockImplementation(enter);
        window.AppMarket.loadCapitalData.mockImplementation(enter);
        window.AppMarket.loadSectorData.mockImplementation(enter);
        window.AppSignals.loadHotRankData.mockImplementation(enter);
        await import('../app/modules/refresh-coordinator.js');

        await window.AppRefreshCoordinator.refreshAll({ skipLimitUp: true, skipOpportunity: true });

        expect(maxActive).toBeLessThanOrEqual(3);
    });

    it('详情页任务也受 3 个普通请求并发上限约束并保留结果顺序', async () => {
        let active = 0;
        let maxActive = 0;
        const loaders = Array.from({ length: 5 }, (_, index) => () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            return new Promise((resolve) => setTimeout(() => {
                active -= 1;
                resolve(index);
            }, 0));
        });
        await import('../app/modules/refresh-coordinator.js');

        const results = await window.AppRefreshCoordinator.runDetail(loaders.map((run) => ({ run })));

        expect(maxActive).toBeLessThanOrEqual(3);
        expect(results.map((item) => item.value)).toEqual([0, 1, 2, 3, 4]);
    });

    it('主窗口隐藏但持仓浮窗可见时继续按主行情周期只刷新持仓', async () => {
        vi.useFakeTimers();
        const setVisibility = mockVisibility('visible');
        const { watchCodes } = installHarness();
        const holdingCodes = watchCodes.slice(0, 2);
        window.AppState.isAutoRefresh = true;
        window.AppDataClient.fetchData.mockResolvedValue({
            success: true,
            data: Object.fromEntries(holdingCodes.map((code) => [code, {
                code,
                name: code,
                price: '10.00',
                priceValue: 10,
                changePercent: 1,
                change: 0.1,
            }])),
            time: '09:30:00',
            meta: { stale: false },
        });
        await import('../app/modules/refresh-coordinator.js');

        window.AppRefreshCoordinator.start();
        await window.AppRefreshCoordinator.setHoldingVisible(true);
        setVisibility('hidden');
        window.AppDataClient.fetchData.mockClear();
        window.AppMarket.loadIndexData.mockClear();
        window.AppWatchlist.loadWatchMarketWarnings.mockClear();

        await vi.advanceTimersByTimeAsync(10000);

        expect(window.AppDataClient.fetchData).toHaveBeenCalledTimes(1);
        expect(window.AppDataClient.fetchData.mock.calls[0][1].codes).toBe(holdingCodes.join(','));
        expect(window.AppMarket.loadIndexData).not.toHaveBeenCalled();
        expect(window.AppWatchlist.loadWatchMarketWarnings).not.toHaveBeenCalled();
        expect(window.shell.syncHoldingWidget).toHaveBeenLastCalledWith(expect.objectContaining({
            status: 'fresh',
        }));
    });

    it('浮窗隐藏后主窗口仍隐藏时停止持仓行情刷新', async () => {
        vi.useFakeTimers();
        const setVisibility = mockVisibility('visible');
        installHarness();
        window.AppState.isAutoRefresh = true;
        await import('../app/modules/refresh-coordinator.js');

        window.AppRefreshCoordinator.start();
        await window.AppRefreshCoordinator.setHoldingVisible(true);
        setVisibility('hidden');
        await window.AppRefreshCoordinator.setHoldingVisible(false);
        window.AppDataClient.fetchData.mockClear();

        await vi.advanceTimersByTimeAsync(30000);

        expect(window.AppDataClient.fetchData).not.toHaveBeenCalled();
        expect(window.AppRefreshCoordinator.isHoldingVisible()).toBe(false);
    });

    it('启动缓存没有本轮接收时间时不会把旧行情标记为 fresh', async () => {
        const { watchCodes } = installHarness();
        const holdingCodes = watchCodes.slice(0, 2);
        window.AppState.watchQuoteCache = Object.fromEntries(holdingCodes.map((code) => [code, {
            code,
            name: code,
            price: '10.00',
            priceValue: 10,
            changePercent: 1,
            change: 0.1,
        }]));
        window.AppState.watchQuoteFreshCodes = Object.fromEntries(holdingCodes.map((code) => [code, true]));
        window.AppState.watchQuoteUpdateTime = '09:30:00';
        await import('../app/modules/refresh-coordinator.js');

        await window.AppRefreshCoordinator.syncCurrentHoldingWidget();

        expect(window.shell.syncHoldingWidget).toHaveBeenLastCalledWith(expect.objectContaining({
            status: 'stale',
            updatedAt: '09:30:00',
        }));
        expect(window.shell.onHoldingWidgetVisibility).toHaveBeenCalledTimes(1);
    });
});

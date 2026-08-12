/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

function makeCodes(count) {
    return Array.from({ length: count }, (_, index) => String(600000 + index).padStart(6, '0'));
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
    window.shell = { syncHoldingWidget: vi.fn().mockResolvedValue({ ok: true }) };
    document.body.innerHTML = '<button id="refresh-btn"></button><div id="refresh-status"></div>';
    return { watchCodes };
}

describe('AppRefreshCoordinator', () => {
    beforeEach(() => {
        vi.resetModules();
        installHarness();
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
});

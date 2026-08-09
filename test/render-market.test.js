/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

function response(data, meta) {
    return {
        ok: true,
        json: vi.fn().mockResolvedValue({ success: true, data, meta: meta || {} }),
    };
}

function installHarness(options) {
    options = options || {};
    document.body.innerHTML = `
        <div data-sector-filter="boardType">
            <button class="sector-tab" data-value="industry"></button>
            <button class="sector-tab" data-value="concept"></button>
            <button class="sector-tab" data-value="region"></button>
        </div>
        <div data-sector-filter="period">
            <button class="sector-tab" data-value="today"></button>
            <button class="sector-tab" data-value="5d"></button>
            <button class="sector-tab" data-value="10d"></button>
        </div>
        <span id="sector-flow-status"></span>
        <div id="sector-bars-inflow"></div>
        <div id="sector-bars-outflow"></div>`;
    const storedFilter = options.storedFilter || { boardType: 'industry', period: 'today' };
    window.AppState = {
        KEYS: {
            SECTOR_TAB_KEY: 'sector-filter',
            SHORT_CACHE_KEYS: { sector: 'sector-cache' },
            SHORT_CACHE_TTL: { sector: 300000 },
            INDEX_PREV_KEY: 'index-prev',
            INDEX_REFRESH_SECONDS: 300,
        },
        liveSectorData: null,
    };
    window.AppUtils = { escapeHtml: (value) => String(value), setLastUpdated: vi.fn() };
    window.AppStorage = { getItem: vi.fn(), setItem: vi.fn() };
    window.AppCache = {
        readJson: vi.fn().mockReturnValue(storedFilter),
        writeJson: vi.fn(),
        readTimedCache: vi.fn().mockReturnValue(options.cached || null),
        writeTimedCache: vi.fn(),
    };
    window.AppDataClient = {
        fetch: options.fetch || vi.fn().mockResolvedValue(response({
            boardType: 'concept',
            period: '5d',
            inflow: [{ name: '概念流入', value: '+3.00亿', mainFundYuan: 300000000, changePct: 2 }],
            outflow: [{ name: '概念流出', value: '-2.00亿', mainFundYuan: -200000000, changePct: -1 }],
        })),
    };
}

describe('板块资金流筛选', () => {
    beforeEach(async () => {
        vi.resetModules();
        installHarness();
        await import('../app/modules/render-market.js');
    });

    it('把板块类型和周期传给后端并渲染对应结果', async () => {
        window.AppMarket.setSectorFilter('boardType', 'concept', false);
        window.AppMarket.setSectorFilter('period', '5d', false);
        await window.AppMarket.loadSectorData(true);

        expect(window.AppDataClient.fetch).toHaveBeenCalledWith('/market-data', {
            type: 'sector',
            boardType: 'concept',
            period: '5d',
        }, { force: true, cacheMode: 'bypass_fresh' });
        expect(document.getElementById('sector-bars-inflow').textContent).toContain('概念流入');
        expect(document.getElementById('sector-bars-outflow').textContent).toContain('概念流出');
    });

    it('接口失败时只复用同一筛选条件的短期缓存并明确标注', async () => {
        vi.resetModules();
        installHarness({
            storedFilter: { boardType: 'region', period: '10d' },
            cached: {
                boardType: 'region',
                period: '10d',
                inflow: [{ name: '地域缓存', value: '+1.00亿', mainFundYuan: 100000000, changePct: 1 }],
                outflow: [],
            },
            fetch: vi.fn().mockRejectedValue(new Error('offline')),
        });
        await import('../app/modules/render-market.js');

        await window.AppMarket.loadSectorData(false);

        expect(document.getElementById('sector-bars-inflow').textContent).toContain('地域缓存');
        expect(document.getElementById('sector-flow-status').textContent).toBe('接口不可用 · 显示缓存');
    });
});

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
        <div id="sector-bars-outflow"></div>
        <section class="market-breadth-section">
            <strong id="market-breadth-up"></strong>
            <strong id="market-breadth-flat"></strong>
            <strong id="market-breadth-down"></strong>
            <div id="market-breadth-track">
                <span data-breadth-segment="up"></span>
                <span data-breadth-segment="flat"></span>
                <span data-breadth-segment="down"></span>
            </div>
            <span id="market-breadth-summary"></span>
            <span id="market-breadth-status"></span>
        </section>`;
    const storedFilter = options.storedFilter || { boardType: 'industry', period: 'today' };
    window.AppState = {
        KEYS: {
            SECTOR_TAB_KEY: 'sector-filter',
            SHORT_CACHE_KEYS: { sector: 'sector-cache' },
            SHORT_CACHE_TTL: { sector: 300000 },
            INDEX_PREV_KEY: 'index-prev',
            INDEX_REFRESH_SECONDS: 300,
        },
        liveMarketBreadthData: null,
        liveSectorData: null,
    };
    window.AppUtils = { escapeHtml: (value) => String(value), setLastUpdated: vi.fn() };
    window.AppDataStatus = { label: (meta, fallback) => meta && meta.stale ? '缓存数据' : fallback };
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

    it('请求沪深京市场宽度并渲染涨跌家数与比例', async () => {
        window.AppDataClient.fetch = vi.fn().mockResolvedValue(response({
            available: true,
            up: 2535,
            down: 2841,
            flat: 167,
            covered: 5543,
            source: 'eastmoney',
            sourceLabel: '东方财富',
            markets: [],
        }));

        await window.AppMarket.loadMarketBreadthData(true);

        expect(window.AppDataClient.fetch).toHaveBeenCalledWith(
            '/market-data',
            { type: 'breadth' },
            { force: true, cacheMode: 'bypass_fresh' },
        );
        expect(document.getElementById('market-breadth-up').textContent).toBe('2,535');
        expect(document.getElementById('market-breadth-down').textContent).toBe('2,841');
        expect(document.getElementById('market-breadth-flat').textContent).toBe('167');
        expect(document.getElementById('market-breadth-summary').textContent)
            .toContain('有效统计 5,543 家');
        expect(document.querySelector('[data-breadth-segment="up"]').style.width).toBe('45.73%');
        expect(document.getElementById('market-breadth-status').textContent).toBe('东方财富 · 实时');
    });

    it('市场宽度刷新失败时保留会话结果并明确标记陈旧', async () => {
        window.AppState.liveMarketBreadthData = {
            available: true,
            up: 1200,
            down: 900,
            flat: 100,
            covered: 2200,
        };
        window.AppMarket.renderMarketBreadthUI(window.AppState.liveMarketBreadthData, '实时数据');
        window.AppDataClient.fetch = vi.fn().mockRejectedValue(new Error('offline'));

        await window.AppMarket.loadMarketBreadthData(false);

        expect(document.getElementById('market-breadth-up').textContent).toBe('1,200');
        expect(document.getElementById('market-breadth-status').textContent)
            .toBe('接口不可用 · 显示上次结果');
        expect(document.querySelector('.market-breadth-section').classList.contains('is-stale')).toBe(true);
    });

    it('按备用资金源返回的真实口径更新格子标签', () => {
        document.body.innerHTML = ['main-fund-value', 'large-value', 'medium-value', 'small-value', 'north-hgt-value', 'north-daily-value']
            .map((id) => '<div class="capital-item"><div class="capital-label"></div><div id="' + id + '"></div></div>')
            .join('');

        window.AppMarket.renderCapitalUI({
            mainFund: {
                label: '主力', value: '-41.62亿', isPositive: false,
                breakdown: {
                    large: { label: '主力流入', value: '+6260.88亿', isPositive: true },
                    medium: { label: '主力流出', value: '-6302.51亿', isPositive: false },
                    small: { label: '散户', value: '-33.09亿', isPositive: false },
                },
            },
        });

        expect(document.getElementById('large-value').previousElementSibling.textContent).toBe('主力流入');
        expect(document.getElementById('large-value').classList.contains('positive')).toBe(true);
        expect(document.getElementById('medium-value').textContent).toBe('-6302.51亿');
        expect(document.getElementById('small-value').previousElementSibling.textContent).toBe('散户');
        expect(document.getElementById('north-daily-value').classList.contains('neutral')).toBe(true);
    });

    it('刷新失败时保留本次会话已显示的指数并明确标记陈旧', async () => {
        document.body.innerHTML = `
            <section class="index-section">
                <div class="card-header"><h2>大盘指数</h2></div>
                <div data-index="shangzhi">
                    <span id="shangzhi-value">3210.88</span>
                    <span id="shangzhi-change">+0.52%</span>
                </div>
            </section>`;
        window.AppState.liveIndexData = { shangzhi: { value: '3210.88', changePercent: 0.52 } };
        window.AppDataClient.fetch = vi.fn().mockRejectedValue(new Error('offline'));

        await window.AppMarket.loadIndexData(true);

        expect(document.getElementById('shangzhi-value').textContent).toBe('3210.88');
        expect(document.querySelector('.index-section').classList.contains('is-stale')).toBe(true);
        expect(window.AppUtils.setLastUpdated).toHaveBeenCalledWith('行情更新失败 · 显示上次结果');
    });

    it('指数分时线横向铺满卡片并按昨收绘制零轴', () => {
        const svg = window.AppMarket.buildIndexSparklineSvg({
            sparkline: Array.from({ length: 242 }, (_, index) => 99 + index / 242),
            priceValue: 101,
            changePercent: 1,
        }, 'positive', null);

        expect(svg).toContain('preserveAspectRatio="none"');
        expect(svg).toContain('class="index-sparkline-zero"');
        expect(svg).toContain('class="index-sparkline-path"');
        expect(svg).toContain('aria-label="当日走势"');
    });

    it('盘中指数分时按已有点绘制，不要求提前凑满全天242点', () => {
        const data = { sparkline: Array.from({ length: 112 }, (_, index) => 99 + index / 112) };
        expect(window.AppMarket.indexSparklineStatus(data)).toEqual({
            available: true, total: 112, valid: 112, reason: '',
        });
        const svg = window.AppMarket.buildIndexSparklineSvg(data, 'neutral', null);
        expect(svg).toContain('class="index-sparkline-path"');
        expect(svg).not.toContain('L178.00 ');
    });

    it('指数分时少于两个有效点时明确不可用', () => {
        const data = { sparkline: [99, null] };
        expect(window.AppMarket.indexSparklineStatus(data)).toEqual({
            available: false, total: 2, valid: 1, reason: '分时数据暂不足（1）',
        });
        expect(window.AppMarket.buildIndexSparklineSvg(data, 'neutral', null)).toBe('');
    });
});

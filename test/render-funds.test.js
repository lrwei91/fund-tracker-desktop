/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

function installDom() {
    document.body.innerHTML = `
        <input id="fund-input">
        <button id="add-fund-btn">添加基金</button>
        <div id="fund-watch-status"></div>
        <span id="fund-watch-update-time"></span>
        <div id="fund-watch-list"></div>
    `;
}

function quoteResult(name = '易方达消费行业股票', change = -0.1) {
    return {
        success: true,
        data: {
            110022: {
                code: '110022',
                name,
                unitNav: 2.95,
                cumulativeNav: 2.95,
                previousNav: 2.953,
                dayChangePercent: change,
                navDate: '2026-08-12',
            },
        },
        time: '2026-08-12',
        meta: { missingCodes: [] },
    };
}

async function installModule(storedFunds = []) {
    const storage = new Map([
        ['fund_tracker_fund_watchlist', JSON.stringify(storedFunds)],
    ]);
    window.AppStorage = {
        getItem: vi.fn((key) => storage.get(key) || null),
        setItem: vi.fn((key, value) => storage.set(key, String(value))),
    };
    window.AppUtils = {
        escapeHtml: (value) => String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    };
    window.AppUiState = {
        render: (_kind, options) => `<div class="ui-state">${options.title}</div>`,
    };
    window.AppDataClient = { fetchData: vi.fn() };
    await import('../app/modules/render-funds.js');
    window.AppFunds.initFunds();
    return { storage };
}

describe('AppFunds', () => {
    beforeEach(() => {
        vi.resetModules();
        installDom();
    });

    it('恢复基金列表但初始化不自动请求，显式刷新才批量取净值', async () => {
        await installModule([{ code: '110022', name: '易方达消费行业股票', type: '股票型' }]);
        expect(document.querySelector('[data-fund-code="110022"]')).not.toBeNull();
        expect(window.AppDataClient.fetchData).not.toHaveBeenCalled();

        window.AppDataClient.fetchData.mockResolvedValue(quoteResult());
        await window.AppFunds.loadFundQuotes(true);

        expect(window.AppDataClient.fetchData).toHaveBeenCalledWith(
            '/fund-quotes',
            { codes: '110022' },
            { force: true, cacheMode: 'bypass_fresh' },
        );
        expect(document.querySelector('.fund-watch-nav strong').textContent).toBe('2.9500');
        expect(document.querySelector('.fund-watch-change').textContent).toBe('-0.10%');
    });

    it('交易时段批量获取自选基金盘中估值', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-13T10:01:00+08:00'));
        await installModule([{ code: '110022', name: '易方达消费行业股票', type: '股票型' }]);
        window.AppDataClient.fetchData.mockImplementation((path) => Promise.resolve(path === '/fund-intraday'
            ? { success: true, data: { 110022: { points: [] } }, meta: { subscription: { acceptedCodes: ['110022'] } } }
            : { success: true, data: { 110022: 0.36 } }));

        await window.AppFunds.loadFundIntraday(false);
        expect(window.AppDataClient.fetchData).toHaveBeenCalledWith(
            '/fund-board-realtime',
            { codes: '110022' },
            { force: false, cacheMode: 'normal' },
        );
        expect(document.querySelector('.fund-watch-intraday').textContent).toContain('+0.36%');
        vi.useRealTimers();
    });

    it('按分钟采样实时估值并渲染基金分时走势', async () => {
        await installModule([{ code: '110022', name: '易方达消费行业股票', type: '股票型' }]);
        window.AppFunds.applyFundIntraday({ success: true, data: { 110022: 0.12 } }, ['110022'], new Date('2026-08-13T09:31:10+08:00').getTime());
        window.AppFunds.applyFundIntraday({ success: true, data: { 110022: 0.28 } }, ['110022'], new Date('2026-08-13T09:32:10+08:00').getTime());

        const intraday = document.querySelector('.fund-watch-intraday');
        expect(intraday.textContent).toContain('+0.28%');
        expect(intraday.textContent).toContain('09:32');
        const line = intraday.querySelector('.fund-watch-intraday-line');
        expect(line.getAttribute('vector-effect')).toBe('non-scaling-stroke');
        expect(line.getAttribute('d')).toContain('C');
        expect(intraday.querySelector('svg').getAttribute('shape-rendering')).toBe('geometricPrecision');
        expect(intraday.querySelector('.fund-watch-intraday-dot').tagName).toBe('path');
        expect(intraday.querySelector('.fund-watch-intraday-dot').getAttribute('vector-effect')).toBe('non-scaling-stroke');
    });

    it('合并共享全天曲线并压缩午间休市时段', async () => {
        await installModule([{ code: '110022', name: '易方达消费行业股票', type: '股票型' }]);
        window.AppFunds.applyFundIntraday(
            { success: true, data: { 110022: 0.1 } }, ['110022'],
            new Date('2026-08-13T11:30:00+08:00').getTime(),
        );
        window.AppFunds.applySharedFundIntraday({
            success: true,
            data: { 110022: { points: [
                { time: new Date('2026-08-13T11:30:00+08:00').getTime(), value: 0.2 },
                { time: new Date('2026-08-13T13:01:00+08:00').getTime(), value: 0.3 },
            ] } },
            meta: { subscription: { acceptedCodes: ['110022'] } },
        }, ['110022']);

        const intraday = document.querySelector('.fund-watch-intraday');
        expect(intraday.textContent).toContain('+0.30%');
        expect(intraday.textContent).toContain('共享采集');
        const path = intraday.querySelector('.fund-watch-intraday-line').getAttribute('d');
        expect(path.match(/M/g)).toHaveLength(1);
        expect(path).toContain('C');
        const coordinatePairs = path.match(/-?\d+\.\d+,-?\d+\.\d+/g);
        const firstX = Number(coordinatePairs[0].split(',')[0]);
        const lastX = Number(coordinatePairs[coordinatePairs.length - 1].split(',')[0]);
        expect(lastX - firstX).toBeLessThan(1);
        expect(window.AppFunds.mergeIntradayPoints(
            [{ time: 1_000_000, value: 0.1 }],
            [{ time: 1_000_000, value: 0.2 }],
        )[0].value).toBe(0.2);
    });

    it('盘中真实缺采样超过二十分钟时仍保留断线', async () => {
        await installModule([{ code: '110022', name: '易方达消费行业股票', type: '股票型' }]);
        window.AppFunds.applySharedFundIntraday({
            success: true,
            data: { 110022: { points: [
                { time: new Date('2026-08-13T10:00:00+08:00').getTime(), value: 0.2 },
                { time: new Date('2026-08-13T10:25:00+08:00').getTime(), value: 0.3 },
            ] } },
            meta: { subscription: { acceptedCodes: ['110022'] } },
        }, ['110022']);

        const path = document.querySelector('.fund-watch-intraday-line').getAttribute('d');
        expect(path.match(/M/g)).toHaveLength(2);
        expect(path).not.toContain('C');
    });

    it('共享采集池满时明确标记未纳入', async () => {
        await installModule([{ code: '110022', name: '易方达消费行业股票', type: '股票型' }]);
        window.AppFunds.applySharedFundIntraday({
            success: true,
            data: {},
            meta: { subscription: { rejectedCodes: [{ code: '110022', reason: 'pool_full' }] } },
        }, ['110022']);
        expect(document.querySelector('.fund-watch-intraday').textContent).toContain('未纳入共享采集');
    });

    it('同一分钟重复采样只更新当前点且过滤异常估值', async () => {
        await installModule([{ code: '110022', name: '易方达消费行业股票', type: '股票型' }]);
        const sampledAt = new Date('2026-08-13T10:05:10+08:00').getTime();
        expect(window.AppFunds.applyFundIntraday({ success: true, data: { 110022: 0.1 } }, ['110022'], sampledAt)).toBe(true);
        expect(window.AppFunds.applyFundIntraday({ success: true, data: { 110022: 0.2 } }, ['110022'], sampledAt + 20_000)).toBe(true);
        expect(window.AppFunds.applyFundIntraday({ success: true, data: { 110022: 99 } }, ['110022'], sampledAt + 60_000)).toBe(false);
        expect(document.querySelector('.fund-watch-intraday').textContent).toContain('+0.20%');
        expect(document.querySelector('.fund-watch-intraday svg')).toBeNull();
    });

    it('按名称搜索后添加基金，并持久化独立基金列表', async () => {
        const { storage } = await installModule();
        window.AppDataClient.fetchData.mockImplementation((path) => {
            if (path === '/fund-search') {
                return Promise.resolve({ data: [{ code: '110022', name: '易方达消费行业股票', type: '股票型' }] });
            }
            return Promise.resolve(quoteResult());
        });
        document.getElementById('fund-input').value = '易方达消费';
        document.getElementById('add-fund-btn').click();
        await vi.waitFor(() => expect(document.querySelector('[data-fund-code="110022"]')).not.toBeNull());
        await vi.waitFor(() => expect(document.querySelector('.fund-watch-nav strong').textContent).toBe('2.9500'));

        expect(JSON.parse(storage.get('fund_tracker_fund_watchlist'))).toEqual([
            { code: '110022', name: '易方达消费行业股票', type: '股票型' },
        ]);
        expect(window.AppDataClient.fetchData.mock.calls[0][0]).toBe('/fund-search');
    });

    it('不伪造货币基金日涨跌，远端名称按纯文本转义', async () => {
        await installModule([{ code: '110022', name: '待刷新', type: '货币型' }]);
        window.AppDataClient.fetchData.mockResolvedValue(quoteResult('<img src=x onerror=alert(1)>', null));
        await window.AppFunds.loadFundQuotes(false);

        expect(document.querySelector('.fund-watch-identity strong').textContent).toBe('<img src=x onerror=alert(1)>');
        expect(document.querySelector('.fund-watch-identity img')).toBeNull();
        expect(document.querySelector('.fund-watch-change').textContent).toBe('--');
    });

    it('刷新失败时保留本次会话已有净值并标记过期', async () => {
        await installModule([{ code: '110022', name: '易方达消费行业股票', type: '股票型' }]);
        window.AppDataClient.fetchData.mockResolvedValueOnce(quoteResult());
        await window.AppFunds.loadFundQuotes(false);
        window.AppDataClient.fetchData.mockRejectedValueOnce(new Error('network'));
        await expect(window.AppFunds.loadFundQuotes(true)).rejects.toThrow('network');

        expect(document.querySelector('.fund-watch-nav strong').textContent).toBe('2.9500');
        expect(document.querySelector('.fund-watch-row').classList.contains('is-stale')).toBe(true);
        expect(document.getElementById('fund-watch-status').textContent).toContain('显示本次会话上次数据');
    });

    it('导入时去重和过滤非法代码，删除后同步持久化', async () => {
        const { storage } = await installModule();
        window.AppDataClient.fetchData.mockResolvedValue(quoteResult());
        const count = window.AppFunds.importFunds([
            { code: '110022', name: '基金一', type: '股票型' },
            { code: '110022', name: '重复项' },
            { code: '<bad>', name: '恶意项' },
        ]);
        expect(count).toBe(1);
        expect(window.AppFunds.exportFunds()).toEqual([{ code: '110022', name: '基金一', type: '股票型' }]);

        document.querySelector('[data-remove-fund="110022"]').click();
        expect(JSON.parse(storage.get('fund_tracker_fund_watchlist'))).toEqual([]);
    });
});

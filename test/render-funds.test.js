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

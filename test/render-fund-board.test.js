/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

function installDom() {
    document.body.innerHTML = `
        <div id="tab-funds" class="active">
            <button data-fund-view="watch" class="active"></button>
            <button data-fund-view="board"></button>
            <section data-fund-panel="watch" class="active"></section>
            <section data-fund-panel="board" hidden></section>
            <input id="fund-board-search">
            <button data-fund-board-filter="" class="active"></button>
            <button data-fund-board-filter="5star"></button>
            <button data-fund-board-filter="内部买"></button>
            <button id="fund-board-sort"></button>
            <button id="fund-board-help"></button>
            <div id="fund-board-status"></div>
            <div id="fund-board-summary"></div>
            <div id="fund-board-grid"></div>
        </div>
        <div id="fund-board-help-modal" hidden><button id="fund-board-help-close"></button></div>`;
    Object.defineProperty(document.getElementById('fund-board-grid'), 'clientWidth', { value: 900 });
}

function boardPayload() {
    return {
        success: true,
        data: {
            funds: [
                { sector: '有色金属', name: '五星内部基金', code: '017193', weekReturn: '1.35%', stars: '★★★★★', tags: '涨得多、内部买', redemptionFee: '7免' },
                { sector: '有色金属', name: '普通基金', code: '015596', weekReturn: '1.60%', stars: '★★★', tags: '有机构', redemptionFee: '7免' },
                { sector: '半导体', name: '芯片基金', code: '012345', weekReturn: '-1.20%', stars: '★★★★', tags: '跌得少', redemptionFee: '30免' },
            ],
            etfInfo: { 有色金属: { code: '512400.SH', name: '有色ETF' } },
        },
        meta: { stale: false },
    };
}

function installGlobals() {
    window.AppUtils = { escapeHtml: (value) => String(value) };
    window.AppUiState = {
        render: (kind, options) => `<div data-kind="${kind}">${options.title}${options.retryScope ? `<button data-ui-retry="${options.retryScope}">重新加载</button>` : ''}</div>`,
        bindRetries: (container, callback) => {
            container.addEventListener('click', (event) => {
                const button = event.target.closest('[data-ui-retry]');
                if (button) callback(button.dataset.uiRetry, button);
            });
        },
    };
    window.AppStorage = {
        getItem: vi.fn(() => 'watch'),
        setItem: vi.fn(),
    };
    window.pinyinPro = {
        pinyin: vi.fn((value, options) => options.pattern === 'first' ? 'wxnbjj ysjs' : 'wuxingneibujijin yousejinshu'),
    };
    window.AppDataClient = {
        fetchData: vi.fn((path) => {
            if (path === '/fund-board') return Promise.resolve(boardPayload());
            if (path === '/fund-board-trends') return Promise.resolve({ success: true, data: { 有色金属: 2.1, 半导体: -1.2 } });
            if (path === '/fund-board-realtime') return Promise.resolve({ success: true, data: { '017193': 1.08, '015596': -0.5 } });
            throw new Error(`unexpected ${path}`);
        }),
    };
}

describe('AppFundBoard', () => {
    beforeEach(async () => {
        vi.resetModules();
        installDom();
        installGlobals();
        await import('../app/modules/render-fund-board.js');
    });

    it('复用基金筛选数值与星级算法，并预计算名称/板块拼音', () => {
        expect(window.AppFundBoard.parseValue('65.2亿(-13.3亿)')).toBe(65.2);
        expect(window.AppFundBoard.getStarCount('★★★★★')).toBe(5);
        const items = window.AppFundBoard.normalizeFunds(boardPayload().data.funds);
        expect(items).toHaveLength(3);
        expect(items[0]._search).toContain('wxnbjj');
        expect(items[0]._search).toContain('wuxingneibujijin');
    });

    it('加载基金池、板块 ETF、板块涨幅与实时估值并渲染', async () => {
        await window.AppFundBoard.loadBoard(false);
        expect(window.AppDataClient.fetchData.mock.calls.map((call) => call[0]))
            .toEqual(['/fund-board', '/fund-board-trends', '/fund-board-realtime']);
        expect(document.getElementById('fund-board-grid').textContent).toContain('有色金属');
        expect(document.getElementById('fund-board-grid').textContent).toContain('有色ETF');
        expect(document.getElementById('fund-board-grid').textContent).toContain('+2.10%');
        expect(document.getElementById('fund-board-grid').textContent).toContain('+1.08%');
        expect(document.getElementById('fund-board-summary').textContent).toBe('2 个板块 · 3 只基金');
    });

    it('恢复到基金筛选子页时确保首次加载且复用同一在途请求', async () => {
        vi.useFakeTimers();
        window.AppStorage.getItem.mockReturnValue('board');
        window.AppFundBoard.initFundBoard();

        await window.AppFundBoard.ensureLoaded();
        expect(window.AppDataClient.fetchData.mock.calls.filter((call) => call[0] === '/fund-board')).toHaveLength(1);
        expect(document.querySelector('[data-fund-panel="board"]').hidden).toBe(false);
        expect(document.getElementById('fund-board-grid').textContent).toContain('有色金属');
        vi.useRealTimers();
    });

    it('首次加载失败后显示错误态并可重新加载', async () => {
        vi.useFakeTimers();
        window.AppDataClient.fetchData.mockImplementationOnce(() => Promise.reject(new Error('network timeout')));
        window.AppFundBoard.initFundBoard();
        window.AppFundBoard.selectView('board');
        await expect(window.AppFundBoard.ensureLoaded()).rejects.toThrow('network timeout');

        expect(document.getElementById('fund-board-grid').textContent).toContain('基金数据加载失败');
        document.querySelector('[data-ui-retry="fund-board"]').click();
        await vi.waitFor(() => expect(document.getElementById('fund-board-grid').textContent).toContain('有色金属'));
        vi.useRealTimers();
    });

    it('五星与内部买筛选采用 AND 组合语义', async () => {
        vi.useFakeTimers();
        window.AppFundBoard.initFundBoard();
        await window.AppFundBoard.loadBoard(false);
        document.querySelector('[data-fund-board-filter="5star"]').click();
        document.querySelector('[data-fund-board-filter="内部买"]').click();
        const text = document.getElementById('fund-board-grid').textContent;
        expect(text).toContain('五星内部基金');
        expect(text).not.toContain('普通基金');
        expect(text).not.toContain('芯片基金');
        expect(document.getElementById('fund-board-summary').textContent).toBe('1 个板块 · 1 只基金');
        vi.useRealTimers();
    });
});

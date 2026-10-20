/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const html = readFileSync('app/index.html', 'utf8');
const script = readFileSync('app/modules/workbench.js', 'utf8');
function install() {
    document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
    window.AppState = { KEYS: { VALID_TABS: ['dashboard', 'market', 'research', 'alerts', 'news'], TAB_TITLES: { dashboard: '我的盯盘', market: '市场总览', research: '研究工作台', alerts: '提醒中心', news: '财经资讯' } }, currentTab: 'dashboard' };
    window.AppStorage = { setItem: vi.fn() };
    window.AppUtils = { escapeHtml: (s) => String(s).replaceAll('<', '&lt;').replaceAll('>', '&gt;') };
    window.AppWatchlist = { getHoldingCodes: () => ['600000', '600001'] };
    window.AppPriceAlerts = { getCodes: () => [], refresh: vi.fn() };
    window.AppRefreshCoordinator = { refreshTab: vi.fn() };
    window.eval(script);
}
describe('个人盯盘工作台', () => {
    beforeEach(install);
    it('五入口保留对应页面且没有重复 ID', () => {
        expect(Array.from(document.querySelectorAll('.desktop-nav .tab-btn')).map((n) => n.dataset.tab)).toEqual(['dashboard', 'market', 'research', 'alerts', 'news']);
        const ids = Array.from(document.querySelectorAll('[id]')).map((n) => n.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(document.querySelector('#tab-dashboard .watchlist-section')).not.toBeNull();
        expect(document.querySelector('#tab-market .hot-rank-section')).not.toBeNull();
        expect(document.querySelector('#tab-research #report-center')).not.toBeNull();
        expect(document.querySelector('#tab-alerts #price-alert-workspace')).not.toBeNull();
    });
    it('缺数量、成本和过期报价不会被补零计入统计', () => {
        const result = window.AppWorkbench.calculate(['a', 'b', 'c', 'd'], { a: { shares: 100, cost: 8 }, b: { shares: 0, cost: 8 }, c: { shares: 50 }, d: { shares: 100, cost: 1 } }, { a: { priceValue: 10 }, b: { priceValue: 10 }, c: { priceValue: 20 }, d: { priceValue: 99 } }, { a: true, b: true, c: true, d: false });
        expect(result).toEqual({ marketValue: 2000, pnl: 200, valueCount: 2, pnlCount: 1, total: 4 });
        expect(window.AppWorkbench.calculate(['a'], {}, {}, {}).marketValue).toBeNull();
        expect(window.AppWorkbench.calculate([], {}, {}, {}).pnl).toBeNull();
    });
    it('旧选股链接映射研究页，导航仅刷新数据不执行模型', () => {
        window.AppWorkbench.navigate('signals', false);
        expect(window.AppState.currentTab).toBe('research');
        expect(document.querySelector('.tab-panel.active').id).toBe('tab-research');
        expect(document.querySelector('[data-tab="research"]').getAttribute('aria-current')).toBe('page');
        expect(window.AppRefreshCoordinator.refreshTab).toHaveBeenCalledWith('research');
        window.AppWorkbench.navigate('funds', false);
        expect(window.AppState.currentTab).toBe('dashboard');
    });
    it('宽屏详情不会令列表 inert，关闭后保留焦点', () => {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
        const trigger = document.createElement('button'); document.getElementById('watchlist-grid').appendChild(trigger);
        window.AppWorkbench.openDetail('600000', trigger);
        expect(document.querySelector('#stock-detail-dock #stock-fund-panel')).not.toBeNull();
        expect(document.getElementById('stock-fund-panel').hidden).toBe(false);
        expect(document.getElementById('app-shell').inert).not.toBe(true);
        window.AppWorkbench.closeDetail();
        expect(document.getElementById('stock-fund-panel').hidden).toBe(true);
        expect(document.activeElement).toBe(trigger);
    });
});

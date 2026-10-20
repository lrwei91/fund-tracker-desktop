/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const source = readFileSync('app/modules/research-reports.js', 'utf8');
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
describe('研究报告中心', () => {
    let api, onState;
    beforeEach(() => {
        document.body.innerHTML = '<section id="report-center"></section>';
        window.AppUtils = { escapeHtml: (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;') };
        api = vi.fn().mockImplementation(async (_route, query) => {
            if (!query || !query.op || query.op === 'settings') return { data: { settings: { premarket: false, afterClose: false }, items: [], calendarKnown: true } };
            if (query.op === 'run') return { data: { id: 'fixture' } };
            return { data: { id: 'fixture', slot: 'afterClose', status: 'queued', tradeDate: '2026-10-20', createdAt: '2026-10-20T07:30:00Z', message: '排队' } };
        });
        window.AppDataClient = { fetchData: api };
        window.shell = { onReportState: (fn) => { onState = fn; }, onReportOpen: vi.fn() };
        window.AppStorage = { flush: vi.fn().mockResolvedValue(undefined) };
        window.AppAlerts = { showStatusToast: vi.fn() };
        window.eval(source);
    });
    it('打开与刷新只读记录，默认关闭自动任务且不调用研究接口', async () => {
        window.AppReports.init(); await settle();
        expect(api).toHaveBeenCalledWith('/research-reports', {});
        expect(document.querySelector('[name="premarket"]').checked).toBe(false);
        expect(api.mock.calls.every(([, q]) => !q.op)).toBe(true);
        document.querySelector('[data-report-refresh]').click(); await settle();
        expect(api.mock.calls.every(([, q]) => !q.op)).toBe(true);
    });
    it('只有明确点击才创建报告，并先保存本地持仓', async () => {
        window.AppReports.init(); await settle();
        document.querySelector('[data-report-run="afterClose"]').click(); await settle();
        expect(window.AppStorage.flush).toHaveBeenCalledTimes(1);
        expect(api.mock.calls.filter(([, q]) => q.op === 'run')).toEqual([['/research-reports', { op: 'run', slot: 'afterClose' }]]);
        expect(api.mock.calls.every(([route]) => route === '/research-reports')).toBe(true);
    });
    it('启用任务持久保存双开关，不直接生成模型请求', async () => {
        window.AppReports.init(); await settle();
        const input = document.querySelector('[name="premarket"]'); input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); await settle();
        const call = api.mock.calls.find(([, q]) => q.op === 'settings');
        expect(JSON.parse(call[1].settings)).toEqual({ premarket: true, afterClose: false });
        expect(api.mock.calls.some(([, q]) => q.op === 'run')).toBe(false);
    });
    it('报告不将模型文本当 HTML，并单独显示本机统计和时点', () => {
        const markup = window.AppReports.renderDocument({ tradeDate: '2026-10-20', slot: 'afterClose', status: 'partial', facts: { expectedQuoteDate: '2026-10-20', portfolio: { marketValue: 1000, unrealizedPnl: 200, valueCount: 1, pnlCount: 1, holdingCount: 2 }, snapshots: [], excluded: [{ code: '510300', reason: 'ETF未深研' }] }, report: { summary: '<img src=x onerror=alert(1)>', stocks: [], portfolioRisks: ['风险'], watchConditions: [], limitations: ['部分覆盖'] } });
        const doc = new DOMParser().parseFromString(markup, 'text/html');
        expect(doc.querySelector('img')).toBeNull();
        expect(doc.body.textContent).toContain('<img');
        expect(doc.body.textContent).toContain('1/2只');
        expect(doc.body.textContent).toContain('2026-10-20 收盘');
        expect(doc.body.textContent).toContain('510300');
    });
    it('原生进度事件刷新状态但不会再发起模型任务', async () => {
        window.AppReports.init(); await settle(); await onState({ id: 'fixture' });
        expect(api.mock.calls.every(([, q]) => !q.op)).toBe(true);
    });
});

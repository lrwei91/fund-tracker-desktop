/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('统一研究与价格提醒', () => {
    beforeEach(async () => {
        vi.resetModules();
        // Node 26 的同名全局不是浏览器存储，明确使用测试 DOM 的 Storage。
        vi.stubGlobal('localStorage', globalThis.jsdom.window.localStorage);
        window.localStorage.clear();
        document.body.innerHTML = '<div id="detail"></div><div id="alerts"></div>';
        delete window.AppRefreshCoordinator;
        await import('../app/modules/utils.js');
        await import('../app/modules/stock-research.js');
        await import('../app/modules/price-alerts.js');
    });

    it('缺失指标保留空值，模型文本不能注入 HTML', () => {
        const financial = window.AppResearch.renderFinancials({
            available: true,
            periods: [
                { reportDate: '2026-06-30', revenue: null, netProfit: 0, profitGrowth: null },
            ],
        });
        expect(financial).toContain('<td>--</td>');
        expect(financial).toContain('<td>0</td>');
        const report = window.AppResearch.renderReport({
            report: { rating: 'review', score: null, summary: '<img src=x onerror=alert(1)>' },
            quant: { score: null },
        });
        document.getElementById('detail').innerHTML = report;
        expect(document.querySelector('img')).toBeNull();
        expect(document.body.textContent).toContain('资料不足');
        expect(document.body.textContent).toContain('--');
    });

    it('打开详情只读取快照和历史，点击才请求模型', async () => {
        const fetchData = vi.fn(async (path, query) => {
            if (path === '/stock-research')
                return { data: { quote: {}, quant: { score: null }, financial: null } };
            if (query.mode === 'history') return { data: { items: [] } };
            return {
                data: {
                    code: query.code,
                    report: { rating: 'review', summary: '资料不足' },
                    quant: {},
                },
            };
        });
        window.AppDataClient = { fetchData };
        await window.AppResearch.mount(document.getElementById('detail'), '600519');
        expect(fetchData.mock.calls.some(([, query]) => query.mode === 'ai')).toBe(false);
        document.querySelector('[data-research-run]').click();
        await vi.waitFor(() =>
            expect(document.querySelector('[data-research-report]').textContent).toContain(
                '资料不足',
            ),
        );
        expect(fetchData).toHaveBeenCalledWith('/stock-ai-research', {
            code: '600519',
            mode: 'ai',
        });
    });

    it('模型失败后恢复按钮，允许重试', async () => {
        window.AppDataClient = {
            fetchData: vi.fn(async (path, query) => {
                if (path === '/stock-research') return { data: { quant: {} } };
                if (query.mode === 'history') return { data: { items: [] } };
                throw new Error('模型响应格式无效');
            }),
        };
        await window.AppResearch.mount(document.getElementById('detail'), '600519');
        const run = document.querySelector('[data-research-run]');
        run.click();
        await vi.waitFor(() => expect(run.disabled).toBe(false));
        expect(document.querySelector('[data-research-report]').textContent).toContain(
            '模型响应格式无效',
        );
    });

    it('提醒编辑保存组合条件并保留默认防重复设置', async () => {
        const doc = { rules: [], history: [], status: 'idle' };
        const fetchData = vi.fn(async () => ({ data: doc }));
        window.AppDataClient = { fetchData };
        await window.AppPriceAlerts.mount(document.getElementById('alerts'), '600519');
        document.querySelector('[data-alert-new]').click();
        const form = document.querySelector('.price-rule-form');
        form.elements.name.value = '放量达到观察价';
        form.querySelector('[data-condition-value]').value = '10';
        form.querySelector('[data-condition-add]').click();
        const conditions = form.querySelectorAll('.price-condition');
        conditions[1].querySelector('[data-condition-field]').value = 'volumeRatio';
        conditions[1].querySelector('[data-condition-value]').value = '2';
        form.dispatchEvent(new Event('submit', { cancelable: true }));
        await vi.waitFor(() =>
            expect(fetchData.mock.calls.some(([, q]) => q.op === 'save')).toBe(true),
        );
        const rule = JSON.parse(fetchData.mock.calls.find(([, q]) => q.op === 'save')[1].rule);
        expect(rule).toMatchObject({
            code: '600519',
            logic: 'and',
            edgeOnly: true,
            cooldownMinutes: 30,
            maxPerDay: 3,
        });
        expect(rule.conditions).toEqual([
            { field: 'price', op: '>=', value: 10 },
            { field: 'volumeRatio', op: '>=', value: 2 },
        ]);
        expect(window.localStorage.length).toBe(0);
    });

    it('详情里保存规则后同步提醒管理页', async () => {
        const doc = { rules: [], history: [] };
        window.AppDataClient = {
            fetchData: vi.fn(async (_path, query) => {
                if (query.op === 'save')
                    doc.rules.push({ ...JSON.parse(query.rule), id: 'sample-id' });
                return { data: doc };
            }),
        };
        await window.AppPriceAlerts.mount(document.getElementById('alerts'));
        await window.AppPriceAlerts.mount(document.getElementById('detail'), '600519');
        document.getElementById('detail').querySelector('[data-alert-new]').click();
        const form = document.querySelector('.price-rule-form');
        form.elements.name.value = '详情创建的规则';
        form.querySelector('[data-condition-value]').value = '10';
        form.dispatchEvent(new Event('submit', { cancelable: true }));
        await vi.waitFor(() =>
            expect(document.getElementById('alerts').textContent).toContain('详情创建的规则'),
        );
    });

    it('API 密钥只交给原生凭据命令，不写前端存储', async () => {
        document.body.innerHTML =
            '<form id="ai-settings-form"><input id="ai-base-url"><input id="ai-model"><input id="ai-api-key"><button type="submit">保存</button></form><button id="ai-clear-key"></button><p id="ai-settings-status"></p>';
        window.shell = {
            aiSettingsStatus: vi.fn(async () => ({ configured: false })),
            aiSettingsSave: vi.fn(async () => ({})),
        };
        window.AppResearch.init();
        await vi.waitFor(() =>
            expect(document.getElementById('ai-settings-status').textContent).toContain('尚未配置'),
        );
        document.getElementById('ai-base-url').value = 'https://api.example.com/v1';
        document.getElementById('ai-model').value = 'test-model';
        document.getElementById('ai-api-key').value = 'synthetic-test-key';
        document
            .getElementById('ai-settings-form')
            .dispatchEvent(new Event('submit', { cancelable: true }));
        await vi.waitFor(() => expect(window.shell.aiSettingsSave).toHaveBeenCalledOnce());
        expect(document.getElementById('ai-api-key').value).toBe('');
        expect(window.localStorage.length).toBe(0);
    });
    it.each(['save', 'clear', 'status'])('AI 设置 %s 显示原生命令的文字错误', async (action) => {
        document.body.innerHTML =
            '<form id="ai-settings-form"><input id="ai-base-url"><input id="ai-model"><input id="ai-api-key"><button type="submit">保存</button></form><button id="ai-clear-key"></button><p id="ai-settings-status"></p>';
        const failure = '模型 API 地址无效';
        window.shell = {
            aiSettingsStatus: vi.fn(async () => {
                if (action === 'status') throw failure;
                return { configured: false };
            }),
            aiSettingsSave: vi.fn(async () => {
                throw failure;
            }),
        };
        window.AppResearch.init();
        const status = document.getElementById('ai-settings-status');
        await vi.waitFor(() => expect(status.textContent).not.toBe(''));
        if (action === 'save') {
            document.getElementById('ai-base-url').value = 'http://127.0.0.1:8788/v1';
            document.getElementById('ai-model').value = 'test-model';
            document
                .getElementById('ai-settings-form')
                .dispatchEvent(new Event('submit', { cancelable: true }));
        } else if (action === 'clear') {
            document.getElementById('ai-clear-key').click();
        }
        await vi.waitFor(() => expect(status.textContent).toBe(failure));
        expect(document.querySelector('[type="submit"]').disabled).toBe(false);
    });
});

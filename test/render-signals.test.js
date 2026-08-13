/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function uiStateHtml(kind, options) {
    return '<div data-ui-state="' + kind + '">' + escapeHtml(options.title) + ' ' + escapeHtml(options.detail) + '</div>';
}

function intradayModuleHtml(options = {}) {
    const name = options.name || '安妮股份';
    const reason = options.reason || '量价配合良好';
    if (options.empty) {
        return '<div class="report-card report-rec">' +
            '<span class="report-rec__time">筛选快照：2026-08-12 14:30</span>' +
            '<div class="report-rec__board"><h3 class="report-rec__board-title">主板 TOP3</h3><div class="report-empty">暂无入选</div></div>' +
            '<div class="report-rec__board"><h3 class="report-rec__board-title">创业板 TOP3</h3><div class="report-empty">暂无入选</div></div>' +
        '</div>';
    }
    return '<div class="report-card report-rec">' +
        '<span class="report-rec__time">筛选快照：2026-08-12 14:30</span>' +
        '<div class="report-rec__board"><h3 class="report-rec__board-title">主板 TOP3</h3>' +
            '<table class="report-rec__table"><tbody>' +
                '<tr><td>#1</td><td><div class="report-stock-name">' + name + '</div>' +
                    '<div class="report-stock-meta">002235 · 传媒</div></td>' +
                    '<td><span class="report-score">66</span></td><td>+4.40%</td><td>12.63%</td><td>2.74</td><td>57.8亿</td></tr>' +
                '<tr class="report-rec__reason"><td colspan="7"><span class="report-chip">近10日涨停 2次</span>' +
                    '<ol><li>' + reason + '</li></ol></td></tr>' +
            '</tbody></table>' +
        '</div>' +
        '<div class="report-rec__board"><h3 class="report-rec__board-title">创业板 TOP3</h3><div class="report-empty">暂无入选</div></div>' +
    '</div>';
}

function readyResponse(overrides = {}) {
    return {
        ok: true,
        json: vi.fn().mockResolvedValue({
            success: true,
            data: {
                status: 'ready',
                snapshotDate: '2026-08-12',
                snapshotTime: '14:30',
                snapshotAt: '2026-08-12 14:30',
                source: 'portfolio',
                sourceLabel: '公开报告',
                moduleHtml: intradayModuleHtml(),
                ...overrides,
            },
            meta: { degraded: false },
        }),
    };
}

async function setupIntraday(fetchImpl = vi.fn().mockResolvedValue(readyResponse())) {
    vi.resetModules();
    document.body.innerHTML = '<button id="intraday-screening-run-btn">开始筛选</button>' +
        '<span id="intraday-screening-update-time"></span>' +
        '<div id="intraday-screening-status"></div>' +
        '<div id="intraday-screening-results"></div>';
    window.AppState = { KEYS: {} };
    window.AppUtils = {
        escapeHtml,
        getShanghaiDateKey: () => '2026-08-12',
    };
    window.AppCache = {};
    window.AppUiState = { render: uiStateHtml };
    window.AppDataClient = { fetch: fetchImpl };
    await import('../app/modules/render-signals.js');
    return fetchImpl;
}

function rotationResponse(overrides = {}) {
    return {
        success: true,
        data: {
            status: 'ready',
            snapshotDate: '2026-08-12',
            source: 'deepq-ticai',
            sourceLabel: 'DeepQ 题材记忆库',
            sectors: [
                { rank: 2, sectorName: '芯片', stocksCount: 8, heatValue: 86, rotationTimes: 3, rotationProb: '60%' },
                {
                    rank: 1,
                    sectorName: '医药',
                    stocksCount: 12,
                    heatValue: 100,
                    driveEvent: '创新药催化',
                    rotationTimes: 5,
                    rotationProb: '80%',
                    emotionalCycle: '发酵期',
                    recognitionBenchmark: '示例药业',
                    trendAnalysis: '主线强度提升',
                    tradingStrategy: '观察分歧承接',
                },
            ],
            ...overrides,
        },
        meta: { degraded: false, stale: false },
    };
}

async function setupRotation(fetchDataImpl = vi.fn().mockResolvedValue(rotationResponse())) {
    vi.resetModules();
    document.body.innerHTML = '<button id="sector-rotation-run-btn">获取板块轮动</button>' +
        '<span id="sector-rotation-update-time"></span>' +
        '<div id="sector-rotation-status"></div>' +
        '<div id="sector-rotation-results"></div>';
    window.AppState = { KEYS: {} };
    window.AppUtils = { escapeHtml, getShanghaiDateKey: () => '2026-08-13' };
    window.AppCache = {};
    window.AppUiState = { render: uiStateHtml };
    window.AppDataClient = { fetchData: fetchDataImpl };
    await import('../app/modules/render-signals.js');
    return fetchDataImpl;
}

describe('机会雷达风险提示', () => {
    beforeEach(async () => {
        vi.resetModules();
        document.body.innerHTML = '<div id="opportunity-radar-list"></div><span id="opportunity-radar-update-time"></span>';
        window.AppState = { KEYS: {} };
        window.AppUtils = {
            escapeHtml: (value) => String(value),
            formatShanghaiTime: () => '10:00',
            getShanghaiDateKey: () => '2026-08-10',
        };
        window.AppCache = { readJson: vi.fn(), writeJson: vi.fn() };
        window.AppDataStatus = { label: (_meta, fallback) => fallback || '' };
        await import('../app/modules/render-signals.js');
    });

    it('展示重点监控期限和严重异动规则', () => {
        window.AppSignals.renderOpportunityRadar({
            generatedAt: '2026-08-10T02:00:00Z',
            items: [{
                code: '920575',
                name: '示例',
                score: 40,
                pct: 5,
                coverage: 100,
                topic: '测试题材',
                risk: { status: 'block', label: '回避', reasons: ['重点监控', '严重异动'] },
                marketWarnings: {
                    monitored: true,
                    monitorEnd: '2026-08-14',
                    anomaly: true,
                    anomalyRule: '北交所10日内3次同向异常波动',
                },
                components: {},
                signals: [],
            }],
        }, true);

        const text = document.getElementById('opportunity-radar-list').textContent;
        expect(text).toContain('重点监控至 2026-08-14');
        expect(text).toContain('严重异动：北交所10日内3次同向异常波动');
        expect(text).toContain('回避');
    });
});

describe('轮动板块手动执行', () => {
    it('模块加载时不请求，点击后按强制刷新契约取数', async () => {
        const fetchDataMock = await setupRotation();
        expect(fetchDataMock).not.toHaveBeenCalled();

        await window.AppSignals.runSectorRotation();

        expect(fetchDataMock).toHaveBeenCalledTimes(1);
        expect(fetchDataMock).toHaveBeenCalledWith('/sector-rotation', {}, {
            force: true,
            cacheMode: 'bypass_fresh',
        });
    });

    it('按排名展示上一交易日数据，并转义上游文本', async () => {
        const fetchDataMock = vi.fn().mockResolvedValue(rotationResponse({
            sectors: [
                { rank: 2, sectorName: '芯片' },
                { rank: 1, sectorName: '<img src=x onerror="window.__rotationPwned=true">', driveEvent: '<script>boom()</script>' },
            ],
        }));
        await setupRotation(fetchDataMock);

        await window.AppSignals.runSectorRotation();

        const results = document.getElementById('sector-rotation-results');
        const cards = results.querySelectorAll('.sector-rotation-card');
        expect(cards).toHaveLength(2);
        expect(cards[0].textContent).toContain('<img src=x');
        expect(cards[1].textContent).toContain('芯片');
        expect(results.querySelector('img')).toBeNull();
        expect(results.querySelector('script')).toBeNull();
        expect(window.__rotationPwned).toBeUndefined();
        expect(document.getElementById('sector-rotation-update-time').textContent).toBe('数据日期：2026-08-12');
        expect(document.getElementById('sector-rotation-status').textContent).toContain('仅手动更新');
    });

    it('重复点击时合并在途请求，失败刷新保留已有结果', async () => {
        let resolveRequest;
        const fetchDataMock = vi.fn().mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));
        await setupRotation(fetchDataMock);
        const first = window.AppSignals.runSectorRotation();
        const second = window.AppSignals.runSectorRotation();
        expect(first).toBe(second);
        expect(fetchDataMock).toHaveBeenCalledTimes(1);
        expect(document.getElementById('sector-rotation-run-btn').disabled).toBe(true);
        resolveRequest(rotationResponse());
        await first;

        fetchDataMock.mockRejectedValueOnce(new Error('offline'));
        await window.AppSignals.runSectorRotation();
        expect(document.getElementById('sector-rotation-results').textContent).toContain('医药');
        expect(document.getElementById('sector-rotation-status').textContent).toContain('保留当前结果');
        expect(document.getElementById('sector-rotation-run-btn').disabled).toBe(false);
    });
});

describe('盘中筛选手动执行', () => {
    it('模块加载时不会自动请求，只有手动入口会取数', async () => {
        const fetchMock = await setupIntraday();

        expect(fetchMock).not.toHaveBeenCalled();
        await window.AppSignals.runIntradayScreening(true);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith('/intraday-screening', {}, {
            force: true,
            cacheMode: 'bypass_fresh',
        });
    });

    it('用惰性 DOM 解析完整字段、筹码标签和理由', async () => {
        await setupIntraday();

        await window.AppSignals.runIntradayScreening(true);

        const results = document.getElementById('intraday-screening-results');
        expect(results.textContent).toContain('主板 TOP3');
        expect(results.textContent).toContain('安妮股份');
        expect(results.textContent).toContain('002235 · 传媒');
        expect(results.textContent).toContain('66');
        expect(results.textContent).toContain('+4.40%');
        expect(results.textContent).toContain('12.63%');
        expect(results.textContent).toContain('2.74');
        expect(results.textContent).toContain('57.8亿');
        expect(results.querySelector('.intraday-screening-chip').textContent).toBe('近10日涨停 2次');
        expect(results.querySelector('.intraday-screening-reason').textContent).toContain('量价配合良好');
        expect(document.getElementById('intraday-screening-update-time').textContent).toBe('筛选快照：2026-08-12 14:30');
        expect(document.getElementById('intraday-screening-status').textContent).toContain('数据源：公开报告');
    });

    it('只从远程 DOM 取纯文本并在本地转义渲染', async () => {
        const malicious = '&lt;img src=x onerror="window.__intradayPwned=true"&gt;';
        const fetchMock = vi.fn().mockResolvedValue(readyResponse({
            moduleHtml: intradayModuleHtml({ name: malicious, reason: '&lt;script&gt;boom()&lt;/script&gt;' }),
        }));
        await setupIntraday(fetchMock);

        await window.AppSignals.runIntradayScreening(true);

        const results = document.getElementById('intraday-screening-results');
        expect(results.querySelector('img')).toBeNull();
        expect(results.querySelector('script')).toBeNull();
        expect(results.innerHTML).toContain('&lt;img src=x onerror=');
        expect(results.textContent).toContain('<script>boom()</script>');
        expect(window.__intradayPwned).toBeUndefined();
    });

    it('当日更新但无候选股时显示明确空态', async () => {
        const fetchMock = vi.fn().mockResolvedValue(readyResponse({ moduleHtml: intradayModuleHtml({ empty: true }) }));
        await setupIntraday(fetchMock);

        await window.AppSignals.runIntradayScreening(true);

        expect(document.getElementById('intraday-screening-results').textContent).toContain('今日暂无入选股票');
        expect(document.getElementById('intraday-screening-status').getAttribute('data-state')).toBe('ready');
    });

    it('结构损坏时拒绝渲染远程内容并进入错误态', async () => {
        const fetchMock = vi.fn().mockResolvedValue(readyResponse({
            moduleHtml: '<div class="report-rec__board"><h3 class="report-rec__board-title">主板 TOP3</h3><div>伪造候选</div></div>',
        }));
        await setupIntraday(fetchMock);

        await window.AppSignals.runIntradayScreening(true);

        const results = document.getElementById('intraday-screening-results');
        expect(results.textContent).toContain('盘中筛选暂不可用');
        expect(results.textContent).not.toContain('伪造候选');
        expect(document.getElementById('intraday-screening-status').getAttribute('data-state')).toBe('error');
    });

    it('双击期间合并在途请求并禁用按钮', async () => {
        let resolveFetch;
        const fetchMock = vi.fn().mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));
        await setupIntraday(fetchMock);

        const first = window.AppSignals.runIntradayScreening(true);
        const second = window.AppSignals.runIntradayScreening(true);
        expect(first).toBe(second);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(document.getElementById('intraday-screening-run-btn').disabled).toBe(true);

        resolveFetch(readyResponse());
        await first;
        expect(document.getElementById('intraday-screening-run-btn').disabled).toBe(false);
    });

    it('not_ready 或跨日快照会清空旧股票', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(readyResponse())
            .mockResolvedValueOnce({
                ok: true,
                json: vi.fn().mockResolvedValue({
                    success: true,
                    data: {
                        status: 'not_ready',
                        snapshotDate: '2026-08-11',
                        snapshotTime: '14:30',
                        latestPublishedAt: '2026-08-11 14:30',
                        source: 'portfolio',
                        sourceLabel: '公开报告',
                        moduleHtml: '',
                    },
                }),
            });
        await setupIntraday(fetchMock);
        await window.AppSignals.runIntradayScreening(true);
        expect(document.getElementById('intraday-screening-results').textContent).toContain('安妮股份');

        await window.AppSignals.runIntradayScreening(true);

        expect(document.getElementById('intraday-screening-results').textContent).not.toContain('安妮股份');
        expect(document.getElementById('intraday-screening-results').textContent).toContain('今日盘中筛选尚未就绪');
    });

    it('同日刷新失败时保留已验证结果并标记错误', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(readyResponse())
            .mockRejectedValueOnce(new Error('offline'));
        await setupIntraday(fetchMock);
        await window.AppSignals.runIntradayScreening(true);

        await window.AppSignals.runIntradayScreening(true);

        expect(document.getElementById('intraday-screening-results').textContent).toContain('安妮股份');
        expect(document.getElementById('intraday-screening-status').textContent).toContain('刷新失败，保留当前同日结果');
        expect(document.getElementById('intraday-screening-status').getAttribute('data-state')).toBe('error');
    });

    it('本地日期跨日时只清除旧结果，不自动请求', async () => {
        const fetchMock = await setupIntraday();
        await window.AppSignals.runIntradayScreening(true);
        expect(document.getElementById('intraday-screening-results').textContent).toContain('安妮股份');

        window.AppUtils.getShanghaiDateKey = () => '2026-08-13';
        const cleared = window.AppSignals.reconcileIntradayScreeningDate();

        expect(cleared).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(document.getElementById('intraday-screening-results').textContent).not.toContain('安妮股份');
        expect(document.getElementById('intraday-screening-results').textContent).toContain('上一交易日结果已清除');
        expect(document.getElementById('intraday-screening-update-time').textContent).toBe('');
        expect(document.getElementById('intraday-screening-status').getAttribute('data-state')).toBe('not-ready');
    });
});

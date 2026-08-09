/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

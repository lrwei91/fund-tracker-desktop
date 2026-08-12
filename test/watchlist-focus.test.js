/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

describe('自选股详情入口', () => {
    beforeEach(async () => {
        vi.resetModules();
        document.body.innerHTML = '<div id="watchlist-grid"></div>';
        window.__watch = {
            state: {
                watchQuoteCache: {
                    '600519': { name: '贵州茅台', priceValue: 1346.5 },
                    '301047': { name: '义翘神州', priceValue: 100.25 },
                },
                watchlistCost: {},
                watchMarketWarnings: {
                    '600519': {
                        anomaly: true,
                        anomalyRule: '30日累计正偏离达到200%',
                        monitored: false,
                    },
                    '301047': {
                        anomaly: false,
                        anomalyWarning: true,
                        anomalyWarningRule: '10日累计正偏离达到100%',
                        anomalyWarningPredictionType: 0,
                        anomalyWarningTriggerPct: 19.05,
                        monitored: false,
                    },
                },
            },
            utils: {
                escapeHtml,
                formatQuotePrice: (_value, fallback) => String(fallback),
            },
            KEYS: {},
            showStockFundFlow: vi.fn(),
        };
        window.AppMarket = { trendArrow: () => '─' };
        await import('../app/modules/watchlist/watch-render.js');
    });

    it('用可聚焦按钮打开详情并保留删除按钮的独立语义', () => {
        const grid = document.getElementById('watchlist-grid');
        grid.innerHTML = window.__watch.renderWatchItem(
            '600519',
            '贵州茅台',
            '1346.50',
            1.2,
            '--',
            0.8,
            false,
            true,
        );
        window.__watch.bindWatchItemClick();

        const trigger = grid.querySelector('.watchlist-detail-trigger');
        const remove = grid.querySelector('.watchlist-remove-btn');
        const warning = grid.querySelector('.watchlist-warning-tag.anomaly');

        expect(trigger.tagName).toBe('BUTTON');
        expect(trigger.type).toBe('button');
        expect(trigger.getAttribute('aria-label')).toBe('查看 贵州茅台 600519 详情');
        expect(warning.textContent).toBe('严重异动');
        expect(warning.title).toBe('30日累计正偏离达到200%');

        trigger.focus();
        trigger.click();
        expect(document.activeElement).toBe(trigger);
        expect(window.__watch.showStockFundFlow).toHaveBeenCalledWith('600519', trigger);

        remove.click();
        expect(window.__watch.showStockFundFlow).toHaveBeenCalledTimes(1);
    });

    it('区分严重异动预警与已经触发的严重异动', () => {
        const grid = document.getElementById('watchlist-grid');
        grid.innerHTML = window.__watch.renderWatchItem(
            '301047',
            '义翘神州',
            '100.25',
            -2.25,
            '--',
            -1.2,
            false,
            true,
        );

        const prediction = grid.querySelector('.watchlist-warning-tag.anomaly-warning');
        expect(prediction.textContent).toBe('严重异动预警');
        expect(prediction.title).toBe('10日累计正偏离达到100%；当日尚未触发；参考触发涨跌幅 +19.05%');
        expect(grid.querySelector('.watchlist-warning-tag.anomaly')).toBeNull();
    });
});

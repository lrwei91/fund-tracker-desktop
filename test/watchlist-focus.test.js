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
                },
                watchlistCost: {},
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

        expect(trigger.tagName).toBe('BUTTON');
        expect(trigger.type).toBe('button');
        expect(trigger.getAttribute('aria-label')).toBe('查看 贵州茅台 600519 详情');

        trigger.focus();
        trigger.click();
        expect(document.activeElement).toBe(trigger);
        expect(window.__watch.showStockFundFlow).toHaveBeenCalledWith('600519', trigger);

        remove.click();
        expect(window.__watch.showStockFundFlow).toHaveBeenCalledTimes(1);
    });
});

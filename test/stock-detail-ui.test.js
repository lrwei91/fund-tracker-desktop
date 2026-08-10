/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const styles = readFileSync(join(process.cwd(), 'app/styles.css'), 'utf8');

function installStyleHarness() {
    document.head.innerHTML = '<style>' + styles + '</style>';
    document.body.innerHTML = [
        '<div class="electron-app">',
        '<button class="watchlist-tab active">自选一</button>',
        '<button class="stock-detail-tab active">研究</button>',
        '<button class="signal-workspace-tab active">机会雷达</button>',
        '<button class="hot-rank-tab active">同花顺热榜</button>',
        '<button class="limit-up-tab active">涨停</button>',
        '<button class="news-source-tab active">金十快讯</button>',
        '<button class="settings-nav-btn active">刷新</button>',
        '<button class="sector-tab active">行业</button>',
        '<div class="modal-panel"><div class="modal-body"></div></div>',
        '<ul class="stock-news-list"><li><span>标题</span><b>时间</b><em>摘要</em></li></ul>',
        '</div>',
    ].join('');
}

async function installChartHarness() {
    vi.resetModules();
    window.__watch = {
        state: {},
        utils: { escapeHtml: (value) => String(value) },
        readFiniteNumber(value) {
            if (value === null || value === undefined || value === '') return null;
            const number = Number(value);
            return Number.isFinite(number) ? number : null;
        },
    };
    window.AppDataStatus = { label: (_meta, fallback) => fallback || '' };
    await import('../app/modules/watchlist/stock-detail.js');
}

describe('统一的次级 Tab 视觉', () => {
    beforeEach(() => {
        installStyleHarness();
    });

    it('个股、信号、快讯等 Tab 与自选股分组使用相同的激活样式', () => {
        const reference = getComputedStyle(document.querySelector('.watchlist-tab'));
        const selectors = [
            '.stock-detail-tab',
            '.signal-workspace-tab',
            '.hot-rank-tab',
            '.limit-up-tab',
            '.news-source-tab',
            '.settings-nav-btn',
            '.sector-tab',
        ];

        selectors.forEach((selector) => {
            const style = getComputedStyle(document.querySelector(selector));
            expect(style.minHeight, selector).toBe(reference.minHeight);
            expect(style.borderRadius, selector).toBe(reference.borderRadius);
            expect(style.background, selector).toBe(reference.background);
            expect(style.boxShadow, selector).toBe(reference.boxShadow);
        });
    });

    it('弹窗使用固定上限高度，新闻摘要跨满整行', () => {
        const panel = getComputedStyle(document.querySelector('.modal-panel'));
        const summary = getComputedStyle(document.querySelector('.stock-news-list li > em'));

        expect(panel.height).toContain('680px');
        expect(summary.gridColumn).toBe('1 / -1');
        expect(summary.textAlign).toBe('left');
    });
});

describe('个股分时图', () => {
    beforeEach(async () => {
        installStyleHarness();
        await installChartHarness();
    });

    it('折线不随 SVG 缩放变粗，交互命中点保持透明', () => {
        const points = [
            { time: '09:30', price: 10, avgPrice: 10, pct: 0, avgPct: 0 },
            { time: '10:00', price: 10.2, avgPrice: 10.1, pct: 2, avgPct: 1 },
            { time: '10:30', price: 10.1, avgPrice: 10.1, pct: 1, avgPct: 1 },
        ];
        const html = window.__watch.renderStockMinuteChart(points, 10, {
            base: 10,
            points,
            maxAbsPct: 2,
        });
        const root = document.createElement('div');
        root.innerHTML = html;

        root.querySelectorAll('.stock-minute-price-line, .stock-minute-avg-line').forEach((path) => {
            expect(path.getAttribute('vector-effect')).toBe('non-scaling-stroke');
        });
        root.querySelectorAll('.stock-minute-hit-point').forEach((point) => {
            expect(point.getAttribute('fill')).toBe('transparent');
            expect(point.getAttribute('pointer-events')).toBe('all');
        });
    });
});

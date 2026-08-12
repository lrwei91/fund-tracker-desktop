/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const styles = readFileSync(join(process.cwd(), 'app/styles.css'), 'utf8');
const stockDetailSource = readFileSync(join(process.cwd(), 'app/modules/watchlist/stock-detail.js'), 'utf8');

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
        '<ul class="stock-news-list"><li class="stock-news-item"><span class="stock-news-title">标题</span><b class="stock-news-meta">来源 · 时间</b><em class="stock-news-summary">摘要</em></li></ul>',
        '<div class="stock-chip-title"><div class="stock-chip-heading"><span>筹码估算</span><small>近180日</small></div><em>90%筹码</em></div>',
        '<div class="stock-chip-axis"><span>58.79</span><span>128.65</span></div>',
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

    it('弹窗使用固定上限高度，新闻标题、元信息和摘要纵向排列', () => {
        const panel = getComputedStyle(document.querySelector('.modal-panel'));
        const item = getComputedStyle(document.querySelector('.stock-news-item'));
        const title = getComputedStyle(document.querySelector('.stock-news-title'));
        const meta = getComputedStyle(document.querySelector('.stock-news-meta'));
        const summary = getComputedStyle(document.querySelector('.stock-news-list li > em'));

        expect(panel.height).toContain('680px');
        expect(item.flexDirection).toBe('column');
        expect(title.color).toBe('var(--text-primary)');
        expect(meta.fontSize).toBe('11px');
        expect(summary.gridColumn).toBe('1 / -1');
        expect(summary.textAlign).toBe('left');
        expect(stockDetailSource).toContain('class="stock-news-title"');
        expect(stockDetailSource).toContain('class="stock-news-meta"');
        expect(stockDetailSource).toContain('[item.source, item.time]');
    });

    it('筹码周期位于标题区，价格轴只保留最低价和最高价', () => {
        const heading = getComputedStyle(document.querySelector('.stock-chip-heading'));
        const axis = document.querySelector('.stock-chip-axis');

        expect(heading.display).toBe('flex');
        expect(axis.children).toHaveLength(2);
        expect(stockDetailSource).toContain('class="stock-chip-heading"');
        expect(stockDetailSource).toContain("var windowLabel = chips.windowDays ? '近' + chips.windowDays + '日' : '';");
        expect(stockDetailSource).not.toContain("utils.escapeHtml(chips.windowDays ? '近' + chips.windowDays + '日' : '')");
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

describe('个股资金汇总', () => {
    beforeEach(async () => {
        vi.resetModules();
        window.__watch = {
            utils: {
                escapeHtml: (value) => String(value),
                formatYuan: (value) => String(value),
            },
            renderStockCostEditor: () => '',
        };
        await import('../app/modules/watchlist/stock-fundflow.js');
    });

    it('主力合计值使用涨跌语义色，标签和昨值使用可读的中性色', () => {
        const html = window.__watch.renderStockFundFlowBody({
            summary: {},
            recent: [
                { date: '2026-08-11', mainNet: 12000000 },
                { date: '2026-08-12', mainNet: -92890000 },
            ],
        }, {
            main: -92890000,
            large: 0,
            medium: 0,
            small: 0,
        }, {}, -122400000, { includeEditor: false, date: '2026-08-12' });

        expect(html).toContain('class="stock-fund-main-label"');
        expect(html).toContain('class="stock-fund-main-value negative"');
        expect(html).toContain('class="stock-fund-main-previous"');
        expect(html).toContain('class="stock-fund-history"');
        expect(html).toContain('2026-08-12');
        expect(html).toContain('净流出');
        expect(html).toContain('净流入');
        expect(html.indexOf('2026-08-12')).toBeLessThan(html.indexOf('2026-08-11'));
        expect(html).not.toContain('stock-fund-trend');
    });
});

/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

const indexHtml = readFileSync(join(process.cwd(), 'app/index.html'), 'utf8');
const appScript = readFileSync(join(process.cwd(), 'app/app.js'), 'utf8');
const styles = readFileSync(join(process.cwd(), 'app/styles.css'), 'utf8');
const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');

function parseIndex() {
    return new DOMParser().parseFromString(indexHtml, 'text/html');
}

async function bootstrapApp(options = {}) {
    const dom = new JSDOM(indexHtml, {
        runScripts: 'outside-only',
        url: options.url || 'https://local.invalid/#signals',
    });
    const { window } = dom;
    const stored = new Map([
        ['fund_tracker_active_main_tab', 'signals'],
    ]);
    window.AppState = {
        KEYS: {
            ACTIVE_TAB_KEY: 'fund_tracker_active_main_tab',
            SETTINGS_KEY: 'fund_tracker_settings',
            COLLAPSE_STATE_KEY: 'fund_tracker_collapse_state',
            VALID_TABS: ['dashboard', 'signals', 'funds', 'news'],
            TAB_TITLES: { dashboard: '市场行情', signals: '市场信号', funds: '自选基金', news: '财经快讯' },
        },
        colorMode: 'light',
        isAutoRefresh: false,
        refreshSecondsMain: 10,
        refreshSecondsSignal: 1800,
        refreshSecondsNews: 60,
        holdingColorMode: 'market',
        holdingOpacity: 100,
        alertEnabled: true,
        alertThreshold: 2,
        alertOpacity: 0.92,
        bullSoundEnabled: true,
        bearSoundEnabled: true,
        customIndexCodes: [],
        restorePersistentState() {},
    };
    window.AppUtils = { setLastUpdated() {} };
    window.AppCache = { readJson: (_key, fallback) => fallback, writeJson() {} };
    window.AppTheme = { normalizeMode: () => 'light', setMode() {} };
    window.AppStorage = {
        hydrate: () => Promise.resolve(),
        getItem: (key) => stored.get(key) || null,
        setItem: (key, value) => stored.set(key, String(value)),
    };
    window.shell = options.shell;
    window.AppFundBoard = options.fundBoard;
    window.AppRefreshCoordinator = options.refreshCoordinator;

    window.eval(appScript);
    if (window.document.readyState === 'loading') {
        await new Promise((resolve) => window.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
    }
    await Promise.resolve();
    await Promise.resolve();
    return dom;
}

describe('主界面信息架构', () => {
    it('底栏只保留设置入口，导入导出位于设置的数据页', () => {
        const doc = parseIndex();
        const navigationButtons = Array.from(doc.querySelectorAll('.desktop-nav > .desktop-nav-btn'));
        const settingsViews = Array.from(doc.querySelectorAll('[data-settings-view]'))
            .map((button) => button.getAttribute('data-settings-view'));

        expect(navigationButtons.map((button) => button.getAttribute('aria-label')))
            .toEqual(['行情', '信号', '基金', '快讯', '设置']);
        expect(doc.querySelector('.desktop-sidebar-footer')).toBeNull();
        expect(doc.getElementById('watchlist-data-btn')).toBeNull();
        expect(doc.getElementById('data-panel')).toBeNull();
        expect(doc.getElementById('data-overlay')).toBeNull();
        expect(settingsViews).toEqual(['appearance', 'refresh', 'alerts', 'widget', 'data', 'about']);

        const dataView = doc.querySelector('[data-settings-panel="data"]');
        expect(dataView).not.toBeNull();
        expect(dataView.querySelector('#export-watchlist-btn')).not.toBeNull();
        expect(dataView.querySelector('#import-watchlist-btn')).not.toBeNull();
        expect(dataView.querySelector('#import-watchlist-file')).not.toBeNull();
    });

    it('每次启动忽略旧 hash 与上次 Tab，固定进入行情', async () => {
        const dom = await bootstrapApp();
        try {
            expect(dom.window.AppState.currentTab).toBe('dashboard');
            expect(dom.window.location.hash).toBe('');
            expect(dom.window.document.querySelector('.tab-panel.active').id).toBe('tab-dashboard');
            expect(dom.window.document.querySelector('.desktop-nav .tab-btn.active').dataset.tab).toBe('dashboard');
        } finally {
            dom.window.close();
        }
    });

    it('进入基金主 Tab 时独立确保已恢复的基金筛选子页完成首次加载', async () => {
        let ensureCount = 0;
        let refreshCount = 0;
        const dom = await bootstrapApp({
            fundBoard: {
                initFundBoard() {},
                ensureLoaded: async () => { ensureCount += 1; },
            },
            refreshCoordinator: {
                start() {},
                refreshAll: async () => {},
                refreshTab: async (tab) => { if (tab === 'funds') refreshCount += 1; },
            },
        });
        try {
            dom.window.document.querySelector('.tab-btn[data-tab="funds"]').click();
            await Promise.resolve();
            expect(ensureCount).toBe(1);
            expect(refreshCount).toBe(1);
        } finally {
            dom.window.close();
        }
    });

    it('主窗口提供 Tauri 原生拖拽区域且交互按钮不抢占拖动', () => {
        const doc = parseIndex();
        const header = doc.getElementById('header');
        const headerActions = header.querySelector('.header-right');
        const brand = doc.querySelector('.desktop-brand');
        const brandMark = doc.querySelector('.desktop-brand-mark');

        expect(header.getAttribute('data-tauri-drag-region')).toBe('deep');
        expect(brand.getAttribute('data-tauri-drag-region')).toBe('deep');
        expect(headerActions.getAttribute('data-tauri-drag-region')).toBe('false');
        expect(brandMark.getAttribute('draggable')).toBe('false');
        expect(styles).toMatch(/\.desktop-brand-mark\s*\{[\s\S]*?-webkit-user-drag:\s*none;/);
    });

    it('关于页使用仓库 metadata，并通过 shell 契约打开真实 GitHub 地址', async () => {
        const opened = [];
        const shell = {
            openExternalUrl: async (url) => {
                opened.push(url);
                return { ok: true };
            },
        };
        const dom = await bootstrapApp({ shell, url: 'https://local.invalid/' });
        try {
            const doc = dom.window.document;
            const aboutView = doc.querySelector('[data-settings-panel="about"]');
            const githubButton = aboutView.querySelector('#about-github-btn');
            const authorGithubButton = aboutView.querySelector('#about-author-github-btn');
            const productName = aboutView.querySelector('.settings-about-name').textContent;

            expect(readme).toContain(`# ${productName}`);
            expect(aboutView.textContent).toContain('基于 Tauri 2 的本地桌面应用');
            expect(readme).toContain('基于 Tauri 2 的本地桌面应用');
            expect(aboutView.textContent).toContain('维护者');
            expect(aboutView.textContent).toContain('lrwei91');
            expect(aboutView.textContent).not.toMatch(/版本\s*\d/);
            expect(aboutView.querySelector('a[href]')).toBeNull();

            githubButton.click();
            await Promise.resolve();
            authorGithubButton.click();
            await Promise.resolve();
            expect(opened).toEqual([
                'https://github.com/lrwei91/fund-tracker-desktop',
                'https://github.com/lrwei91',
            ]);
        } finally {
            dom.window.close();
        }
    });

    it('五个入口位于同一导航组并共享尺寸规则', () => {
        const doc = parseIndex();
        expect(Array.from(doc.querySelectorAll('.desktop-nav > .desktop-nav-btn'))).toHaveLength(5);
        expect(doc.querySelector('[data-tab="dashboard"] [data-nav-icon]').getAttribute('data-nav-icon')).toBe('market');
        expect(doc.querySelector('[data-tab="signals"] [data-nav-icon]').getAttribute('data-nav-icon')).toBe('radar');
        expect(doc.querySelector('[data-tab="funds"] [data-nav-icon]').getAttribute('data-nav-icon')).toBe('fund');
        expect(styles).toMatch(/\.desktop-nav-btn\s*\{[\s\S]*?flex:\s*1;/);
        expect(styles).toMatch(/@media \(min-width: 1280px\)[\s\S]*?\.desktop-nav-btn\s*\{[\s\S]*?height:\s*58px;/);
        expect(styles).not.toMatch(/\.desktop-sidebar-footer\s*\{/);
    });

    it('市场涨跌家数紧跟资金流向并复用行情卡片视觉契约', () => {
        const doc = parseIndex();
        const capital = doc.querySelector('.capital-section');
        const breadth = doc.querySelector('.market-breadth-section');
        expect(capital.nextElementSibling).toBe(breadth);
        expect(breadth.querySelector('.card-header h2').textContent).toBe('市场涨跌家数');
        expect(breadth.querySelectorAll('.market-breadth-item')).toHaveLength(3);
        expect(breadth.querySelector('#market-breadth-track')).not.toBeNull();
        expect(styles).toMatch(/\.market-breadth-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,/);
        expect(styles).toMatch(/\.market-breadth-segment\.is-up\s*\{[\s\S]*?var\(--red\)/);
        expect(styles).toMatch(/\.market-breadth-segment\.is-down\s*\{[\s\S]*?var\(--green\)/);
    });

    it('行业全景位于行情区域最底部并使用双列紧凑行情网格', () => {
        const doc = parseIndex();
        const sector = doc.querySelector('.sector-section');
        const panorama = doc.querySelector('.sector-panorama-section');
        expect(sector.nextElementSibling).toBe(panorama);
        expect(panorama.querySelector('.card-header h2').textContent).toBe('行业全景');
        expect(panorama.querySelector('#sector-panorama-grid')).not.toBeNull();
        expect(styles).toMatch(/\.sector-panorama-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,/);
        expect(styles).toMatch(/\.sector-panorama-change\s*\{[\s\S]*?font-variant-numeric:\s*tabular-nums;/);
    });

    it('基金 Tab 紧跟信号，并提供独立自选基金表格', () => {
        const doc = parseIndex();
        const desktopTabs = Array.from(doc.querySelectorAll('.desktop-nav > .tab-btn'))
            .map((button) => button.dataset.tab);
        expect(desktopTabs).toEqual(['dashboard', 'signals', 'funds', 'news']);
        const panel = doc.getElementById('tab-funds');
        expect(panel.querySelector('#fund-input')).not.toBeNull();
        expect(panel.querySelector('#add-fund-btn').textContent).toBe('添加基金');
        expect(panel.querySelectorAll('.fund-watch-table-head [role="columnheader"]')).toHaveLength(7);
        expect(panel.textContent).toContain('单位净值');
        expect(panel.textContent).toContain('日涨跌');
        expect(styles).toMatch(/\.fund-watch-section > \.card-body\s*\{[\s\S]*?padding:\s*0;/);
        expect(styles).toMatch(/\.fund-watch-add input\s*\{[\s\S]*?height:\s*36px;/);
        expect(styles).toMatch(/\.fund-watch-status:empty\s*\{[\s\S]*?display:\s*none;/);
        expect(styles).toMatch(/\.fund-watch-list > \.ui-state\s*\{[\s\S]*?min-height:\s*72px;/);
        expect(styles).toMatch(/#main-content:has\(#tab-funds\.active \.fund-board-workspace\.active\)\s*\{[\s\S]*?overflow:\s*hidden;/);
        expect(styles).toMatch(/#tab-funds\.active:has\(\.fund-board-workspace\.active\)\s*\{[\s\S]*?grid-template-rows:\s*auto minmax\(0, 1fr\);[\s\S]*?height:\s*100%;/);
        expect(styles).toMatch(/\.fund-board-workspace\.active\s*\{[\s\S]*?grid-template-rows:\s*auto minmax\(0, 1fr\) auto;[\s\S]*?overflow:\s*hidden;/);
        expect(styles).toMatch(/\.fund-board-grid\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*auto;[\s\S]*?overscroll-behavior:\s*contain;/);
    });

    it('轮动板块位于盘中筛选左侧，两个面板初始都只提供手动入口', () => {
        const doc = parseIndex();
        const signalViews = Array.from(doc.querySelectorAll('[data-signal-view]'))
            .map((button) => button.getAttribute('data-signal-view'));
        const rotationPanel = doc.querySelector('[data-signal-panel="rotation"]');
        const screeningPanel = doc.querySelector('[data-signal-panel="screening"]');

        expect(signalViews).toEqual(['radar', 'rotation', 'screening', 'heat', 'limit']);
        expect(rotationPanel).not.toBeNull();
        expect(rotationPanel.hidden).toBe(true);
        expect(rotationPanel.querySelector('#sector-rotation-run-btn').textContent).toBe('获取板块轮动');
        expect(rotationPanel.querySelector('#sector-rotation-status').textContent).toContain('不会自动获取');
        expect(rotationPanel.querySelector('#sector-rotation-results').children).toHaveLength(0);
        expect(screeningPanel).not.toBeNull();
        expect(screeningPanel.hidden).toBe(true);
        expect(screeningPanel.querySelector('#intraday-screening-run-btn').textContent).toBe('获取今日推荐');
        expect(screeningPanel.querySelector('#intraday-screening-status').textContent).toContain('不会自动获取');
        expect(screeningPanel.querySelector('#intraday-screening-results').children).toHaveLength(0);
    });

    it('盘中推荐 loader 只绑定到专属按钮点击', () => {
        expect(appScript.match(/runIntradayScreening\(true\)/g)).toHaveLength(1);
        expect(appScript).toMatch(/intradayScreeningRunBtn\.addEventListener\('click',[\s\S]*runIntradayScreening\(true\)/);
        expect(appScript).toMatch(/visibilitychange[\s\S]*reconcileIntradayScreeningDate/);
        expect(appScript).toMatch(/scheduleIntradayScreeningDayRollover/);
    });

    it('轮动板块 loader 只绑定到专属按钮点击', () => {
        expect(appScript.match(/runSectorRotation\(\)/g)).toHaveLength(1);
        expect(appScript).toMatch(/sectorRotationRunBtn\.addEventListener\('click',[\s\S]*runSectorRotation\(\)/);
    });
});

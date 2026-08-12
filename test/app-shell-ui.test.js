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
            VALID_TABS: ['dashboard', 'signals', 'news'],
            TAB_TITLES: { dashboard: '市场行情', signals: '市场信号', news: '财经快讯' },
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
            .toEqual(['行情', '信号', '快讯', '设置']);
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

    it('四个入口位于同一导航组并共享尺寸规则', () => {
        const doc = parseIndex();
        expect(Array.from(doc.querySelectorAll('.desktop-nav > .desktop-nav-btn'))).toHaveLength(4);
        expect(styles).toMatch(/\.desktop-nav-btn\s*\{[\s\S]*?flex:\s*1;/);
        expect(styles).toMatch(/@media \(min-width: 1280px\)[\s\S]*?\.desktop-nav-btn\s*\{[\s\S]*?height:\s*58px;/);
        expect(styles).not.toMatch(/\.desktop-sidebar-footer\s*\{/);
    });

    it('盘中筛选紧跟机会雷达，初始只提供手动获取入口', () => {
        const doc = parseIndex();
        const signalViews = Array.from(doc.querySelectorAll('[data-signal-view]'))
            .map((button) => button.getAttribute('data-signal-view'));
        const screeningPanel = doc.querySelector('[data-signal-panel="screening"]');

        expect(signalViews).toEqual(['radar', 'screening', 'heat', 'limit']);
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
});

/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const indexHtml = readFileSync(join(process.cwd(), 'app/index.html'), 'utf8');
const appScript = readFileSync(join(process.cwd(), 'app/app.js'), 'utf8');

function parseIndex() {
    return new DOMParser().parseFromString(indexHtml, 'text/html');
}

describe('主界面信息架构', () => {
    it('底栏只保留设置入口，导入导出位于设置的数据页', () => {
        const doc = parseIndex();
        const utilityButtons = Array.from(doc.querySelectorAll('.desktop-sidebar-footer button'));
        const settingsViews = Array.from(doc.querySelectorAll('[data-settings-view]'))
            .map((button) => button.getAttribute('data-settings-view'));

        expect(utilityButtons).toHaveLength(1);
        expect(utilityButtons[0].id).toBe('settings-btn');
        expect(doc.getElementById('watchlist-data-btn')).toBeNull();
        expect(doc.getElementById('data-panel')).toBeNull();
        expect(doc.getElementById('data-overlay')).toBeNull();
        expect(settingsViews).toEqual(['appearance', 'refresh', 'alerts', 'widget', 'data']);

        const dataView = doc.querySelector('[data-settings-panel="data"]');
        expect(dataView).not.toBeNull();
        expect(dataView.querySelector('#export-watchlist-btn')).not.toBeNull();
        expect(dataView.querySelector('#import-watchlist-btn')).not.toBeNull();
        expect(dataView.querySelector('#import-watchlist-file')).not.toBeNull();
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

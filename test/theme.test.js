/**
 * @vitest-environment jsdom
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(process.cwd(), 'app/theme.js'), 'utf8');
const mediaListeners = new Set();
const media = {
    matches: false,
    addEventListener: vi.fn((_event, listener) => mediaListeners.add(listener)),
    removeEventListener: vi.fn((_event, listener) => mediaListeners.delete(listener)),
};
const emptyStorage = { getItem: () => null };

describe('AppTheme', () => {
    beforeAll(() => {
        window.matchMedia = vi.fn(() => media);
        new Function('window', source)(window);
    });

    beforeEach(() => {
        media.matches = false;
        delete window.__TAURI__;
        window.AppTheme.start({ storage: emptyStorage, window, media, document });
    });

    it('规范化主题模式，旧配置和非法值回退浅色', () => {
        expect(window.AppTheme.normalizeMode('dark')).toBe('dark');
        expect(window.AppTheme.normalizeMode('SYSTEM')).toBe('system');
        expect(window.AppTheme.normalizeMode('legacy-blue')).toBe('light');
        expect(window.AppTheme.readMode({ getItem: () => JSON.stringify({ autoRefresh: true }) })).toBe('light');
        expect(window.AppTheme.readMode({ getItem: () => '{bad json' })).toBe('light');
    });

    it('解析跟随系统，并在系统外观变化时更新实际主题', () => {
        window.AppTheme.setMode('system', { prefersDark: false });
        expect(document.documentElement.dataset.colorMode).toBe('system');
        expect(document.documentElement.dataset.theme).toBe('light');

        media.matches = true;
        mediaListeners.forEach((listener) => listener({ matches: true }));
        expect(document.documentElement.dataset.theme).toBe('dark');
    });

    it('通过 storage 事件同步其他窗口写入的主题设置', () => {
        window.dispatchEvent(new StorageEvent('storage', {
            key: 'fund_tracker_settings',
            newValue: JSON.stringify({ colorMode: 'dark' }),
        }));
        expect(window.AppTheme.getMode()).toBe('dark');
        expect(document.documentElement.dataset.theme).toBe('dark');
    });

    it('同步最终主题到 Tauri 原生窗口', () => {
        const setTheme = vi.fn(() => Promise.resolve());
        window.__TAURI__ = {
            window: {
                getCurrentWindow: () => ({ setTheme }),
            },
        };

        window.AppTheme.setMode('light', { window });
        expect(setTheme).toHaveBeenCalledWith('light');

        window.AppTheme.setMode('system', { window, prefersDark: true });
        expect(setTheme).toHaveBeenLastCalledWith('dark');
    });
});

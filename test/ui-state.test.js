/**
 * @vitest-environment jsdom
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(process.cwd(), 'app/modules/ui-state.js'), 'utf8');

describe('AppUiState', () => {
    beforeAll(() => {
        new Function('window', source)(window);
    });

    beforeEach(() => {
        document.body.innerHTML = '<main id="root"></main>';
    });

    it('渲染统一的 loading、empty 和 error 结构并转义文案', () => {
        const loading = window.AppUiState.render('loading', { title: '<等待>' });
        const empty = window.AppUiState.render('empty');
        const error = window.AppUiState.render('error', { retryScope: 'news' });

        expect(loading).toContain('data-ui-state="loading"');
        expect(loading).toContain('&lt;等待&gt;');
        expect(loading).toContain('ui-state-skeleton');
        expect(empty).toContain('data-ui-state="empty"');
        expect(error).toContain('data-ui-retry="news"');
        expect(error).toContain('role="alert"');
    });

    it('将重试按钮委托给现有刷新调用方，并可解绑', () => {
        const root = document.getElementById('root');
        const retry = vi.fn();
        root.innerHTML = window.AppUiState.render('error', { retryScope: 'signals' });
        const unbind = window.AppUiState.bindRetries(root, retry);

        root.querySelector('[data-ui-retry]').click();
        expect(retry).toHaveBeenCalledWith('signals', expect.any(HTMLButtonElement));
        unbind();
        root.querySelector('[data-ui-retry]').click();
        expect(retry).toHaveBeenCalledTimes(1);
    });
});

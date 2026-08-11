/**
 * @vitest-environment jsdom
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(process.cwd(), 'app/modules/dialog.js'), 'utf8');

describe('AppDialog', () => {
    beforeAll(() => {
        new Function('window', 'document', source)(window, document);
    });

    beforeEach(() => {
        document.body.className = '';
        document.body.innerHTML = [
            '<div class="app-shell" id="app-shell"><button id="trigger">打开</button></div>',
            '<div id="overlay" hidden></div>',
            '<section id="panel" hidden><button id="first">第一项</button><button id="last">最后一项</button></section>',
        ].join('');
    });

    it('打开后约束焦点并使背景 inert，Escape 关闭后恢复焦点', () => {
        const trigger = document.getElementById('trigger');
        const overlay = document.getElementById('overlay');
        const panel = document.getElementById('panel');
        const first = document.getElementById('first');
        const last = document.getElementById('last');
        const onClose = vi.fn();
        trigger.focus();

        window.AppDialog.open(panel, overlay, {
            trigger,
            hideOnClose: true,
            focusTarget: first,
            onClose,
        });
        expect(panel.hidden).toBe(false);
        expect(overlay.hidden).toBe(false);
        expect(document.getElementById('app-shell').inert).toBe(true);
        expect(document.activeElement).toBe(first);

        last.focus();
        panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        expect(document.activeElement).toBe(first);
        panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        expect(panel.hidden).toBe(true);
        expect(overlay.hidden).toBe(true);
        expect(document.getElementById('app-shell').inert).toBe(false);
        expect(document.activeElement).toBe(trigger);
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('触发控件被列表重绘替换后按稳定位置恢复焦点', () => {
        const trigger = document.getElementById('trigger');
        const panel = document.getElementById('panel');
        const first = document.getElementById('first');
        trigger.focus();

        window.AppDialog.open(panel, null, {
            trigger,
            hideOnClose: true,
            focusTarget: first,
            restoreFocus: () => document.getElementById('trigger'),
        });
        const replacement = trigger.cloneNode(true);
        trigger.replaceWith(replacement);

        panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        expect(panel.hidden).toBe(true);
        expect(document.activeElement).toBe(replacement);
    });
});

/**
 * @vitest-environment jsdom
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

describe('桌面提醒卡片', () => {
    var receiveAlert;
    var play;

    beforeAll(async () => {
        document.body.innerHTML = [
            '<section id="alert">',
            '<div id="mascot"></div>',
            '<div><strong id="alert-title"></strong><span id="alert-detail"></span></div>',
            '</section>',
        ].join('');
        play = vi.fn(() => Promise.resolve());
        globalThis.Audio = vi.fn(function (source) {
            this.source = source;
            this.volume = 1;
            this.play = play;
        });
        window.shell = {
            onStockAlert(callback) {
                receiveAlert = callback;
                return () => {};
            },
        };
        await import('../renderer/alert-popup.js');
    });

    it('按 StockPet 的牛卡样式展示并播放牛叫', () => {
        receiveAlert({ name: '浦发银行', code: '600000', price: 10.5, changePct: 2.3, opacity: 0.8, soundEnabled: true });
        expect(document.getElementById('mascot').textContent).toBe('🐂');
        expect(document.getElementById('alert-title').textContent).toBe('浦发银行 上涨提醒');
        expect(document.getElementById('alert-detail').textContent).toContain('+2.30%');
        expect(document.getElementById('alert').style.opacity).toBe('0.8');
        expect(globalThis.Audio).toHaveBeenCalledWith('assets/bull-moo.wav');
        expect(play).toHaveBeenCalledOnce();
    });

    it('按 StockPet 的熊卡样式展示且可关闭声音', () => {
        play.mockClear();
        receiveAlert({ name: '测试股', code: '000001', price: 9.8, changePct: -2, opacity: 1, soundEnabled: false });
        expect(document.getElementById('mascot').textContent).toBe('🐻');
        expect(document.getElementById('alert-title').textContent).toBe('测试股 下跌提醒');
        expect(document.getElementById('alert-detail').textContent).toContain('-2.00%');
        expect(play).not.toHaveBeenCalled();
    });
});

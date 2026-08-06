/**
 * @vitest-environment jsdom
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

describe('桌面提醒测试入口', () => {
    var showStockAlert;

    beforeAll(async () => {
        document.body.innerHTML = '<div id="alert-toast-container"></div>';
        window.AppState = {
            KEYS: {
                ALERT_SETTINGS_KEY: 'alert-settings',
                WATCH_ALERT_STATE_KEY: 'alert-state',
                WATCH_ALERT_SCHEMA_VERSION: 2,
                ALERT_TOAST_MAX: 5,
                ALERT_TOAST_TTL_MS: 20000,
                STATUS_TOAST_TTL_MS: 2500,
            },
            alertEnabled: true,
            alertThreshold: 2,
            alertOpacity: 0.75,
            bullSoundEnabled: true,
            bearSoundEnabled: false,
            watchAlertState: {},
        };
        window.AppUtils = { getShanghaiDateKey: () => '2026-08-06' };
        window.AppStorage = { setItem: vi.fn() };
        window.shell = { showStockAlert: vi.fn(() => Promise.resolve({ ok: true })) };
        showStockAlert = window.shell.showStockAlert;
        await import('../app/modules/render-alerts.js');
    });

    beforeEach(() => {
        showStockAlert.mockClear();
    });

    it('可预览小牛提醒并传递不透明度和声音设置', () => {
        window.AppAlerts.previewAlert('rising');
        expect(showStockAlert).toHaveBeenCalledWith(expect.objectContaining({
            code: 'DEMO',
            changePct: 2,
            opacity: 0.75,
            soundEnabled: true,
        }));
    });

    it('可预览小熊提醒并遵循小熊声音开关', () => {
        window.AppAlerts.previewAlert('falling');
        expect(showStockAlert).toHaveBeenCalledWith(expect.objectContaining({
            code: 'DEMO',
            changePct: -2,
            opacity: 0.75,
            soundEnabled: false,
        }));
    });

    it('只监控持仓股，不监控候选股', () => {
        window.AppState.watchAlertState = {
            '600000': { openDate: '2026-08-06', openPrice: 10, lastTriggerPrice: null },
            '000001': { openDate: '2026-08-06', openPrice: 10, lastTriggerPrice: null },
        };
        window.AppWatchlist = {
            getWatchTabs: () => [
                { id: 'default', codes: ['600000'] },
                { id: 'candidate', codes: ['000001'] },
            ],
        };

        window.AppAlerts.checkAlerts({
            '600000': { name: '浦发银行', priceValue: 10.3, openPrice: 10 },
            '000001': { name: '平安银行', priceValue: 10.3, openPrice: 10 },
        });

        expect(showStockAlert).toHaveBeenCalledTimes(1);
        expect(showStockAlert).toHaveBeenCalledWith(expect.objectContaining({ code: '600000' }));
        expect(window.AppState.watchAlertState['000001'].lastTriggerPrice).toBeNull();
    });
});

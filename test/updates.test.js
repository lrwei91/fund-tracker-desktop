/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

describe('桌面更新流程', () => {
    let onState;
    beforeEach(async () => {
        vi.resetModules();
        document.body.innerHTML = fs.readFileSync('app/index.html', 'utf8');
        window.shell = {
            updateStatus: vi.fn(async () => ({ phase: 'idle', currentVersion: '1.0.6', automatic: true, canInstall: true, enabled: true })),
            updateCheck: vi.fn(async () => ({ phase: 'available', version: '1.0.7', canInstall: true, notes: '<img src=x>' })),
            updateDownload: vi.fn(async () => ({ phase: 'downloaded', version: '1.0.7', canInstall: true })),
            updateInstall: vi.fn(async () => {}),
            updatePreferences: vi.fn(async automatic => ({ phase: 'idle', automatic })),
            onUpdateState: vi.fn(fn => { onState = fn; }),
        };
        window.AppStorage = { flush: vi.fn(async () => {}), getStatus: () => ({ pending: 0 }) };
        await import('../app/modules/dialog.js');
        await import('../app/modules/updates.js');
        await window.AppUpdates.init();
    });
    it('检查、下载和确认安装分开，版本说明不执行 HTML', async () => {
        expect(window.shell.updateCheck).not.toHaveBeenCalled();
        document.getElementById('app-check-update').click();
        await vi.waitFor(() => expect(document.getElementById('app-download-update').hidden).toBe(false));
        expect(document.getElementById('app-update-notes').querySelector('img')).toBeNull();
        expect(window.shell.updateDownload).not.toHaveBeenCalled();
        document.getElementById('app-download-update').click();
        await vi.waitFor(() => expect(document.getElementById('app-install-update').hidden).toBe(false));
        expect(window.shell.updateInstall).not.toHaveBeenCalled();
        document.getElementById('app-install-update').click();
        expect(document.getElementById('app-update-install-dialog').hidden).toBe(false);
        document.getElementById('app-update-install-cancel').click();
        expect(window.shell.updateInstall).not.toHaveBeenCalled();
        document.getElementById('app-install-update').click();
        document.getElementById('app-update-install-confirm').click();
        await vi.waitFor(() => expect(window.shell.updateInstall).toHaveBeenCalledTimes(1));
        expect(window.AppStorage.flush).toHaveBeenCalledTimes(1);
    });
    it('保存失败阻止安装，允许重试', async () => {
        onState({ phase: 'downloaded', version: '1.0.7', canInstall: true });
        window.AppStorage.flush.mockRejectedValueOnce(new Error('磁盘不可写'));
        document.getElementById('app-install-update').click();
        document.getElementById('app-update-install-confirm').click();
        await vi.waitFor(() => expect(document.getElementById('app-update-install-error').textContent).toContain('磁盘不可写'));
        expect(window.shell.updateInstall).not.toHaveBeenCalled();
        expect(document.getElementById('app-update-install-confirm').disabled).toBe(false);
    });
    it('检查失败保留错误并可重试，关闭自动检查只保存偏好', async () => {
        window.shell.updateCheck.mockRejectedValueOnce(new Error('网络不可用'));
        document.getElementById('app-check-update').click();
        await vi.waitFor(() => expect(document.getElementById('app-update-status').textContent).toContain('网络不可用'));
        expect(document.getElementById('app-check-update').disabled).toBe(false);
        const toggle = document.getElementById('app-automatic-updates');
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(window.shell.updatePreferences).toHaveBeenCalledWith(false));
        expect(window.shell.updateDownload).not.toHaveBeenCalled();
    });
    it('下载事件显示进度，便携模式不能下载安装', () => {
        onState({ phase: 'downloading', received: 20, total: 100, canInstall: true });
        expect(document.getElementById('app-update-progress').value).toBe(20);
        onState({ phase: 'available', version: '1.0.7', canInstall: false });
        expect(document.getElementById('app-download-update').disabled).toBe(true);
    });
});

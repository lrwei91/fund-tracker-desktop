/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

async function installStorage() {
    vi.resetModules();
    window.localStorage.clear();
    window.AppConfigSchema = { keys: ['demo'] };
    window.shell = {
        configStorage: {
            patch: vi.fn(),
            load: vi.fn().mockResolvedValue({ data: {} }),
        },
    };
    await import('../app/modules/storage.js');
}

describe('AppStorage', () => {
    beforeEach(async () => {
        document.body.innerHTML = '';
        await installStorage();
    });

    it('写入失败时 flush 拒绝并保留待保存内容', async () => {
        const patch = window.shell.configStorage.patch;
        patch.mockRejectedValueOnce(new Error('disk full'));
        window.AppStorage.setItem('demo', 'first');
        await expect(window.AppStorage.flush()).rejects.toThrow('disk full');

        patch.mockResolvedValueOnce({});
        await window.AppStorage.flush();
        expect(patch).toHaveBeenLastCalledWith({ demo: 'first' });
        expect(window.AppStorage.getStatus().state).toBe('saved');
    });

    it('失败期间的新编辑覆盖旧值，重试按最新值提交', async () => {
        let reject;
        window.shell.configStorage.patch.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
        window.AppStorage.setItem('demo', 'old');
        const first = window.AppStorage.flush();
        window.AppStorage.setItem('demo', 'new');
        reject(new Error('offline'));
        await expect(first).rejects.toThrow('offline');
        window.shell.configStorage.patch.mockResolvedValueOnce({});
        await window.AppStorage.flush();
        expect(window.shell.configStorage.patch).toHaveBeenLastCalledWith({ demo: 'new' });
    });

    it('commit 在原生保存成功后才更新本地镜像', async () => {
        window.localStorage.setItem('demo', 'old');
        let resolve;
        window.shell.configStorage.patch.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
        const pending = window.AppStorage.commit({ demo: 'new' });
        expect(window.localStorage.getItem('demo')).toBe('old');
        resolve({});
        await pending;
        expect(window.localStorage.getItem('demo')).toBe('new');
    });

    it('提交期间的新修改在上一批成功后继续排队保存', async () => {
        let resolve;
        window.shell.configStorage.patch.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
        window.AppStorage.setItem('demo', 'old');
        const first = window.AppStorage.flush();
        window.AppStorage.setItem('demo', 'new');
        resolve({});
        await first;
        await new Promise((done) => setTimeout(done, 180));
        expect(window.shell.configStorage.patch).toHaveBeenLastCalledWith({ demo: 'new' });
    });
});

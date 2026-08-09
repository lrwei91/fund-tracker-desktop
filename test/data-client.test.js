/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('AppDataClient 数据错误契约', () => {
    beforeEach(() => {
        vi.resetModules();
        window.__TAURI__ = {
            core: { invoke: vi.fn() },
        };
    });

    it('保留 route/code/retryable/status/payload 到 AppDataError', async () => {
        window.__TAURI__.core.invoke.mockResolvedValue({
            success: false,
            message: '接口被限流',
            error: 'HTTP 429',
            errorCode: 'rate_limited',
            retryable: true,
            status: 429,
        });
        await import('../app/modules/data-client.js');

        await expect(window.AppDataClient.fetchData('/stock', { codes: '600000' }))
            .rejects.toMatchObject({
                name: 'AppDataError',
                route: '/stock',
                code: 'rate_limited',
                retryable: true,
                status: 429,
            });
        expect(window.__TAURI__.core.invoke).toHaveBeenCalledWith('fetch_data', {
            path: '/stock',
            query: { codes: '600000' },
        });
    });

    it('桥接不可用时返回不可重试错误', async () => {
        delete window.__TAURI__;
        await import('../app/modules/data-client.js');
        await expect(window.AppDataClient.fetchData('/stock', {})).rejects.toMatchObject({
            code: 'bridge_unavailable',
            retryable: false,
        });
    });

    it('规范化 codes 并向 Rust 传递 cache mode 与刷新周期', async () => {
        window.__TAURI__.core.invoke.mockResolvedValue({ success: true, data: {} });
        await import('../app/modules/data-client.js');

        await window.AppDataClient.fetchData('/stock', {
            codes: '600002,600001,600002',
        }, { cacheMode: 'bypass_fresh', cycleId: 9 });

        expect(window.__TAURI__.core.invoke).toHaveBeenCalledWith('fetch_data', {
            path: '/stock',
            query: { codes: '600001,600002' },
            options: { cacheMode: 'bypass_fresh', cycleId: 9 },
        });
    });

    it('强制刷新仍复用同一查询的在途请求', async () => {
        let resolveRequest;
        window.__TAURI__.core.invoke.mockReturnValueOnce(new Promise((resolve) => {
            resolveRequest = resolve;
        }));
        await import('../app/modules/data-client.js');

        const first = window.AppDataClient.fetchData('/stock', { codes: '600000' }, { cacheMode: 'normal' });
        const second = window.AppDataClient.fetchData('/stock', { codes: '600000' }, { force: true, cacheMode: 'bypass_fresh' });
        expect(window.__TAURI__.core.invoke).toHaveBeenCalledTimes(0);
        await Promise.resolve();
        expect(window.__TAURI__.core.invoke).toHaveBeenCalledTimes(1);
        resolveRequest({ success: true, data: {} });
        await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    });
});

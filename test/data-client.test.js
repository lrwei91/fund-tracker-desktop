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
});

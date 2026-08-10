/**
 * @vitest-environment jsdom
 */
import { beforeAll, describe, expect, it } from 'vitest';

describe('数据来源状态展示', () => {
    beforeAll(async () => {
        await import('../app/modules/data-status.js');
    });

    it('stale 数据显示缓存和年龄', () => {
        expect(window.AppDataStatus.label({ stale: true, staleAgeSeconds: 125 })).toBe('缓存数据 · 2分钟前');
    });

    it('degraded 数据显示备用来源提示', () => {
        expect(window.AppDataStatus.label({ degraded: true }, '新浪财经')).toBe('备用来源 · 新浪财经');
    });
});

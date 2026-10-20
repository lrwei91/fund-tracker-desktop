/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const schemaSource = readFileSync('app/config-schema.js', 'utf8');
describe.each(['app/modules/storage.js', 'renderer/storage.js'])('%s 原生状态保护', (file) => {
    beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
    afterEach(() => vi.useRealTimers());
    it('旧镜像和显式写入都不会回传或删除原生报告记录', async () => {
        const patch = vi.fn().mockResolvedValue({});
        window.eval(schemaSource);
        localStorage.setItem('fund_tracker_report_center', '{"runs":[]}');
        window.shell = { configStorage: { load: async () => ({ data: {} }), patch } };
        window.eval(readFileSync(file, 'utf8'));
        await window.AppStorage.hydrate();
        window.AppStorage.setItem('fund_tracker_report_center', '{"runs":["stale"]}');
        window.AppStorage.removeItem('fund_tracker_report_center');
        window.AppStorage.setItem('fund_tracker_watchlist_remarks', '{"600000":"保留"}');
        await window.AppStorage.flush();
        expect(patch).toHaveBeenCalledTimes(1);
        expect(patch.mock.calls[0][0]).toEqual({ fund_tracker_watchlist_remarks: '{"600000":"保留"}' });
    });
});

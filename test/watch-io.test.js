/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(process.cwd(), 'app/modules/watchlist/watch-io.js'), 'utf8');

function installWatch(options = {}) {
    const state = {
        activeWatchTabId: 'default',
        watchlistCost: { '600519': { cost: 100, shares: 1 } },
        watchlistRemarks: { '600519': '已有备注' },
        customIndexCodes: [],
        customIndexCache: {},
        customIndexUpdateTime: '',
        watchQuoteCache: { '600519': { price: 100 } },
        watchQuoteUpdateTime: '10:00',
        watchAlertState: { '600519': { last: 1 } },
    };
    const currentTabs = [{ id: 'default', name: '持仓股', codes: ['600519'] }, { id: 'candidate', name: '候选股', codes: [] }];
    const calls = { status: [] };
    const commit = options.commit || vi.fn().mockResolvedValue({});
    window.AppStorage = { commit, setItem: vi.fn() };
    window.AppFunds = {
        normalizeFunds: (entries) => Array.isArray(entries) ? entries.filter((entry) => /^\d{6}$/.test(String(entry.code))).map((entry) => ({ code: String(entry.code), name: entry.name || entry.code, type: entry.type || '' })) : [],
        exportFunds: () => [{ code: '110022', name: '已有基金', type: '股票型' }],
        importFunds: vi.fn(),
    };
    window.AppDialog = { choose: vi.fn().mockResolvedValue(options.mode || 'merge') };
    window.__watch = {
        state,
        KEYS: {
            CUSTOM_INDEX_MAX: 4,
            WATCH_TABS_KEY: 'fund_tracker_watchlist_tabs',
            STORAGE_KEY: 'fund_tracker_watchlist',
            ACTIVE_WATCH_TAB_KEY: 'fund_tracker_active_watch_tab',
            WATCHLIST_COST_KEY: 'fund_tracker_watchlist_cost',
            WATCHLIST_REMARKS_KEY: 'fund_tracker_watchlist_remarks',
            CUSTOM_INDICES_KEY: 'fund_tracker_custom_indices',
            WATCH_ALERT_STATE_KEY: 'fund_tracker_watch_alert_state',
            WATCH_ALERT_SCHEMA_VERSION: 2,
            FIXED_WATCH_TAB_IDS: ['default', 'candidate'],
        },
        hasOwn: (obj, key) => Object.prototype.hasOwnProperty.call(obj, key),
        sanitizeCodes: (codes) => Array.isArray(codes) ? codes.map((item) => String(item && item.code || item || '').trim()).filter((code, index, list) => /^\d{6}$/.test(code) && list.indexOf(code) === index) : [],
        normalizeWatchTabName: (name, index) => name || (index ? '分组' + (index + 1) : '持仓股'),
        getWatchTabs: () => currentTabs.map((tab) => ({ ...tab, codes: [...tab.codes] })),
        getCodesFromTabs: (tabs) => Object.fromEntries(tabs.flatMap((tab) => tab.codes.map((code) => [code, true]))),
        showDataStatus: (message, type) => calls.status.push({ message, type }),
        persistWatchQuoteCache: vi.fn(), persistWatchQuoteUpdateTime: vi.fn(),
        renderWatchTabs: vi.fn(), renderWatchlist: vi.fn(), renderCustomIndex: vi.fn(),
        loadWatchlistData: vi.fn(), loadCustomIndexData: vi.fn(),
    };
    new Function(source)();
    return { state, calls, commit };
}

function importFile(payload) {
    window.FileReader = class {
        readAsText() { this.result = JSON.stringify(payload); this.onload(); }
    };
    const target = { files: [{}], value: 'selected' };
    window.__watch.importWatchlistData({ target });
    return target;
}

describe('自选数据导入事务', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        delete window.__watch;
        delete window.AppDialog;
        delete window.AppFunds;
    });

    it('取消预览时不修改原状态', async () => {
        const { state, commit } = installWatch({ mode: 'cancel' });
        const before = JSON.stringify(state);
        importFile({ watchTabs: [{ id: 'default', name: '新分组', codes: ['000001'] }] });
        await Promise.resolve();
        expect(JSON.stringify(state)).toBe(before);
        expect(commit).not.toHaveBeenCalled();
    });

    it('保存失败时原状态保持不变并报告错误', async () => {
        const commit = vi.fn().mockRejectedValue(new Error('disk full'));
        const { state, calls } = installWatch({ commit, mode: 'replace' });
        const before = JSON.stringify(state);
        importFile({ watchTabs: [{ id: 'default', name: '新分组', codes: ['000001'] }], funds: [] });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(JSON.stringify(state)).toBe(before);
        expect(calls.status.at(-1).message).toContain('disk full');
    });

    it('合并成功后一次提交并更新界面', async () => {
        const { state, commit } = installWatch({ mode: 'merge' });
        importFile({ watchTabs: [{ id: 'default', name: '导入名', codes: ['000001'] }], funds: [{ code: '110023', name: '新基金' }] });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(commit).toHaveBeenCalledOnce();
        expect(JSON.parse(commit.mock.calls[0][0].fund_tracker_watchlist_tabs)[0].codes).toEqual(['600519', '000001']);
        expect(state.watchQuoteCache).toEqual({});
    });
});

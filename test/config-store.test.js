const fs = require('fs');
const os = require('os');
const path = require('path');
const { createConfigStore } = require('../desktop/config-store');

describe('desktop config store', () => {
    let directory;

    beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fund-tracker-config-')); });
    afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

    it('写入、合并并删除持久化配置', async () => {
        const store = createConfigStore(() => directory);
        await store.patch({ fund_tracker_active_main_tab: 'signals' });
        await store.patch({ fund_tracker_holding_clown_mode: 'true' });
        expect(store.load().data).toMatchObject({
            fund_tracker_active_main_tab: 'signals',
            fund_tracker_holding_clown_mode: 'true',
        });
        await store.patch({ fund_tracker_active_main_tab: null });
        expect(store.load().data.fund_tracker_active_main_tab).toBeUndefined();
        expect(JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8')).version).toBe(2);
    });
});

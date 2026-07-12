const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

describe('news refresh behavior', () => {
    it('刷新最新消息时保留分页游标并去重置顶', async () => {
        const dom = new JSDOM('<div id="news-list"></div>', { runScripts: 'dangerously', url: 'http://localhost/' });
        const { window } = dom;
        window.AppState = {
            KEYS: { NEWS_PAGE_SIZE: { jin10: 20 }, NEWS_SOURCE_KEY: 'source' },
            currentNewsSource: 'jin10',
            newsState: {
                jin10: {
                    items: [{ id: 'old', title: '', summary: '旧消息', time: '2026-07-12 10:00:00' }],
                    cursor: 'cursor-old', hasMore: true, isLoading: false, error: false,
                    actualSource: 'jin10', degraded: false,
                },
            },
        };
        window.AppUtils = { escapeHtml: (value) => String(value), getShanghaiDateKey: () => '2026-07-12' };
        window.AppStorage = { setItem() {} };
        window.AppDataClient = {
            fetch: async (_path, query) => {
                expect(query.cursor).toBeUndefined();
                return {
                    ok: true,
                    json: async () => ({
                        success: true,
                        data: {
                            data: [
                                { id: 'new', time: '2026-07-12 11:00:00', data: { content: '新消息' } },
                                { id: 'old', time: '2026-07-12 10:00:00', data: { content: '旧消息' } },
                            ],
                            nextCursor: 'cursor-new', hasMore: true, source: 'jin10',
                        },
                    }),
                };
            },
        };
        const code = fs.readFileSync(path.join(__dirname, '../app/modules/render-news.js'), 'utf8');
        window.eval(code);
        await window.AppNews.refreshNewsData();
        expect(window.AppState.newsState.jin10.cursor).toBe('cursor-old');
        expect(window.AppState.newsState.jin10.items.map((item) => item.id)).toEqual(['new', 'old']);
    });
});

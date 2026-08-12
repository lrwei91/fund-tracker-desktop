const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

describe('news refresh behavior', () => {
    it('每次启动固定使用金十快讯，不恢复上次来源', () => {
        const dom = new JSDOM('', { runScripts: 'dangerously', url: 'http://localhost/' });
        const { window } = dom;
        window.AppStorage = {
            getItem: (key) => key === 'fund_tracker_news_source' ? 'eastmoney' : null,
            setItem() {},
            removeItem() {},
        };
        const code = fs.readFileSync(path.join(__dirname, '../app/modules/state.js'), 'utf8');
        window.eval(code);
        window.AppState.restorePersistentState();
        expect(window.AppState.currentNewsSource).toBe('jin10');
        dom.window.close();
    });

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

    it('正常快讯列表不显示当前来源，降级时才显示警告', () => {
        const dom = new JSDOM('<div id="news-list"></div>', { runScripts: 'dangerously', url: 'http://localhost/' });
        const { window } = dom;
        window.AppState = {
            KEYS: { NEWS_PAGE_SIZE: { jin10: 20 } },
            currentNewsSource: 'jin10',
            newsState: {
                jin10: {
                    items: [{ id: '1', title: '', summary: '盘中快讯', time: '2026-08-13 10:00:00' }],
                    cursor: null, hasMore: false, isLoading: false, error: false,
                    actualSource: 'jin10', degraded: false, stale: false, staleAgeSeconds: 0,
                },
            },
        };
        window.AppUtils = { escapeHtml: (value) => String(value), getShanghaiDateKey: () => '2026-08-13' };
        const code = fs.readFileSync(path.join(__dirname, '../app/modules/render-news.js'), 'utf8');
        window.eval(code);

        window.AppNews.renderNewsList();
        expect(window.document.getElementById('news-list').textContent).not.toContain('当前来源');
        expect(window.document.querySelector('.news-source-warning')).toBeNull();

        window.AppState.newsState.jin10.degraded = true;
        window.AppNews.renderNewsList();
        expect(window.document.querySelector('.news-source-warning').textContent).toContain('备用来源');
        dom.window.close();
    });
});

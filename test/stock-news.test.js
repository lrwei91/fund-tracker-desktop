const news = require('../app/api/stock-news');

describe('stock-news helpers', () => {
    it('stripHtml 清理标签和实体', () => {
        expect(news.stripHtml('<em>订单</em>&amp;增长<br>')).toBe('订单&增长');
    });

    it('scoreNews 识别催化词和风险词', () => {
        const result = news.scoreNews([
            { title: '公司获得大额订单并启动回购' },
            { title: '股东拟减持，公司提示质押风险' },
        ]);
        expect(result.positiveHits).toEqual(expect.arrayContaining(['订单', '回购']));
        expect(result.riskHits).toEqual(expect.arrayContaining(['减持', '质押', '风险']));
        expect(result.score).toBeLessThan(0);
    });

    it('normalizeRows 归一化东财搜索结果', () => {
        const rows = news.normalizeRows({
            result: {
                cmsArticleWebOld: [{
                    title: '<em>中标</em>项目',
                    content: '产能&nbsp;说明',
                    date: '2026-07-09 09:30:00',
                    mediaName: '东方财富',
                    code: '2026070934567890',
                }],
            },
        }, 5);
        expect(rows).toHaveLength(1);
        expect(rows[0].title).toBe('中标项目');
        expect(rows[0].source).toBe('东方财富');
        expect(rows[0].url).toContain('2026070934567890');
    });
});

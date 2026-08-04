const clsNews = require('../app/api/cls-news');
const dragonTiger = require('../app/api/dragon-tiger');
const fundFlow = require('../app/api/fund-flow-120d');
const marketData = require('../app/api/market-data');
const stockRisk = require('../app/api/stock-risk');
const { runSources } = require('../app/api/_utils');

describe('v3.4 data reliability adapters', () => {
    it('生成稳定的财联社排序签名', () => {
        const request = clsNews.buildClsRequest('', 3);
        expect(request.query).toBe('appName=CailianpressWeb&last_time=&os=web&refresh_type=1&rn=3&sv=7.7.5');
        expect(request.sign).toBe('1f0bc409e7f8da02c2638332fd9bc9f3');
    });

    it('标准化财联社快讯', () => {
        const rows = clsNews.normalizeClsRows({ data: { roll_data: [{ id: 1, ctime: 1783831953, title: '标题', content: '正文' }] } });
        expect(rows[0]).toMatchObject({ id: '1', title: '标题', summary: '正文', timestamp: 1783831953 });
    });

    it('主源空数据时顺序切换备用源并记录原因', async () => {
        const result = await runSources([
            { id: 'primary', label: '主源', load: async () => [], validate: (rows) => rows.length > 0 },
            { id: 'backup', label: '备用源', load: async () => [1], validate: (rows) => rows.length > 0 },
        ]);
        expect(result.value).toEqual([1]);
        expect(result.meta).toMatchObject({ actual: 'backup', degraded: true });
        expect(result.meta.fallbackReason).toContain('主源');
    });

    it('新浪资金流只填充可确认字段', () => {
        const rows = fundFlow.parseSinaRows([{ opendate: '2026-07-10', netamount: '1000', changeratio: '0.012' }]);
        expect(rows[0]).toMatchObject({ date: '2026-07-10', mainNet: 1000, pct: 1.2 });
        expect(rows[0].largeNet).toBeNull();
        expect(rows[0].smallNet).toBeNull();
    });

    it('资金流不可用时不以零值伪装', () => {
        const item = fundFlow.unavailableItem('600519', '贵州茅台', new Error('全部失败'));
        expect(item.available).toBe(false);
        expect(item.summary.main_5d).toBeNull();
        expect(item.summary.today).toBeNull();
    });

    it('解析沪深交易所龙虎榜字段', () => {
        expect(dragonTiger.normalizeSzse([{ zqdm: '000001', zqjc: '平安银行', plyy: '异常波动' }])[0])
            .toMatchObject({ code: '000001', name: '平安银行', netBuyWan: null });
        expect(dragonTiger.normalizeSse(['证券代码: 600000  证券简称: 浦发银行'])[0])
            .toMatchObject({ code: '600000', name: '浦发银行', netBuyWan: null });
    });

    it('解析 HKEX 北向成交额和真实指数分钟点', () => {
        const hkex = 'tabData = ' + JSON.stringify([
            { date: '2026-07-10', market: 'SSE Northbound', content: [{ table: { tr: [{ td: [['100,000.00']] }] } }] },
            { date: '2026-07-10', market: 'SZSE Northbound', content: [{ table: { tr: [{ td: [['200,000.00']] }] } }] },
        ]);
        expect(marketData.parseHkexDaily(hkex)).toEqual({ date: '2026-07-10', turnoverYi: 3000 });
        expect(marketData.parseIndexMinuteRows(['0930 3010.12 10 20', '0931 3011.50 11 21'])).toEqual([3010.12, 3011.5]);
    });

    it('使用新版解禁字段并忽略废弃字段', () => {
        const result = stockRisk.normalizeLockupRows([{
            FREE_DATE: '2026-08-01', FREE_SHARES_TYPE: '定增', FREE_SHARES: 20,
            ABLE_FREE_SHARES: 15, FREE_RATIO: 0.025, LIMITED_STOCK_TYPE: '旧字段',
        }], '2026-07-12');
        expect(result.upcoming[0]).toMatchObject({ type: '定增', shares: 20, ableShares: 15, ratioPct: 2.5 });
    });
});

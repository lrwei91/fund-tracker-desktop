const radar = require('../app/api/opportunity-radar');

describe('opportunity-radar helpers', () => {
    it('historyWinRate 计算近 K 线上涨日占比', () => {
        const rate = radar.historyWinRate({
            bars: [
                { pct: 1.2 },
                { pct: -0.4 },
                { pct: 0 },
                { pct: 2.1 },
            ],
        });
        expect(rate).toBe(50);
    });

    it('riskState 识别新闻风险和技术弱势', () => {
        const risk = radar.riskState({
            name: '样例股份',
            pct: -8,
            isLimitDown: false,
        }, {
            kline: { analysis: { score: -40 } },
            fund: { summary: { today: { main: -150000000 } } },
            news: { score: { riskHits: ['减持', '问询'] } },
        });
        expect(risk.status).toBe('block');
        expect(risk.reasons).toEqual(expect.arrayContaining(['跌幅过大', '技术弱势', '主力流出']));
    });

    it('scoreRadarCandidate 输出综合分和分项分', () => {
        const row = radar.scoreRadarCandidate({
            code: '600000',
            name: '浦发银行',
            pct: 3.2,
            topicTags: ['银行'],
            signals: [{ label: '同花顺热榜', points: 18 }],
            sourceScore: 26,
            dragonNetWan: 12000,
            isLimitDown: false,
        }, {
            kline: {
                latestDate: '2026-07-09',
                analysis: { score: 28, indicators: { momentum21: 9, volumeRatio: 1.6 } },
                bars: [{ pct: 1 }, { pct: 2 }, { pct: -1 }, { pct: 0.5 }],
            },
            fund: { summary: { today: { main: 180000000 }, main_5d: 320000000 } },
            news: { score: { score: 1.6, positiveHits: ['订单'], riskHits: [] } },
        });
        expect(row.score).toBeGreaterThan(70);
        expect(row.components).toHaveProperty('topic');
        expect(row.risk.status).toBe('pass');
        expect(row.topic).toContain('银行');
    });

    it('sectorScoreFor 匹配板块资金流入和流出', () => {
        const sectorData = {
            inflow: [{ name: '机器人', value: '+8.00亿', leader: '甲公司' }],
            outflow: [{ name: '医药', value: '-3.00亿', leader: '乙公司' }],
        };
        expect(radar.sectorScoreFor({ industry: '机器人', topicTags: [] }, sectorData).points).toBeGreaterThan(0);
        expect(radar.sectorScoreFor({ industry: '消费', topicTags: ['医药'] }, sectorData).points).toBeLessThan(0);
    });
});

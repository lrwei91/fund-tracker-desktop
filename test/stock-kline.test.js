// 纯逻辑单测 — stock-kline.js 技术指标与筹码分布
// 不触发任何网络请求,只验证本地计算正确性
const k = require('../app/api/stock-kline');

function makeBars(n, start, end) {
    const bars = [];
    for (let i = 0; i < n; i++) {
        const close = start + (end - start) * (i / (n - 1));
        bars.push({
            date: '2024-01-' + String((i % 28) + 1).padStart(2, '0'),
            open: close - 0.5,
            close,
            high: close + 1,
            low: close - 1,
            volume: 1000 + i,
            amount: 100000,
            amplitude: 2,
            pct: 1,
            change: 0.5,
            turnover: 1,
        });
    }
    return bars;
}

function makeChipBars(n) {
    const bars = [];
    for (let i = 0; i < n; i++) {
        const base = 20 + 5 * Math.sin(i / 5);
        bars.push({
            date: '2024-02-' + String((i % 28) + 1).padStart(2, '0'),
            open: base - 0.3,
            close: base,
            high: base + 1,
            low: base - 1,
            volume: 500 + (i % 100),
            amount: 1000,
            amplitude: 1,
            pct: 0.5,
            change: 0,
            turnover: 1,
        });
    }
    return bars;
}

describe('基础工具函数', () => {
    it('marketCode: 沪市(6/9 开头)返回 1, 深市返回 0', () => {
        expect(k.marketCode('600000')).toBe(1);
        expect(k.marketCode('900901')).toBe(1);
        expect(k.marketCode('000001')).toBe(0);
        expect(k.marketCode('300750')).toBe(0);
    });

    it('clamp: 收敛到区间', () => {
        expect(k.clamp(150, -100, 100)).toBe(100);
        expect(k.clamp(-150, -100, 100)).toBe(-100);
        expect(k.clamp(42, -100, 100)).toBe(42);
    });

    it('round: 保留指定位数, 非数字返回 null', () => {
        expect(k.round(2.345, 2)).toBe(2.35);
        expect(k.round(2.345, 0)).toBe(2);
        expect(k.round(null, 2)).toBeNull();
        expect(k.round('abc', 2)).toBeNull();
    });

    it('parseKline: 逗号分隔解析为带类型的对象', () => {
        const bar = k.parseKline('2024-01-02,10,11,12,9,1000,20000,5,3,0.3,2');
        expect(bar.date).toBe('2024-01-02');
        expect(bar.open).toBe(10);
        expect(bar.close).toBe(11);
        expect(bar.high).toBe(12);
        expect(bar.low).toBe(9);
        expect(bar.volume).toBe(1000);
    });

    it('sma: 取末尾窗口均值', () => {
        expect(k.sma([1, 2, 3, 4], 2)).toBe(3.5);
        expect(k.sma([1], 2)).toBeNull();
    });

    it('emaSeries: 长度与输入一致', () => {
        const r = k.emaSeries([1, 2, 3], 2);
        expect(r).toHaveLength(3);
        expect(Number.isFinite(r[2])).toBe(true);
    });

    it('rsi: 返回 0~100 数值', () => {
        const r = k.rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 14);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(100);
    });

    it('macd: 返回 dif/dea/hist', () => {
        const closes = Array.from({ length: 60 }, (_, i) => 10 + Math.sin(i / 3));
        const m = k.macd(closes);
        expect(m).toHaveProperty('dif');
        expect(m).toHaveProperty('dea');
        expect(m).toHaveProperty('hist');
        expect(Number.isFinite(m.dif)).toBe(true);
    });

    it('bollinger: upper > mid > lower', () => {
        const closes = Array.from({ length: 40 }, (_, i) => 10 + i * 0.1);
        const b = k.bollinger(closes, 20);
        expect(b.upper).toBeGreaterThan(b.mid);
        expect(b.mid).toBeGreaterThan(b.lower);
    });

    it('percentileFromDistribution: 累加权重命中分位价格', () => {
        const levels = [
            { price: 10, weight: 1 },
            { price: 20, weight: 1 },
            { price: 30, weight: 1 },
        ];
        expect(k.percentileFromDistribution(levels, 0.5)).toBe(20);
        expect(k.percentileFromDistribution([], 0.5)).toBeNull();
    });
});

describe('computeTechnicalAnalysis', () => {
    it('持续上涨 -> 评分 > 0', () => {
        const bars = makeBars(120, 10, 30);
        const a = k.computeTechnicalAnalysis(bars);
        expect(a.score).toBeGreaterThan(0);
        expect(['强势', '偏多', '中性']).toContain(a.verdict);
        expect(a.signals.length).toBeGreaterThan(0);
        expect(a.indicators).toHaveProperty('ma20');
        expect(a.indicators).toHaveProperty('rsi14');
    });

    it('持续下跌 -> 评分 < 0', () => {
        const bars = makeBars(120, 30, 10);
        const a = k.computeTechnicalAnalysis(bars);
        expect(a.score).toBeLessThan(0);
        expect(['偏弱', '弱势', '中性']).toContain(a.verdict);
    });

    it('评分被钳制在 [-100, 100]', () => {
        const bars = makeBars(260, 10, 10);
        const a = k.computeTechnicalAnalysis(bars);
        expect(a.score).toBeGreaterThanOrEqual(-100);
        expect(a.score).toBeLessThanOrEqual(100);
    });

    it('signals 按权重绝对值降序且最多 6 条', () => {
        const bars = makeBars(260, 8, 25);
        const a = k.computeTechnicalAnalysis(bars);
        expect(a.signals.length).toBeLessThanOrEqual(6);
        for (let i = 1; i < a.signals.length; i++) {
            expect(Math.abs(a.signals[i].weight)).toBeLessThanOrEqual(Math.abs(a.signals[i - 1].weight));
        }
    });
});

describe('computeChipDistribution', () => {
    it('返回筹码分布关键字段且盈利比例在 0~100', () => {
        const bars = makeChipBars(60);
        const c = k.computeChipDistribution(bars);
        expect(c).not.toBeNull();
        expect(Number.isFinite(c.avgCost)).toBe(true);
        expect(c.profitRatio).toBeGreaterThanOrEqual(0);
        expect(c.profitRatio).toBeLessThanOrEqual(100);
        expect(c.levels.length).toBe(48);
        expect(c.note).toMatch(/成交量/);
    });

    it('成交量不足时返回 null', () => {
        const bars = makeChipBars(10);
        expect(k.computeChipDistribution(bars)).toBeNull();
    });

    it('支撑 < 压力(若两者均存在)', () => {
        const bars = makeChipBars(120);
        const c = k.computeChipDistribution(bars);
        if (c.support !== null && c.resistance !== null) {
            expect(c.support).toBeLessThan(c.resistance);
        }
    });
});

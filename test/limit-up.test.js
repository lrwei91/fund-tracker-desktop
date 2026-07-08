// 纯逻辑单测 — limit-up.js 涨停池字段映射与时间格式化
// 不触发网络(fetchPool 需联网, 此处不调用)
const l = require('../app/api/limit-up');

describe('fmtZtTime', () => {
    it('6 位整数补齐为 HH:mm:ss', () => {
        expect(l.fmtZtTime(93015)).toBe('09:30:15');
        expect(l.fmtZtTime(0)).toBe('00:00:00');
    });
    it('不足 6 位左侧补零', () => {
        expect(l.fmtZtTime(830)).toBe('00:08:30');
        expect(l.fmtZtTime(930)).toBe('00:09:30');
    });
    it('undefined/null 返回空串', () => {
        expect(l.fmtZtTime(undefined)).toBe('');
        expect(l.fmtZtTime(null)).toBe('');
    });
});

describe('todayStr', () => {
    it('返回 8 位 YYYYMMDD', () => {
        expect(l.todayStr()).toMatch(/^\d{8}$/);
    });
});

describe('POOL_MAPPER', () => {
    it('覆盖四池映射函数', () => {
        expect(Object.keys(l.POOL_MAPPER).sort()).toEqual(['dt', 'yzt', 'zb', 'zt']);
        expect(typeof l.POOL_MAPPER.zt).toBe('function');
        expect(typeof l.POOL_MAPPER.zb).toBe('function');
        expect(typeof l.POOL_MAPPER.dt).toBe('function');
        expect(typeof l.POOL_MAPPER.yzt).toBe('function');
    });
});

describe('mapZt', () => {
    it('价格除以 1000, 百分比四舍五入, 连板文案正确', () => {
        const p = {
            c: '600000', n: '浦发银行', m: 1, p: 13500, zdp: 9.98,
            amount: 1000000, ltsz: 500, hs: 3.21, lbc: 2,
            fbt: 93015, lbt: 93100, fund: 20000, zbc: 0,
            hybk: '银行', zttj: { days: 3, ct: 2 },
        };
        const r = l.mapZt(p);
        expect(r.code).toBe('600000');
        expect(r.name).toBe('浦发银行');
        expect(r.price).toBe(13.5);
        expect(r.pct).toBe(9.98);
        expect(r.floatCap).toBe(500);
        expect(r.turnover).toBe(3.21);
        expect(r.limitDays).toBe(2);
        expect(r.firstSeal).toBe('09:30:15');
        expect(r.lastSeal).toBe('09:31:00');
        expect(r.sealFund).toBe(20000);
        expect(r.breakTimes).toBe(0);
        expect(r.industry).toBe('银行');
        expect(r.ztStat).toBe('3天2板');
    });
});

describe('mapZb / mapDt / mapYzt', () => {
    it('mapZb 含涨停价与炸板次数', () => {
        const r = l.mapZb({ c: '000001', n: '平安银行', m: 0, p: 12345, ztp: 13500, zdp: 5.5, hs: 2.1, fbt: 93100, zbc: 1, zf: 8.5, zs: 3.2, hybk: '银行', zttj: { days: 1, ct: 1 } });
        expect(r.price).toBe(12.345);
        expect(r.limitPrice).toBe(13.5);
        expect(r.breakTimes).toBe(1);
        expect(r.amplitude).toBe(8.5);
    });
    it('mapDt 含跌停天数', () => {
        const r = l.mapDt({ c: '600519', n: '贵州茅台', m: 1, p: 1500000, zdp: -10, hs: 1.1, fund: 0, lbt: 94500, fba: 500, days: 2, oc: 3, hybk: '白酒' });
        expect(r.price).toBe(1500);
        expect(r.pct).toBe(-10);
        expect(r.dtDays).toBe(2);
        expect(r.openTimes).toBe(3);
    });
    it('mapYzt 含昨连板数', () => {
        const r = l.mapYzt({ c: '002594', n: '比亚迪', m: 0, p: 250000, zdp: 3.2, hs: 4.5, zf: 6, zs: 2, yfbt: 93000, ylbc: 3, hybk: '汽车', zttj: { days: 4, ct: 3 } });
        expect(r.price).toBe(250);
        expect(r.yLimitDays).toBe(3);
        expect(r.ztStat).toBe('4天3板');
    });
});

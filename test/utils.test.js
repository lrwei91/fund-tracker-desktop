// @vitest-environment jsdom
// 纯逻辑单测 — utils.js(window.AppUtils) 的格式化与转义
// 该模块以 IIFE 挂到 window, require 后从 window.AppUtils 取用
require('../app/modules/utils');
const U = window.AppUtils;

describe('formatYuan: 元 -> 亿/万 文本', () => {
    it('0 / null / undefined 一律返回 0', () => {
        expect(U.formatYuan(0)).toBe('0');
        expect(U.formatYuan(null)).toBe('0');
        expect(U.formatYuan(undefined)).toBe('0');
    });
    it('亿级: 除以 1e8 保留 2 位并带正负号', () => {
        expect(U.formatYuan(123456789)).toBe('+1.23亿');
        expect(U.formatYuan(-123456789)).toBe('-1.23亿');
    });
    it('万级: 除以 1e4 取整', () => {
        expect(U.formatYuan(12345)).toBe('+1万');
        expect(U.formatYuan(-50000)).toBe('-5万');
    });
    it('千元以下: 直接取整带正号', () => {
        expect(U.formatYuan(500)).toBe('+500');
    });
});

describe('escapeHtml: 防 XSS 转义', () => {
    it('转义 < > & " \'', () => {
        expect(U.escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    });
    it('转义引号与 &', () => {
        expect(U.escapeHtml('a&b"c\'')).toBe('a&amp;b&quot;c&#39;');
    });
    it('null/undefined 安全', () => {
        expect(U.escapeHtml(null)).toBe('');
        expect(U.escapeHtml(undefined)).toBe('');
    });
});

describe('formatQuotePrice: ETF 价格保留三位', () => {
    it('名称含 ETF 时使用三位小数', () => {
        expect(U.formatQuotePrice(2.3456, '--', '159915', '创业板ETF')).toBe('2.346');
    });
    it('常见 ETF 代码段使用三位小数', () => {
        expect(U.formatQuotePrice(1.2349, '--', '510300', '沪深300')).toBe('1.235');
    });
    it('普通股票仍保留两位小数并支持无数据回退', () => {
        expect(U.formatQuotePrice(12.345, '--', '600000', '浦发银行')).toBe('12.35');
        expect(U.formatQuotePrice(null, '--', '600000', '浦发银行')).toBe('--');
    });
});

describe('isTradingWeekday', () => {
    it('周一到周五为交易日', () => {
        expect(U.isTradingWeekday('周一')).toBe(true);
        expect(U.isTradingWeekday('周五')).toBe(true);
    });
    it('周末非交易日', () => {
        expect(U.isTradingWeekday('周六')).toBe(false);
        expect(U.isTradingWeekday('周日')).toBe(false);
    });
});

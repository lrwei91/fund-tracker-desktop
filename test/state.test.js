/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
// 副作用导入:执行 state.js 的 IIFE,挂载 window.AppState 及其受控访问层
import '../app/modules/state.js';

describe('AppState 受控访问层 (渐进治理)', () => {
    beforeEach(() => {
        // 把可测字段复位,避免测试间串味
        window.AppState.setState({ currentTab: 'dashboard', alertThreshold: 2 });
    });

    it('getState 返回共享单例同一引用', () => {
        expect(window.AppState.getState()).toBe(window.AppState);
    });

    it('setState 浅合并并写回顶层字段', () => {
        window.AppState.setState({ currentTab: 'news' });
        expect(window.AppState.currentTab).toBe('news');
    });

    it('setState 触发 change 事件并携带 patch', () => {
        var received = null;
        var off = window.AppState.subscribe('change', function (p) { received = p; });
        window.AppState.setState({ alertThreshold: 5 });
        expect(received).not.toBeNull();
        expect(received.patch.alertThreshold).toBe(5);
        expect(window.AppState.alertThreshold).toBe(5);
        off();
    });

    it('setState 触发 change:<key> 粒度事件', () => {
        var key = null;
        var off = window.AppState.subscribe('change:currentTab', function (p) { key = p.key; });
        window.AppState.setState({ currentTab: 'signals' });
        expect(key).toBe('currentTab');
        off();
    });

    it('change:<key> 仅对目标 key 触发,跨 key 不串', () => {
        var fired = false;
        var off = window.AppState.subscribe('change:alertThreshold', function () { fired = true; });
        window.AppState.setState({ currentTab: 'news' });
        expect(fired).toBe(false);
        window.AppState.setState({ alertThreshold: 9 });
        expect(fired).toBe(true);
        off();
    });

    it('subscribe 返回的函数可取消订阅', () => {
        var n = 0;
        var off = window.AppState.subscribe('change', function () { n++; });
        off();
        window.AppState.setState({ currentTab: 'news' });
        expect(n).toBe(0);
    });

    it('setState 非对象入参安全返回且不抛', () => {
        expect(window.AppState.setState(null)).toBe(window.AppState);
        expect(window.AppState.setState('x')).toBe(window.AppState);
        expect(window.AppState.setState(42)).toBe(window.AppState);
    });
});

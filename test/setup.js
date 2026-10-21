// Node >= 25 自带全局 localStorage/sessionStorage，未传 --localstorage-file
// 时取值为 undefined；vitest 的 jsdom 环境发现同名属性已存在便不再注入
// jsdom 的实现，于是 jsdom 测试里 localStorage 整体不可用（Node 24 无此问题）。
// 这里在每个 jsdom 测试文件执行前，用一个独立 JSDOM 实例的 Storage 重新绑定。
import { JSDOM } from 'jsdom';

if (typeof window !== 'undefined') {
    const ref = new JSDOM('', { url: 'http://localhost/' }).window;
    for (const key of ['localStorage', 'sessionStorage']) {
        if (typeof globalThis[key] === 'undefined' && ref[key]) {
            Object.defineProperty(globalThis, key, {
                value: ref[key],
                configurable: true,
                writable: true,
            });
        }
    }
}

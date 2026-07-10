const gateway = require('../app/api/_gateway');

describe('API gateway', () => {
    it('合并相同在途请求并复用 TTL 缓存', async () => {
        let calls = 0;
        const loader = async () => {
            calls += 1;
            return { value: calls };
        };
        const [first, second] = await Promise.all([
            gateway.request('test-coalesce', 'same', loader, { cacheTtl: 1000 }),
            gateway.request('test-coalesce', 'same', loader, { cacheTtl: 1000 }),
        ]);
        expect(first).toEqual({ value: 1 });
        expect(second).toEqual({ value: 1 });
        await expect(gateway.request('test-coalesce', 'same', loader, { cacheTtl: 1000 })).resolves.toEqual({ value: 1 });
        expect(calls).toBe(1);
    });

    it('尊重 provider 并发上限', async () => {
        let active = 0;
        let maxActive = 0;
        const loader = () => new Promise((resolve) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            setTimeout(() => { active -= 1; resolve(true); }, 5);
        });
        await Promise.all(['a', 'b', 'c'].map((key) => gateway.request('test-serial', key, loader, {
            concurrency: 1, minStartInterval: 0,
        })));
        expect(maxActive).toBe(1);
    });
});

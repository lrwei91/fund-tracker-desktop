const gateway = require('../app/api/_gateway');

describe('API gateway', () => {
    beforeEach(() => gateway.reset());

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

    it('东方财富 403 后立即熔断并允许半开探测恢复', async () => {
        const blocked = new Error('HTTP 403');
        blocked.status = 403;
        await expect(gateway.request('eastmoney', 'blocked', async () => { throw blocked; }, {
            minStartInterval: 0, startJitter: 0,
        })).rejects.toThrow('HTTP 403');
        await expect(gateway.request('eastmoney', 'next', async () => true)).rejects.toMatchObject({
            code: 'PROVIDER_CIRCUIT_OPEN',
        });

        const until = gateway.diagnostics().providers.eastmoney.circuitUntil;
        const dateNow = vi.spyOn(Date, 'now').mockReturnValue(until + 1);
        await expect(gateway.request('eastmoney', 'probe', async () => 'ok', {
            minStartInterval: 0, startJitter: 0,
        })).resolves.toBe('ok');
        expect(gateway.diagnostics().providers.eastmoney.circuitUntil).toBeNull();
        dateNow.mockRestore();
    });
});

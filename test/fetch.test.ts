import { jest, describe, test, expect } from '@jest/globals';
import { Bulkhead } from '../src/index.js';
import { limitFetch } from '../src/fetch.js';

type FetchArgs = [input: string | URL | Request, init?: RequestInit];

/** A fake fetch whose responses the test releases one at a time. */
function fakeFetch(respond: (input: FetchArgs[0]) => Response = () => new Response('ok')) {
    const calls: FetchArgs[] = [];
    const gates: Array<() => void> = [];
    let gated = false;
    const fn = (async (...args: FetchArgs) => {
        calls.push(args);
        if (gated) await new Promise<void>((r) => gates.push(r));
        return respond(args[0]);
    }) as typeof fetch;
    return {
        fn,
        calls,
        gate() {
            gated = true;
        },
        releaseAll() {
            gated = false;
            gates.splice(0).forEach((r) => r());
        },
    };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('limitFetch — concurrency', () => {
    test('passes the request through and returns the response untouched', async () => {
        const f = fakeFetch(() => new Response('hello', { status: 201 }));
        const limited = limitFetch(new Bulkhead({ concurrency: 1 }), { fetch: f.fn });
        const res = await limited('https://example.test/a', { method: 'POST', body: 'x' });
        expect(res.status).toBe(201);
        await expect(res.text()).resolves.toBe('hello');
        expect(f.calls[0][0]).toBe('https://example.test/a');
        expect(f.calls[0][1]).toMatchObject({ method: 'POST', body: 'x' });
    });

    test('caps in-flight requests at the bulkhead concurrency', async () => {
        const f = fakeFetch();
        f.gate();
        const bulkhead = new Bulkhead({ concurrency: 2 });
        const limited = limitFetch(bulkhead, { fetch: f.fn });
        const all = Promise.all([1, 2, 3, 4].map((i) => limited(`https://example.test/${i}`)));
        await tick();
        expect(f.calls).toHaveLength(2);
        expect(bulkhead.pendingCount).toBe(2);
        f.releaseAll();
        await tick();
        f.releaseAll();
        await all;
        expect(f.calls).toHaveLength(4);
    });

    test('takes per-request priority and queueTimeout from init.bulkhead and strips it', async () => {
        const f = fakeFetch();
        f.gate();
        const limited = limitFetch(new Bulkhead({ concurrency: 1 }), { fetch: f.fn });
        const first = limited('https://example.test/first');
        const low = limited('https://example.test/low', { bulkhead: { priority: 0 } });
        const high = limited('https://example.test/high', { headers: { a: 'b' }, bulkhead: { priority: 5 } });
        await tick();
        f.releaseAll();
        await first;
        await tick();
        expect(f.calls[1][0]).toBe('https://example.test/high');
        expect(f.calls[1][1]).toEqual({ headers: { a: 'b' } });
        f.releaseAll();
        await tick();
        f.releaseAll();
        await Promise.all([low, high]);
    });

    test('an abort signal on init or on a Request removes the queued request', async () => {
        const f = fakeFetch();
        f.gate();
        const limited = limitFetch(new Bulkhead({ concurrency: 1 }), { fetch: f.fn });
        const blocker = limited('https://example.test/blocker');

        const viaInit = new AbortController();
        const viaRequest = new AbortController();
        const a = limited('https://example.test/a', { signal: viaInit.signal });
        const b = limited(new Request('https://example.test/b', { signal: viaRequest.signal }));
        await tick();
        viaInit.abort();
        viaRequest.abort();
        await expect(a).rejects.toMatchObject({ name: 'AbortError' });
        await expect(b).rejects.toMatchObject({ name: 'AbortError' });

        f.releaseAll();
        await blocker;
        expect(f.calls).toHaveLength(1);
    });
});

describe('limitFetch — adaptive feedback', () => {
    const statusFetch = (status: number, headers: Record<string, string> = {}) =>
        fakeFetch(() => new Response(null, { status, headers })).fn;

    test('a 429 throttles, honours Retry-After, and still resolves with the response', async () => {
        const throttles: unknown[] = [];
        const bulkhead = new Bulkhead({ concurrency: 4, adaptive: { onThrottle: (i) => throttles.push(i) } });
        const res = await limitFetch(bulkhead, { fetch: statusFetch(429, { 'Retry-After': '7' }) })('https://x.test');
        expect(res.status).toBe(429);
        expect(bulkhead.concurrency).toBe(2);
        expect(bulkhead.isPaused).toBe(true);
        expect(throttles).toEqual([{ cooldownMs: 7_000, previousConcurrency: 4, newConcurrency: 2 }]);
        bulkhead.resume();
    });

    test('a 503 counts as overload by default', async () => {
        const bulkhead = new Bulkhead({ concurrency: 4, adaptive: true });
        await limitFetch(bulkhead, { fetch: statusFetch(503) })('https://x.test');
        expect(bulkhead.concurrency).toBe(2);
        bulkhead.resume();
    });

    test('overloadStatuses replaces the default set', async () => {
        const bulkhead = new Bulkhead({ concurrency: 4, adaptive: true });
        await limitFetch(bulkhead, { fetch: statusFetch(503), overloadStatuses: [429] })('https://x.test');
        expect(bulkhead.concurrency).toBe(4);
    });

    test.each([200, 204, 404])('a %i counts as success and ramps back up', async (status) => {
        const bulkhead = new Bulkhead({ concurrency: 4, adaptive: { successStep: 1 } });
        bulkhead.reportOverload({ retryAfterMs: 0 });
        await limitFetch(bulkhead, { fetch: statusFetch(status) })('https://x.test');
        expect(bulkhead.concurrency).toBe(3);
    });

    test('other 5xx responses and network errors are ignored', async () => {
        const bulkhead = new Bulkhead({ concurrency: 4, adaptive: { successStep: 1 } });
        bulkhead.reportOverload({ retryAfterMs: 0 });
        await limitFetch(bulkhead, { fetch: statusFetch(500) })('https://x.test');
        const failing = (async () => {
            throw new TypeError('fetch failed');
        }) as typeof fetch;
        await expect(limitFetch(bulkhead, { fetch: failing })('https://x.test')).rejects.toThrow('fetch failed');
        expect(bulkhead.concurrency).toBe(2);
    });

    test('defaults to the global fetch', async () => {
        const original = globalThis.fetch;
        const spy = jest.fn(async () => new Response('global'));
        globalThis.fetch = spy as unknown as typeof fetch;
        try {
            const res = await limitFetch(new Bulkhead({ concurrency: 1 }))('https://x.test');
            await expect(res.text()).resolves.toBe('global');
            expect(spy).toHaveBeenCalledTimes(1);
        } finally {
            globalThis.fetch = original;
        }
    });
});

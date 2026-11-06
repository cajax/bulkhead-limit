import { jest, describe, test, expect, afterEach } from '@jest/globals';
import { Bulkhead, QueueFullError, QueueTimeoutError } from '../src/index.js';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
}
const tick = () => new Promise((r) => setImmediate(r));

afterEach(() => {
    jest.useRealTimers();
});

describe('Bulkhead.configure', () => {
    test('raising maxQueueSize admits more waiting tasks', async () => {
        const bulkhead = new Bulkhead({ concurrency: 1, maxQueueSize: 0 });
        const gate = deferred();
        const blocker = bulkhead.run(() => gate.promise);
        await expect(bulkhead.run(() => 1)).rejects.toBeInstanceOf(QueueFullError);

        bulkhead.configure({ maxQueueSize: 1 });
        const queued = bulkhead.run(() => 2);
        await expect(bulkhead.run(() => 3)).rejects.toBeInstanceOf(QueueFullError);

        gate.resolve();
        await expect(queued).resolves.toBe(2);
        await blocker;
    });

    test('shrinking maxQueueSize keeps already-waiting tasks and sheds new ones', async () => {
        const bulkhead = new Bulkhead({ concurrency: 1, maxQueueSize: 5 });
        const gate = deferred();
        const blocker = bulkhead.run(() => gate.promise);
        const waiting = [bulkhead.run(() => 'a'), bulkhead.run(() => 'b')];
        await tick();

        bulkhead.configure({ maxQueueSize: 1 });
        expect(bulkhead.pendingCount).toBe(2);
        await expect(bulkhead.run(() => 'c')).rejects.toBeInstanceOf(QueueFullError);

        gate.resolve();
        await expect(Promise.all(waiting)).resolves.toEqual(['a', 'b']);
        await blocker;
    });

    test('maxQueueSize: undefined removes the bound', async () => {
        const bulkhead = new Bulkhead({ concurrency: 1, maxQueueSize: 0 });
        bulkhead.configure({ maxQueueSize: undefined });
        const gate = deferred();
        const runs = [bulkhead.run(() => gate.promise), bulkhead.run(() => 1), bulkhead.run(() => 2)];
        await tick();
        expect(bulkhead.pendingCount).toBe(2);
        gate.resolve();
        await Promise.all(runs);
    });

    test('a new queueTimeout applies to tasks queued afterwards', async () => {
        jest.useFakeTimers();
        const bulkhead = new Bulkhead({ concurrency: 1 });
        const gate = deferred();
        const blocker = bulkhead.run(() => gate.promise);

        bulkhead.configure({ queueTimeout: 100 });
        const assertion = expect(bulkhead.run(() => 1)).rejects.toBeInstanceOf(QueueTimeoutError);
        await jest.advanceTimersByTimeAsync(100);
        await assertion;

        bulkhead.configure({ queueTimeout: undefined });
        const patient = bulkhead.run(() => 'waited');
        await jest.advanceTimersByTimeAsync(60_000);
        gate.resolve();
        await expect(patient).resolves.toBe('waited');
        await blocker;
    });

    test('concurrency is applied like setConcurrency', () => {
        const bulkhead = new Bulkhead({ concurrency: 2, adaptive: true });
        bulkhead.configure({ concurrency: 6 });
        expect(bulkhead.concurrency).toBe(6);
        expect(bulkhead.targetConcurrency).toBe(6);
    });

    test('adaptive settings can be tuned live', () => {
        const bulkhead = new Bulkhead({ concurrency: 8, adaptive: true });
        bulkhead.configure({ adaptive: { decreaseFactor: 0.75, decreaseWindowMs: 0 } });
        bulkhead.reportOverload({ retryAfterMs: 0 });
        expect(bulkhead.concurrency).toBe(6);

        bulkhead.configure({ adaptive: { successStep: 1 } });
        bulkhead.reportSuccess();
        expect(bulkhead.concurrency).toBe(7);
    });

    test('rejects invalid values and leaves the configuration unchanged', async () => {
        const bulkhead = new Bulkhead({ concurrency: 1, maxQueueSize: 0, adaptive: true });
        expect(() => bulkhead.configure({ maxQueueSize: -1 })).toThrow(RangeError);
        expect(() => bulkhead.configure({ queueTimeout: Number.NaN })).toThrow(RangeError);
        expect(() => bulkhead.configure({ maxQueueSize: 10, adaptive: { decreaseFactor: 2 } })).toThrow(RangeError);

        const gate = deferred();
        const blocker = bulkhead.run(() => gate.promise);
        await expect(bulkhead.run(() => 1)).rejects.toBeInstanceOf(QueueFullError);
        gate.resolve();
        await blocker;
    });

    test('adaptive settings are rejected when adaptive is disabled', () => {
        const bulkhead = new Bulkhead({ concurrency: 1 });
        expect(() => bulkhead.configure({ adaptive: { successStep: 2 } })).toThrow(/adaptive/);
    });
});

import { jest, describe, test, expect, afterEach } from '@jest/globals';
import { Bulkhead, QueueFullError, QueueTimeoutError, QueueClearedError } from '../src/index.js';

/** A task whose completion the test controls. */
function deferred<T = void>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setImmediate(r));

afterEach(() => {
    jest.useRealTimers();
});

describe('Bulkhead.run — admission', () => {
    test('returns the task result', async () => {
        const bulkhead = new Bulkhead({ concurrency: 2 });
        await expect(bulkhead.run(async () => 42)).resolves.toBe(42);
        await expect(bulkhead.run(() => 'sync')).resolves.toBe('sync');
    });

    test('never runs more than `concurrency` tasks at once', async () => {
        const bulkhead = new Bulkhead({ concurrency: 2 });
        let running = 0;
        let peak = 0;
        const task = async () => {
            running++;
            peak = Math.max(peak, running);
            await tick();
            running--;
        };
        await Promise.all(Array.from({ length: 10 }, () => bulkhead.run(task)));
        expect(peak).toBe(2);
        expect(bulkhead.activeCount).toBe(0);
        expect(bulkhead.pendingCount).toBe(0);
    });

    test('releases the slot when the task throws, synchronously or not', async () => {
        const bulkhead = new Bulkhead({ concurrency: 1 });
        await expect(
            bulkhead.run(() => {
                throw new Error('sync');
            }),
        ).rejects.toThrow('sync');
        await expect(
            bulkhead.run(async () => {
                throw new Error('async');
            }),
        ).rejects.toThrow('async');
        expect(bulkhead.activeCount).toBe(0);
        await expect(bulkhead.run(() => 'still works')).resolves.toBe('still works');
    });

    test('dispatches higher-priority queued tasks first, FIFO within a priority', async () => {
        const bulkhead = new Bulkhead({ concurrency: 1 });
        const gate = deferred();
        const order: string[] = [];
        const blocker = bulkhead.run(() => gate.promise);
        const runs = [
            bulkhead.run(() => order.push('low-1'), { priority: 0 }),
            bulkhead.run(() => order.push('high'), { priority: 10 }),
            bulkhead.run(() => order.push('low-2'), { priority: 0 }),
        ];
        gate.resolve();
        await Promise.all([blocker, ...runs]);
        expect(order).toEqual(['high', 'low-1', 'low-2']);
    });

    test('validates options', () => {
        expect(() => new Bulkhead({ concurrency: 0 })).toThrow(RangeError);
        expect(() => new Bulkhead({ concurrency: 1, maxQueueSize: -1 })).toThrow(RangeError);
        expect(() => new Bulkhead({ concurrency: 1, queueTimeout: Number.NaN })).toThrow(RangeError);
    });
});

describe('Bulkhead.run — load shedding', () => {
    test('rejects with QueueFullError once maxQueueSize tasks are waiting, without running it', async () => {
        const bulkhead = new Bulkhead({ concurrency: 1, maxQueueSize: 1 });
        const gate = deferred();
        const blocker = bulkhead.run(() => gate.promise);
        const queued = bulkhead.run(() => 'queued');
        const shed = jest.fn(() => 'shed');

        await expect(bulkhead.run(shed)).rejects.toBeInstanceOf(QueueFullError);
        expect(shed).not.toHaveBeenCalled();

        gate.resolve();
        await expect(queued).resolves.toBe('queued');
        await blocker;
    });

    test('rejects with QueueTimeoutError when the queue wait exceeds queueTimeout', async () => {
        jest.useFakeTimers();
        const bulkhead = new Bulkhead({ concurrency: 1, queueTimeout: 1_000 });
        const gate = deferred();
        const blocker = bulkhead.run(() => gate.promise);
        const stale = jest.fn();

        const result = bulkhead.run(stale);
        const assertion = expect(result).rejects.toBeInstanceOf(QueueTimeoutError);
        await jest.advanceTimersByTimeAsync(1_000);
        await assertion;
        expect(stale).not.toHaveBeenCalled();
        expect(bulkhead.pendingCount).toBe(0);

        gate.resolve();
        await blocker;
    });

    test('a per-run queueTimeout overrides the default', async () => {
        jest.useFakeTimers();
        const bulkhead = new Bulkhead({ concurrency: 1, queueTimeout: 60_000 });
        const gate = deferred();
        const blocker = bulkhead.run(() => gate.promise);

        const assertion = expect(bulkhead.run(() => 1, { queueTimeout: 10 })).rejects.toBeInstanceOf(QueueTimeoutError);
        await jest.advanceTimersByTimeAsync(10);
        await assertion;

        gate.resolve();
        await blocker;
    });

    test('clearQueue rejects waiting tasks with QueueClearedError (or a given reason)', async () => {
        const bulkhead = new Bulkhead({ concurrency: 1 });
        const gate = deferred();
        const blocker = bulkhead.run(() => gate.promise);
        const a = bulkhead.run(() => 'a');
        const b = bulkhead.run(() => 'b');

        expect(bulkhead.clearQueue()).toBe(2);
        await expect(a).rejects.toBeInstanceOf(QueueClearedError);
        await expect(b).rejects.toBeInstanceOf(QueueClearedError);

        const c = bulkhead.run(() => 'c');
        const reason = new Error('logged out');
        bulkhead.clearQueue(reason);
        await expect(c).rejects.toBe(reason);

        gate.resolve();
        await blocker;
    });
});

describe('Bulkhead.run — AbortSignal', () => {
    test('passes the signal to the task', async () => {
        const bulkhead = new Bulkhead({ concurrency: 1 });
        const controller = new AbortController();
        const seen = await bulkhead.run(({ signal }) => signal, { signal: controller.signal });
        expect(seen).toBe(controller.signal);
    });

    test('aborting while queued removes the task and rejects with signal.reason', async () => {
        const bulkhead = new Bulkhead({ concurrency: 1 });
        const gate = deferred();
        const blocker = bulkhead.run(() => gate.promise);
        const controller = new AbortController();
        const task = jest.fn();

        const result = bulkhead.run(task, { signal: controller.signal });
        await tick();
        expect(bulkhead.pendingCount).toBe(1);

        const reason = new Error('user left');
        controller.abort(reason);
        await expect(result).rejects.toBe(reason);
        expect(bulkhead.pendingCount).toBe(0);

        gate.resolve();
        await blocker;
        expect(task).not.toHaveBeenCalled();
    });

    test('an already-aborted signal rejects without running, even when a slot is free', async () => {
        const bulkhead = new Bulkhead({ concurrency: 1 });
        const task = jest.fn();
        await expect(bulkhead.run(task, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
        expect(task).not.toHaveBeenCalled();
        expect(bulkhead.activeCount).toBe(0);
    });

    test('aborting a running task keeps its slot until the task actually settles', async () => {
        const bulkhead = new Bulkhead({ concurrency: 1 });
        const controller = new AbortController();
        const gate = deferred();
        const running = bulkhead.run(() => gate.promise, { signal: controller.signal });
        await tick();

        controller.abort();
        await tick();
        expect(bulkhead.activeCount).toBe(1);

        gate.resolve();
        await running;
        expect(bulkhead.activeCount).toBe(0);
    });
});

describe('Bulkhead — runtime control', () => {
    test('setConcurrency resizes the live limit and the adaptive target', async () => {
        const bulkhead = new Bulkhead({ concurrency: 1, adaptive: true });
        const gate = deferred();
        const runs = [1, 2, 3].map(() => bulkhead.run(() => gate.promise));
        await tick();
        expect(bulkhead.activeCount).toBe(1);

        bulkhead.setConcurrency(3);
        expect(bulkhead.concurrency).toBe(3);
        expect(bulkhead.targetConcurrency).toBe(3);
        expect(bulkhead.activeCount).toBe(3);

        gate.resolve();
        await Promise.all(runs);
    });

    test('pause holds queued tasks; resume releases them', async () => {
        const bulkhead = new Bulkhead({ concurrency: 1 });
        bulkhead.pause(60_000);
        expect(bulkhead.isPaused).toBe(true);
        const task = jest.fn(() => 'ran');
        const result = bulkhead.run(task);
        await tick();
        expect(task).not.toHaveBeenCalled();

        bulkhead.resume();
        await expect(result).resolves.toBe('ran');
    });

    test('reports queue-wait time on dispatch', async () => {
        const infos: { waitMs: number; queueSize: number }[] = [];
        const bulkhead = new Bulkhead({ concurrency: 1, onDispatch: (i) => infos.push(i) });
        await bulkhead.run(() => undefined);
        expect(infos).toEqual([{ waitMs: 0, queueSize: 0 }]);
    });
});

describe('Bulkhead — adaptive feedback', () => {
    test('a task classified as overload throttles before its slot is released', async () => {
        const bulkhead = new Bulkhead({
            concurrency: 4,
            adaptive: { classify: (o) => (o.ok ? 'success' : { overload: true, retryAfterMs: 60_000 }) },
        });
        const next = jest.fn();

        const failing = bulkhead.run(async () => {
            throw new Error('429');
        });
        const queuedBehind = bulkhead.run(next);
        await expect(failing).rejects.toThrow('429');

        expect(bulkhead.concurrency).toBe(2);
        expect(bulkhead.isPaused).toBe(true);
        expect(bulkhead.targetConcurrency).toBe(4);
        // queuedBehind was admitted immediately (slot was free); new work now waits for the cooldown.
        await queuedBehind;
        const held = jest.fn();
        const later = bulkhead.run(held);
        await tick();
        expect(held).not.toHaveBeenCalled();

        bulkhead.resetAdaptive();
        await later;
        expect(held).toHaveBeenCalled();
        expect(bulkhead.concurrency).toBe(4);
    });

    test('a task queued behind an overloaded one waits out the cooldown instead of slipping through', async () => {
        const bulkhead = new Bulkhead({
            concurrency: 1,
            adaptive: { classify: () => 'overload', fallbackCooldownMs: 60_000 },
        });
        const next = jest.fn();
        const failing = bulkhead.run(async () => {
            await tick();
            throw new Error('429');
        });
        const queued = bulkhead.run(next);
        await expect(failing).rejects.toThrow('429');
        await tick();
        expect(next).not.toHaveBeenCalled();
        expect(bulkhead.pendingCount).toBe(1);

        bulkhead.resume();
        await queued;
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('by default, a resolved task counts as success and a rejected one is ignored', async () => {
        const bulkhead = new Bulkhead({ concurrency: 4, adaptive: { successStep: 1 } });
        bulkhead.reportOverload({ retryAfterMs: 0 });
        expect(bulkhead.concurrency).toBe(2);

        await bulkhead
            .run(async () => {
                throw new Error('x');
            })
            .catch(() => undefined);
        expect(bulkhead.concurrency).toBe(2);

        await bulkhead.run(() => 'ok');
        expect(bulkhead.concurrency).toBe(3);
    });

    test('a per-run classifier overrides the default', async () => {
        const bulkhead = new Bulkhead({ concurrency: 4, adaptive: true });
        await bulkhead.run(() => ({ status: 429 }), {
            classify: (o) => (o.ok && (o.value as { status: number }).status === 429 ? 'overload' : 'success'),
        });
        expect(bulkhead.concurrency).toBe(2);
        bulkhead.resume();
    });

    test('without adaptive, feedback changes nothing', async () => {
        const bulkhead = new Bulkhead({ concurrency: 4 });
        bulkhead.reportOverload({ retryAfterMs: 60_000 });
        await bulkhead.run(() => 'x', { classify: () => 'overload' });
        expect(bulkhead.concurrency).toBe(4);
        expect(bulkhead.isPaused).toBe(false);
    });
});

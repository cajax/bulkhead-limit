import { jest, describe, test, expect, afterEach } from '@jest/globals';
import { BoundedLimiter, ReleaseFn, Cancellation } from '../src/bounded-limiter.js';

// These tests exercise the generic primitive directly — note there is NO axios
// import anywhere in this file, which is the point: BoundedLimiter is decoupled.

// Distinct sentinel errors so we can assert the right factory ran with the right context.
class TimeoutErr extends Error {
    constructor(public readonly ctx: unknown) {
        super('timeout');
    }
}
class OverflowErr extends Error {
    constructor(public readonly ctx: unknown) {
        super('overflow');
    }
}
class AbortErr extends Error {
    constructor(public readonly ctx: unknown) {
        super('abort');
    }
}

interface LimiterOpts {
    maxConcurrency: number;
    maxQueueSize?: number;
    queueTimeout?: number;
}

function makeLimiter(opts: LimiterOpts) {
    const events = {
        active: [] as number[],
        pending: [] as number[],
        dispatch: [] as any[],
        timeout: [] as any[],
        overflow: [] as any[],
    };
    const limiter = new BoundedLimiter<string>({
        maxConcurrency: opts.maxConcurrency,
        maxQueueSize: opts.maxQueueSize,
        queueTimeout: opts.queueTimeout,
        onActiveCountChange: (n) => events.active.push(n),
        onPendingCountChange: (n) => events.pending.push(n),
        onDispatch: (i) => events.dispatch.push(i),
        onQueueTimeout: (i) => events.timeout.push(i),
        onQueueOverflow: (i) => events.overflow.push(i),
        createTimeoutError: (ctx) => new TimeoutErr(ctx),
        createOverflowError: (ctx) => new OverflowErr(ctx),
        createAbortError: (ctx) => new AbortErr(ctx),
    });
    return { limiter, events };
}

/** A controllable Cancellation, with visibility into listener cleanup. */
function makeCancellation() {
    let aborted = false;
    const listeners = new Set<() => void>();
    const cancellation: Cancellation = {
        get aborted() {
            return aborted;
        },
        subscribe(onAbort) {
            listeners.add(onAbort);
            return () => listeners.delete(onAbort);
        },
    };
    return {
        cancellation,
        abort() {
            aborted = true;
            for (const l of [...listeners]) l();
        },
        preAbort() {
            aborted = true;
        },
        listenerCount: () => listeners.size,
    };
}

interface Rec {
    granted: boolean;
    release: ReleaseFn | null;
    error: unknown;
    done: boolean;
}

/** Acquire and record the outcome without risking an unhandled rejection. */
function track(p: Promise<ReleaseFn>): Rec {
    const rec: Rec = { granted: false, release: null, error: undefined, done: false };
    p.then(
        (release) => {
            rec.granted = true;
            rec.release = release;
            rec.done = true;
        },
        (error) => {
            rec.error = error;
            rec.done = true;
        },
    );
    return rec;
}

async function flushUntil(cond: () => boolean, label = 'condition'): Promise<void> {
    for (let i = 0; i < 500; i++) {
        if (cond()) return;
        await Promise.resolve();
    }
    throw new Error(`flushUntil: ${label} was never met`);
}

afterEach(() => {
    jest.useRealTimers();
});

describe('BoundedLimiter — admission & concurrency', () => {
    test('admits immediately when a slot is free, reporting zero queue-wait', async () => {
        const { limiter, events } = makeLimiter({ maxConcurrency: 1, queueTimeout: 100 });
        jest.useFakeTimers();

        const a = track(limiter.acquire('a'));
        await flushUntil(() => a.granted, 'a granted');

        expect(limiter.activeCount).toBe(1);
        expect(limiter.pendingCount).toBe(0);
        expect(events.active).toEqual([1]);
        expect(events.dispatch).toEqual([{ context: 'a', waitMs: 0, queueSize: 0 }]);
        expect(jest.getTimerCount()).toBe(0); // immediate admit arms no queue timer
    });

    test('caps concurrency and dispatches the queue in FIFO order', async () => {
        const { limiter, events } = makeLimiter({ maxConcurrency: 2 });

        const a = track(limiter.acquire('a'));
        const b = track(limiter.acquire('b'));
        await flushUntil(() => limiter.activeCount === 2, 'two running');
        const c = track(limiter.acquire('c'));
        const d = track(limiter.acquire('d'));
        await flushUntil(() => limiter.pendingCount === 2, 'two queued');

        expect(Math.max(...events.active)).toBe(2);

        // Free one slot → 'c' (queued first) runs before 'd'.
        a.release!();
        await flushUntil(() => c.granted, 'c dispatched');
        expect(d.granted).toBe(false);
        expect(events.dispatch.map((i) => i.context)).toEqual(['a', 'b', 'c']);

        b.release!();
        await flushUntil(() => d.granted, 'd dispatched');
        c.release!();
        d.release!();
        await flushUntil(() => limiter.activeCount === 0, 'drained');
        expect(Math.max(...events.active)).toBe(2);
        expect(limiter.pendingCount).toBe(0);
    });

    test('release is idempotent — a double release never over-decrements active', async () => {
        const { limiter, events } = makeLimiter({ maxConcurrency: 1 });

        const a = track(limiter.acquire('a'));
        await flushUntil(() => a.granted, 'a granted');
        const b = track(limiter.acquire('b'));
        await flushUntil(() => limiter.pendingCount === 1, 'b queued');

        a.release!();
        a.release!(); // second call must be a no-op
        await flushUntil(() => b.granted, 'b dispatched');

        expect(limiter.activeCount).toBe(1); // only b, not -1 + b
        expect(events.active).toEqual([1, 0, 1]); // admit a, release a (once), dispatch b

        b.release!();
        await flushUntil(() => limiter.activeCount === 0, 'drained');
        expect(events.active).toEqual([1, 0, 1, 0]);
    });
});

describe('BoundedLimiter — queueTimeout', () => {
    test('times out a task that waits too long, leaving active untouched and clearing the timer', async () => {
        jest.useFakeTimers();
        const { limiter, events } = makeLimiter({ maxConcurrency: 1, queueTimeout: 1000 });

        const a = track(limiter.acquire('a'));
        await flushUntil(() => a.granted, 'a running');
        const b = track(limiter.acquire('b'));
        await flushUntil(() => limiter.pendingCount === 1, 'b queued');
        expect(jest.getTimerCount()).toBe(1);

        const activeEventsBefore = events.active.length;
        await jest.advanceTimersByTimeAsync(1000);

        expect(b.error).toBeInstanceOf(TimeoutErr);
        expect((b.error as TimeoutErr).ctx).toBe('b'); // factory got the right context
        expect(limiter.pendingCount).toBe(0);
        expect(limiter.activeCount).toBe(1); // 'a' untouched
        expect(events.active.length).toBe(activeEventsBefore); // timeout never touched active
        expect(events.timeout).toEqual([{ context: 'b', waitMs: 1000, queueSize: 0 }]);
        expect(jest.getTimerCount()).toBe(0);

        a.release!();
        await flushUntil(() => limiter.activeCount === 0, 'drained');
    });

    test('a task dispatched before its deadline keeps running and clears its timer', async () => {
        jest.useFakeTimers();
        const { limiter } = makeLimiter({ maxConcurrency: 1, queueTimeout: 1000 });

        const a = track(limiter.acquire('a'));
        await flushUntil(() => a.granted, 'a running');
        const b = track(limiter.acquire('b'));
        await flushUntil(() => limiter.pendingCount === 1, 'b queued');

        await jest.advanceTimersByTimeAsync(300);
        a.release!();
        await flushUntil(() => b.granted, 'b dispatched');
        expect(jest.getTimerCount()).toBe(0); // b's timer cleared on dispatch

        await jest.advanceTimersByTimeAsync(5000); // well past the original deadline
        expect(b.error).toBeUndefined();
        b.release!();
        await flushUntil(() => limiter.activeCount === 0, 'drained');
    });

    test('a per-acquire queueTimeout overrides the limiter default', async () => {
        jest.useFakeTimers();
        const { limiter } = makeLimiter({ maxConcurrency: 1, queueTimeout: 10000 });

        const a = track(limiter.acquire('a'));
        await flushUntil(() => a.granted, 'a running');
        const b = track(limiter.acquire('b', { queueTimeout: 200 }));
        await flushUntil(() => limiter.pendingCount === 1, 'b queued');

        await jest.advanceTimersByTimeAsync(200);
        expect(b.error).toBeInstanceOf(TimeoutErr); // hit 200, not 10000

        a.release!();
        await flushUntil(() => limiter.activeCount === 0, 'drained');
    });

    test('reports queue-wait latency on dispatch', async () => {
        jest.useFakeTimers();
        const { limiter, events } = makeLimiter({ maxConcurrency: 1 });

        const a = track(limiter.acquire('a'));
        await flushUntil(() => a.granted, 'a running');
        const b = track(limiter.acquire('b'));
        await flushUntil(() => limiter.pendingCount === 1, 'b queued');

        await jest.advanceTimersByTimeAsync(420);
        a.release!();
        await flushUntil(() => b.granted, 'b dispatched');

        expect(events.dispatch[0]).toEqual({ context: 'a', waitMs: 0, queueSize: 0 });
        expect(events.dispatch[1]).toEqual({ context: 'b', waitMs: 420, queueSize: 0 });
    });
});

describe('BoundedLimiter — maxQueueSize', () => {
    test('overflow rejects immediately with no count callback and leaves the queue intact', async () => {
        const { limiter, events } = makeLimiter({ maxConcurrency: 1, maxQueueSize: 1 });

        const a = track(limiter.acquire('a'));
        await flushUntil(() => a.granted, 'a running');
        const b = track(limiter.acquire('b'));
        await flushUntil(() => limiter.pendingCount === 1, 'b queued (full)');

        const pendingEvents = events.pending.length;
        const activeEvents = events.active.length;

        const c = track(limiter.acquire('c'));
        await flushUntil(() => c.done, 'c rejected');

        expect(c.error).toBeInstanceOf(OverflowErr);
        expect((c.error as OverflowErr).ctx).toBe('c');
        expect(events.overflow).toEqual([{ context: 'c', waitMs: 0, queueSize: 1 }]);
        // No count callback fired for the overflow-rejected task.
        expect(events.pending.length).toBe(pendingEvents);
        expect(events.active.length).toBe(activeEvents);
        expect(limiter.pendingCount).toBe(1); // 'b' still queued

        a.release!();
        await flushUntil(() => b.granted, 'b dispatched');
        b.release!();
        await flushUntil(() => limiter.activeCount === 0, 'drained');
    });
});

describe('BoundedLimiter — cancellation', () => {
    test('aborting a queued task removes it, fires pending--, rejects, and unsubscribes the listener', async () => {
        jest.useFakeTimers();
        const { limiter, events } = makeLimiter({ maxConcurrency: 1, queueTimeout: 1000 });
        const cancel = makeCancellation();

        const a = track(limiter.acquire('a'));
        await flushUntil(() => a.granted, 'a running');
        const b = track(limiter.acquire('b', { cancellation: cancel.cancellation }));
        await flushUntil(() => limiter.pendingCount === 1, 'b queued');
        expect(cancel.listenerCount()).toBe(1);
        expect(jest.getTimerCount()).toBe(1);

        const activeEventsBefore = events.active.length;
        cancel.abort();
        await flushUntil(() => b.done, 'b cancelled');

        expect(b.error).toBeInstanceOf(AbortErr);
        expect((b.error as AbortErr).ctx).toBe('b');
        expect(limiter.pendingCount).toBe(0);
        expect(limiter.activeCount).toBe(1); // untouched
        expect(events.active.length).toBe(activeEventsBefore);
        expect(cancel.listenerCount()).toBe(0); // listener removed → no leak
        expect(jest.getTimerCount()).toBe(0); // queue timer cleared

        a.release!();
        await flushUntil(() => limiter.activeCount === 0, 'drained');
    });

    test('an already-aborted cancellation rejects before enqueue, without queuing or subscribing', async () => {
        const { limiter, events } = makeLimiter({ maxConcurrency: 1 });
        const cancel = makeCancellation();

        const a = track(limiter.acquire('a'));
        await flushUntil(() => a.granted, 'a running');

        cancel.preAbort(); // aborted before we even try to enqueue
        const b = track(limiter.acquire('b', { cancellation: cancel.cancellation }));
        await flushUntil(() => b.done, 'b rejected');

        expect(b.error).toBeInstanceOf(AbortErr);
        expect(limiter.pendingCount).toBe(0);
        expect(events.pending).toEqual([]); // never enqueued → no pending callback
        expect(cancel.listenerCount()).toBe(0); // never subscribed

        a.release!();
        await flushUntil(() => limiter.activeCount === 0, 'drained');
    });
});

describe('BoundedLimiter — invariants', () => {
    test('mixed workload keeps active/pending counts and event payloads exact', async () => {
        jest.useFakeTimers();
        const { limiter, events } = makeLimiter({ maxConcurrency: 1, maxQueueSize: 3, queueTimeout: 1000 });
        const cancelE = makeCancellation();

        const a = track(limiter.acquire('a'));
        await flushUntil(() => a.granted, 'a admitted');
        const b = track(limiter.acquire('b'));
        await flushUntil(() => limiter.pendingCount === 1, 'b queued');
        const c = track(limiter.acquire('c'));
        await flushUntil(() => limiter.pendingCount === 2, 'c queued');
        const e = track(limiter.acquire('e', { cancellation: cancelE.cancellation }));
        await flushUntil(() => limiter.pendingCount === 3, 'e queued');

        const d = track(limiter.acquire('d')); // overflow
        await flushUntil(() => d.done, 'd overflow');
        expect(d.error).toBeInstanceOf(OverflowErr);

        a.release!(); // → dispatch b
        await flushUntil(() => b.granted, 'b dispatched');

        cancelE.abort(); // cancel e (middle of queue)
        await flushUntil(() => e.done, 'e cancelled');

        await jest.advanceTimersByTimeAsync(1000); // c times out
        await flushUntil(() => c.done, 'c timed out');

        b.release!();
        await flushUntil(() => limiter.activeCount === 0, 'drained');

        expect(a.granted).toBe(true);
        expect(b.granted).toBe(true);
        expect(c.error).toBeInstanceOf(TimeoutErr);
        expect(e.error).toBeInstanceOf(AbortErr);

        // Exact transition sequences (same model the axios layer relies on).
        expect(events.active).toEqual([1, 0, 1, 0]);
        expect(events.pending).toEqual([1, 2, 3, 2, 1, 0]);
        expect(events.dispatch.map((i) => i.context)).toEqual(['a', 'b']);
        expect(events.overflow).toEqual([{ context: 'd', waitMs: 0, queueSize: 3 }]);
        expect(events.timeout).toEqual([{ context: 'c', waitMs: 1000, queueSize: 0 }]);

        expect(limiter.activeCount).toBe(0);
        expect(limiter.pendingCount).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('timeout and dispatch on the same tick settle to exactly one outcome', async () => {
        jest.useFakeTimers();
        const { limiter, events } = makeLimiter({ maxConcurrency: 1, queueTimeout: 1000 });

        const a = track(limiter.acquire('a'));
        await flushUntil(() => a.granted, 'a running');
        const b = track(limiter.acquire('b'));
        await flushUntil(() => limiter.pendingCount === 1, 'b queued');

        // Release 'a' on the very tick 'b' would time out.
        setTimeout(() => a.release!(), 1000);
        await jest.advanceTimersByTimeAsync(1000);
        await flushUntil(() => b.done, 'b settled');

        const dispatchedB = events.dispatch.some((i) => i.context === 'b');
        const timedOutB = events.timeout.some((i) => i.context === 'b');
        expect(Number(dispatchedB) + Number(timedOutB)).toBe(1); // exactly one acted

        if (dispatchedB) {
            expect(b.granted).toBe(true);
            b.release!();
        } else {
            expect(b.error).toBeInstanceOf(TimeoutErr);
        }
        await flushUntil(() => limiter.activeCount === 0, 'drained');
        expect(limiter.pendingCount).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('validates constructor options and rejects invalid boundaries', () => {
        expect(() => makeLimiter({ maxConcurrency: 0 })).toThrow(RangeError);
        expect(() => makeLimiter({ maxConcurrency: -1 })).toThrow(RangeError);
        expect(() => makeLimiter({ maxConcurrency: NaN })).toThrow(RangeError);

        expect(() => makeLimiter({ maxConcurrency: 2, maxQueueSize: -1 })).toThrow(RangeError);
        expect(() => makeLimiter({ maxConcurrency: 2, maxQueueSize: NaN })).toThrow(RangeError);

        expect(() => makeLimiter({ maxConcurrency: 2, queueTimeout: -1 })).toThrow(RangeError);
        expect(() => makeLimiter({ maxConcurrency: 2, queueTimeout: NaN })).toThrow(RangeError);

        // Valid boundary zero for queue size/timeout should not throw
        expect(() => makeLimiter({ maxConcurrency: 2, maxQueueSize: 0, queueTimeout: 0 })).not.toThrow();
    });

    test('dispatches higher priority queued tasks before lower priority tasks', async () => {
        const { limiter } = makeLimiter({ maxConcurrency: 1 });

        // 'a' consumes the single slot
        const a = track(limiter.acquire('a'));
        await flushUntil(() => a.granted, 'a granted');

        // Queue tasks with different priorities:
        // b: default priority 0
        // c: priority 5
        // d: priority 10 (highest)
        // e: priority 5 (equal to c, should run after c)
        const b = track(limiter.acquire('b', { priority: 0 }));
        const c = track(limiter.acquire('c', { priority: 5 }));
        const d = track(limiter.acquire('d', { priority: 10 }));
        const e = track(limiter.acquire('e', { priority: 5 }));

        await flushUntil(() => limiter.pendingCount === 4, 'all 4 queued');

        const dispatchOrder: string[] = [];

        // Release 'a', highest priority 'd' (10) must be dispatched first
        a.release!();
        await flushUntil(() => d.granted, 'd dispatched');
        dispatchOrder.push('d');

        // Release 'd', 'c' (5) must be dispatched next (before 'e' due to FIFO on equal priority)
        d.release!();
        await flushUntil(() => c.granted, 'c dispatched');
        dispatchOrder.push('c');

        // Release 'c', 'e' (5) must be dispatched next
        c.release!();
        await flushUntil(() => e.granted, 'e dispatched');
        dispatchOrder.push('e');

        // Release 'e', 'b' (0) dispatched last
        e.release!();
        await flushUntil(() => b.granted, 'b dispatched');
        dispatchOrder.push('b');

        b.release!();
        await flushUntil(() => limiter.activeCount === 0, 'drained');

        expect(dispatchOrder).toEqual(['d', 'c', 'e', 'b']);
    });

    test('dynamically adjusts concurrency with setMaxConcurrency', async () => {
        const { limiter } = makeLimiter({ maxConcurrency: 1 });

        const a = track(limiter.acquire('a'));
        await flushUntil(() => a.granted, 'a granted');
        const b = track(limiter.acquire('b'));
        const c = track(limiter.acquire('c'));
        await flushUntil(() => limiter.pendingCount === 2, 'b and c queued');

        expect(limiter.activeCount).toBe(1);
        expect(limiter.pendingCount).toBe(2);

        // Scale concurrency up to 3: both b and c should immediately be granted
        limiter.setMaxConcurrency(3);
        await flushUntil(() => b.granted && c.granted, 'b and c dispatched on scale up');

        expect(limiter.activeCount).toBe(3);
        expect(limiter.pendingCount).toBe(0);

        a.release!();
        b.release!();
        c.release!();

        await flushUntil(() => limiter.activeCount === 0, 'all drained');
    });

    test('clears waiting queue with clearQueue', async () => {
        const { limiter } = makeLimiter({ maxConcurrency: 1 });

        const a = track(limiter.acquire('a'));
        await flushUntil(() => a.granted, 'a granted');
        const b = track(limiter.acquire('b'));
        const c = track(limiter.acquire('c'));
        await flushUntil(() => limiter.pendingCount === 2, 'b and c queued');

        const cleared = limiter.clearQueue(new Error('manual queue cancellation'));
        expect(cleared).toBe(2);
        expect(limiter.pendingCount).toBe(0);
        expect(limiter.activeCount).toBe(1); // 'a' is still running

        await flushUntil(() => b.done && c.done, 'b and c rejected');
        expect(b.error).toBeInstanceOf(Error);
        expect(c.error).toBeInstanceOf(Error);

        a.release!();
        await flushUntil(() => limiter.activeCount === 0, 'a finished');
    });
});

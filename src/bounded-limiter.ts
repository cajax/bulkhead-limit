/**
 * A generic, dependency-free concurrency limiter with a bounded queue and a
 * queue-wait deadline. This is the runtime-agnostic core that powers
 * `axiosParallelLimit` — it knows nothing about Axios (or HTTP at all). The host
 * supplies the request "context" type, the cancellation source, and the error
 * factories, so the same primitive can wrap anything.
 *
 * Semantics:
 *  - up to `maxConcurrency` tasks hold a slot at once;
 *  - extra tasks wait in a FIFO queue, optionally bounded by `maxQueueSize`
 *    (overflow rejects immediately) and/or a per-task `queueTimeout` (queue-wait
 *    only — never execution time);
 *  - a queued task can be removed early by its `Cancellation`;
 *  - `active`/`pending` counts and the dispatch/timeout/overflow callbacks fire
 *    exactly once per state transition, with leak-free timer/listener cleanup.
 */

import { PriorityDeque, type QueueItem } from './priority-deque.js';

const now = (): number => Date.now();

/** Payload handed to the dispatch / timeout / overflow callbacks. */
export interface BoundedLimiterEventInfo<T> {
    /** The task context (whatever the host passed to `acquire`). */
    context: T;
    /** Time (ms) the task spent waiting in the queue (0 for immediate / overflow). */
    waitMs: number;
    /** Number of tasks still waiting in the queue when the event fired. */
    queueSize: number;
}

/**
 * A cancellation source for a queued task, abstracted away from any concrete
 * implementation (`AbortSignal`, an Axios cancel token, etc.). The limiter calls
 * `subscribe` when it queues a task and the returned unsubscribe the instant the
 * task leaves the queue, so nothing fires for an already-settled task.
 */
export interface Cancellation {
    readonly aborted: boolean;
    /** Register `onAbort`; return a function that removes it. */
    subscribe(onAbort: () => void): () => void;
}

/** Per-`acquire` overrides. */
export interface AcquireOptions {
    /** Overrides the limiter-level `queueTimeout` for this task only. */
    queueTimeout?: number;
    /** Cancellation source; if it aborts while queued, the task is removed. */
    cancellation?: Cancellation;
    /**
     * Relative priority for queue ordering (higher numbers are dispatched first).
     * Tasks with the same priority are dispatched in FIFO order. Default: 0.
     */
    priority?: number;
}

/** Releases the held slot. Idempotent; pulls the next queued task. */
export type ReleaseFn = () => void;

export interface BoundedLimiterOptions<T> {
    /** Maximum number of tasks holding a slot simultaneously. */
    maxConcurrency: number;
    /** Hard cap on queue depth; further tasks overflow. Default: unbounded. */
    maxQueueSize?: number;
    /** Default max queue-wait (ms) before a queued task times out. Default: off. */
    queueTimeout?: number;

    onActiveCountChange?: (activeCount: number) => void;
    onPendingCountChange?: (pendingCount: number) => void;
    onDispatch?: (info: BoundedLimiterEventInfo<T>) => void;
    onQueueTimeout?: (info: BoundedLimiterEventInfo<T>) => void;
    onQueueOverflow?: (info: BoundedLimiterEventInfo<T>) => void;

    /** Builds the rejection for a queue-wait timeout. */
    createTimeoutError: (context: T) => unknown;
    /** Builds the rejection for a queue overflow. */
    createOverflowError: (context: T) => unknown;
    /** Builds the rejection for a cancellation while queued. */
    createAbortError: (context: T) => unknown;
}

/** Throws unless `value` is `undefined` or a finite number >= 0. */
export function assertOptionalNonNegative(name: string, value: number | undefined): void {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        throw new RangeError(`${name} must be a non-negative number >= 0, received: ${value}`);
    }
}

/** Throws unless `value` is a finite number >= 1. */
export function assertConcurrency(value: number): void {
    if (!Number.isFinite(value) || value < 1) {
        throw new RangeError(`maxConcurrency must be a positive number >= 1, received: ${value}`);
    }
}

export class BoundedLimiter<T> {
    private readonly queue = new PriorityDeque<T>();
    private active = 0;
    private _maxConcurrency: number;
    private _maxQueueSize: number | undefined;
    private _queueTimeout: number | undefined;
    private pausedUntil = 0;
    private pauseTimer?: ReturnType<typeof setTimeout>;

    constructor(private readonly options: BoundedLimiterOptions<T>) {
        assertConcurrency(options.maxConcurrency);
        assertOptionalNonNegative('maxQueueSize', options.maxQueueSize);
        assertOptionalNonNegative('queueTimeout', options.queueTimeout);
        this._maxConcurrency = options.maxConcurrency;
        this._maxQueueSize = options.maxQueueSize;
        this._queueTimeout = options.queueTimeout;
    }

    /** Current queue-depth bound (`undefined` = unbounded). */
    get maxQueueSize(): number | undefined {
        return this._maxQueueSize;
    }

    /** Current default queue-wait deadline (`undefined` = none). */
    get queueTimeout(): number | undefined {
        return this._queueTimeout;
    }

    /**
     * Change the queue-depth bound. Tasks already waiting are kept even if the
     * queue is now over the new bound; only new arrivals are shed.
     */
    setMaxQueueSize(size: number | undefined): void {
        assertOptionalNonNegative('maxQueueSize', size);
        this._maxQueueSize = size;
    }

    /** Change the default queue-wait deadline. Applies to tasks queued from now on. */
    setQueueTimeout(timeout: number | undefined): void {
        assertOptionalNonNegative('queueTimeout', timeout);
        this._queueTimeout = timeout;
    }

    /** Tasks currently holding a slot. */
    get activeCount(): number {
        return this.active;
    }

    /** Tasks currently waiting in the queue. */
    get pendingCount(): number {
        return this.queue.size;
    }

    /** Current maximum concurrency limit. */
    get maxConcurrency(): number {
        return this._maxConcurrency;
    }

    /** Whether queue dispatch is temporarily paused in a backoff cooldown. */
    get isPaused(): boolean {
        return this.pausedUntil > now();
    }

    /** Timestamp (epoch ms) until which queue dispatch is paused. */
    get pausedUntilTimestamp(): number {
        return this.pausedUntil;
    }

    /**
     * Pause dispatching tasks from the queue for `durationMs` milliseconds.
     * In-flight tasks continue running, but queued tasks wait until the cooldown expires.
     *
     * Pauses only ever extend: a shorter `pause()` during a longer active pause is
     * a no-op (so a later `Retry-After: 1` cannot cut short an earlier
     * `Retry-After: 30`). Call {@link resume} to end a pause early.
     *
     * The pause timer keeps the process alive only while tasks are waiting on
     * it: queued work must not be silently dropped by the process exiting, but
     * a script whose work is all done must not hang until the cooldown ends.
     */
    pause(durationMs: number): void {
        if (!Number.isFinite(durationMs) || durationMs <= 0) {
            return;
        }
        const until = now() + durationMs;
        if (until <= this.pausedUntil) {
            return;
        }
        this.pausedUntil = until;
        if (this.pauseTimer) {
            clearTimeout(this.pauseTimer);
        }
        this.pauseTimer = setTimeout(() => {
            this.pausedUntil = 0;
            this.pauseTimer = undefined;
            this.drain();
        }, durationMs);
        this.syncPauseTimerRef();
    }

    /**
     * Resume queue dispatch immediately if paused.
     */
    resume(): void {
        if (this.pauseTimer) {
            clearTimeout(this.pauseTimer);
            this.pauseTimer = undefined;
        }
        this.pausedUntil = 0;
        this.drain();
    }

    /**
     * Dynamically update the concurrency limit at runtime.
     * If increased, queued tasks are immediately dispatched into available slots.
     */
    setMaxConcurrency(limit: number): void {
        assertConcurrency(limit);
        this._maxConcurrency = limit;
        this.drain();
    }

    /**
     * Clear all tasks currently waiting in the queue, rejecting them with
     * `reason` (or the default cancellation error). Does not affect tasks
     * already actively in-flight. Returns the count of cancelled tasks.
     */
    clearQueue(reason?: unknown): number {
        const items = this.queue.clear();
        if (items.length === 0) return 0;

        for (const item of items) {
            if (item.settled) continue;
            item.settled = true;
            this.clearItem(item);
            item.reject(reason ?? this.options.createAbortError(item.context));
        }
        this.notifyPending();
        return items.length;
    }

    /**
     * Acquire a slot. Resolves with a `release()` once a slot is held; rejects
     * (without ever consuming a slot) on overflow, queue-wait timeout, or
     * cancellation while queued.
     */
    acquire(context: T, opts: AcquireOptions = {}): Promise<ReleaseFn> {
        // 1) Slot free AND not paused → admit immediately (never subject to queueTimeout).
        if (!this.isPaused && this.active < this._maxConcurrency) {
            this.active++;
            this.notifyActive();
            this.emit(this.options.onDispatch, context, 0);
            return Promise.resolve(this.makeRelease());
        }

        const { cancellation } = opts;

        // 2) Already cancelled before we could queue it → don't enqueue.
        if (cancellation && cancellation.aborted) {
            return Promise.reject(this.options.createAbortError(context));
        }

        // 3) Queue full → reject BEFORE enqueuing (pending unchanged, no count callback).
        const maxQueueSize = this._maxQueueSize;
        if (maxQueueSize !== undefined && this.queue.size >= maxQueueSize) {
            this.emit(this.options.onQueueOverflow, context, 0);
            return Promise.reject(this.options.createOverflowError(context));
        }

        // 4) Defer: park in the queue until a slot frees (or it times out / is cancelled).
        return new Promise<ReleaseFn>((resolve, reject) => {
            const priority = typeof opts.priority === 'number' && Number.isFinite(opts.priority) ? opts.priority : 0;
            const item: QueueItem<T> = { context, priority, enqueuedAt: now(), settled: false, resolve, reject };

            const timeout = typeof opts.queueTimeout === 'number' ? opts.queueTimeout : this._queueTimeout;
            if (timeout !== undefined) {
                const timer = setTimeout(() => this.onTimeout(item), timeout);
                if (
                    typeof timer === 'object' &&
                    timer !== null &&
                    'unref' in timer &&
                    typeof timer.unref === 'function'
                ) {
                    timer.unref();
                }
                item.timer = timer;
            }
            if (cancellation) {
                item.detachAbort = cancellation.subscribe(() => this.onAbort(item));
            }

            this.queue.insert(item);
            this.notifyPending();
        });
    }

    private notifyActive = (): void => {
        this.options.onActiveCountChange?.(this.active);
    };

    private notifyPending = (): void => {
        this.syncPauseTimerRef();
        this.options.onPendingCountChange?.(this.queue.size);
    };

    /** Hold the process open for the pause timer only while something is queued. */
    private syncPauseTimerRef = (): void => {
        const timer = this.pauseTimer as { ref?: () => void; unref?: () => void } | undefined;
        if (!timer || typeof timer.unref !== 'function' || typeof timer.ref !== 'function') return;
        if (this.queue.size > 0) {
            timer.ref();
        } else {
            timer.unref();
        }
    };

    private emit = (cb: ((info: BoundedLimiterEventInfo<T>) => void) | undefined, context: T, waitMs: number): void => {
        cb?.({ context, waitMs, queueSize: this.queue.size });
    };

    /** Tear down a queued item's timer and cancellation listener. Idempotent. */
    private clearItem = (item: QueueItem<T>): void => {
        if (item.timer !== undefined) {
            clearTimeout(item.timer);
            item.timer = undefined;
        }
        if (item.detachAbort) {
            item.detachAbort();
            item.detachAbort = undefined;
        }
    };

    private removeFromQueue = (item: QueueItem<T>): boolean => {
        return this.queue.remove(item.node);
    };

    private makeRelease = (): ReleaseFn => {
        let released = false;
        return () => {
            if (released) return; // never decrement twice for one slot
            released = true;
            this.active--;
            this.notifyActive(); // active--
            this.pullNext();
        };
    };

    /** Fill every free slot from the queue (until paused, full, or empty). */
    private drain = (): void => {
        while (!this.isPaused && this.active < this._maxConcurrency && this.queue.size > 0) {
            this.pullNext();
        }
    };

    /** Promote the next queued task into a freed slot, if any. */
    private pullNext = (): void => {
        if (this.isPaused || this.active >= this._maxConcurrency) return;
        const item = this.queue.shift();
        if (!item) return;

        // Won the slot: disable its timeout/cancel so neither can act later.
        item.settled = true;
        this.clearItem(item);

        this.notifyPending(); // pending--
        this.active++;
        this.notifyActive(); // active++
        this.emit(this.options.onDispatch, item.context, now() - item.enqueuedAt);

        item.resolve(this.makeRelease());
    };

    private onTimeout = (item: QueueItem<T>): void => {
        if (item.settled) return; // dispatch already won the race
        item.settled = true;
        this.clearItem(item);
        if (!this.removeFromQueue(item)) return;

        this.notifyPending(); // pending-- (active untouched — it never became in-flight)
        this.emit(this.options.onQueueTimeout, item.context, now() - item.enqueuedAt);
        item.reject(this.options.createTimeoutError(item.context));
    };

    private onAbort = (item: QueueItem<T>): void => {
        if (item.settled) return;
        item.settled = true;
        this.clearItem(item);
        if (!this.removeFromQueue(item)) return;

        this.notifyPending(); // pending-- (active untouched)
        item.reject(this.options.createAbortError(item.context));
    };
}

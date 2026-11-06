import { AdaptiveConcurrency, type AdaptiveOptions, type OverloadReport } from './adaptive.js';
import {
    BoundedLimiter,
    assertConcurrency,
    assertOptionalNonNegative,
    type BoundedLimiterEventInfo,
    type Cancellation,
} from './bounded-limiter.js';
import { QueueClearedError, QueueFullError, QueueTimeoutError } from './errors.js';

/** How a finished task turned out, as seen by a {@link Classifier}. */
export type Outcome<R = unknown> = { ok: true; value: R } | { ok: false; error: unknown };

/** What a finished task tells the adaptive controller. */
export type Feedback = 'success' | 'ignore' | 'overload' | ({ overload: true } & OverloadReport);

/** Maps a task outcome to adaptive feedback. */
export type Classifier<R = unknown> = (outcome: Outcome<R>) => Feedback;

/** Default: a resolved task is a success; a rejection says nothing about load. */
const defaultClassify: Classifier = (outcome) => (outcome.ok ? 'success' : 'ignore');

export interface QueueEventInfo {
    /** Time (ms) spent waiting in the queue. `0` when admitted immediately or rejected on overflow. */
    waitMs: number;
    /** Tasks still waiting when the event fired. */
    queueSize: number;
}

export interface BulkheadOptions {
    /** Maximum number of tasks running at once. */
    concurrency: number;
    /** Maximum number of waiting tasks; beyond it `run()` rejects with `QueueFullError`. Default: unbounded. */
    maxQueueSize?: number;
    /** Maximum queue wait (ms) before `run()` rejects with `QueueTimeoutError`. Default: none. */
    queueTimeout?: number;
    /**
     * Enable AIMD adaptive concurrency. `true` uses defaults. `classify` decides
     * what each finished task reports; by default resolved = success and
     * rejected = ignored. Default: disabled.
     */
    adaptive?: boolean | (AdaptiveOptions & { classify?: Classifier });
    onActiveCountChange?: (activeCount: number) => void;
    onPendingCountChange?: (pendingCount: number) => void;
    onDispatch?: (info: QueueEventInfo) => void;
    onQueueTimeout?: (info: QueueEventInfo) => void;
    onQueueOverflow?: (info: QueueEventInfo) => void;
}

export interface RunOptions<R = unknown> {
    /**
     * Cancels the task while it waits (it is removed and `run()` rejects with
     * `signal.reason`). Once running, the task receives it and is expected to
     * honour it; the slot stays held until the task actually settles.
     */
    signal?: AbortSignal;
    /** Higher runs first. Equal priorities are FIFO. Default: 0. */
    priority?: number;
    /** Overrides the bulkhead's `queueTimeout` for this task. */
    queueTimeout?: number;
    /** Overrides the bulkhead's adaptive classifier for this task. */
    classify?: Classifier<R>;
}

/** Settings `configure()` can change on a live bulkhead. */
export interface BulkheadConfig {
    concurrency?: number;
    /** `undefined` removes the bound. Tasks already waiting are kept; only new arrivals are shed. */
    maxQueueSize?: number | undefined;
    /** `undefined` removes the deadline. Applies to tasks queued from now on. */
    queueTimeout?: number | undefined;
    /** Tune adaptive control. Only allowed when the bulkhead was created with `adaptive`. */
    adaptive?: AdaptiveOptions;
}

export interface TaskContext {
    signal?: AbortSignal;
}

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

function cancellationFor(signal: AbortSignal): Cancellation {
    return {
        get aborted() {
            return signal.aborted;
        },
        subscribe(onAbort) {
            signal.addEventListener('abort', onAbort, { once: true });
            return () => signal.removeEventListener('abort', onAbort);
        },
    };
}

function toQueueInfo(
    cb: ((info: QueueEventInfo) => void) | undefined,
): ((info: BoundedLimiterEventInfo<TaskContext>) => void) | undefined {
    return cb && ((info) => cb({ waitMs: info.waitMs, queueSize: info.queueSize }));
}

/**
 * A concurrency limiter that refuses work it can't finish in time: bounded
 * queue, queue-wait deadlines, abort-aware waiting, priorities, and optional
 * adaptive (AIMD) concurrency.
 */
export class Bulkhead {
    private readonly limiter: BoundedLimiter<TaskContext>;
    private readonly adaptive?: AdaptiveConcurrency;
    private readonly classify: Classifier;

    constructor(options: BulkheadOptions) {
        this.limiter = new BoundedLimiter<TaskContext>({
            maxConcurrency: options.concurrency,
            maxQueueSize: options.maxQueueSize,
            queueTimeout: options.queueTimeout,
            onActiveCountChange: options.onActiveCountChange,
            onPendingCountChange: options.onPendingCountChange,
            onDispatch: toQueueInfo(options.onDispatch),
            onQueueTimeout: toQueueInfo(options.onQueueTimeout),
            onQueueOverflow: toQueueInfo(options.onQueueOverflow),
            createTimeoutError: () => new QueueTimeoutError(),
            createOverflowError: () => new QueueFullError(),
            // Reached for an aborted signal, or for clearQueue() without a reason.
            createAbortError: (ctx) => (ctx.signal?.aborted ? abortReason(ctx.signal) : new QueueClearedError()),
        });

        const { adaptive } = options;
        if (adaptive) {
            const { classify, ...adaptiveOptions } = adaptive === true ? {} : adaptive;
            this.adaptive = new AdaptiveConcurrency(this.limiter, adaptiveOptions);
            this.classify = classify ?? defaultClassify;
        } else {
            this.classify = defaultClassify;
        }
    }

    /** Tasks currently running. */
    get activeCount(): number {
        return this.limiter.activeCount;
    }

    /** Tasks currently waiting for a slot. */
    get pendingCount(): number {
        return this.limiter.pendingCount;
    }

    /** Current concurrency limit (may sit below the target while adaptively throttled). */
    get concurrency(): number {
        return this.limiter.maxConcurrency;
    }

    /** The concurrency adaptive control ramps back up to (equals `concurrency` without adaptive). */
    get targetConcurrency(): number {
        return this.adaptive?.targetConcurrency ?? this.limiter.maxConcurrency;
    }

    /** Whether dispatch is paused (by `pause()` or an adaptive cooldown). */
    get isPaused(): boolean {
        return this.limiter.isPaused;
    }

    /**
     * Run `fn` once a slot is free. Rejects without running it on queue
     * overflow (`QueueFullError`), queue-wait timeout (`QueueTimeoutError`),
     * abort while waiting (`signal.reason`) or `clearQueue()`.
     */
    async run<R>(fn: (ctx: TaskContext) => R | PromiseLike<R>, options: RunOptions<R> = {}): Promise<R> {
        const { signal } = options;
        if (signal?.aborted) {
            throw abortReason(signal);
        }

        const release = await this.limiter.acquire(
            { signal },
            {
                priority: options.priority,
                queueTimeout: options.queueTimeout,
                cancellation: signal && cancellationFor(signal),
            },
        );

        let outcome: Outcome<R>;
        try {
            outcome = { ok: true, value: await fn({ signal }) };
        } catch (error) {
            outcome = { ok: false, error };
        }

        // Feedback is applied BEFORE the slot is released, so an overload's
        // pause/decrease takes effect before the next queued task is pulled.
        try {
            if (this.adaptive) {
                this.applyFeedback((options.classify ?? this.classify) as Classifier<R>, outcome);
            }
        } finally {
            release();
        }

        if (outcome.ok) {
            return outcome.value;
        }
        throw outcome.error;
    }

    /** Change the concurrency limit (and the adaptive target). Queued tasks fill new slots immediately. */
    setConcurrency(limit: number): void {
        if (this.adaptive) {
            this.adaptive.setTargetConcurrency(limit);
        } else {
            this.limiter.setMaxConcurrency(limit);
        }
    }

    /**
     * Change settings on the live bulkhead, for example from a config reload.
     * Keys that are present are applied (`undefined` clears a bound); missing
     * keys are left alone. Everything is validated first: if any value is
     * invalid, a `RangeError` is thrown and nothing changes.
     */
    configure(config: BulkheadConfig): void {
        const has = (key: keyof BulkheadConfig) => Object.prototype.hasOwnProperty.call(config, key);

        if (has('concurrency')) assertConcurrency(config.concurrency as number);
        if (has('maxQueueSize')) assertOptionalNonNegative('maxQueueSize', config.maxQueueSize);
        if (has('queueTimeout')) assertOptionalNonNegative('queueTimeout', config.queueTimeout);
        if (config.adaptive) {
            if (!this.adaptive) {
                throw new TypeError('adaptive settings require a bulkhead created with the `adaptive` option');
            }
            this.adaptive.validate(config.adaptive);
        }

        if (has('maxQueueSize')) this.limiter.setMaxQueueSize(config.maxQueueSize);
        if (has('queueTimeout')) this.limiter.setQueueTimeout(config.queueTimeout);
        if (config.adaptive) this.adaptive!.configure(config.adaptive);
        if (has('concurrency')) this.setConcurrency(config.concurrency as number);
    }

    /** Hold queued tasks for `durationMs`. Never shortens an active pause; use `resume()` for that. */
    pause(durationMs: number): void {
        this.limiter.pause(durationMs);
    }

    /** End any pause now. */
    resume(): void {
        this.limiter.resume();
    }

    /**
     * Reject every waiting task with `reason` (default: a `QueueClearedError`
     * each). Running tasks are unaffected. Returns how many were removed.
     */
    clearQueue(reason?: unknown): number {
        return this.limiter.clearQueue(reason);
    }

    /** Tell adaptive control the downstream pushed back. No-op unless `adaptive` is enabled. */
    reportOverload(report?: OverloadReport): void {
        this.adaptive?.reportOverload(report);
    }

    /** Tell adaptive control a task succeeded. No-op unless `adaptive` is enabled. */
    reportSuccess(): void {
        this.adaptive?.reportSuccess();
    }

    /** Drop adaptive backoff state: restore the target concurrency and end any pause. */
    resetAdaptive(): void {
        if (this.adaptive) {
            this.adaptive.reset();
        } else {
            this.limiter.resume();
        }
    }

    private applyFeedback<R>(classify: Classifier<R>, outcome: Outcome<R>): void {
        const feedback = classify(outcome);
        if (feedback === 'success') {
            this.adaptive!.reportSuccess();
        } else if (feedback === 'overload') {
            this.adaptive!.reportOverload();
        } else if (typeof feedback === 'object' && feedback.overload) {
            this.adaptive!.reportOverload({ retryAfterMs: feedback.retryAfterMs });
        }
    }
}

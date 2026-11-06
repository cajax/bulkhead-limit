/**
 * Rejection reasons produced by the bulkhead. Each carries a stable `name` and
 * `code`, and each has a guard that also recognises structurally identical
 * errors (e.g. from a second copy of this package in the dependency tree,
 * where `instanceof` would fail).
 */

function isCoded(err: unknown, name: string, code: string): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        (err as { name?: unknown }).name === name &&
        (err as { code?: unknown }).code === code
    );
}

/** The queue already held `maxQueueSize` waiting tasks: rejected immediately (load shedding). */
export class QueueFullError extends Error {
    readonly code = 'ERR_QUEUE_FULL' as const;

    constructor(message = 'Rejected because the queue is full (maxQueueSize reached)') {
        super(message);
        this.name = 'QueueFullError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** The task waited longer than `queueTimeout` for a slot and was removed without running. */
export class QueueTimeoutError extends Error {
    readonly code = 'ERR_QUEUE_TIMEOUT' as const;

    constructor(message = 'Timed out while waiting in the queue for a free slot (queueTimeout)') {
        super(message);
        this.name = 'QueueTimeoutError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/** The task was removed from the queue by `clearQueue()` without running. */
export class QueueClearedError extends Error {
    readonly code = 'ERR_QUEUE_CLEARED' as const;

    constructor(message = 'Removed from the queue by clearQueue() before it could run') {
        super(message);
        this.name = 'QueueClearedError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

export function isQueueFullError(err: unknown): err is QueueFullError {
    return err instanceof QueueFullError || isCoded(err, 'QueueFullError', 'ERR_QUEUE_FULL');
}

export function isQueueTimeoutError(err: unknown): err is QueueTimeoutError {
    return err instanceof QueueTimeoutError || isCoded(err, 'QueueTimeoutError', 'ERR_QUEUE_TIMEOUT');
}

export function isQueueClearedError(err: unknown): err is QueueClearedError {
    return err instanceof QueueClearedError || isCoded(err, 'QueueClearedError', 'ERR_QUEUE_CLEARED');
}

import type { Bulkhead, Feedback, Outcome } from './bulkhead.js';
import { parseRetryAfter } from './retry-after.js';

/** Per-request bulkhead options, passed as `init.bulkhead` (stripped before calling fetch). */
export interface FetchBulkheadOptions {
    /** Higher runs first. Equal priorities are FIFO. Default: 0. */
    priority?: number;
    /** Overrides the bulkhead's `queueTimeout` for this request. */
    queueTimeout?: number;
}

export type LimitedRequestInit = RequestInit & { bulkhead?: FetchBulkheadOptions };

export type LimitedFetch = (input: Parameters<typeof fetch>[0], init?: LimitedRequestInit) => Promise<Response>;

export interface LimitFetchOptions {
    /** The fetch implementation to wrap. Default: `globalThis.fetch`, looked up per call. */
    fetch?: typeof fetch;
    /**
     * Response statuses that mean "the server is overloaded". They report an
     * overload to adaptive control, honouring `Retry-After`. Default: `[429, 503]`.
     */
    overloadStatuses?: readonly number[];
}

/**
 * Wrap `fetch` so every request runs through `bulkhead`.
 *
 * The response is always returned as-is (a 429 still resolves, as fetch does).
 * With adaptive control enabled on the bulkhead, overload statuses throttle
 * concurrency (and pause for `Retry-After`), other statuses below 500 count as
 * successes, and the remaining 5xx and network errors are ignored.
 */
export function limitFetch(bulkhead: Bulkhead, options: LimitFetchOptions = {}): LimitedFetch {
    const overloadStatuses = new Set(options.overloadStatuses ?? [429, 503]);

    const classify = (outcome: Outcome<Response>): Feedback => {
        if (!outcome.ok) return 'ignore';
        const { status, headers } = outcome.value;
        if (overloadStatuses.has(status)) {
            return { overload: true, retryAfterMs: parseRetryAfter(headers.get('retry-after')) };
        }
        return status < 500 ? 'success' : 'ignore';
    };

    return (input, init) => {
        const { bulkhead: perRequest, ...rest } = init ?? {};
        const fetchInit: RequestInit | undefined = init === undefined ? undefined : rest;
        const signal =
            init?.signal ?? (typeof Request !== 'undefined' && input instanceof Request ? input.signal : undefined);
        const doFetch = options.fetch ?? globalThis.fetch;

        return bulkhead.run(() => doFetch(input, fetchInit), {
            signal: signal ?? undefined,
            priority: perRequest?.priority,
            queueTimeout: perRequest?.queueTimeout,
            classify,
        });
    };
}

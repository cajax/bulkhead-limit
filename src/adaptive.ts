/**
 * Transport-agnostic AIMD (additive-increase / multiplicative-decrease)
 * concurrency control.
 *
 * The controller knows nothing about HTTP. Callers tell it what happened:
 *  - `reportOverload({ retryAfterMs })` — the downstream pushed back (HTTP 429,
 *    503, a DB "too many connections" error, an LLM rate-limit…). Concurrency is
 *    multiplied by `decreaseFactor` and dispatch pauses for the cooldown.
 *  - `reportSuccess()` — the downstream handled a task fine. Every
 *    `successStep` consecutive successes add one slot, up to the target.
 */

/** The subset of a limiter the controller drives. `BoundedLimiter` satisfies it. */
export interface ConcurrencyTarget {
    readonly maxConcurrency: number;
    setMaxConcurrency(limit: number): void;
    pause(durationMs: number): void;
    resume(): void;
}

export interface ThrottleInfo {
    /** How long dispatch was asked to pause (after fallback and cap). */
    cooldownMs: number;
    previousConcurrency: number;
    newConcurrency: number;
}

export interface RampUpInfo {
    concurrency: number;
    targetConcurrency: number;
}

export interface AdaptiveOptions {
    /** Concurrency never drops below this. Default: 1. */
    minConcurrency?: number;
    /** Multiplier applied on overload, 0 < factor < 1. Default: 0.5. */
    decreaseFactor?: number;
    /** Consecutive successes needed to add one slot back. Default: 5. */
    successStep?: number;
    /** Cooldown when an overload carries no `retryAfterMs`. Default: 1000. */
    fallbackCooldownMs?: number;
    /** Upper bound for any cooldown, however long `retryAfterMs` is. Default: 60000. */
    maxCooldownMs?: number;
    /**
     * Overloads within this window after a decrease don't decrease again, so a
     * burst of in-flight failures from one overload event counts once. They
     * still extend the pause. Default: 200.
     */
    decreaseWindowMs?: number;
    onThrottle?: (info: ThrottleInfo) => void;
    onRampUp?: (info: RampUpInfo) => void;
}

export interface OverloadReport {
    /** Requested cooldown, e.g. from a `Retry-After` header (see `parseRetryAfter`). */
    retryAfterMs?: number;
}

type Settings = Required<Omit<AdaptiveOptions, 'onThrottle' | 'onRampUp'>> &
    Pick<AdaptiveOptions, 'onThrottle' | 'onRampUp'>;

const DEFAULTS: Settings = {
    minConcurrency: 1,
    decreaseFactor: 0.5,
    successStep: 5,
    fallbackCooldownMs: 1000,
    maxCooldownMs: 60_000,
    decreaseWindowMs: 200,
};

function check(name: string, value: number, ok: boolean, rule: string): void {
    if (!Number.isFinite(value) || !ok) {
        throw new RangeError(`${name} must be ${rule}, received: ${value}`);
    }
}

/** Merge `patch` over `base` (ignoring keys explicitly set to `undefined`) and validate the result. */
function resolveSettings(base: Settings, patch: AdaptiveOptions): Settings {
    const next: Settings = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) (next as unknown as Record<string, unknown>)[key] = value;
    }
    check('minConcurrency', next.minConcurrency, next.minConcurrency >= 1, '>= 1');
    check(
        'decreaseFactor',
        next.decreaseFactor,
        next.decreaseFactor > 0 && next.decreaseFactor < 1,
        'between 0 and 1 (exclusive)',
    );
    check('successStep', next.successStep, next.successStep >= 1, '>= 1');
    check('fallbackCooldownMs', next.fallbackCooldownMs, next.fallbackCooldownMs >= 0, '>= 0');
    check('maxCooldownMs', next.maxCooldownMs, next.maxCooldownMs >= 0, '>= 0');
    check('decreaseWindowMs', next.decreaseWindowMs, next.decreaseWindowMs >= 0, '>= 0');
    return next;
}

export class AdaptiveConcurrency {
    private target: number;
    private successes = 0;
    private lastDecrease = Number.NEGATIVE_INFINITY;
    private settings: Settings;

    constructor(
        private readonly limiter: ConcurrencyTarget,
        options: AdaptiveOptions = {},
    ) {
        this.settings = resolveSettings(DEFAULTS, options);
        this.target = limiter.maxConcurrency;
    }

    /** Throws a `RangeError` if `patch` would produce invalid settings. Changes nothing. */
    validate(patch: AdaptiveOptions): void {
        resolveSettings(this.settings, patch);
    }

    /**
     * Change settings live. Omitted keys keep their value. Takes effect from
     * the next report; the current concurrency is not recomputed.
     */
    configure(patch: AdaptiveOptions): void {
        this.settings = resolveSettings(this.settings, patch);
    }

    /** The concurrency the controller ramps back up to. */
    get targetConcurrency(): number {
        return this.target;
    }

    /** Set a new target and apply it immediately (a manual override). */
    setTargetConcurrency(limit: number): void {
        this.limiter.setMaxConcurrency(limit);
        this.target = limit;
    }

    reportOverload(report: OverloadReport = {}): void {
        const requested = report.retryAfterMs;
        const cooldownMs = Math.min(
            this.settings.maxCooldownMs,
            requested !== undefined && Number.isFinite(requested) && requested >= 0
                ? requested
                : this.settings.fallbackCooldownMs,
        );

        this.successes = 0;
        this.limiter.pause(cooldownMs);

        const previousConcurrency = this.limiter.maxConcurrency;
        let newConcurrency = previousConcurrency;
        const now = Date.now();
        if (now - this.lastDecrease >= this.settings.decreaseWindowMs) {
            newConcurrency = Math.min(
                previousConcurrency,
                Math.max(this.settings.minConcurrency, Math.floor(previousConcurrency * this.settings.decreaseFactor)),
            );
            if (newConcurrency !== previousConcurrency) {
                this.limiter.setMaxConcurrency(newConcurrency);
            }
            this.lastDecrease = now;
        }

        this.settings.onThrottle?.({ cooldownMs, previousConcurrency, newConcurrency });
    }

    reportSuccess(): void {
        const current = this.limiter.maxConcurrency;
        if (current >= this.target) {
            return;
        }
        this.successes++;
        if (this.successes < this.settings.successStep) {
            return;
        }
        this.successes = 0;
        const concurrency = Math.min(this.target, current + 1);
        this.limiter.setMaxConcurrency(concurrency);
        this.settings.onRampUp?.({ concurrency, targetConcurrency: this.target });
    }

    /** Forget all backoff state: restore the target and end any pause. */
    reset(): void {
        this.successes = 0;
        this.lastDecrease = Number.NEGATIVE_INFINITY;
        this.limiter.resume();
        this.limiter.setMaxConcurrency(this.target);
    }
}

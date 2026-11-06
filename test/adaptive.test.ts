import { jest, describe, test, expect, afterEach } from '@jest/globals';
import { AdaptiveConcurrency, type AdaptiveOptions, type ThrottleInfo, type RampUpInfo } from '../src/adaptive.js';
import { BoundedLimiter } from '../src/bounded-limiter.js';

function setup(concurrency: number, opts: AdaptiveOptions = {}) {
    const limiter = new BoundedLimiter<undefined>({
        maxConcurrency: concurrency,
        createTimeoutError: () => new Error('timeout'),
        createOverflowError: () => new Error('overflow'),
        createAbortError: () => new Error('abort'),
    });
    const throttles: ThrottleInfo[] = [];
    const rampUps: RampUpInfo[] = [];
    const adaptive = new AdaptiveConcurrency(limiter, {
        ...opts,
        onThrottle: (i) => throttles.push(i),
        onRampUp: (i) => rampUps.push(i),
    });
    return { limiter, adaptive, throttles, rampUps };
}

afterEach(() => {
    jest.useRealTimers();
});

describe('AdaptiveConcurrency — multiplicative decrease', () => {
    test('an overload halves concurrency and pauses for retryAfterMs', () => {
        const { limiter, adaptive, throttles } = setup(4);

        adaptive.reportOverload({ retryAfterMs: 1_000 });

        expect(limiter.maxConcurrency).toBe(2);
        expect(limiter.isPaused).toBe(true);
        expect(adaptive.targetConcurrency).toBe(4);
        expect(throttles).toEqual([{ cooldownMs: 1_000, previousConcurrency: 4, newConcurrency: 2 }]);
        limiter.resume();
    });

    test('uses fallbackCooldownMs when no retryAfterMs is given, capped by maxCooldownMs', () => {
        const a = setup(4, { fallbackCooldownMs: 250 });
        a.adaptive.reportOverload();
        expect(a.throttles[0].cooldownMs).toBe(250);
        a.limiter.resume();

        const b = setup(4, { maxCooldownMs: 5_000 });
        b.adaptive.reportOverload({ retryAfterMs: 3_600_000 });
        expect(b.throttles[0].cooldownMs).toBe(5_000);
        b.limiter.resume();
    });

    test('never drops below minConcurrency', () => {
        const { limiter, adaptive } = setup(2, { minConcurrency: 2 });
        adaptive.reportOverload({ retryAfterMs: 0 });
        expect(limiter.maxConcurrency).toBe(2);
    });

    test('a burst of overloads within decreaseWindowMs counts as one decrease', async () => {
        jest.useFakeTimers();
        const { limiter, adaptive } = setup(16, { decreaseWindowMs: 200 });

        adaptive.reportOverload({ retryAfterMs: 0 });
        adaptive.reportOverload({ retryAfterMs: 0 });
        adaptive.reportOverload({ retryAfterMs: 0 });
        expect(limiter.maxConcurrency).toBe(8);

        await jest.advanceTimersByTimeAsync(201);
        adaptive.reportOverload({ retryAfterMs: 0 });
        expect(limiter.maxConcurrency).toBe(4);
    });
});

describe('AdaptiveConcurrency — additive increase', () => {
    test('steps up by one every successStep successes, up to the target', () => {
        const { limiter, adaptive, rampUps } = setup(3, { decreaseFactor: 0.34, successStep: 2 });
        adaptive.reportOverload({ retryAfterMs: 0 });
        expect(limiter.maxConcurrency).toBe(1);

        adaptive.reportSuccess();
        expect(limiter.maxConcurrency).toBe(1);
        adaptive.reportSuccess();
        expect(limiter.maxConcurrency).toBe(2);
        adaptive.reportSuccess();
        adaptive.reportSuccess();
        expect(limiter.maxConcurrency).toBe(3);
        adaptive.reportSuccess();
        adaptive.reportSuccess();
        expect(limiter.maxConcurrency).toBe(3);

        expect(rampUps).toEqual([
            { concurrency: 2, targetConcurrency: 3 },
            { concurrency: 3, targetConcurrency: 3 },
        ]);
    });

    test('an overload resets the success streak', async () => {
        jest.useFakeTimers();
        const { limiter, adaptive } = setup(8, { successStep: 2, decreaseWindowMs: 0 });
        adaptive.reportOverload({ retryAfterMs: 0 }); // 8 -> 4
        adaptive.reportSuccess();
        await jest.advanceTimersByTimeAsync(1);
        adaptive.reportOverload({ retryAfterMs: 0 }); // 4 -> 2, streak reset
        adaptive.reportSuccess();
        expect(limiter.maxConcurrency).toBe(2);
        adaptive.reportSuccess();
        expect(limiter.maxConcurrency).toBe(3);
    });

    test('successes at full target concurrency do nothing', () => {
        const { limiter, adaptive, rampUps } = setup(3, { successStep: 1 });
        adaptive.reportSuccess();
        expect(limiter.maxConcurrency).toBe(3);
        expect(rampUps).toEqual([]);
    });
});

describe('AdaptiveConcurrency — control', () => {
    test('setTargetConcurrency moves both the target and the live limit', () => {
        const { limiter, adaptive } = setup(4);
        adaptive.setTargetConcurrency(10);
        expect(adaptive.targetConcurrency).toBe(10);
        expect(limiter.maxConcurrency).toBe(10);
    });

    test('reset restores the target concurrency and ends the pause', () => {
        const { limiter, adaptive } = setup(5, { fallbackCooldownMs: 10_000 });
        adaptive.reportOverload();
        expect(limiter.maxConcurrency).toBe(2);
        expect(limiter.isPaused).toBe(true);

        adaptive.reset();
        expect(limiter.maxConcurrency).toBe(5);
        expect(limiter.isPaused).toBe(false);
    });

    test.each([
        [{ decreaseFactor: 0 }],
        [{ decreaseFactor: 1 }],
        [{ minConcurrency: 0 }],
        [{ successStep: 0 }],
        [{ fallbackCooldownMs: -1 }],
        [{ maxCooldownMs: Number.NaN }],
        [{ decreaseWindowMs: -1 }],
    ])('rejects invalid options %p', (opts) => {
        expect(() => setup(4, opts as AdaptiveOptions)).toThrow(RangeError);
    });
});

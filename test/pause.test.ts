import { jest, describe, test, expect, afterEach } from '@jest/globals';
import { BoundedLimiter } from '../src/bounded-limiter.js';

const make = () =>
    new BoundedLimiter<string>({
        maxConcurrency: 1,
        createTimeoutError: () => new Error('timeout'),
        createOverflowError: () => new Error('overflow'),
        createAbortError: () => new Error('abort'),
    });

afterEach(() => {
    jest.useRealTimers();
});

describe('BoundedLimiter — pause', () => {
    test('a shorter pause never shortens an active longer pause', async () => {
        jest.useFakeTimers();
        const limiter = make();

        limiter.pause(30_000);
        limiter.pause(1_000);

        await jest.advanceTimersByTimeAsync(5_000);
        expect(limiter.isPaused).toBe(true);

        await jest.advanceTimersByTimeAsync(25_000);
        expect(limiter.isPaused).toBe(false);
    });

    test('a longer pause extends an active shorter pause', async () => {
        jest.useFakeTimers();
        const limiter = make();

        limiter.pause(1_000);
        limiter.pause(10_000);

        await jest.advanceTimersByTimeAsync(5_000);
        expect(limiter.isPaused).toBe(true);
    });

    test('queued tasks dispatch when the pause expires', async () => {
        jest.useFakeTimers();
        const limiter = make();
        const first = await limiter.acquire('a');
        limiter.pause(1_000);
        first();

        let granted = false;
        void limiter.acquire('b').then(() => (granted = true));
        await jest.advanceTimersByTimeAsync(999);
        expect(granted).toBe(false);
        await jest.advanceTimersByTimeAsync(1);
        expect(granted).toBe(true);
    });

    test('the pause timer holds the process open only while tasks are waiting on it', async () => {
        const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
        const limiter = make();
        const before = timers();

        limiter.pause(60_000);
        expect(timers()).toBe(before); // nothing waiting: a finished script may exit

        const waiting = limiter.acquire('queued').catch(() => undefined);
        expect(timers()).toBe(before + 1); // queued work: keep the process alive

        limiter.clearQueue();
        await waiting;
        expect(timers()).toBe(before); // queue emptied: release the process again

        limiter.resume();
    });
});

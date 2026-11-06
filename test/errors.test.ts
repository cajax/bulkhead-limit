import { describe, test, expect } from '@jest/globals';
import {
    QueueFullError,
    QueueTimeoutError,
    QueueClearedError,
    isQueueFullError,
    isQueueTimeoutError,
    isQueueClearedError,
} from '../src/errors.js';

describe('errors', () => {
    test.each([
        [QueueFullError, 'QueueFullError', 'ERR_QUEUE_FULL', isQueueFullError],
        [QueueTimeoutError, 'QueueTimeoutError', 'ERR_QUEUE_TIMEOUT', isQueueTimeoutError],
        [QueueClearedError, 'QueueClearedError', 'ERR_QUEUE_CLEARED', isQueueClearedError],
    ] as const)('%p carries a stable name and code', (Ctor, name, code, guard) => {
        const err = new Ctor();
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(Ctor);
        expect(err.name).toBe(name);
        expect(err.code).toBe(code);
        expect(err.message.length).toBeGreaterThan(0);
        expect(guard(err)).toBe(true);
    });

    test('guards recognise structurally identical errors from another bundle copy', () => {
        const foreign = Object.assign(new Error('x'), { name: 'QueueFullError', code: 'ERR_QUEUE_FULL' });
        expect(isQueueFullError(foreign)).toBe(true);
        expect(isQueueTimeoutError(foreign)).toBe(false);
    });

    test('guards reject unrelated values', () => {
        for (const v of [undefined, null, 'ERR_QUEUE_FULL', new Error('x'), { code: 'ERR_QUEUE_FULL' }]) {
            expect(isQueueFullError(v)).toBe(false);
        }
    });

    test('accepts a custom message', () => {
        expect(new QueueTimeoutError('waited too long').message).toBe('waited too long');
    });
});

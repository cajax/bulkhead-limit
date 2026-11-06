import { describe, test, expect } from '@jest/globals';
import { parseRetryAfter } from '../src/retry-after.js';

describe('parseRetryAfter', () => {
    const NOW = Date.parse('2026-01-01T00:00:00Z');

    test('parses integer delay-seconds', () => {
        expect(parseRetryAfter('120', NOW)).toBe(120_000);
        expect(parseRetryAfter(' 0 ', NOW)).toBe(0);
    });

    test('accepts numeric values and fractional seconds', () => {
        expect(parseRetryAfter(3, NOW)).toBe(3_000);
        expect(parseRetryAfter('1.5', NOW)).toBe(1_500);
    });

    test('parses an HTTP-date into a delay relative to now', () => {
        expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', NOW)).toBe(30_000);
    });

    test('clamps an HTTP-date in the past to zero', () => {
        expect(parseRetryAfter('Wed, 31 Dec 2025 23:59:00 GMT', NOW)).toBe(0);
    });

    test('returns undefined for missing or unparseable values', () => {
        for (const v of [undefined, null, '', 'soon', '-5', '1e3', NaN, -1, Infinity]) {
            expect(parseRetryAfter(v, NOW)).toBeUndefined();
        }
    });
});

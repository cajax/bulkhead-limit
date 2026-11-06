/**
 * Parse an HTTP `Retry-After` value (RFC 9110 §10.2.3) into a delay in ms.
 *
 * Accepts delay-seconds (`"120"`, also fractional `"1.5"` and plain numbers)
 * or an HTTP-date (`"Thu, 01 Jan 2026 00:00:30 GMT"`), which is converted to a
 * delay relative to `now` and clamped at zero. Returns `undefined` when the
 * value is missing or unparseable, so the caller can apply its own fallback.
 */
export function parseRetryAfter(value: unknown, now: number = Date.now()): number | undefined {
    if (typeof value === 'number') {
        return Number.isFinite(value) && value >= 0 ? value * 1000 : undefined;
    }
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
        return Math.round(parseFloat(trimmed) * 1000);
    }
    // Only treat it as a date when it looks like one: Date.parse is lenient and
    // happily turns strings like "-5" or "1e3" into a timestamp.
    if (/[a-z]/i.test(trimmed) && /\d/.test(trimmed)) {
        const at = Date.parse(trimmed);
        if (!Number.isNaN(at)) {
            return Math.max(0, at - now);
        }
    }
    return undefined;
}

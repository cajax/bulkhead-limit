# Changelog

## Unreleased

### 0.1.0 (initial release)

Extracted from [`@cajax/axios-parallel-limit`](https://github.com/cajax/axios-parallel-limit) 1.1.1 as a transport-agnostic core.

- `Bulkhead`: `run(fn, { signal, priority, queueTimeout, classify })` with bounded queue, queue-wait deadline, abort-aware waiting, priorities, pause/resume, resize and `clearQueue()`.
- `Bulkhead.configure()`: change concurrency, queue limit, queue deadline and adaptive settings on a live bulkhead. Validates everything first and changes nothing on error.
- Runnable examples in `examples/` and an interactive simulator (`npm run simulator`).
- `AdaptiveConcurrency`: AIMD control decoupled from HTTP (`reportOverload({ retryAfterMs })` / `reportSuccess()`), with a configurable `decreaseWindowMs` (previously a hard-coded 200 ms).
- `@cajax/bulkhead-limit/fetch`: `limitFetch()` wrapper; 429/503 + `Retry-After` drive adaptive control.
- Transport-agnostic errors: `QueueFullError`, `QueueTimeoutError`, `QueueClearedError`, with guards.
- `parseRetryAfter()` returns `undefined` for unparseable values (callers choose the fallback).

### Fixed, compared with axios-parallel-limit 1.1.1

- A shorter `pause()` no longer cuts short an active longer pause (for example, a `Retry-After: 1` arriving during a `Retry-After: 30` cooldown).
- The pause timer keeps the process alive while tasks are waiting on it, so a script no longer exits silently with queued work during a cooldown. When nothing is queued it still lets the process exit.
- `parseRetryAfter('1.5')` is parsed as 1.5 s instead of being handed to `Date.parse` (which V8 reads as a date in 2001, giving a 0 ms cooldown).

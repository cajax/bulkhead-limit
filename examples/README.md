# Examples

Each example is a single runnable file. The downstream (a database, an LLM provider, a payment gateway) is simulated locally, so no network access or API keys are needed. Each example runs the scenario with and without the bulkhead and prints the results.

Build the library once first. The examples import `@cajax/bulkhead-limit` by its package name, the same way your code would:

```bash
npm install
npm run build
```

| Example                                                | Scenario                                                                            | Feature shown                                                                                                                        |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [`api-load-shedding.mjs`](api-load-shedding.mjs)       | An API in front of a slow database gets a 10× spike.                                | `maxQueueSize` and `queueTimeout` turn overload into fast 503s, so the database never runs queries for clients that already gave up. |
| [`llm-rate-limits.mjs`](llm-rate-limits.mjs)           | Batch-processing prompts against a rate-limited LLM API whose limit you don't know. | `adaptive` and `limitFetch` find the provider's real concurrency and honour `Retry-After`: 37 429s instead of 1,140.                 |
| [`priority-lanes.mjs`](priority-lanes.mjs)             | Checkout and a nightly reconciliation job share one payment gateway.                | `priority` keeps checkout's p95 wait at about 40 ms instead of about 5 s, with the same gateway load.                                |
| [`cancel-on-disconnect.mjs`](cancel-on-disconnect.mjs) | A typeahead search aborts the previous request on every keystroke.                  | An `AbortSignal` tied to the connection drops abandoned work, cutting backend time by about 60% and halving latency.                 |
| [`graceful-shutdown.mjs`](graceful-shutdown.mjs)       | A job worker receives SIGTERM, as in a Kubernetes rollout.                          | `clearQueue()` hands unstarted jobs back to the broker while running jobs finish. Nothing is lost.                                   |
| [`stream-backpressure.mjs`](stream-backpressure.mjs)   | Enriching a 5,000-record export through an API.                                     | `pendingCount` and `onPendingCountChange` keep memory flat (64 queued instead of 4,992) at the same throughput.                      |

```bash
node examples/api-load-shedding.mjs
```

Results vary slightly between runs because the simulated latencies are random.

## Simulator

An interactive page that sends simulated traffic through a real `Bulkhead` running in your browser. You can start, pause and stop it, and change any setting while it runs: arrival rate, bursts, priority mix, caller patience and cancellation, concurrency, queue limit, queue deadline, the adaptive backoff settings, and the downstream service's execution time, variability, capacity, Retry-After and error rate.

```bash
npm run simulator
# then open http://localhost:4173
```

It comes with four scenarios: steady traffic, a traffic spike, a rate-limited API, and a slow dependency with no limits. It runs without a network connection; only the web font needs one, and it falls back to the system font.

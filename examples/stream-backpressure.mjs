// Processing a large stream with bounded memory.
//
// We enrich 5,000 records from an export file by calling an API for each one
// (8 at a time, ~10 ms per call). Reading the file is much faster than the
// API, so a naive loop queues every record immediately: memory grows with the
// file size, and nothing is gained because the API is the bottleneck anyway.
//
// Instead, the reader waits whenever the bulkhead already has enough work
// queued. Memory stays flat regardless of file size, and throughput is the same.
//
// Run: npm run build && node examples/stream-backpressure.mjs

import { Readable } from 'node:stream';
import { Bulkhead } from '@cajax/bulkhead-limit';

const RECORDS = 5_000;
const HIGH_WATER = 64; // pause reading at this many waiting records…
const LOW_WATER = 16; // …and resume once the queue drains to this

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enrich = (record) => sleep(8 + Math.random() * 4).then(() => ({ ...record, enriched: true }));

function exportFile() {
    return Readable.from(
        (function* () {
            for (let id = 1; id <= RECORDS; id++) yield { id, payload: 'x'.repeat(1_000) };
        })(),
    );
}

async function run(name, withBackpressure) {
    let wake;
    let peakQueued = 0;
    const api = new Bulkhead({
        concurrency: 8,
        onPendingCountChange: (n) => {
            peakQueued = Math.max(peakQueued, n);
            if (n <= LOW_WATER) wake?.();
        },
    });

    const started = Date.now();
    let done = 0;
    const inFlight = new Set();
    for await (const record of exportFile()) {
        if (withBackpressure && api.pendingCount >= HIGH_WATER) {
            await new Promise((r) => (wake = r));
        }
        const p = api
            .run(() => enrich(record))
            .then(() => {
                done++;
                inFlight.delete(p);
            });
        inFlight.add(p);
    }
    await Promise.all(inFlight);

    return {
        [name]: {
            'Records processed': done,
            'Peak records held in the queue': peakQueued,
            'Time (s)': ((Date.now() - started) / 1000).toFixed(1),
        },
    };
}

console.log(`\nEnriching ${RECORDS.toLocaleString('en')} records through an API that handles 8 at a time\n`);
console.table({
    ...(await run('Read everything up front', false)),
    ...(await run(`Backpressure (${LOW_WATER}–${HIGH_WATER} queued)`, true)),
});
console.log();

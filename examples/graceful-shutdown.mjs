// Graceful shutdown of a job worker (for example on a Kubernetes SIGTERM).
//
// The worker pulls jobs from a broker and processes 4 at a time. When SIGTERM
// arrives it must stop within its grace period without losing work:
//   1. stop pulling new jobs,
//   2. hand every job that hasn't started back to the broker (clearQueue),
//   3. let the jobs already running finish, then exit.
//
// Run: npm run build && node examples/graceful-shutdown.mjs

import { Bulkhead, isQueueClearedError } from 'bulkhead-limit';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A tiny in-memory stand-in for a message broker.
const broker = {
    ready: Array.from({ length: 40 }, (_, i) => `job-${i + 1}`),
    acked: [],
    requeued: [],
    pull: () => broker.ready.shift(),
    ack: (job) => broker.acked.push(job),
    nack: (job) => broker.requeued.push(job), // back on the queue for another worker
};

let idle;
const worker = new Bulkhead({
    concurrency: 4,
    onActiveCountChange: (n) => n === 0 && idle?.(),
});

let shuttingDown = false;
const handled = [];

async function pullLoop() {
    while (!shuttingDown) {
        const job = broker.pull();
        if (!job) break;
        handled.push(
            worker
                .run(() => sleep(100 + Math.random() * 100))
                .then(
                    () => broker.ack(job),
                    (err) => (isQueueClearedError(err) ? broker.nack(job) : Promise.reject(err)),
                ),
        );
        await sleep(5); // jobs arrive faster than they are processed
    }
}

process.once('SIGTERM', async () => {
    const started = Date.now();
    shuttingDown = true; // 1. stop pulling
    const handedBack = worker.clearQueue(); // 2. waiting jobs reject with QueueClearedError → nack
    const running = worker.activeCount;
    if (running > 0) await new Promise((r) => (idle = r)); // 3. drain in-flight work
    await Promise.all(handled);

    console.log(`\nSIGTERM: handed ${handedBack} waiting jobs back, finished ${running} running jobs`);
    console.log(`Shutdown took ${Date.now() - started} ms\n`);
    console.table({
        'Processed and acked': broker.acked.length,
        'Returned to the broker': broker.requeued.length,
        'Never pulled': broker.ready.length,
        Lost: 40 - broker.acked.length - broker.requeued.length - broker.ready.length,
    });
    process.exit(0);
});

pullLoop();
setTimeout(() => process.kill(process.pid, 'SIGTERM'), 150);

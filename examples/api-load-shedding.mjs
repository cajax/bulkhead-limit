// Load shedding for an HTTP API in front of a slow database.
//
// The /report endpoint runs a query that takes ~100 ms, and the database can
// handle 4 at once (40 queries/s). A spike of 400 requests arrives within one
// second, and clients give up after one second.
//
// With an unbounded queue (plain concurrency limit) the server keeps every
// request, so most wait far longer than the client does: the client times out,
// and the server still runs the query for nobody. With a bulkhead, requests
// that can't be served in time get a fast 503 instead, and the database only
// does work someone is still waiting for.
//
// Run: npm run build && node examples/api-load-shedding.mjs

import http from 'node:http';
import { Bulkhead, isQueueFullError, isQueueTimeoutError } from '@cajax/bulkhead-limit';

const QUERY_MS = 100;
const DB_CONNECTIONS = 4;
const SPIKE_REQUESTS = 400;
const SPIKE_WINDOW_MS = 1_000;
const CLIENT_TIMEOUT_MS = 1_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scenario(name, bulkheadOptions) {
    const db = new Bulkhead({ concurrency: DB_CONNECTIONS, ...bulkheadOptions });
    let wastedQueries = 0;

    const server = http.createServer(async (req, res) => {
        try {
            await db.run(() => sleep(QUERY_MS));
            if (res.destroyed) {
                wastedQueries++; // the client already hung up
                return;
            }
            res.writeHead(200).end('report');
        } catch (err) {
            if (isQueueFullError(err) || isQueueTimeoutError(err)) {
                res.writeHead(503, { 'Retry-After': '1' }).end();
            } else {
                res.writeHead(500).end();
            }
        }
    });
    await new Promise((r) => server.listen(0, r));
    const url = `http://127.0.0.1:${server.address().port}/report`;

    const outcomes = { served: 0, shed: 0, clientTimeout: 0 };
    const requests = Array.from({ length: SPIKE_REQUESTS }, async (_, i) => {
        await sleep((i / SPIKE_REQUESTS) * SPIKE_WINDOW_MS);
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS) });
            await res.arrayBuffer();
            if (res.status === 200) outcomes.served++;
            else outcomes.shed++;
        } catch {
            outcomes.clientTimeout++;
        }
    });
    await Promise.all(requests);

    // Let the server finish whatever it still has queued, then count the waste.
    if (db.pendingCount > 0)
        console.log(`${name}: clients are done, the server still has ${db.pendingCount} queries queued…`);
    while (db.activeCount + db.pendingCount > 0) await sleep(50);
    server.closeAllConnections();
    server.close();

    return { name, ...outcomes, wastedQueries };
}

const results = [
    await scenario('Unbounded queue', {}),
    await scenario('Bulkhead', { maxQueueSize: 20, queueTimeout: 500 }),
];

console.log(
    `\n${SPIKE_REQUESTS} requests in ${SPIKE_WINDOW_MS} ms against a database that serves ${(1000 / QUERY_MS) * DB_CONNECTIONS}/s\n`,
);
console.table(
    Object.fromEntries(
        results.map((r) => [
            r.name,
            {
                'Served in time': r.served,
                'Fast 503': r.shed,
                'Client gave up': r.clientTimeout,
                'Queries run for nobody': r.wastedQueries,
            },
        ]),
    ),
);
console.log(
    'The bulkhead answers every request within the client deadline, and the database spends no time on abandoned work.\n',
);

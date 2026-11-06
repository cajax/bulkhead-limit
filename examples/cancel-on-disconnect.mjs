// Dropping queued work when the client goes away.
//
// A typeahead search box fires a request on every keystroke and aborts the
// previous one. The search backend allows 2 concurrent queries (~200 ms each).
// A user types "bulkhead" (8 keystrokes, 60 ms apart), so 7 of the 8 requests
// are abandoned almost immediately.
//
// If the server ignores disconnects, it still runs all 8 queries, and the one
// the user actually wants waits behind abandoned ones. Passing an AbortSignal
// tied to the connection removes abandoned requests from the queue the moment
// the client hangs up, and stops the ones already running.
//
// Run: npm run build && node examples/cancel-on-disconnect.mjs

import http from 'node:http';
import { Bulkhead } from '@cajax/bulkhead-limit';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Stand-in for a database query: takes `ms`, stops early if `signal` aborts. */
function query(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(signal.reason);
        });
    });
}

/** An AbortSignal that fires if the client disconnects before we respond. */
function disconnectSignal(res) {
    const controller = new AbortController();
    res.on('close', () => {
        if (!res.writableFinished) controller.abort(new Error('client disconnected'));
    });
    return controller.signal;
}

async function scenario(name, honourDisconnects) {
    const search = new Bulkhead({ concurrency: 2 });
    let queriesRun = 0;
    let backendMs = 0;

    const server = http.createServer(async (req, res) => {
        const signal = honourDisconnects ? disconnectSignal(res) : undefined;
        try {
            const results = await search.run(
                async ({ signal }) => {
                    queriesRun++;
                    const started = Date.now();
                    try {
                        await query(200, signal);
                    } finally {
                        backendMs += Date.now() - started;
                    }
                    return `results for ${new URL(req.url, 'http://x').searchParams.get('q')}`;
                },
                { signal },
            );
            res.end(results);
        } catch {
            if (!res.destroyed) res.writeHead(499).end();
        }
    });
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}/search?q=`;

    const started = Date.now();
    let previous;
    let last;
    const word = 'bulkhead';
    for (let i = 1; i <= word.length; i++) {
        previous?.abort();
        previous = new AbortController();
        last = fetch(base + word.slice(0, i), { signal: previous.signal }).catch(() => undefined);
        if (i < word.length) await sleep(60);
    }
    const res = await last;
    const body = await res.text();
    const latency = Date.now() - started - (word.length - 1) * 60;

    while (search.activeCount + search.pendingCount > 0) await sleep(20);
    server.closeAllConnections();
    server.close();
    return {
        [name]: {
            'Queries started': queriesRun,
            'Backend busy (ms)': backendMs,
            'Final result after (ms)': latency,
            Response: body,
        },
    };
}

console.log('\nA user types "bulkhead"; each keystroke aborts the previous request\n');
console.table({
    ...(await scenario('Ignoring disconnects', false)),
    ...(await scenario('AbortSignal on disconnect', true)),
});
console.log();

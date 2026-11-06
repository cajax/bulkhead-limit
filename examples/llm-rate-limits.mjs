// Calling a rate-limited LLM API without burning your quota on 429s.
//
// The mock provider below serves at most 6 concurrent completions (~200 ms
// each) and answers anything beyond that with 429 + Retry-After: 1. We have
// 120 prompts to process and don't know the real limit up front, so we start
// optimistic at 24 concurrent requests.
//
// A fixed limit keeps hammering the provider at 24 and collects a 429 for most
// attempts. Adaptive concurrency halves the limit on each 429, pauses for
// Retry-After, then probes back up one slot at a time, so it settles near the
// provider's real capacity.
//
// Run: npm run build && node examples/llm-rate-limits.mjs

import http from 'node:http';
import { Bulkhead } from '@cajax/bulkhead-limit';
import { limitFetch } from '@cajax/bulkhead-limit/fetch';

const PROVIDER_CONCURRENCY = 6;
const PROMPTS = 120;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startMockProvider() {
    let inFlight = 0;
    const server = http.createServer(async (req, res) => {
        if (inFlight >= PROVIDER_CONCURRENCY) {
            res.writeHead(429, { 'Retry-After': '1', 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'rate_limit_exceeded' }));
            return;
        }
        inFlight++;
        await sleep(150 + Math.random() * 100);
        inFlight--;
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ text: 'ok' }));
    });
    return new Promise((r) => server.listen(0, () => r(server)));
}

/** Send one prompt, retrying 429s. Returns the number of 429s it hit. */
async function complete(api, url, prompt) {
    for (let rateLimited = 0; ; rateLimited++) {
        const res = await api(url, { method: 'POST', body: JSON.stringify({ prompt }) });
        await res.arrayBuffer();
        if (res.status !== 429) return rateLimited;
        // With adaptive control the bulkhead itself is now paused for Retry-After,
        // so the retry simply waits in its queue. Without it, we sleep here.
        if (!api.adaptive) await sleep(Number(res.headers.get('retry-after')) * 1000);
    }
}

async function scenario(name, adaptive) {
    const server = await startMockProvider();
    const url = `http://127.0.0.1:${server.address().port}/v1/completions`;
    const timeline = [];
    const bulkhead = new Bulkhead({
        concurrency: 24,
        adaptive: adaptive && {
            successStep: 3,
            // Fires for every 429; a burst from one overload only lowers the limit once.
            onThrottle: ({ previousConcurrency, newConcurrency, cooldownMs }) => {
                if (newConcurrency !== previousConcurrency) {
                    timeline.push(`429: limit ${previousConcurrency} → ${newConcurrency}, pause ${cooldownMs} ms`);
                }
            },
            onRampUp: ({ concurrency }) => timeline.push(`3 successes: limit → ${concurrency}`),
        },
    });
    const api = Object.assign(limitFetch(bulkhead), { adaptive });

    const started = Date.now();
    const rateLimited = await Promise.all(Array.from({ length: PROMPTS }, (_, i) => complete(api, url, `prompt ${i}`)));
    const elapsed = Date.now() - started;
    server.closeAllConnections();
    server.close();

    return {
        name,
        timeline,
        row: {
            '429 responses': rateLimited.reduce((a, b) => a + b, 0),
            'Total time (s)': (elapsed / 1000).toFixed(1),
            'Final concurrency': bulkhead.concurrency,
        },
    };
}

const fixed = await scenario('Fixed limit of 24', false);
const adaptive = await scenario('Adaptive, starting at 24', true);

console.log(`\n${PROMPTS} prompts against a provider that allows ${PROVIDER_CONCURRENCY} concurrent requests\n`);
console.table({ [fixed.name]: fixed.row, [adaptive.name]: adaptive.row });
console.log('\nAdaptive control, step by step:');
for (const line of adaptive.timeline.slice(0, 14)) console.log(`  ${line}`);
if (adaptive.timeline.length > 14) console.log(`  … ${adaptive.timeline.length - 14} more changes`);
console.log();

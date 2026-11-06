// Keeping checkout fast while a background job shares the same dependency.
//
// A payment gateway allows 3 concurrent calls (~50 ms each). A nightly
// reconciliation job dumps 300 calls on it at once; meanwhile customers keep
// checking out, one every 25 ms. All traffic goes through one bulkhead, so the
// gateway is never overloaded.
//
// Without priorities, every checkout waits behind the whole backlog. With
// priority 10 for checkout, each one jumps the queue and only waits for a slot
// to free up; the background job absorbs the delay instead.
//
// Run: npm run build && node examples/priority-lanes.mjs

import { Bulkhead } from 'bulkhead-limit';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const callGateway = () => sleep(45 + Math.random() * 10);
const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)];

async function scenario(name, checkoutPriority) {
    const gateway = new Bulkhead({ concurrency: 3 });
    const timed = async (priority) => {
        const queuedAt = Date.now();
        let waited = 0;
        await gateway.run(
            () => {
                waited = Date.now() - queuedAt;
                return callGateway();
            },
            { priority },
        );
        return waited;
    };

    const reconciliation = Promise.all(Array.from({ length: 300 }, () => timed(0)));
    const checkouts = [];
    for (let i = 0; i < 80; i++) {
        checkouts.push(timed(checkoutPriority));
        await sleep(25);
    }
    const checkoutWaits = await Promise.all(checkouts);
    const reconciliationWaits = await reconciliation;

    return {
        [name]: {
            'Checkout wait p95 (ms)': p95(checkoutWaits),
            'Checkout wait max (ms)': Math.max(...checkoutWaits),
            'Background wait p95 (ms)': p95(reconciliationWaits),
        },
    };
}

console.log('\n300 background calls + 80 checkouts through a gateway that allows 3 at a time\n');
console.table({
    ...(await scenario('FIFO (no priorities)', 0)),
    ...(await scenario('Checkout priority 10', 10)),
});
console.log('Same gateway load, same total work: priorities only decide who waits.\n');

import { Bulkhead, isQueueClearedError, isQueueFullError, isQueueTimeoutError } from '/lib/bulkhead-limit.js';
import { createChart } from '/charts.js';

const $ = (id) => document.getElementById(id);
const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const PRESETS = {
    steady: {
        label: 'Steady traffic',
        note: 'The service keeps up. The queue stays short and nothing is turned away.',
        values: { arrivalRate: 30, execMs: 200, concurrency: 8, capacity: 10, queueLimit: 50, queueTimeout: 2000 },
    },
    spike: {
        label: 'Traffic spike',
        note: 'Arrivals are double what the service can handle. The queue limit and deadline turn the excess into fast rejections instead of long waits.',
        values: { arrivalRate: 80, execMs: 200, concurrency: 8, capacity: 10, queueLimit: 40, queueTimeout: 1000 },
    },
    rateLimited: {
        label: 'Rate-limited API',
        note: 'The service accepts 6 requests at once and answers 429 beyond that. Adaptive backoff starts at 24 and finds the real limit.',
        values: {
            arrivalRate: 20,
            execMs: 250,
            concurrency: 24,
            capacity: 6,
            retryAfter: 1,
            queueLimit: 200,
            queueTimeout: 5000,
        },
    },
    slow: {
        label: 'Slow dependency, no limits',
        note: 'No queue limit, no deadline, and nothing tells the server when a caller leaves. Callers give up after 3 s while their requests keep waiting, and the service later does that work for nobody. Turn on the queue deadline or cancellation to fix it.',
        values: {
            arrivalRate: 15,
            execMs: 1500,
            jitter: 50,
            concurrency: 8,
            capacity: 20,
            queueUnbounded: true,
            queueTimeoutOff: true,
            patience: 3000,
            cancelOnGiveUp: false,
        },
    },
};

const DEFAULTS = {
    arrivalRate: 30,
    highShare: 10,
    burstSize: 100,
    patience: 5000,
    patienceOff: false,
    cancelOnGiveUp: true,
    concurrency: 8,
    queueLimit: 50,
    queueUnbounded: false,
    queueTimeout: 2000,
    queueTimeoutOff: false,
    adaptive: true,
    decreaseFactor: 0.5,
    successStep: 5,
    minConcurrency: 1,
    execMs: 200,
    jitter: 30,
    capacity: 10,
    retryAfter: 1,
    errorRate: 0,
};

const settings = { ...DEFAULTS };

const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)} s` : `${v} ms`);

const GROUPS = [
    {
        title: 'Traffic',
        controls: [
            { key: 'arrivalRate', label: 'Arrival rate', min: 0, max: 200, step: 1, format: (v) => `${v}/s` },
            { key: 'highShare', label: 'High-priority share', min: 0, max: 100, step: 5, format: (v) => `${v}%` },
            { key: 'burstSize', label: 'Burst size', min: 10, max: 500, step: 10, format: (v) => `${v}` },
        ],
    },
    {
        title: 'Callers',
        controls: [
            {
                key: 'patience',
                label: 'Give up after',
                min: 100,
                max: 20000,
                step: 100,
                format: ms,
                toggle: { key: 'patienceOff', label: 'Wait forever', shows: 'Never' },
            },
            { key: 'cancelOnGiveUp', label: 'Cancel work when the caller gives up', type: 'switch' },
        ],
    },
    {
        title: 'Bulkhead',
        controls: [
            { key: 'concurrency', label: 'Concurrency', min: 1, max: 64, step: 1, format: (v) => `${v}` },
            {
                key: 'queueLimit',
                label: 'Queue limit',
                min: 0,
                max: 500,
                step: 5,
                format: (v) => `${v}`,
                toggle: { key: 'queueUnbounded', label: 'Unbounded', shows: 'None' },
            },
            {
                key: 'queueTimeout',
                label: 'Queue deadline',
                min: 50,
                max: 10000,
                step: 50,
                format: ms,
                toggle: { key: 'queueTimeoutOff', label: 'No deadline', shows: 'None' },
            },
            { key: 'adaptive', label: 'Adaptive backoff on 429', type: 'switch' },
            {
                key: 'decreaseFactor',
                label: 'On 429, multiply the limit by',
                min: 0.1,
                max: 0.9,
                step: 0.05,
                format: (v) => `×${v.toFixed(2)}`,
                dependsOn: 'adaptive',
            },
            {
                key: 'successStep',
                label: 'Successes per slot regained',
                min: 1,
                max: 30,
                step: 1,
                format: (v) => `${v}`,
                dependsOn: 'adaptive',
            },
            {
                key: 'minConcurrency',
                label: 'Minimum concurrency',
                min: 1,
                max: 32,
                step: 1,
                format: (v) => `${v}`,
                dependsOn: 'adaptive',
            },
        ],
    },
    {
        title: 'Service',
        note: 'A downstream service with its own capacity. Requests beyond it get a 429.',
        controls: [
            { key: 'execMs', label: 'Execution time', min: 10, max: 3000, step: 10, format: ms },
            { key: 'jitter', label: 'Variability', min: 0, max: 100, step: 5, format: (v) => `±${v}%` },
            { key: 'capacity', label: 'Capacity', min: 1, max: 100, step: 1, format: (v) => `${v} at once` },
            {
                key: 'retryAfter',
                label: 'Retry-After on 429',
                min: 0,
                max: 10,
                step: 0.5,
                format: (v) => (v === 0 ? 'Not sent' : `${v} s`),
            },
            { key: 'errorRate', label: 'Error rate', min: 0, max: 50, step: 1, format: (v) => `${v}%` },
        ],
    },
];

const controlByKey = new Map();

function renderControls() {
    const root = $('controls');
    for (const group of GROUPS) {
        const section = document.createElement('section');
        section.className = 'group';
        const h2 = document.createElement('h2');
        h2.textContent = group.title;
        section.append(h2);
        if (group.note) {
            const note = document.createElement('p');
            note.className = 'group-note';
            note.textContent = group.note;
            section.append(note);
        }
        for (const c of group.controls) section.append(c.type === 'switch' ? renderSwitch(c) : renderRange(c));
        root.append(section);
    }
}

function renderSwitch(c) {
    const wrap = document.createElement('div');
    wrap.className = 'control-switch';
    const label = document.createElement('label');
    label.className = 'toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.role = 'switch';
    input.addEventListener('change', () => change(c.key, input.checked));
    label.append(input, document.createTextNode(c.label));
    wrap.append(label);
    controlByKey.set(c.key, { c, sync: () => (input.checked = settings[c.key]) });
    return wrap;
}

function renderRange(c) {
    const wrap = document.createElement('div');
    wrap.className = 'control';
    const id = `ctl-${c.key}`;
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = c.label;
    const output = document.createElement('output');
    output.htmlFor = id;
    const input = document.createElement('input');
    Object.assign(input, { type: 'range', id, min: c.min, max: c.max, step: c.step });
    input.addEventListener('input', () => change(c.key, Number(input.value)));
    wrap.append(label, output, input);

    let toggleInput;
    if (c.toggle) {
        const t = document.createElement('label');
        t.className = 'toggle';
        toggleInput = document.createElement('input');
        toggleInput.type = 'checkbox';
        toggleInput.addEventListener('change', () => change(c.toggle.key, toggleInput.checked));
        t.append(toggleInput, document.createTextNode(c.toggle.label));
        wrap.append(t);
    }

    const sync = () => {
        const value = settings[c.key];
        input.value = value;
        input.style.setProperty('--fill', `${((value - c.min) / (c.max - c.min)) * 100}%`);
        const off = c.toggle && settings[c.toggle.key];
        const inactive = c.dependsOn && !settings[c.dependsOn];
        if (toggleInput) toggleInput.checked = !!off;
        input.disabled = !!off || !!inactive;
        wrap.classList.toggle('is-disabled', input.disabled);
        output.textContent = off ? c.toggle.shows : c.format(value);
        output.classList.toggle('off', !!off || !!inactive);
    };
    controlByKey.set(c.key, { c, sync });
    if (c.toggle) controlByKey.set(c.toggle.key, { c, sync });
    return wrap;
}

function syncAllControls() {
    for (const { sync } of controlByKey.values()) sync();
}

function change(key, value, fromPreset = false) {
    settings[key] = value;
    controlByKey.get(key)?.sync();
    if (key === 'adaptive') {
        for (const k of ['decreaseFactor', 'successStep', 'minConcurrency']) controlByKey.get(k).sync();
    }
    if (!fromPreset) {
        $('preset').value = 'custom';
        $('preset-note').textContent = 'Your own settings. Every change applies to the running simulation.';
    }
    applyLive(key);
}

// Push a changed setting into the live bulkhead. Traffic, caller and service
// settings are read when they are used, so they need nothing here.
function applyLive(key) {
    switch (key) {
        case 'concurrency':
            bulkhead.configure({ concurrency: settings.concurrency });
            break;
        case 'queueLimit':
        case 'queueUnbounded':
            bulkhead.configure({ maxQueueSize: settings.queueUnbounded ? undefined : settings.queueLimit });
            break;
        case 'queueTimeout':
        case 'queueTimeoutOff':
            bulkhead.configure({ queueTimeout: settings.queueTimeoutOff ? undefined : settings.queueTimeout });
            break;
        case 'adaptive':
            if (!settings.adaptive) {
                bulkhead.resetAdaptive();
                if (sim.state !== 'stopped') log('Adaptive backoff off: limit restored');
            } else if (sim.state !== 'stopped') {
                log('Adaptive backoff on');
            }
            break;
        case 'decreaseFactor':
        case 'successStep':
        case 'minConcurrency':
            bulkhead.configure({ adaptive: { [key]: settings[key] } });
            break;
    }
}

function applyPreset(name) {
    const preset = PRESETS[name];
    if (!preset) return;
    for (const [key, value] of Object.entries({ ...DEFAULTS, ...preset.values })) {
        if (key === 'burstSize') continue;
        change(key, value, true);
    }
    $('preset').value = name;
    $('preset-note').textContent = preset.note;
    if (sim.state !== 'stopped') log(`Scenario: ${preset.label}`);
}

function renderPresets() {
    const select = $('preset');
    for (const [value, p] of Object.entries(PRESETS)) select.append(new Option(p.label, value));
    select.append(new Option('Custom', 'custom'));
    select.addEventListener('change', () => applyPreset(select.value));
}

// ---------------------------------------------------------------------------
// The bulkhead under test (the real library) and a simulated downstream
// ---------------------------------------------------------------------------

function createBulkhead() {
    return new Bulkhead({
        concurrency: settings.concurrency,
        maxQueueSize: settings.queueUnbounded ? undefined : settings.queueLimit,
        queueTimeout: settings.queueTimeoutOff ? undefined : settings.queueTimeout,
        adaptive: {
            decreaseFactor: settings.decreaseFactor,
            successStep: settings.successStep,
            minConcurrency: settings.minConcurrency,
            onThrottle: ({ previousConcurrency, newConcurrency, cooldownMs }) => {
                if (newConcurrency !== previousConcurrency) {
                    log(`429: limit ${previousConcurrency} → ${newConcurrency}, pause ${ms(cooldownMs)}`);
                }
            },
            onRampUp: ({ concurrency, targetConcurrency }) =>
                log(`Limit raised to ${concurrency} of ${targetConcurrency}`),
        },
    });
}

// Per-run classifier: 429 is an overload (with Retry-After), success ramps back
// up, everything else says nothing about load. Off switch: report nothing.
const classify = (outcome) => {
    if (!settings.adaptive) return 'ignore';
    if (outcome.ok) return 'success';
    if (outcome.error?.status === 429) return { overload: true, retryAfterMs: outcome.error.retryAfterMs };
    return 'ignore';
};

class ServiceError extends Error {
    constructor(status, retryAfterMs) {
        super(`HTTP ${status}`);
        this.status = status;
        this.retryAfterMs = retryAfterMs;
    }
}

const service = {
    inFlight: 0,
    last429: -Infinity,
    async call(task, signal) {
        if (this.inFlight >= settings.capacity) {
            task.duration = 5;
            await sleep(5);
            this.last429 = now();
            throw new ServiceError(429, settings.retryAfter > 0 ? settings.retryAfter * 1000 : undefined);
        }
        this.inFlight++;
        try {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, task.duration);
                signal?.addEventListener('abort', () => {
                    clearTimeout(timer);
                    reject(signal.reason);
                });
            });
            if (Math.random() * 100 < settings.errorRate) throw new ServiceError(500);
        } finally {
            this.inFlight--;
        }
    },
};

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

let bulkhead = createBulkhead();
const sim = {
    state: 'stopped',
    startedAt: 0,
    stoppedAt: 0,
    abort: new AbortController(),
    arrivals: null,
    sampler: null,
    lastArrivalTick: 0,
    carry: 0,
    holdUntil: 0,
};

const waiting = new Set();
const slots = [];
let totals;
let recent; // timestamps for rolling rates and percentiles
let samples = [];
let events = [];

function resetStats() {
    totals = { completed: 0, shed: 0, timeout: 0, gaveup: 0, cleared: 0, r429: 0, errors: 0, wasted: 0 };
    recent = { completed: [], turnedAway: [], waits: [], latencies: [] };
    samples = [];
    events = [];
    waiting.clear();
    slots.length = 0;
    renderLog();
}

function submit() {
    const priority = Math.random() * 100 < settings.highShare ? 10 : 0;
    const created = now();
    const dropAt = Math.min(
        settings.queueTimeoutOff ? Infinity : created + settings.queueTimeout,
        settings.patienceOff ? Infinity : created + settings.patience,
    );
    const task = { priority, created, dropAt, window: dropAt - created, slot: -1, startedAt: 0, duration: 0 };
    waiting.add(task);

    // Giving up either cancels the work (the AbortSignal reaches the bulkhead and
    // the task) or just walks away, leaving the work to finish for nobody.
    let signal = sim.abort.signal;
    if (!settings.patienceOff && settings.cancelOnGiveUp) {
        signal = AbortSignal.any([sim.abort.signal, AbortSignal.timeout(settings.patience)]);
    } else if (!settings.patienceOff) {
        task.giveUp = setTimeout(() => {
            task.abandoned = true;
            record('gaveup', task);
        }, settings.patience);
    }

    bulkhead
        .run(({ signal }) => execute(task, signal), { signal, priority, classify })
        .then(
            () => record('completed', task, true),
            (err) => record(kindOf(err), task, true),
        );
}

async function execute(task, signal) {
    waiting.delete(task);
    task.startedAt = now();
    const jitter = settings.jitter / 100;
    task.duration = Math.max(5, settings.execMs * (1 + jitter * (Math.random() * 2 - 1)));
    task.slot = allocateSlot(task);
    try {
        await service.call(task, signal);
    } finally {
        slots[task.slot] = null;
    }
}

function allocateSlot(task) {
    const limit = bulkhead.concurrency;
    for (let i = 0; i < Math.max(limit, slots.length + 1); i++) {
        if (!slots[i] && (i < limit || i >= slots.length)) {
            slots[i] = task;
            return i;
        }
    }
    slots.push(task);
    return slots.length - 1;
}

function kindOf(err) {
    if (sim.abort.signal.aborted) return 'stopped';
    if (isQueueFullError(err)) return 'shed';
    if (isQueueTimeoutError(err)) return 'timeout';
    if (isQueueClearedError(err)) return 'cleared';
    if (err?.status === 429) return 'r429';
    if (err?.status >= 500) return 'errors';
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'gaveup';
    return 'errors';
}

function record(kind, task, settled = false) {
    if (!settled && task.abandoned) {
        totals.gaveup++;
        recent.turnedAway.push(now());
        return;
    }
    if (settled) {
        clearTimeout(task.giveUp);
        waiting.delete(task);
        if (task.abandoned) {
            // The caller left long ago; whatever happened now, nobody receives it.
            if (kind === 'completed') totals.wasted++;
            return;
        }
    }
    waiting.delete(task);
    if (kind === 'stopped') return;
    totals[kind]++;
    const t = now();
    if (kind === 'completed') {
        recent.completed.push(t);
        recent.waits.push([t, task.startedAt - task.created]);
        recent.latencies.push([t, t - task.created]);
    } else if (kind === 'shed' || kind === 'timeout' || kind === 'gaveup' || kind === 'cleared') {
        recent.turnedAway.push(t);
    }
}

function arrivalsTick() {
    const t = now();
    const dt = Math.min(250, t - sim.lastArrivalTick);
    sim.lastArrivalTick = t;
    sim.carry += (settings.arrivalRate * dt) / 1000;
    while (sim.carry >= 1) {
        submit();
        sim.carry -= 1;
    }
}

function startArrivals() {
    sim.lastArrivalTick = now();
    sim.carry = Math.random();
    sim.arrivals = setInterval(arrivalsTick, 40);
}

function stopArrivals() {
    clearInterval(sim.arrivals);
    sim.arrivals = null;
}

function takeSample() {
    const t = now();
    const cutoff = t - 1000;
    const prune = (list, horizon) => {
        while (list.length && (Array.isArray(list[0]) ? list[0][0] : list[0]) < horizon) list.shift();
    };
    prune(recent.completed, t - 5000);
    prune(recent.turnedAway, t - 5000);
    prune(recent.waits, t - 5000);
    prune(recent.latencies, t - 5000);

    samples.push({
        t: t - sim.startedAt,
        running: bulkhead.activeCount,
        limit: bulkhead.concurrency,
        target: bulkhead.targetConcurrency,
        waiting: bulkhead.pendingCount,
        queueLimit: settings.queueUnbounded ? NaN : settings.queueLimit,
        completed: recent.completed.filter((x) => x >= cutoff).length,
        turnedAway: recent.turnedAway.filter((x) => x >= cutoff).length,
    });
    while (samples.length && samples[0].t < samples[samples.length - 1].t - 62_000) samples.shift();

    charts.slots.update(samples);
    charts.queue.update(samples);
    charts.outcomes.update(samples);
    renderTiles();
    if ($('data-table').closest('details').open) renderTable();
}

function start() {
    sim.abort = new AbortController();
    bulkhead = createBulkhead();
    resetStats();
    sim.state = 'running';
    sim.startedAt = now();
    startArrivals();
    sim.sampler = setInterval(takeSample, 250);
    log('Started');
    renderRunState();
}

function pause() {
    sim.state = 'paused';
    stopArrivals();
    bulkhead.pause(24 * 3600 * 1000);
    log('Paused: arrivals stopped, dispatch held');
    renderRunState();
}

function resume() {
    sim.state = 'running';
    bulkhead.resume();
    startArrivals();
    log('Resumed');
    renderRunState();
}

function stop() {
    stopArrivals();
    sim.abort.abort();
    bulkhead.clearQueue();
    bulkhead.resume();
    clearInterval(sim.sampler);
    takeSample();
    sim.state = 'stopped';
    sim.stoppedAt = now();
    log('Stopped');
    renderRunState();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const MAX_CELLS = 168;
const queueEl = $('queue');
const decksEl = $('decks');
const cellPool = [];
const compartmentPool = [];
const moreEl = document.createElement('p');
moreEl.className = 'queue-more';

function renderQueue(t) {
    const sorted = [...waiting].sort((a, b) => b.priority - a.priority || a.created - b.created);
    const shown = sorted.slice(0, MAX_CELLS);
    const bound = settings.queueUnbounded ? 0 : Math.min(settings.queueLimit, MAX_CELLS);
    const total = Math.max(shown.length, bound);

    while (cellPool.length < total) {
        const cell = document.createElement('div');
        cellPool.push(cell);
    }
    for (let i = 0; i < cellPool.length; i++) {
        const cell = cellPool[i];
        if (i >= total) {
            cell.remove();
            continue;
        }
        if (!cell.isConnected) queueEl.insertBefore(cell, moreEl.isConnected ? moreEl : null);
        const task = shown[i];
        if (task) {
            cell.className = task.priority > 0 ? 'cell high' : 'cell';
            const left = task.abandoned
                ? 0
                : Number.isFinite(task.window)
                  ? Math.max(0, (task.dropAt - t) / task.window)
                  : 1;
            cell.style.setProperty('--left', left.toFixed(3));
        } else {
            cell.className = 'cell slot';
        }
    }
    const hidden = sorted.length - shown.length;
    if (hidden > 0) {
        moreEl.textContent = `and ${hidden.toLocaleString('en')} more`;
        if (!moreEl.isConnected) queueEl.append(moreEl);
    } else if (moreEl.isConnected) {
        moreEl.remove();
    }

    $('q-count').textContent = bulkhead.pendingCount;
    $('q-limit').textContent = settings.queueUnbounded ? ' (no limit)' : ` of ${settings.queueLimit}`;
}

function renderHull(t) {
    const limit = bulkhead.concurrency;
    const target = bulkhead.targetConcurrency;
    let highest = -1;
    for (let i = 0; i < slots.length; i++) if (slots[i]) highest = i;
    const count = Math.max(target, limit, highest + 1);
    const decks = Math.ceil(count / 16);
    const cols = Math.ceil(count / decks);
    decksEl.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    decksEl.style.setProperty('--deck-h', `${[0, 96, 64, 48, 40][decks] ?? 36}px`);

    while (compartmentPool.length < count) {
        const c = document.createElement('div');
        c.className = 'compartment';
        const fill = document.createElement('div');
        fill.className = 'fill';
        c.append(fill);
        compartmentPool.push(c);
    }
    for (let i = 0; i < compartmentPool.length; i++) {
        const c = compartmentPool[i];
        if (i >= count) {
            c.remove();
            continue;
        }
        if (!c.isConnected) decksEl.append(c);
        const task = slots[i];
        const over = task && i >= limit;
        const sealed = !task && i >= limit;
        c.className = `compartment${sealed ? ' sealed' : ''}${over ? ' over' : ''}`;
        const p = task ? Math.min(1, (t - task.startedAt) / task.duration) : 0;
        c.style.setProperty('--p', p.toFixed(3));
    }

    $('h-running').textContent = bulkhead.activeCount;
    $('h-limit').textContent =
        target !== limit ? ` running, limit ${limit}, target ${target}` : ` running, limit ${limit}`;

    const banner = $('hull-banner');
    let text = '';
    if (sim.state === 'paused') text = 'Dispatch held while paused';
    else if (bulkhead.isPaused && t < sim.holdUntil) text = 'Dispatch held';
    else if (bulkhead.isPaused) text = 'Cooling down after a 429';
    banner.hidden = !text;
    banner.textContent = text;
}

function renderService(t) {
    const load = service.inFlight;
    const cap = settings.capacity;
    const ratio = Math.min(1, load / cap);
    const overloaded = t - service.last429 < 1000;
    const fill = $('gauge-fill');
    fill.style.height = `${ratio * 100}%`;
    fill.style.setProperty('--g', `${ratio * 100}%`);
    $('gauge').classList.toggle('overloaded', overloaded);
    $('s-load').textContent = load;
    $('s-cap').textContent = cap;
    const state = $('s-state');
    state.textContent = overloaded ? 'Sent a 429 in the last second' : load ? `Serving ${load}` : 'Idle';
    state.classList.toggle('overloaded', overloaded);
}

const percentile = (pairs, q) => {
    if (!pairs.length) return 0;
    const values = pairs.map((p) => p[1]).sort((a, b) => a - b);
    return values[Math.min(values.length - 1, Math.floor(values.length * q))];
};

function renderTiles() {
    const t = now();
    const lastSecond = recent.completed.filter((x) => x >= t - 1000).length;
    $('m-throughput').textContent = lastSecond;
    $('m-wait').textContent = Math.round(percentile(recent.waits, 0.95));
    $('m-latency').textContent = Math.round(percentile(recent.latencies, 0.95));
    $('c-completed').textContent = totals.completed.toLocaleString('en');
    $('c-shed').textContent = totals.shed.toLocaleString('en');
    $('c-timeout').textContent = totals.timeout.toLocaleString('en');
    $('c-gaveup').textContent = totals.gaveup.toLocaleString('en');
    $('c-429').textContent = totals.r429.toLocaleString('en');
    $('c-errors').textContent = totals.errors.toLocaleString('en');
    $('m-wasted').textContent = totals.wasted.toLocaleString('en');
}

function renderTable() {
    const table = $('data-table');
    const latest = samples.length ? samples[samples.length - 1].t : 0;
    const rows = samples.filter((s) => s.t >= latest - 10_000 && Math.round(s.t) % 1000 < 250).reverse();
    const head = ['Time', 'Running', 'Limit', 'Waiting', 'Completed/s', 'Turned away/s'];
    const tr = (cells, tag) => {
        const row = document.createElement('tr');
        for (const c of cells) {
            const cell = document.createElement(tag);
            cell.textContent = c;
            row.append(cell);
        }
        return row;
    };
    table.replaceChildren(
        tr(head, 'th'),
        ...rows.map((s) =>
            tr(
                [
                    latest - s.t < 500 ? 'now' : `${Math.round((latest - s.t) / 1000)} s ago`,
                    s.running,
                    s.limit,
                    s.waiting,
                    s.completed,
                    s.turnedAway,
                ],
                'td',
            ),
        ),
    );
}

function log(text) {
    const t = sim.state === 'stopped' && !sim.startedAt ? 0 : (now() - sim.startedAt) / 1000;
    events.unshift({ t, text });
    events.length = Math.min(events.length, 40);
    renderLog();
}

function renderLog() {
    const list = $('log');
    if (!events.length) {
        const li = document.createElement('li');
        li.className = 'log-empty';
        li.textContent = 'Press Start to send traffic. Throttling, recovery and your actions show up here.';
        list.replaceChildren(li);
        return;
    }
    list.replaceChildren(
        ...events.slice(0, 6).map((e) => {
            const li = document.createElement('li');
            const time = document.createElement('time');
            time.textContent = `${e.t.toFixed(1)}`;
            const span = document.createElement('span');
            span.textContent = e.text;
            li.append(time, span);
            return li;
        }),
    );
}

function renderRunState() {
    const labels = { running: 'Running', paused: 'Paused', stopped: 'Stopped' };
    $('run-state').dataset.state = sim.state;
    $('run-label').textContent = labels[sim.state];
    $('btn-start').textContent = sim.state === 'stopped' ? (sim.startedAt ? 'Restart' : 'Start') : 'Restart';
    $('btn-pause').textContent = sim.state === 'paused' ? 'Resume' : 'Pause';
    $('btn-pause').disabled = sim.state === 'stopped';
    $('btn-stop').disabled = sim.state === 'stopped';
    for (const id of ['btn-burst', 'btn-hold', 'btn-clear', 'btn-reset-backoff']) {
        $(id).disabled = sim.state !== 'running';
    }
}

function frame() {
    const t = now();
    renderQueue(t);
    renderHull(t);
    renderService(t);
    if (sim.startedAt) {
        const end = sim.state === 'stopped' ? sim.stoppedAt : t;
        $('run-clock').textContent = `${((end - sim.startedAt) / 1000).toFixed(1)} s`;
    }
    requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const tooltip = $('tooltip');
const charts = {
    slots: createChart(
        $('chart-slots'),
        {
            series: [
                { key: 'running', label: 'Running', color: '--ink', fill: true },
                { key: 'limit', label: 'Limit', color: '--ink-3', dash: [5, 4], step: true },
                { key: 'target', label: 'Target', color: '--ink-3', dash: [1, 4], step: true },
            ],
        },
        tooltip,
    ),
    queue: createChart(
        $('chart-queue'),
        {
            series: [
                { key: 'waiting', label: 'Waiting', color: '--ink', fill: true },
                { key: 'queueLimit', label: 'Queue limit', color: '--ink-3', dash: [5, 4], step: true },
            ],
        },
        tooltip,
    ),
    outcomes: createChart(
        $('chart-outcomes'),
        {
            series: [
                { key: 'completed', label: 'Completed', color: '--series-1' },
                { key: 'turnedAway', label: 'Turned away', color: '--series-2' },
            ],
            unit: '/s',
        },
        tooltip,
    ),
};

$('btn-start').addEventListener('click', () => {
    if (sim.state !== 'stopped') stop();
    start();
});
$('btn-pause').addEventListener('click', () => (sim.state === 'paused' ? resume() : pause()));
$('btn-stop').addEventListener('click', stop);
$('btn-burst').addEventListener('click', () => {
    for (let i = 0; i < settings.burstSize; i++) submit();
    log(`Burst of ${settings.burstSize} requests`);
});
$('btn-hold').addEventListener('click', () => {
    bulkhead.pause(3000);
    sim.holdUntil = now() + 3000;
    log('Dispatch held for 3 s');
});
$('btn-clear').addEventListener('click', () => {
    const n = bulkhead.clearQueue();
    log(`Cleared ${n} waiting ${n === 1 ? 'request' : 'requests'}`);
});
$('btn-reset-backoff').addEventListener('click', () => {
    bulkhead.resetAdaptive();
    log(`Backoff reset: limit back to ${bulkhead.concurrency}`);
});

const THEME_KEY = 'bulkhead-simulator-theme';
function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try {
        localStorage.setItem(THEME_KEY, theme);
    } catch {
        /* storage unavailable: theme lasts for this visit */
    }
    for (const chart of Object.values(charts)) chart.redraw();
}
$('btn-theme').addEventListener('click', () => {
    const current =
        document.documentElement.dataset.theme ||
        (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    setTheme(current === 'dark' ? 'light' : 'dark');
});
try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved) document.documentElement.dataset.theme = saved;
} catch {
    /* ignore */
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    for (const chart of Object.values(charts)) chart.redraw();
});
$('data-table')
    .closest('details')
    .addEventListener('toggle', (e) => e.target.open && renderTable());

renderPresets();
renderControls();
resetStats();
applyPreset('steady');
syncAllControls();
renderRunState();
renderTiles();
requestAnimationFrame(frame);

// Exposed for tinkering from the devtools console.
Object.defineProperty(window, 'bulkhead', { get: () => bulkhead });

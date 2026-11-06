// Minimal canvas line charts for the simulator: one y-axis, 2px lines,
// recessive grid, crosshair tooltip on hover.

const WINDOW_MS = 60_000;
const PAD = { top: 8, right: 10, bottom: 20, left: 34 };

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function niceMax(value) {
    if (value <= 4) return 4;
    const exp = 10 ** Math.floor(Math.log10(value));
    for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
        if (m * exp >= value) return m * exp;
    }
    return 10 * exp;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ series: Array<{ key: string, label: string, color: string, dash?: number[], step?: boolean, fill?: boolean }>, unit?: string }} spec
 *   `color` is a CSS custom property name, resolved on every draw so theme switches apply.
 * @param {HTMLElement} tooltip
 */
export function createChart(canvas, spec, tooltip) {
    const ctx = canvas.getContext('2d');
    let samples = [];
    let hoverX = null;
    let geometry = null;

    const resize = () => {
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(canvas.clientWidth * dpr);
        canvas.height = Math.round(canvas.clientHeight * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        draw();
    };
    new ResizeObserver(resize).observe(canvas);

    canvas.addEventListener('pointermove', (e) => {
        hoverX = e.offsetX;
        draw();
    });
    canvas.addEventListener('pointerleave', () => {
        hoverX = null;
        tooltip.hidden = true;
        draw();
    });

    function draw() {
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (!w || !h) return;
        ctx.clearRect(0, 0, w, h);

        const plotW = w - PAD.left - PAD.right;
        const plotH = h - PAD.top - PAD.bottom;
        const end = samples.length ? samples[samples.length - 1].t : 0;
        const start = Math.max(0, end - WINDOW_MS);
        const span = Math.max(end - start, 10_000);
        let max = 0;
        for (const s of samples) {
            if (s.t < start) continue;
            for (const series of spec.series) {
                const v = s[series.key];
                if (Number.isFinite(v)) max = Math.max(max, v);
            }
        }
        const yMax = niceMax(max);
        const x = (t) => PAD.left + ((t - start) / span) * plotW;
        const y = (v) => PAD.top + plotH - (v / yMax) * plotH;
        geometry = { start, span, plotW, x };

        // grid + axis labels (recessive)
        ctx.font = `12px ${css('--font')}`;
        ctx.fillStyle = css('--ink-3');
        ctx.strokeStyle = css('--rule');
        ctx.lineWidth = 1;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'right';
        for (const v of [0, yMax / 2, yMax]) {
            const yy = Math.round(y(v)) + 0.5;
            ctx.beginPath();
            ctx.moveTo(PAD.left, yy);
            ctx.lineTo(w - PAD.right, yy);
            ctx.stroke();
            ctx.fillText(formatNumber(v), PAD.left - 6, yy);
        }
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        const ticks = 4;
        for (let i = 0; i <= ticks; i++) {
            const t = start + (span * i) / ticks;
            const ago = Math.round((end - t) / 1000);
            const label = i === ticks ? 'now' : `${ago} s ago`;
            ctx.textAlign = i === 0 ? 'left' : i === ticks ? 'right' : 'center';
            ctx.fillText(label, x(t), h - 4);
        }

        // series
        const visible = samples.filter((s) => s.t >= start);
        for (const series of spec.series) {
            const color = css(series.color);
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.setLineDash(series.dash ?? []);
            ctx.beginPath();
            let started = false;
            let prev = null;
            for (const s of visible) {
                const v = s[series.key];
                if (!Number.isFinite(v)) {
                    started = false;
                    prev = null;
                    continue;
                }
                const px = x(s.t);
                const py = y(v);
                if (!started) {
                    ctx.moveTo(px, py);
                    started = true;
                } else if (series.step && prev) {
                    ctx.lineTo(px, prev.py);
                    ctx.lineTo(px, py);
                } else {
                    ctx.lineTo(px, py);
                }
                prev = { px, py };
            }
            ctx.stroke();
            ctx.setLineDash([]);

            if (series.fill && visible.length > 1) {
                ctx.lineTo(x(visible[visible.length - 1].t), y(0));
                ctx.lineTo(x(visible[0].t), y(0));
                ctx.closePath();
                ctx.globalAlpha = 0.08;
                ctx.fillStyle = color;
                ctx.fill();
                ctx.globalAlpha = 1;
            }
        }

        // hover crosshair + tooltip
        if (hoverX !== null && visible.length) {
            const t = start + ((hoverX - PAD.left) / plotW) * span;
            let nearest = visible[0];
            for (const s of visible) if (Math.abs(s.t - t) < Math.abs(nearest.t - t)) nearest = s;
            const px = x(nearest.t);
            ctx.strokeStyle = css('--rule-strong');
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(Math.round(px) + 0.5, PAD.top);
            ctx.lineTo(Math.round(px) + 0.5, PAD.top + plotH);
            ctx.stroke();
            const surface = css('--panel');
            for (const series of spec.series) {
                const v = nearest[series.key];
                if (!Number.isFinite(v)) continue;
                ctx.beginPath();
                ctx.arc(px, y(v), 4, 0, Math.PI * 2);
                ctx.fillStyle = css(series.color);
                ctx.fill();
                ctx.lineWidth = 2;
                ctx.strokeStyle = surface;
                ctx.stroke();
            }
            showTooltip(nearest, end);
        }
    }

    function showTooltip(sample, end) {
        const ago = (end - sample.t) / 1000;
        const time = document.createElement('div');
        time.className = 'tooltip-time';
        time.textContent = ago < 0.5 ? 'Now' : `${ago.toFixed(1)} s ago`;
        const rows = spec.series.map((s) => {
            const v = sample[s.key];
            const row = document.createElement('div');
            row.className = 'tooltip-row';
            const label = document.createElement('span');
            label.textContent = s.label;
            const value = document.createElement('strong');
            value.textContent = Number.isFinite(v) ? `${formatNumber(v)}${spec.unit ?? ''}` : 'none';
            row.append(label, value);
            return row;
        });
        tooltip.replaceChildren(time, ...rows);
        tooltip.hidden = false;
        const rect = canvas.getBoundingClientRect();
        const left = rect.left + geometry.x(sample.t) + 14;
        const top = rect.top + 8;
        const maxLeft = window.innerWidth - tooltip.offsetWidth - 8;
        tooltip.style.left = `${left > maxLeft ? rect.left + geometry.x(sample.t) - tooltip.offsetWidth - 14 : left}px`;
        tooltip.style.top = `${top}px`;
    }

    return {
        update(next) {
            samples = next;
            draw();
        },
        redraw: draw,
    };
}

export function formatNumber(v) {
    if (v >= 1000) return `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k`;
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

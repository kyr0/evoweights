/** Hero schematic of one EvoWeights generation, in the order of the method (paper §method):
 * variation (mutants of the parent) → race (scores on shared seeds; the three best are finalists) → candidate (the best finalist,
 * or the crossing of the three finalists: agreeing moves kept, opposing ones cancel) → validation against the parent on fresh seeds
 * (kept only at paired t ≥ 2) → inheritance (the child becomes the parent). After STALL generations without a child the run has
 * reached a local optimum and stops; it can be repeated. Illustrative only: grids, scores, t values and noise are synthetic. */
// A module (loaded with type="module"), so its declarations stay out of the global scope.
export {};
// Every figure.evo-plate on the page runs its own copy (the website hero; the deck has it on two slides). Parts are found by data-evo.
for (const fig of document.querySelectorAll('.evo-plate'))
    plate(fig);
function plate(fig) {
    const $ = (key) => fig.querySelector('[data-evo="' + key + '"]');
    const found = $('canvas');
    if (!found)
        return;
    const context = found.getContext('2d');
    if (!context)
        return;
    // Re-bound after the checks so the hoisted drawing functions below see them as present.
    const canvas = found, ctx = context;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const COLS = 12, ROWS = 9, N = COLS * ROWS, MUTANTS = 6, FINALISTS = 3, T_GATE = 2, T_MAX = 4, STALL = 24, FLASH = 4;
    const FAST = 210, SLOW = 4200; // ms per generation; slow motion is 20× slower
    const UP = '#b6a4fc', DOWN = '#65d3bc', INK = '#edefef', QUIET = '#9aa0ad';
    const FONT = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace', BIG = '700 17px ui-monospace, SFMono-Regular, Menlo, monospace';
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    let seed = 7, run = 0;
    const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(2 * Math.PI * rand());
    let parent, shown, age, sign, quality, generation, tried, kept, lastKept, lineage, mutants, finalists, cand, decided, done;
    let cycleStart = 0, cycleMs = FAST, visible = true, restartTimer = 0;
    function reset() {
        seed = 7 + 7919 * run++;
        parent = Array.from({ length: N }, () => Math.round(clamp(gauss() * 2.6, -7, 7)));
        shown = parent.slice();
        age = new Array(N).fill(FLASH);
        sign = new Array(N).fill(0);
        quality = 0.3;
        generation = 1;
        tried = 0;
        kept = 0;
        lastKept = 0;
        done = false;
        lineage = [{ gen: 0, fit: quality }];
        spawn();
        renderLineage();
    }
    function spawn() {
        mutants = Array.from({ length: MUTANTS }, () => {
            const w = parent.slice(), moved = new Map();
            for (let i = 0; i < N; i++)
                if (rand() < 0.12) {
                    const d = rand() < 0.5 ? -2 : 2, v = clamp(w[i] + d, -7, 7);
                    if (v !== w[i]) {
                        moved.set(i, Math.sign(v - w[i]));
                        w[i] = v;
                    }
                }
            // Gains shrink as the parent improves: the search runs into a local optimum.
            const effect = gauss() * 0.06 * (1 - quality) - 0.008, score = clamp(quality + effect + gauss() * 0.03, 0.02, 0.99);
            return { w, moved, effect, score };
        });
        // Race: the three best scores are the finalists. Crossing: their moves fused, agreeing moves kept and opposing ones cancelled.
        finalists = mutants
            .slice()
            .sort((a, b) => b.score - a.score)
            .slice(0, FINALISTS);
        const w = parent.slice(), moved = new Map();
        for (let i = 0; i < N; i++) {
            const d = finalists.map((f) => f.moved.get(i)).filter((x) => Boolean(x));
            if (d.length && d.every((x) => x === d[0])) {
                const v = clamp(w[i] + 2 * d[0], -7, 7);
                if (v !== w[i]) {
                    moved.set(i, d[0]);
                    w[i] = v;
                }
            }
        }
        const crossEffect = 0.55 * finalists.reduce((a, f) => a + Math.max(f.effect, 0), 0) - 0.01 + gauss() * 0.01;
        const crossing = {
            w,
            moved,
            effect: crossEffect,
            score: clamp(quality + crossEffect + gauss() * 0.03, 0.02, 0.99),
            crossing: true,
        };
        // Candidate: whichever of the best finalist and the crossing does better on the deciding seeds.
        const best = crossing.score > finalists[0].score ? crossing : finalists[0];
        // Validation against the parent on fresh seeds: paired t of the true effect plus seed noise.
        cand = Object.assign(best, { t: best.effect / 0.018 + gauss() * 0.9 });
        tried += MUTANTS;
        decided = false;
    }
    const shade = (level) => {
        const t = (level + 7) / 14, c = (x) => Math.round(46 + t * x);
        return `rgb(${c(92)},${c(96)},${c(110)})`;
    };
    function grid(w, x, y, cell, moved, alpha = 1) {
        ctx.globalAlpha = alpha;
        for (let i = 0; i < N; i++) {
            const m = moved?.get(i) ?? 0;
            ctx.fillStyle = m > 0 ? UP : m < 0 ? DOWN : shade(w[i]);
            ctx.fillRect(x + (i % COLS) * cell, y + Math.floor(i / COLS) * cell, cell - 1, cell - 1);
        }
        ctx.globalAlpha = 1;
    }
    // The parent: inherited weights light up in the raised/lowered colours and fade over FLASH generations.
    function parentGrid(x, y, cell) {
        for (let i = 0; i < N; i++) {
            const cx = x + (i % COLS) * cell, cy = y + Math.floor(i / COLS) * cell;
            ctx.fillStyle = shade(shown[i]);
            ctx.fillRect(cx, cy, cell - 1, cell - 1);
            if (age[i] < FLASH) {
                ctx.globalAlpha = 1 - age[i] / FLASH;
                ctx.fillStyle = sign[i] > 0 ? UP : DOWN;
                ctx.fillRect(cx, cy, cell - 1, cell - 1);
                ctx.globalAlpha = 1;
            }
        }
    }
    function bar(x, y, w, value, threshold, color) {
        ctx.fillStyle = '#343846';
        ctx.fillRect(x, y, w, 4);
        ctx.fillStyle = color;
        ctx.fillRect(x, y, w * value, 4);
        ctx.fillStyle = INK;
        ctx.fillRect(x + w * clamp(threshold, 0, 1), y - 3, 1.5, 10);
    }
    function label(text, x, y, color = QUIET, align = 'left') {
        ctx.fillStyle = color;
        ctx.textAlign = align;
        ctx.fillText(text, x, y);
    }
    // A status badge on a solid dark background, so it never mixes with what lies underneath.
    function badge(text, x, y, color, align = 'right') {
        const w = ctx.measureText(text).width + 8, left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
        ctx.fillStyle = '#0d0f14';
        ctx.fillRect(left, y - 9, w, 12);
        ctx.fillStyle = color;
        ctx.textAlign = 'left';
        ctx.fillText(text, left + 4, y);
    }
    function draw(now) {
        const W = canvas.clientWidth, H = canvas.clientHeight, dpr = devicePixelRatio || 1;
        if (canvas.width !== Math.round(W * dpr)) {
            canvas.width = Math.round(W * dpr);
            canvas.height = Math.round(H * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        ctx.font = FONT;
        ctx.textBaseline = 'alphabetic';
        const phase = reduced ? 0.7 : done ? 1 : Math.min(1, (now - cycleStart) / cycleMs);
        const pc = Math.floor(Math.min((W * 0.36) / COLS, (H - 76) / ROWS)), px = 2, py = 18, pw = COLS * pc;
        // Timeline of one generation: race scores fill, finalists, candidate, validation against the parent, then inheritance.
        const fill = clamp((phase - 0.1) / 0.3, 0, 1), finalsOn = phase > 0.42, candOn = phase > 0.52, val = clamp((phase - 0.58) / 0.2, 0, 1);
        if (!decided && phase > 0.78) {
            decided = true;
            if (cand.t >= T_GATE) {
                kept++;
                cand.kept = true;
            }
        }
        // The grid shows the model the mutants come from: the base model until the first child is kept, then the newest child.
        label(kept ? 'CHILD · GEN ' + lastKept.toLocaleString('en-US') : 'BASE MODEL', px, 11, INK);
        parentGrid(px, py, pc);
        const top = py + ROWS * pc + 10;
        label('METRIC', px, top + 4);
        bar(px + 44, top, pw - 44, quality, quality, '#8c83a1');
        // Validation row: the candidate's paired t against the parent on fresh seeds, with the gate at t = 2.
        label('VALIDATION', px, top + 20);
        const vx = px + 66, vw = pw - 66 - 34, shownT = clamp(cand.t, 0, T_MAX) * val;
        ctx.fillStyle = '#343846';
        ctx.fillRect(vx, top + 16, vw, 4);
        ctx.fillStyle = decided ? (cand.kept ? UP : '#777e89') : '#8c83a1';
        ctx.fillRect(vx, top + 16, (vw * shownT) / T_MAX, 4);
        ctx.fillStyle = INK;
        ctx.fillRect(vx + (vw * T_GATE) / T_MAX, top + 13, 1.5, 10);
        if (val > 0 && !done)
            label('t ' + (cand.t * val).toFixed(1), px + pw, top + 20, decided ? (cand.kept ? UP : INK) : QUIET, 'right');
        label('GENERATION', px, top + 38);
        ctx.font = BIG;
        label(generation.toLocaleString('en-US'), px + pw, top + 40, INK, 'right');
        ctx.font = FONT;
        const gx = px + pw + 18, mw = (W - gx - 2) / 3, mc = Math.floor(Math.min((mw - 10) / COLS, (H / 2 - 26) / ROWS));
        mutants.forEach((m, k) => {
            const x = gx + (k % 3) * mw, y = 11 + Math.floor(k / 3) * (H / 2);
            const pop = clamp(phase / 0.1, 0, 1), finalist = finalists.includes(m), isCand = m === cand, out = finalsOn && !finalist;
            const name = 'MUTANT ' + (k + 1);
            label(name, x, y, isCand && candOn ? (decided ? (m.kept ? UP : INK) : INK) : finalsOn && finalist ? INK : QUIET);
            grid(m.w, x, y + 6, mc, m.moved, pop * (out || done ? 0.3 : 1));
            bar(x, y + 12 + ROWS * mc, COLS * mc, m.score * fill, quality, isCand && candOn ? (decided && m.kept ? UP : '#a49bbb') : finalsOn && finalist ? '#8c83a1' : '#5c6270');
            // Finalists are marked inside their grid (top-left), so the title row keeps its width.
            if (finalsOn && finalist && !done)
                badge('FINALIST', x, y + 16, isCand && candOn ? INK : '#c6bed8', 'left');
            if (isCand && candOn && !done)
                badge(decided ? (m.kept ? 'KEPT' : 'REJECTED') : val > 0 ? 'VALIDATING' : 'CANDIDATE', x + (COLS * mc) / 2, y + 10 + (ROWS * mc) / 2, decided && m.kept ? UP : INK, 'center');
        });
        // The crossing is not one of the six mutants: its badge sits between the finalists' rows.
        if (cand.crossing && candOn && !done) {
            const ids = finalists
                .map((f) => mutants.indexOf(f) + 1)
                .sort((a, b) => a - b)
                .join(' × ');
            badge((decided ? (cand.kept ? 'KEPT · ' : 'REJECTED · ') : val > 0 ? 'VALIDATING · ' : 'CANDIDATE · ') +
                'CROSSING ' +
                ids, gx + (W - gx) / 2, H / 2 + 2, decided && cand.kept ? UP : INK, 'center');
        }
        // Inheritance: the kept candidate's moves are copied into the parent grid.
        if (decided && cand.kept && phase > 0.8) {
            const s = clamp((phase - 0.8) / 0.15, 0, 1);
            for (const [i, d] of cand.moved)
                if (shown[i] !== cand.w[i] && rand() < s) {
                    shown[i] = cand.w[i];
                    age[i] = 0;
                    sign[i] = d;
                }
        }
        if (done) {
            const cx = gx + (W - gx) / 2, cy = H / 2;
            ctx.fillStyle = 'rgba(13,15,20,.86)';
            ctx.fillRect(gx - 6, cy - 34, W - gx + 6, 76);
            ctx.font = '700 13px ui-monospace, SFMono-Regular, Menlo, monospace';
            label('LOCAL OPTIMUM REACHED', cx, cy - 14, UP, 'center');
            ctx.font = FONT;
            label('no validated child in ' + STALL + ' generations', cx, cy + 1, INK, 'center');
        }
        $('tried').textContent = tried.toLocaleString('en-US');
        $('kept').textContent = String(kept);
    }
    // Base model → (earlier children) → parent → child, then the local optimum.
    const list = $('lineage'), repeat = $('repeat');
    function renderLineage() {
        if (!list)
            return;
        const item = (role, e) => {
            const li = document.createElement('li'), b = document.createElement('b'), s = document.createElement('span');
            b.textContent = role;
            s.textContent = (e.gen ? 'gen ' + e.gen : 'start') + ' · ' + Math.round(e.fit * 100) + ' %';
            li.append(b, s);
            return li;
        };
        const n = lineage.length, items = [item('Base model', lineage[0])];
        if (n > 3) {
            const li = document.createElement('li'), s = document.createElement('span');
            li.className = 'evo-gap';
            li.title = n - 3 + ' earlier ' + (n - 3 === 1 ? 'child' : 'children');
            s.textContent = '+' + (n - 3);
            li.append(s);
            items.push(li);
        }
        if (n > 2)
            items.push(item('Parent', lineage[n - 2]));
        if (n > 1)
            items.push(item('Child', lineage[n - 1]));
        list.replaceChildren(...items);
        if (done) {
            const li = document.createElement('li'), b = document.createElement('b'), s = document.createElement('span');
            li.className = 'evo-optimum';
            b.textContent = 'Local opt.';
            li.title = 'Local optimum';
            s.textContent = lineage.length - 1 + ' children';
            li.append(b, s);
            list.append(li);
        }
        if (repeat)
            repeat.hidden = !done;
    }
    function next() {
        if (cand?.kept) {
            for (const [i, d] of cand.moved) {
                if (age[i] >= FLASH || shown[i] !== cand.w[i]) {
                    age[i] = 0;
                    sign[i] = d;
                }
            }
            parent = cand.w.slice();
            quality = clamp(quality + Math.max(cand.effect, 0), 0, 0.97);
            lastKept = generation;
            lineage.push({ gen: generation, fit: quality });
            renderLineage();
        }
        shown = parent.slice();
        for (let i = 0; i < N; i++)
            age[i]++;
        if (generation - lastKept >= STALL) {
            done = true;
            renderLineage();
            return;
        }
        generation++;
        spawn();
    }
    reset();
    if (reduced) {
        decided = false;
        draw(0);
    }
    else {
        new IntersectionObserver(([e]) => {
            visible = e.isIntersecting;
        }).observe(canvas);
        const loop = (now) => {
            if (!cycleStart)
                cycleStart = now;
            if (visible && !document.hidden) {
                if (!done && now - cycleStart >= cycleMs) {
                    cycleStart = now;
                    next();
                }
                draw(now);
                // Without a repeat button (the deck), the run starts over after a pause.
                if (done && !repeat && !restartTimer)
                    restartTimer = setTimeout(() => {
                        restartTimer = 0;
                        reset();
                        cycleStart = performance.now();
                    }, 4000);
            }
            requestAnimationFrame(loop);
        };
        repeat?.addEventListener('click', () => {
            reset();
            cycleStart = performance.now();
        });
        // Slow motion: the same cycle at 20× the duration; the current phase is kept when switching.
        const slow = $('slow');
        slow?.addEventListener('click', () => {
            const now = performance.now(), p = Math.min(1, (now - cycleStart) / cycleMs);
            cycleMs = cycleMs === FAST ? SLOW : FAST;
            cycleStart = now - p * cycleMs;
            slow.setAttribute('aria-pressed', String(cycleMs === SLOW));
        });
        requestAnimationFrame(loop);
    }
}

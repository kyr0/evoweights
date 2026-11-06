import { openRevisionStore, revisionId, } from '../revisions/store.js';
import { referenceGain, rankReferences, validReference, REFERENCE, } from '../revisions/reference.js';
import { sha256 } from '../shared/sha256.js';
import { TRUST } from '../revisions/trust.js';
import { moduleUrl, siteUrl } from '../shared/site.js';
// Training provenance: every file that decides how a learning run plays and selects, fingerprinted once per page.
const CODE_FILES = [
    'training/edno.js',
    'training/live-es.js',
    'training/original-reference.js',
    'workers/training-worker.js',
    'workers/training-lane.js',
    'training/lane-pool.js',
    'revisions/reference.js',
    'revisions/store.js',
    'app/revisions-panel.js',
    'policy/decision-policy.js',
    'tactical/tactical.js',
    'tactical/combat-approach.js',
    'tactical/approach-memory.js',
    'tactical/facing-guard.js',
    'engine/arena.js',
    'engine/arena.wasm',
    // HYPOTHESIS: sprite pixels feed the threat-mask observations, so the WAD is part of what produced a measurement
    // (falsifier: a WAD-only change that leaves every reference record identical).
    'engine/arena.wad.gz',
    'model/kumo.js',
    'model/policy-simd.wasm',
];
let codePrint = null;
function codeFingerprint() {
    return (codePrint ??= (async () => {
        const files = {};
        for (const f of CODE_FILES) {
            try {
                const r = await fetch(siteUrl(f));
                files[f] = r.ok ? await sha256(new Uint8Array(await r.arrayBuffer())) : null;
            }
            catch {
                files[f] = null;
            }
        }
        return {
            files,
            modelManifestSHA256: TRUST.bases.w4.sha256,
            combinedSHA256: await sha256(new TextEncoder().encode(JSON.stringify(files))),
        };
    })());
}
function environment() {
    const n = globalThis.navigator || {};
    return {
        userAgent: n.userAgent ?? null,
        platform: n.userAgentData?.platform ?? n.platform ?? null,
        hardwareConcurrency: n.hardwareConcurrency ?? null,
        deviceMemoryGB: n.deviceMemory ?? null,
        language: n.language ?? null,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
        crossOriginIsolated: globalThis.crossOriginIsolated ?? null,
    };
}
/** A panel element the code reads without a null check (always in index.html), typed by the caller. */
const $ = (id) => document.getElementById(id);
/** An element the code null-checks before use. */
const $maybe = (id) => document.getElementById(id);
/** A descendant of markup this code has just rendered, typed by the caller. */
const $in = (root, selector) => root.querySelector(selector);
/** Whether `value` is one of `options` (a saved preference or a select value). */
function oneOf(options, value) {
    const list = options;
    return list.includes(value);
}
const selectionKey = 'agm-arena-choice-v8', trainingParentKey = 'agm-arena-training-parent-v1', activeKey = 'agm-arena-playing-v8', importKey = 'agm-arena-imports-v8', lanesKey = 'agm-arena-lanes-v9', collapsedKey = 'agm-arena-tree-collapsed-v9', referenceKey = REFERENCE.cacheKey;
const MAX_LANES = 32;
function laneLimit() {
    const n = Number(globalThis.navigator?.hardwareConcurrency);
    return Math.max(1, Math.min(MAX_LANES, Number.isFinite(n) && n > 0 ? Math.floor(n) : 1));
}
function read(key) {
    try {
        return localStorage.getItem(key);
    }
    catch {
        return null;
    }
}
function save(key, value) {
    try {
        localStorage.setItem(key, value);
    }
    catch {
        /* Storage permission is optional for UI preferences. */
    }
}
function importedIds() {
    try {
        return new Set(JSON.parse(read(importKey) || '[]'));
    }
    catch {
        return new Set();
    }
}
function short(id) {
    return String(id || '').slice(-8);
}
function name(record) {
    return (record?.name ||
        (record?.kind === 'original'
            ? 'Original FP32'
            : record?.kind === 'shipped'
                ? 'Astra 6 Weight-Space Programming'
                : record?.kind === 'base'
                    ? '4-bit base'
                    : 'Model'));
}
// Shipped children of the 4-bit roots: kind label and source per built-in key.
const RELEASES = {
    survivor: [
        'EvoWeights · built-in',
        'experiments/v11/edno-neutral-browser (historical DOOM experiment, survival metric, R3)',
    ],
    terminator: [
        'EvoWeights · built-in',
        'experiments/v11/edno-neutral-browser (historical DOOM experiment, hugs metric, R4)',
    ],
    opus: ['Opus edit · built-in', 'experiments/v12/independent-edit (independent edit by Claude Opus 5.5)'],
};
/** A built-in revision by its key (`shipped`, `neutral`, a release key, …); undefined for keys the store does not ship. */
function builtinOf(builtins, key) {
    if (!builtins || key === undefined)
        return undefined;
    const isKey = (k) => Object.hasOwn(builtins, k);
    return isKey(key) ? builtins[key] : undefined;
}
const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ENTITIES[c]);
function renderName(record) {
    return name(record);
}
function notify(text, error = false) {
    const p = $('revision-notice');
    p.textContent = text;
    p.dataset.error = String(error);
}
function errorText(e) {
    const x = e;
    return x?.code === 'STALE_PARENT'
        ? 'The training base was changed in another tab. The model saved there is kept.'
        : x?.message || String(e);
}
// Retain a real download link after async assembly; a second click also works on
// browsers that require fresh user activation for downloading a large Blob.
function download(blob, file) {
    const link = $('revision-save-file');
    if (link.href.startsWith('blob:'))
        URL.revokeObjectURL(link.href);
    link.href = URL.createObjectURL(blob);
    link.download = file;
    link.textContent = 'Save weight file · ' + file;
    link.hidden = false;
    link.click();
}
export function installRevisions({ activate, pauseGame, isBenchmarking, onActivity, trainingFrame = () => { }, trainingView = () => { }, }) {
    const select = $('revision-select'), file = $('revision-file'), laneSelect = $('revision-lanes'), maxLanes = laneLimit();
    laneSelect.replaceChildren(...Array.from({ length: maxLanes }, (_, i) => {
        const opt = document.createElement('option');
        opt.value = String(i + 1);
        opt.textContent = String(i + 1) + (i + 1 === maxLanes ? ' (all)' : '');
        return opt;
    }));
    const savedLanes = Number(read(lanesKey));
    laneSelect.value = String(Number.isInteger(savedLanes) && savedLanes >= 1 && savedLanes <= maxLanes ? savedLanes : maxLanes);
    laneSelect.addEventListener('change', () => save(lanesKey, laneSelect.value));
    function lanes() {
        const n = Number(laneSelect.value);
        return Number.isInteger(n) && n >= 1 ? Math.min(n, maxLanes) : maxLanes;
    }
    // Mutation selection: automatic (coverage-weighted, widens on stagnation), uniform small or uniform large steps.
    const mutationSelect = $maybe('revision-mutation'), mutationKey = 'agm-arena-mutation-v11';
    if (mutationSelect) {
        const saved = read(mutationKey);
        if (oneOf(['auto', 'uniform', 'broad'], saved))
            mutationSelect.value = saved;
        mutationSelect.addEventListener('change', () => save(mutationKey, mutation()));
    }
    function mutation() {
        const v = mutationSelect?.value;
        return oneOf(['auto', 'uniform', 'broad'], v) ? v : 'broad';
    }
    // The protocol-6 search reads the same choice as its diversity profile.
    function diversity() {
        return { auto: 'balanced', uniform: 'focused', broad: 'broad' }[mutation()];
    }
    // Training priority: survival-first (default) or kills-first weights and gate metric.
    const prioritySelect = $maybe('revision-priority'), priorityKey = 'agm-arena-priority-v9';
    if (prioritySelect) {
        const saved = read(priorityKey);
        if (oneOf(['survival', 'kills'], saved))
            prioritySelect.value = saved;
        prioritySelect.addEventListener('change', () => save(priorityKey, priority()));
    }
    function priority() {
        return prioritySelect?.value === 'kills' ? 'kills' : 'survival';
    }
    // Method: EDNO with race selection and crossing (default), the adaptive strategy, or block evidence. The protocol-6 search and
    // "race + prune" (race-prune) stay in the modules for reproducing their experiments but are not offered: neither gained on
    // held-out seeds, and per-promotion attribution only slowed runs down (on demand: "Measure causes" in the explorer).
    const methods = ['edno-race', 'edno-adaptive', 'edno-evidence'], searchSelect = $maybe('revision-search'), searchHint = $maybe('revision-search-hint');
    const methodHints = {
        'edno-race': 'Each generation plays 48 mirrored directions. The best ones race against the parent on shared seeds, their crossing races with them, and the winner is validated on fresh seeds.',
        'edno-adaptive': 'Before each generation a bandit chooses between race · large, evidence · automatic and race · automatic: whichever combination has so far been most likely, per game, to lead to a promotion. The mutation size setting does not apply.',
        'edno-evidence': 'Each mirrored game pair credits its effect to every parameter block it changed. Only blocks with t ≥ 2 after at least eight measurements are proposed, followed by the same validation.',
    };
    const showMethodHint = () => {
        if (searchHint)
            searchHint.textContent = methodHints[searchSelect?.value ?? ''] ?? methodHints['edno-race'];
    };
    if (searchSelect) {
        const saved = read('agm-arena-search-v11');
        if (oneOf(methods, saved))
            searchSelect.value = saved;
        showMethodHint();
        searchSelect.addEventListener('change', () => {
            save('agm-arena-search-v11', searchSelect.value);
            showMethodHint();
            controls();
        });
    }
    // Mutation size and main goal: one short description for the selected value.
    const hintFor = (selectId, hintId, texts) => {
        const sel = $maybe(selectId), hint = $maybe(hintId);
        if (!sel || !hint)
            return;
        const show = () => {
            hint.textContent = texts[sel.value] ?? '';
        };
        show();
        sel.addEventListener('change', show);
    };
    hintFor('revision-mutation', 'revision-mutation-hint', {
        broad: 'Moves 50 % of the parameter blocks by two levels.',
        auto: 'Starts with 15 % of the blocks by one level, prefers rarely tested blocks and grows after four generations without a child.',
        uniform: 'Moves 15 % of the parameter blocks by one level.',
    });
    hintFor('revision-priority', 'revision-priority-hint', {
        survival: 'The check compares survival time; one second counts as much as 2.5 hugs.',
        kills: 'The check compares hugs (fed or befriended); one hug counts as much as eight seconds.',
    });
    function learning() {
        const method = oneOf(methods, searchSelect?.value) ? searchSelect.value : 'edno-race';
        return { method: 'edno', selection: method.slice(5), mode: mutation(), ties: false, attribution: false };
    }
    // Assigned once the store opens (`ready`); code that may run earlier checks it, the rest runs only once rows exist.
    let registry;
    let rows = [], tip = null, active = null, selectedId = read(selectionKey), trainingParentId = read(trainingParentKey), seenImports = importedIds(), job = null, fileBusy = false, refreshSerial = 0, channel = null;
    // Virtual W4 bases are listed but not stored; only stored revisions can be deleted. A delete needs a second click within six seconds.
    let virtualIds = new Set(), pendingDelete = null;
    const option = () => rows.find((r) => r.id === select.value);
    const p = (id) => rows.find((r) => r.id === id);
    // Any W4 revision can become the training base: a learned child, an imported branch or a bare W4 base starts its own lineage.
    function canAdopt(r) {
        return r?.precision === 'w4' && !!tip && r.id !== tip.id;
    }
    function lineageRoot(record) {
        const visited = new Set();
        for (let node = record; node && !visited.has(node.id); node = p(node.parentId)) {
            visited.add(node.id);
            if (node.kind !== 'learned')
                return node.precision === 'w4' ? node : null;
        }
        return null;
    }
    function collapsedIds() {
        try {
            return new Set(JSON.parse(read(collapsedKey) || '[]'));
        }
        catch {
            return new Set();
        }
    }
    const kindOrder = { original: 0, shipped: 1, base: 2, learned: 3 };
    function childrenMap() {
        const children = new Map();
        for (const r of rows) {
            const list = children.get(r.parentId) || [];
            list.push(r);
            children.set(r.parentId, list);
        }
        for (const list of children.values())
            list.sort((a, b) => (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9) ||
                name(a).localeCompare(name(b), 'en') ||
                a.id.localeCompare(b.id));
        return children;
    }
    // Depth-first order with indentation, shared by the tree grid and every revision selector.
    function treeOrder() {
        const children = childrenMap(), out = [];
        const walk = (r, depth, last) => {
            out.push({ record: r, depth, prefix: depth ? '\u2007'.repeat(2 * (depth - 1)) + (last ? '└ ' : '├ ') : '' });
            const kids = children.get(r.id) || [];
            kids.forEach((k, i) => walk(k, depth + 1, i === kids.length - 1));
        };
        for (const root of children.get(null) || [])
            walk(root, 0, true);
        return out;
    }
    function treeOption(entry, label = name(entry.record)) {
        const opt = document.createElement('option');
        opt.value = entry.record.id;
        opt.textContent = entry.prefix + label;
        return opt;
    }
    // Signed t statistic with a typographic minus.
    function tStat(x) {
        return (x < 0 ? '−' : '') + Math.abs(x).toFixed(2);
    }
    // Weight explorer: compare a revision with its parent or any other W4 recipe.
    // Prefer the best measured revision; without current scores, show the included Introvertor example.
    let release = null, explorerModule = null, exploring = null, exploreAuto = true;
    // the new-model overlay in the game view (see bornView)
    let born = null;
    let exploreView = 'm0'; // the explorer tab: m0–m2 sensor-weight matrices (default), r0–r2 output rows
    const exploreCandidate = $('explore-candidate'), exploreBase = $('explore-base'), exploreRow = $('explore-row'), exploreNote = $maybe('explore-note');
    function fillExploreSelects() {
        if (!exploreCandidate || !exploreBase)
            return;
        const order = treeOrder().filter((e) => e.record.precision === 'w4');
        const candidateValue = exploreCandidate.value, baseValue = exploreBase.value;
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = 'Release comparison (FP32 → 4-bit → DNP)';
        exploreCandidate.replaceChildren(blank, ...order.map((e) => treeOption(e, name(e.record))));
        exploreBase.replaceChildren(...order.map((e) => treeOption(e, name(e.record))));
        if (p(candidateValue))
            exploreCandidate.value = candidateValue;
        else
            exploreCandidate.value = '';
        if (p(baseValue))
            exploreBase.value = baseValue;
    }
    async function renderExplorer() {
        const host = document.querySelector('[data-weights-explorer]');
        if (!host || !exploreCandidate)
            return;
        const candidate = p(exploreCandidate.value), base = p(exploreBase.value);
        const mod = (explorerModule ??= await import('./weights-explorer.js'));
        if (!candidate || candidate.precision !== 'w4') {
            exploreBase.disabled = true;
            exploreRow.disabled = true;
            if (causesBox)
                causesBox.hidden = true;
            if (exploreNote)
                exploreNote.textContent = 'Original FP32 weights alongside their 4-bit quantization and Astra 6’s edits.';
            if (exploring) {
                exploring = null;
                await mod.remountWeightsExplorer(host);
            }
            return;
        }
        if (!base || base.precision !== 'w4') {
            const parent = p(candidate.parentId);
            exploreBase.value = parent?.precision === 'w4' ? parent.id : registry.builtins.shipped.id;
            return renderExplorer();
        }
        exploreBase.disabled = false;
        exploreRow.disabled = false;
        release ??= (await (await fetch(siteUrl('data/weights-explorer.json'), { credentials: 'same-origin' })).json());
        const row = Number(exploreRow.value);
        const model = mod.buildRevisionComparison({
            candidate: { ops: candidate.ops, controller: candidate.controller },
            base: { ops: base.ops, controller: base.controller },
            release,
            head: TRUST.head,
            row,
            labels: { candidate: name(candidate), base: name(base) },
        });
        exploring = { candidate: candidate.id, base: base.id, row };
        mod.renderRevisionDiff(host, model, {
            view: exploreView,
            onView: (v) => {
                exploreView = v;
            },
            onRow: (r) => {
                exploreView = 'r' + r;
                exploreRow.value = String(r);
                renderExplorer().catch((e) => notify(errorText(e), true));
            },
        });
        await renderCauses(candidate, base).catch((e) => {
            if (causesNote)
                causesNote.textContent = errorText(e);
        });
        const rowsChanged = model.summary.rowChanges;
        if (exploreNote)
            exploreNote.textContent =
                name(candidate) +
                    ' compared with ' +
                    name(base) +
                    ': ' +
                    plural(model.summary.directChanged, 'native parameter') +
                    ' (rows 0/1/2: ' +
                    rowsChanged.join(' / ') +
                    ') and ' +
                    plural(model.summary.controllerChanged, 'controller parameter') +
                    ' changed. Sensor weights ≠ 0: candidate ' +
                    model.summary.candidateNonzero +
                    (model.summary.candidateNonzero ? '' : ' (neutral, sensor weights off)') +
                    ', base ' +
                    model.summary.baseNonzero +
                    (model.summary.baseNonzero ? '' : ' (neutral, sensor weights off)') +
                    ' of ' +
                    model.summary.controllerSlots +
                    '.';
    }
    // Attribution panel: which change group explains the candidate's difference from the base (knock-out and knock-in games).
    const causesBox = $maybe('explore-causes'), causesNote = $('causes-note'), causesTable = $('causes-table'), causesButton = $('causes-measure'), causesCredit = $('causes-credit');
    const measured = new Map();
    let causesJob = null;
    const sec = (t) => (t >= 0 ? '+' : '−') + Math.abs(t / 35).toFixed(1) + ' s', num = (x, d = 1) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(d);
    const tone = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : 'flat');
    function slotLabel(s, x, y) {
        // `controller` is typed nullable (FP32 revisions have none); the shipped W4 model always carries one.
        const c = registry.builtins.shipped.controller, step = x === undefined ? '' : ' (' + x + ' → ' + y + ')';
        if (s < 52)
            return 'Aim sensor weights: ' + c?.graft.outputs[Math.floor(s / 13)] + ' ← ' + c?.graft.inputs[s % 13] + step;
        if (s < 118) {
            const t = s - 52;
            return ('Combat sensor weights: ' + c?.combat.outputs[Math.floor(t / 11)] + ' ← ' + c?.combat.inputs[t % 11] + step);
        }
        return 'Facing guard' + step;
    }
    const rowName = (r) => ['LEFT', 'RIGHT', 'FIRE'][r];
    function groupLabel(g) {
        if (g.kind === 'native') {
            const up = g.coords.filter(([, x, y]) => y > x).length;
            return ('Classifier row ' +
                g.row +
                ' (' +
                rowName(g.row) +
                ') · columns ' +
                g.columns[0] +
                '–' +
                g.columns[1] +
                '<small>' +
                plural(g.size, 'parameter') +
                ' · ' +
                up +
                ' raised, ' +
                (g.size - up) +
                ' lowered</small>');
        }
        if (g.slots.length === 1)
            return escape(slotLabel(...g.slots[0]));
        return ({ graft: 'Aim sensor weights', combat: 'Combat sensor weights', facing: 'Facing guard' }[g.matrix] +
            '<small>' +
            plural(g.slots.length, 'parameter') +
            '</small>');
    }
    function verdict(g) {
        const o = g.knockOut.utility, i = g.knockIn.utility;
        if (o > 0 && i > 0)
            return 'carries the improvement';
        if (o > 0)
            return 'works only in combination';
        if (i > 0)
            return 'useful alone, replaceable in the candidate';
        if (o < 0 && i < 0)
            return 'harmful';
        if (o < 0)
            return 'harmful in the candidate';
        if (i < 0)
            return 'harmful alone';
        return 'no measurable effect';
    }
    // Bold when the contribution stands out from seed noise (|t| ≥ 2); the ± value is one standard error of the summed difference.
    const cell = (d) => '<td class="num ' +
        tone(d.utility) +
        (Math.abs(d.t ?? 0) >= 2 ? ' sig' : '') +
        '">' +
        sec(d.survival) +
        (d.seSurvival !== undefined ? ' ± ' + (d.seSurvival / 35).toFixed(1) + ' s' : '') +
        ' · ' +
        num(d.utility) +
        '<small>↑' +
        d.better +
        ' ↓' +
        d.worse +
        ' =' +
        d.same +
        ' seeds' +
        (d.t !== undefined ? ' · t ' + num(d.t, 1) : '') +
        '</small></td>';
    function causesHTML(a) {
        const rows = a.groups
            .slice()
            .sort((x, y) => Math.max(y.knockOut.utility, y.knockIn.utility) - Math.max(x.knockOut.utility, x.knockIn.utility) ||
            x.id - y.id);
        return ('<table><thead><tr><th>Change</th><th>Contribution in the candidate<small>candidate minus candidate without it</small></th><th>Effect alone<small>base with only this change minus base</small></th><th>Verdict</th></tr></thead><tbody>' +
            rows
                .map((g) => '<tr><td>' +
                groupLabel(g) +
                '</td>' +
                cell(g.knockOut) +
                cell(g.knockIn) +
                '<td>' +
                verdict(g) +
                '</td></tr>')
                .join('') +
            '</tbody><tfoot><tr><td>Total</td><td class="num ' +
            tone(a.gain.utility) +
            '">' +
            sec(a.gain.survival) +
            ' · ' +
            num(a.gain.utility) +
            '<small>' +
            num(a.gain.kills, 0) +
            ' hugs</small></td><td class="num ' +
            tone(a.sumKnockIn) +
            '">Σ ' +
            num(a.sumKnockIn) +
            '<small>interaction ' +
            num(a.interaction) +
            '</small></td><td></td></tr></tfoot></table>');
    }
    function creditLine(rc) {
        const top = (rc?.credit || []).slice(0, 6);
        if (!top.length)
            return '';
        return ('What the search has learned so far (strongest directions): ' +
            top
                .map(([k, s]) => (k[0] === 'c'
                ? slotLabel(Number(k.slice(1)))
                : 'Row ' + (Number(k.slice(1)) >>> 10) + ' column ' + (Number(k.slice(1)) % 1024)) +
                ' ' +
                (s > 0 ? '↑' : '↓'))
                .join(' · ') +
            '.');
    }
    async function renderCauses(candidate, base) {
        if (!causesBox)
            return;
        causesBox.hidden = false;
        const key = candidate.id + '|' + base.id + '|' + priority();
        let att = measured.get(key), source = att
            ? 'Measured in this browser on ' +
                att.seeds.length +
                ' fixed explanation seeds (' +
                att.games +
                ' games, goal: ' +
                (priority() === 'kills' ? 'hugs' : 'survival') +
                ').'
            : '';
        const rc = (await registry.receipt?.(candidate.id).catch(() => null));
        if (!att && base.id === candidate.parentId && rc?.attribution) {
            att = rc.attribution;
            source =
                'From the training run, on the ' +
                    att.seeds.length +
                    ' validation seeds of the promotion (' +
                    att.games +
                    ' games).';
        }
        causesButton.disabled = !!job || !!causesJob || !registry;
        causesButton.textContent = causesJob
            ? 'Approximating …'
            : att
                ? 'Approximate again'
                : 'Approximate cause and effect';
        const line = base.id === candidate.parentId ? creditLine(rc) : '';
        causesCredit.hidden = !line;
        causesCredit.textContent = line;
        if (!att) {
            causesTable.innerHTML = '';
            if (!causesJob)
                causesNote.textContent =
                    'Not measured yet. “Approximate cause and effect” plays the candidate without each change group in turn and the base with only that group, each on 24 fixed seeds; with up to 12 groups that is at most 624 games. Values in bold stand out from seed noise with |t| ≥ 2. Future research will explore how this can be used to improve evolution towards a metric goal.';
            return;
        }
        causesNote.textContent =
            source +
                ' Total effect: ' +
                sec(att.gain.survival) +
                ' survival, fitness ' +
                num(att.gain.utility) +
                '. Added one at a time, the groups together explain ' +
                num(att.sumKnockIn) +
                '; ' +
                num(att.interaction) +
                ' arises only from their interaction.';
        causesTable.innerHTML = causesHTML(att);
    }
    causesButton?.addEventListener('click', () => {
        const candidate = p(exploreCandidate.value), base = p(exploreBase.value);
        if (!candidate || !base || job || causesJob || candidate.precision !== 'w4' || base.precision !== 'w4')
            return;
        stopReference();
        const key = candidate.id + '|' + base.id + '|' + priority(), w = new Worker(moduleUrl('workers/training-worker'), { type: 'module' });
        const target = { worker: w, key, total: 0 };
        causesJob = target;
        pauseGame();
        controls();
        causesButton.disabled = true;
        causesButton.textContent = 'Approximating …';
        causesNote.textContent = 'Starting ' + plural(lanes(), 'CPU core') + ' …';
        const finish = () => {
            w.terminate();
            if (causesJob?.worker === w)
                causesJob = null;
            controls();
            renderExplorer().catch((e) => notify(errorText(e), true));
        };
        // While this worker reports, `causesJob` is `target`: a second job cannot start, and `finish` terminates the worker.
        w.onmessage = ({ data: m }) => {
            if (m.type === 'progress') {
                if (m.total && !target.total) {
                    target.total = m.total;
                    target.since = performance.now();
                    target.base = m.games ?? 0;
                }
                const done = (m.games ?? 0) - (target.base ?? 0), rate = target.since ? done / ((performance.now() - target.since) / 1000) : 0;
                const left = rate > 0 && target.total ? Math.max(0, (target.total - done) / rate) : null;
                causesNote.textContent =
                    'Measuring causes … ' +
                        Math.max(0, done) +
                        (causesJob?.total ? ' / ' + causesJob.total : '') +
                        ' games · ' +
                        plural(m.lanes || 0, 'CPU core') +
                        (left !== null && done >= 4
                            ? ' · about ' + (left < 90 ? Math.round(left) + ' s' : Math.round(left / 60) + ' min') + ' left'
                            : '');
            }
            else if (m.type === 'attribution')
                measured.set(key, m.result);
            else if (m.type === 'error') {
                notify(m.message || 'Measurement failed.', true);
            }
            else if (m.type === 'stopped')
                finish();
        };
        w.onerror = (e) => {
            notify(e.message || 'Measurement worker could not start.', true);
            finish();
        };
        w.postMessage({
            type: 'attribute',
            parent: { id: base.id, ops: base.ops, tactical: base.controller },
            child: { id: candidate.id, ops: candidate.ops, tactical: candidate.controller },
            lanes: lanes(),
            priority: priority(),
            watch: false,
        });
    });
    function bestRevision() {
        let best = null, factor = -Infinity;
        for (const r of rows) {
            if (r.precision !== 'w4' || r.kind === 'shipped')
                continue;
            const g = rootGain(r);
            if (g && g.factor > factor) {
                factor = g.factor;
                best = r;
            }
        }
        return best;
    }
    // The output row with the most changed channels between two W4 recipes.
    function busiestRow(base, candidate) {
        const byRow = [0, 0, 0];
        for (const c of registry.nativeDiff?.(base.ops, candidate.ops) || [])
            byRow[c.row]++;
        return Math.max(...byRow) > 0 ? byRow.indexOf(Math.max(...byRow)) : 2;
    }
    function autoExplore() {
        if (!exploreAuto || !exploreCandidate || !registry)
            return;
        const candidate = bestRevision() ?? registry.builtins.survivor ?? registry.builtins.neutral, shipped = registry.builtins.shipped;
        if (!shipped || (exploreCandidate.value === candidate.id && exploreBase.value === shipped.id))
            return;
        fillExploreSelects();
        exploreCandidate.value = candidate.id;
        exploreBase.value = shipped.id;
        exploreRow.value = String(busiestRow(shipped, candidate));
        renderExplorer().catch((e) => notify(errorText(e), true));
    }
    async function explore(record, against = null) {
        if (!record || !exploreCandidate)
            return;
        exploreAuto = false;
        fillExploreSelects();
        exploreCandidate.value = record.precision === 'fp32' ? '' : record.id;
        if (record.precision === 'w4') {
            // Default comparison: the parent when it is a 4-bit model, otherwise the shipped DNP.
            const parent = against ?? p(record.parentId);
            exploreBase.value = parent?.precision === 'w4' ? parent.id : registry.builtins.shipped.id;
            // Open the row with the most changes first.
            if (parent?.precision === 'w4')
                exploreRow.value = String(busiestRow(parent, record));
        }
        // Straight to the explorer itself, not the section introduction above it.
        document.querySelector('[data-weights-explorer]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        try {
            await renderExplorer();
        }
        catch (e) {
            notify(errorText(e), true);
            return;
        }
    }
    exploreCandidate?.addEventListener('change', () => {
        exploreAuto = false;
        const c = p(exploreCandidate.value);
        if (c) {
            const parent = p(c.parentId);
            exploreBase.value = parent?.precision === 'w4' ? parent.id : registry.builtins.shipped.id;
        }
        renderExplorer().catch((e) => notify(errorText(e), true));
    });
    exploreBase?.addEventListener('change', () => {
        exploreAuto = false;
        return renderExplorer().catch((e) => notify(errorText(e), true));
    });
    exploreRow?.addEventListener('change', () => {
        exploreAuto = false;
        return renderExplorer().catch((e) => notify(errorText(e), true));
    });
    // Base, Compare and Row sit in the explorer's own header; the explorer rebuilds its viewer, so they are placed again after each rebuild.
    const explorerHost = document.querySelector('[data-weights-explorer]'), selectorLabels = [exploreBase, exploreCandidate]
        .map((x) => x?.closest('label'))
        .filter((l) => Boolean(l));
    const rowLabel = exploreRow?.closest('label');
    if (rowLabel)
        rowLabel.hidden = true;
    function placeSelectors() {
        const toolbar = explorerHost?.querySelector('.wx-toolbar');
        if (!toolbar || !selectorLabels.length)
            return;
        let box = toolbar.querySelector('.wx-selectors');
        if (!box) {
            box = document.createElement('div');
            box.className = 'wx-selectors';
            toolbar.prepend(box);
        }
        if (selectorLabels.some((l) => l.parentElement !== box))
            box.append(...selectorLabels);
    }
    if (explorerHost) {
        new MutationObserver(placeSelectors).observe(explorerHost, { childList: true });
        placeSelectors();
    }
    // Promotion evidence of each learned child: its step over the parent on the receipt's own validation seeds.
    const gains = new Map();
    function summarizeReceipt(rc) {
        if (rc?.validation?.candidate?.length && rc.validation.parent?.length) {
            // Protocol 7 (EDNO) and crossings: sums over the validation seeds.
            const v = rc.validation, sum = (xs, k) => xs.reduce((a, x) => a + (x[k] ?? 0), 0), P = sum(v.parent, 'tics'), C = sum(v.candidate, 'tics');
            if (!(P > 0))
                return null;
            const pk = sum(v.parent, 'kills'), ck = sum(v.candidate, 'kills'), pu = sum(v.parent, 'utility'), cu = sum(v.candidate, 'utility');
            return {
                survival: C / P - 1,
                utility: pu > 0 ? cu / pu - 1 : null,
                seeds: v.candidate.length,
                kills: pk > 0 ? ck / pk - 1 : null,
                priority: rc.priority || 'survival',
                minutes: rc.curriculum?.minutes ?? (rc.horizon ? rc.horizon / 1050 : null),
                cross: rc.kind === 'cross',
                unconfirmed: !!rc.unconfirmed && rc.status !== 'promoted',
            };
        }
        // Protocol ≤ 6: the promoted challenger's check (without a receipt or a winner there is none).
        if (!rc || rc.winner === undefined)
            return null;
        const c = rc.challengers?.[rc.winner], ch = c?.validation?.check;
        if (!ch || !(ch.parentSurvival > 0))
            return null;
        const kills = ch.seeds?.reduce((a, s) => a + s.kills, 0), parentKills = ch.seeds?.reduce((a, s) => a + s.parentKills, 0);
        return {
            survival: ch.survival / ch.parentSurvival - 1,
            utility: ch.parentUtility > 0 ? ch.utility / ch.parentUtility - 1 : null,
            seeds: ch.seeds?.length ?? 0,
            kills: parentKills > 0 ? kills / parentKills - 1 : null,
            priority: rc.priority || 'survival',
            minutes: rc.curriculum?.minutes ?? null,
        };
    }
    // Total gain ("Total") against the original FP32 model, the root of every line, and step ("Survival") against the parent: every
    // revision plays the same fixed reference seeds (reference.mjs), so totals of all lines are comparable and the total of a child is
    // exactly the total of its parent times its step. FP32 and the built-in revisions ship current-game results; others are measured here once
    // and cached in this browser.
    const reference = new Map(), shippedReference = new Set();
    let referenceJob = null;
    try {
        for (const [id, x] of Object.entries(JSON.parse(read(referenceKey) || '{}')))
            if (validReference(x))
                reference.set(id, x);
    }
    catch {
        /* A damaged cache is measured again. */
    }
    async function loadShippedReference() {
        try {
            const res = await fetch(siteUrl('data/huggingdoom-reference-v1.json'));
            if (!res.ok)
                return;
            const d = (await res.json());
            if (d.protocol !== REFERENCE.protocol)
                return;
            for (const [id, x] of Object.entries(d.revisions ?? {})) {
                const rec = { protocol: d.protocol, hash: x.hash, tics: x.tics, kills: x.kills };
                if (validReference(rec)) {
                    reference.set(id, rec);
                    shippedReference.add(id);
                }
            }
        }
        catch {
            /* Without the shipped file the built-in roots are measured in the browser. */
        }
    }
    const shippedReady = loadShippedReference();
    function storeReference(id, rec) {
        reference.set(id, rec);
        const keep = new Set(rows.map((r) => r.id));
        save(referenceKey, JSON.stringify(Object.fromEntries([...reference].filter(([k]) => !shippedReference.has(k) && keep.has(k)))));
    }
    const original = () => rows.find((r) => r.kind === 'original');
    // Lookup by an ID that may be missing (no parent, no FP32 row): Map.get of a missing key, typed.
    const referenceOf = (id) => (id == null ? undefined : reference.get(id));
    function standings() {
        return rankReferences(rows.flatMap((r) => {
            const rec = reference.get(r.id);
            return rec ? [[r.id, rec]] : [];
        }));
    }
    function performanceMarkup(r, all = standings()) {
        const mine = all.find((x) => x.id === r.id);
        if (!mine)
            return '<span class="performance-pending">' + (referencePending(r) ? 'Measuring…' : 'Not measured') + '</span>';
        const base = all.find((x) => x.id === original()?.id);
        return ('<div class="model-performance" aria-label="Model performance">' +
            ['tics', 'kills']
                .map((key) => {
                const label = key === 'tics' ? 'Survival' : 'Hugs', maximum = Math.max(0, ...all.map((x) => x[key])), width = maximum > 0 ? mine[key] / maximum : 0, average = mine[key] / REFERENCE.count / (key === 'tics' ? 35 : 1), value = average.toFixed(1) + (key === 'tics' ? ' s' : ''), gain = base && base[key] > 0 ? fmtGain(mine[key] / base[key]) : value, total = key === 'tics' ? rootGain(r) : null, line = key === 'tics' ? lineGain(r) : null, title = value +
                    ' per game · ' +
                    REFERENCE.count +
                    ' fixed HuggingDOOM games · full bar = best measured model' +
                    (base && base[key] > 0 ? ' · ' + gain + ' vs Original FP32' : '') +
                    (total ? ' · ' + referenceTitle(total, 'Original FP32') : '') +
                    (line?.gain ? ' · vs line root ' + name(line.root) + ': ' + fmtGain(line.gain.factor) : '');
                return ('<div class="performance-metric" data-metric="' +
                    key +
                    '" title="' +
                    escape(title) +
                    '">' +
                    '<span>' +
                    label +
                    '</span><strong>' +
                    gain +
                    '</strong><i aria-hidden="true"><b style="--performance:' +
                    width +
                    '"></b></i></div>');
            })
                .join('') +
            '</div>');
    }
    function renderCardPerformance() {
        const all = standings();
        for (const card of document.querySelectorAll('.pick-card[data-ref]')) {
            const r = p(card.dataset.ref);
            const meter = card.querySelector('.pick-meter');
            if (!r || !meter)
                continue;
            meter.hidden = !reference.has(r.id);
            meter.removeAttribute('title');
            meter.innerHTML = performanceMarkup(r, all);
        }
    }
    function rootGain(r) {
        return r?.precision === 'w4' ? referenceGain(reference.get(r.id), referenceOf(original()?.id)) : null;
    }
    function stepGain(r) {
        return r?.precision === 'w4' ? referenceGain(reference.get(r.id), referenceOf(r.parentId)) : null;
    }
    function lineGain(r) {
        const root = lineageRoot(r);
        return root && root.id !== r.id ? { root, gain: referenceGain(reference.get(r.id), reference.get(root.id)) } : null;
    }
    // Every displayed model participates, including FP32 and unrelated built-in lineages.
    function referenceNeeded() {
        return treeOrder()
            .map((e) => e.record)
            .filter((r) => !reference.has(r.id));
    }
    const referencePending = (r) => !!referenceJob && (referenceJob.ids.has(r.id) || referenceJob.ids.has(r.parentId));
    const fmtGain = (f) => pct(f - 1);
    function rootGainText(r) {
        const x = rootGain(r);
        return x ? fmtGain(x.factor) : '';
    }
    // Selector label: total gain against FP32 first, the step over the parent in parentheses (both on the reference seeds). A W4 base
    // is a direct child of FP32, so its step equals its total and is left out.
    function gainLabel(r) {
        const total = rootGainText(r), s = r.kind === 'learned' ? stepGain(r) : null;
        return total ? ' · ' + total + (s ? ' (' + fmtGain(s.factor) + ')' : '') : '';
    }
    const plusMinus = (x) => '± ' + Math.abs(100 * x).toFixed(1) + ' %';
    function referenceTitle(x, against) {
        return ('Survival time relative to ' +
            against +
            ' on the same ' +
            x.seeds +
            ' fixed reference seeds (up to 10 min per game) · ' +
            plusMinus(x.se) +
            ' standard error · longer on ' +
            x.better +
            ', shorter on ' +
            x.worse +
            ' seeds' +
            (x.kills ? ' · hugs ' + fmtGain(x.kills.factor) : ''));
    }
    const referenceButton = $maybe('reference-measure');
    function renderReference() {
        if (!referenceButton)
            return;
        if (referenceJob) {
            referenceButton.hidden = false;
            referenceButton.disabled = false;
            referenceButton.dataset.running = '';
            referenceButton.textContent =
                'Measuring performance · ' +
                    referenceJob.done +
                    ' / ' +
                    referenceJob.total +
                    (referenceJob.total === 1 ? ' model' : ' models') +
                    (referenceJob.games ? ' · ' + plural(referenceJob.games, 'game') : '') +
                    ' · Stop';
            referenceButton.title = 'Models measured so far stay saved.';
            return;
        }
        // Always visible once the store is open: with nothing left to measure it stays as a disabled status.
        const n = registry ? referenceNeeded().length : 0, done = rows.filter((r) => reference.has(r.id)).length;
        referenceButton.hidden = !registry;
        delete referenceButton.dataset.running;
        referenceButton.textContent = n
            ? 'Measure performance · ' + n + ' pending'
            : 'Performance measured · ' + plural(done, 'model');
        referenceButton.disabled = !n || !!job || !!causesJob || fileBusy || isBenchmarking();
        referenceButton.title = n
            ? 'Plays every model not yet measured on the same ' +
                REFERENCE.count +
                ' fixed seeds, with up to 10 minutes per game; the result stays saved in this browser.'
            : 'All models are measured on the same ' +
                REFERENCE.count +
                ' reference seeds. New models are measured automatically after saving.';
    }
    function relabel() {
        select.replaceChildren(...treeOrder().map((e) => treeOption(e, (e.record.id === tip?.id ? '★ ' : '') +
            name(e.record) +
            ' · ' +
            (e.record.precision === 'fp32' ? 'FP32' : '4-bit') +
            gainLabel(e.record))));
        // Default training base: the 4-bit base with neutral (all-zero) sensor weights, the start of the EvoWeights lineages.
        const parent = p(trainingParentId);
        if (parent?.precision === 'w4')
            select.value = parent.id;
        else {
            select.value = registry.builtins.neutral.id;
            if (trainingParentId) {
                trainingParentId = null;
                save(trainingParentKey, '');
            }
        }
        autoExplore();
    }
    function startReference() {
        if (referenceJob || job || causesJob || fileBusy || isBenchmarking() || !registry)
            return;
        const items = referenceNeeded();
        if (!items.length) {
            renderReference();
            return;
        }
        const w = new Worker(moduleUrl('workers/training-worker'), { type: 'module' });
        const target = {
            worker: w,
            total: items.length,
            done: 0,
            games: 0,
            ids: new Set(items.map((r) => r.id)),
        };
        referenceJob = target;
        const finish = () => {
            w.terminate();
            if (referenceJob === target)
                referenceJob = null;
            relabel();
            controls();
            renderTree();
            renderOwnCard();
            renderCardPerformance();
            updateBorn();
            if (!referenceNeeded().length)
                notify('Performance measured for all ' + plural(rows.length, 'model') + '.');
        };
        w.onmessage = ({ data: m }) => {
            if (referenceJob !== target)
                return;
            if (m.type === 'reference-result' && target.ids.has(m.id) && validReference(m.record)) {
                storeReference(m.id, m.record);
                target.done++;
                relabel();
                controls();
                renderTree();
                renderOwnCard();
                renderCardPerformance();
                updateBorn();
            }
            else if (m.type === 'progress') {
                if (Number.isFinite(m.games))
                    target.games = m.games;
                renderReference();
                updateBorn();
            }
            else if (m.type === 'error')
                notify(m.message || 'Reference measurement failed.', true);
            else if (m.type === 'stopped')
                finish();
        };
        w.onerror = (e) => {
            notify(e.message || 'Reference worker could not start.', true);
            finish();
        };
        // One lane stays free for the game in the arena.
        w.postMessage({
            type: 'reference',
            items: items.map((r) => ({ id: r.id, precision: r.precision, ops: r.ops, tactical: r.controller })),
            lanes: Math.max(1, lanes() - 1),
            watch: false,
        });
        controls();
        renderTree();
        renderOwnCard();
        updateBorn();
    }
    // A confirmed child gets its own overlay in the game view: congratulations, the live reference measurement, results and play.
    // Overlay card "Your own models": models trained in this browser, or a pointer to the training panel when there are none.
    function renderOwnCard() {
        const card = $maybe('pick-own');
        if (!card)
            return;
        const own = rows.filter((r) => r.kind === 'learned' && !virtualIds.has(r.id) && !releaseOf(r));
        const h = document.createElement('h3');
        h.textContent = 'Your own models';
        if (!own.length) {
            const hint = document.createElement('p');
            hint.className = 'own-hint';
            hint.innerHTML =
                '<span class="own-arrow" aria-hidden="true"></span><span>Train your own model in this browser with <b>Start Evolution</b> in the training panel, then choose it here and  Let AI play.</span>';
            card.replaceChildren(h, hint);
            card.dataset.empty = '';
            return;
        }
        delete card.dataset.empty;
        const pick = document.createElement('select');
        pick.id = 'pick-own-select';
        pick.setAttribute('aria-label', 'Your own model');
        // Same tree as the parent-model selector, reduced to the visitor's models and their ancestors; ancestors are shown but not selectable.
        const ownIds = new Set(own.map((r) => r.id)), shown = new Set(), kids = childrenMap();
        for (const r of own)
            for (let x = r; x && !shown.has(x.id); x = p(x.parentId))
                shown.add(x.id);
        const walk = (r, depth, last) => {
            const o = treeOption({ record: r, prefix: depth ? '\u2007'.repeat(2 * (depth - 1)) + (last ? '└ ' : '├ ') : '' }, name(r) + ' · ' + (r.precision === 'fp32' ? 'FP32' : '4-bit') + gainLabel(r));
            o.disabled = !ownIds.has(r.id);
            pick.append(o);
            const next = (kids.get(r.id) || []).filter((k) => shown.has(k.id));
            next.forEach((k, i) => walk(k, depth + 1, i === next.length - 1));
        };
        for (const root of (kids.get(null) || []).filter((r) => shown.has(r.id)))
            walk(root, 0, true);
        pick.value = own[own.length - 1].id;
        const keep = card.querySelector('select')?.value;
        if (keep && own.some((r) => r.id === keep))
            pick.value = keep;
        const p0 = document.createElement('p');
        p0.textContent =
            own.length === 1 ? 'One model trained in this browser.' : own.length + ' models trained in this browser.';
        const b = document.createElement('button');
        b.className = 'launch';
        b.dataset.ownPlay = '';
        b.innerHTML = '<span aria-hidden="true">▶</span>  Let AI play';
        const row = document.createElement('div');
        row.className = 'own-row';
        row.append(pick, b);
        const meter = document.createElement('div');
        meter.className = 'own-performance';
        const update = () => {
            const chosen = p(pick.value);
            meter.innerHTML = chosen ? performanceMarkup(chosen) : '';
        };
        pick.onchange = () => {
            update();
            if (!reference.has(pick.value))
                startReference();
        };
        const exploreButton = document.createElement('button');
        exploreButton.type = 'button';
        exploreButton.className = 'pick-explore';
        exploreButton.dataset.ownExplore = '';
        exploreButton.textContent = 'Explore Weights';
        exploreButton.onclick = () => {
            const chosen = p(pick.value);
            if (chosen)
                void explore(chosen);
        };
        update();
        card.replaceChildren(h, p0, meter, row, exploreButton);
    }
    function bornView(saved, parent, run = null) {
        const host = $maybe('viewport');
        if (!host)
            return;
        born?.el.remove();
        const el = document.createElement('div');
        el.className = 'born';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', 'New model');
        el.innerHTML =
            '<div class="born-inner"><span class="overline">NEW MODEL GENERATION</span><h3>🎉 Congratulations, a new best candidate model has been born!</h3><p class="born-name"></p>' +
                '<p class="born-status" role="status"></p><progress max="1" value="0"></progress><dl class="born-results" hidden></dl>' +
                '<div class="born-actions"><button type="button" class="launch born-play" hidden><span aria-hidden="true">▶</span>  Let AI play</button><button type="button" class="born-close">Close</button></div></div>';
        const mins = run ? Math.floor(run.seconds / 60) : 0, secs = run ? Math.round(run.seconds % 60) : 0;
        $in(el, '.born-name').textContent =
            name(saved) +
                (parent ? ' · child of ' + name(parent) : '') +
                (run
                    ? ' · trained in ' +
                        (mins ? mins + ' min ' : '') +
                        secs +
                        ' s · ' +
                        run.decisions.toLocaleString('en-US') +
                        ' decisions'
                    : '');
        $in(el, '.born-play').onclick = () => {
            const r = p(saved.id);
            if (!r || !setActive(r, true))
                return;
            el.remove();
            born = null;
        };
        $in(el, '.born-close').onclick = () => {
            el.remove();
            born = null;
        };
        host.append(el);
        born = { el, id: saved.id, parentId: parent?.id ?? null };
        updateBorn();
    }
    function updateBorn() {
        if (!born)
            return;
        const el = born.el, r = p(born.id), bar = $in(el, 'progress'), status = $in(el, '.born-status');
        if (!r)
            return;
        const all = standings(), standing = all.find((x) => x.id === r.id), mine = rootGain(r), missing = referenceNeeded();
        if (!mine || !standing || missing.length) {
            const t = referenceJob, total = (t ? t.total : 1) * REFERENCE.count, games = Math.min(t?.games ?? 0, total);
            bar.max = total;
            bar.value = games;
            status.textContent = t
                ? 'Validating on the ' + REFERENCE.count + ' reference games: ' + games + ' of ' + total + ' played …'
                : 'Performance comparison incomplete. Use “Measure performance” above the model tree to finish it.';
            $in(el, '.born-results').hidden = true;
            $in(el, '.born-play').hidden = !reference.has(born.id);
            return;
        }
        bar.max = 1;
        bar.value = 1;
        status.textContent = 'Validation complete.';
        const parentGain = referenceGain(reference.get(r.id), referenceOf(born.parentId));
        const items = [
            ['Survival vs Original FP32', fmtGain(mine.factor)],
            ['Rank among all models', '#' + standing.rank + ' of ' + all.length],
            ...(parentGain ? [['Survival vs parent', fmtGain(parentGain.factor)]] : []),
        ];
        const dl = $in(el, '.born-results');
        dl.hidden = false;
        dl.replaceChildren(...items.map(([k, v]) => {
            const d = document.createElement('div'), t = document.createElement('dt'), dd = document.createElement('dd');
            t.textContent = k;
            dd.textContent = v;
            d.append(t, dd);
            return d;
        }));
        $in(el, '.born-play').hidden = false;
    }
    function stopReference() {
        const t = referenceJob;
        if (!t)
            return;
        t.worker.terminate();
        referenceJob = null;
        relabel();
        controls();
        renderTree();
        renderOwnCard();
        renderCardPerformance();
        updateBorn();
    }
    referenceButton?.addEventListener('click', () => (referenceJob ? stopReference() : startReference()));
    async function loadGains() {
        if (!registry?.receipt)
            return;
        await Promise.all(rows
            .filter((r) => r.kind === 'learned' && !gains.has(r.id))
            .map(async (r) => {
            const rc = (await registry.receipt(r.id).catch(() => null));
            gains.set(r.id, summarizeReceipt(rc));
        }));
    }
    const pct = (x) => (x >= 0 ? '+' : '−') + Math.abs(100 * x).toFixed(1) + ' %';
    const canDelete = (r) => !!registry?.persistent &&
        !!registry.remove &&
        r.kind !== 'original' &&
        r.kind !== 'shipped' &&
        !virtualIds.has(r.id);
    function branch(id) {
        const out = [id];
        for (let i = 0; i < out.length; i++)
            for (const r of rows)
                if (r.parentId === out[i] && !virtualIds.has(r.id) && !out.includes(r.id))
                    out.push(r.id);
        return out;
    }
    function deleteButton(r) {
        if (!canDelete(r))
            return '';
        const n = branch(r.id).length, armed = pendingDelete?.id === r.id;
        return ('<button type="button" class="tree-delete' +
            (armed ? ' tree-delete-armed' : '') +
            '" data-action="delete"' +
            (job || fileBusy ? ' disabled' : '') +
            ' title="' +
            (job
                ? 'Not available during a training run'
                : armed
                    ? 'Click again to delete ' + plural(n, 'model') + ' permanently'
                    : 'Delete this model' + (n > 1 ? ' and its ' + plural(n - 1, 'descendant') : '') + ' from local storage') +
            '">' +
            (armed ? 'Confirm · ' + n : 'Delete') +
            '</button>');
    }
    // "Clear all local models": every stored model that can be deleted, branch by branch; built-in models stay. Two clicks, like Delete.
    let pendingClear = null;
    const clearRoots = () => rows.filter((r) => {
        const parent = p(r.parentId);
        return canDelete(r) && !(parent && canDelete(parent));
    });
    function clearButton() {
        const b = $maybe('revision-clear');
        if (!b)
            return;
        const roots = clearRoots(), n = roots.reduce((a, r) => a + branch(r.id).length, 0);
        b.hidden = !registry?.persistent;
        b.disabled = !n || !!job || fileBusy;
        if (pendingClear)
            b.dataset.armed = '';
        else
            delete b.dataset.armed;
        b.textContent = pendingClear ? 'Confirm · delete ' + plural(n, 'model') : 'Clear all local models';
        b.title = job
            ? 'Not available during a training run'
            : !n
                ? 'No local models stored in this browser'
                : 'Deletes all ' + plural(n, 'model') + ' stored in this browser; built-in models stay';
    }
    async function clearAll() {
        const roots = clearRoots();
        if (!roots.length || job || fileBusy)
            return;
        if (!pendingClear) {
            pendingClear = setTimeout(() => {
                pendingClear = null;
                clearButton();
            }, 6000);
            notify('All local models will be deleted when you click “Confirm”. Deleted models can only be restored from a downloaded weight file.');
            clearButton();
            return;
        }
        clearTimeout(pendingClear);
        pendingClear = null;
        fileBusy = true;
        controls();
        let count = 0;
        try {
            for (const r of roots)
                count += (await registry.remove(r.id)).removed.length;
            broadcast();
            await refresh();
            if (active && !p(active.id))
                setActive(tip || registry.builtins.shipped, false);
            if (exploring)
                await renderExplorer().catch(() => { });
            notify(plural(count, 'local model') + ' deleted. Training base: ' + name(tip || registry.builtins.shipped) + '.');
        }
        catch (e) {
            notify(errorText(e), true);
            await refresh().catch(() => { });
        }
        finally {
            fileBusy = false;
            controls();
            renderTree();
        }
    }
    async function requestDelete(r) {
        if (!canDelete(r) || job || fileBusy)
            return;
        const ids = branch(r.id);
        if (pendingDelete?.id !== r.id) {
            clearTimeout(pendingDelete?.timer);
            pendingDelete = {
                id: r.id,
                timer: setTimeout(() => {
                    pendingDelete = null;
                    renderTree();
                }, 6000),
            };
            notify(name(r) +
                (ids.length > 1 ? ' and ' + plural(ids.length - 1, 'descendant') : '') +
                ' will be deleted when you click “Confirm”. Deleted models can only be restored from a downloaded weight file.');
            renderTree();
            return;
        }
        clearTimeout(pendingDelete.timer);
        pendingDelete = null;
        fileBusy = true;
        controls();
        try {
            const result = await registry.remove(r.id), removed = new Set(result.removed);
            broadcast();
            await refresh();
            if (active && removed.has(active.id))
                setActive(tip || registry.builtins.shipped, false);
            if (exploring)
                await renderExplorer().catch(() => { });
            notify(plural(result.removed.length, 'model') +
                ' deleted' +
                (r.kind === 'base' ? '; the 4-bit base stays available as a root' : '') +
                '. Training base: ' +
                name(tip || registry.builtins.shipped) +
                '.');
        }
        catch (e) {
            notify(errorText(e), true);
            await refresh().catch(() => { });
        }
        finally {
            fileBusy = false;
            controls();
            renderTree();
        }
    }
    // Separate row grids share the natural widths of all data columns.
    function fitModelColumn() {
        const grid = $maybe('revision-tree');
        if (!grid)
            return;
        const cols = ['--col-model', '--col-rank', '--col-performance', '--col-parent', '--col-delta'];
        cols.forEach((c) => grid.style.setProperty(c, 'max-content'));
        const rowsNow = [...grid.querySelectorAll('.data-grid-row')];
        // VERIFIED: getBoundingClientRect measures after CSS page zoom; the custom properties are zoomed again when applied.
        const zoom = grid.currentCSSZoom || 1;
        cols.forEach((c, i) => {
            const w = Math.max(0, ...rowsNow.map((r) => (r.children[i]?.getBoundingClientRect().width || 0) / zoom));
            if (w > 20)
                grid.style.setProperty(c, Math.ceil(w) + (i === 0 ? 12 : 2) + 'px');
            else
                grid.style.removeProperty(c);
        });
        // Actions: the widest row's buttons set one shared column width, so the header and every row end at the same edge.
        const act = Math.max(0, ...rowsNow.map((r) => {
            const c = r.lastElementChild, k = c?.lastElementChild;
            if (!c || !k)
                return 0;
            return ((k.getBoundingClientRect().right - c.getBoundingClientRect().left) / zoom +
                parseFloat(getComputedStyle(c).paddingRight || '0'));
        }));
        if (act > 20)
            grid.style.setProperty('--col-actions', Math.ceil(act) + 2 + 'px');
        else
            grid.style.removeProperty('--col-actions');
    }
    // Web fonts and layout changes alter the natural width: measure again.
    document.fonts?.ready.then(fitModelColumn);
    addEventListener('resize', () => requestAnimationFrame(fitModelColumn));
    function renderTree() {
        const body = $maybe('revision-tree-body'), meta = $maybe('revision-tree-meta');
        if (!body || !rows.length)
            return;
        const children = childrenMap(), all = standings();
        const collapsed = collapsedIds(), html = [], selected = selectedId;
        let shown = 0;
        const walk = (r, depth) => {
            const kids = children.get(r.id) || [], parent = p(r.parentId), w4 = r.precision === 'w4';
            const native = w4 ? r.ops.length : 0, nativeDelta = w4 && parent?.precision === 'w4' ? (registry.nativeDiff?.(parent.ops, r.ops).length ?? null) : null;
            const ctrl = w4 && parent?.precision === 'w4'
                ? (registry.controllerDiff?.(parent.controller, r.controller).length ?? null)
                : null;
            const open = !collapsed.has(r.id), standing = all.find((x) => x.id === r.id), flags = (r.id === tip?.id ? '<b class="tree-flag tree-flag-tip" title="Training base">★</b>' : '') +
                (r.id === active?.id ? '<b class="tree-flag tree-flag-active" title="Playing">▶</b>' : '');
            shown++;
            html.push('<div class="data-grid-row" role="row" data-id="' +
                escape(r.id) +
                '" aria-level="' +
                (depth + 1) +
                '"' +
                (kids.length ? ' aria-expanded="' + open + '"' : '') +
                (r.id === selected ? ' aria-selected="true"' : '') +
                (r.id === tip?.id ? ' data-tip' : '') +
                '>' +
                '<div class="data-grid-cell" data-locked><span class="data-grid-toggle" data-action="toggle" style="--depth:' +
                depth +
                '"' +
                (kids.length ? ' role="button" tabindex="0" aria-label="Expand or collapse branch"' : ' data-leaf') +
                '></span><span class="data-grid-content tree-name">' +
                escape(name(r)) +
                '</span>' +
                flags +
                '</div>' +
                '<div class="data-grid-cell tree-rank" data-type="number" title="Rank by survival across ' +
                all.length +
                ' measured models of ' +
                rows.length +
                '; equal survival totals share a rank">' +
                (standing ? '#' + standing.rank : '—') +
                '</div><div class="data-grid-cell tree-performance">' +
                performanceMarkup(r, all) +
                '</div>' +
                '<div class="data-grid-cell tree-parent">' +
                (parent ? escape(name(parent)) : '—') +
                '</div>' +
                // One delta column: native 4-bit codes plus sensor weights changed relative to the parent. A 4-bit root differs from FP32 by quantization.
                (nativeDelta !== null && ctrl !== null
                    ? '<div class="data-grid-cell" data-type="number" title="' +
                        nativeDelta +
                        ' native 4-bit codes and ' +
                        ctrl +
                        ' sensor weights changed relative to the parent">Δ' +
                        (nativeDelta + ctrl).toLocaleString('en-US') +
                        '</div>'
                    : '<div class="data-grid-cell" data-type="number"' +
                        (w4
                            ? ' title="A 4-bit root: all weights quantized from FP32; ' +
                                native +
                                ' edited native codes, 119 sensor weights"'
                            : '') +
                        '>—</div>') +
                '<div class="data-grid-cell tree-actions">' +
                (w4
                    ? '<button type="button" data-action="explore" title="Show the weight changes relative to the parent in the explorer below">Explore</button>'
                    : '') +
                (w4
                    ? '<button type="button" data-action="diff" title="Only the changed parameters, as JSON">Diff ↓</button><button type="button" data-action="provenance" title="Ancestry, training receipts, run logs (settings, environment, code fingerprint, every generation) and totals, as JSON">Provenance ↓</button>'
                    : '') +
                '<button type="button" data-action="weights" title="Complete weight file">Weights ↓</button>' +
                deleteButton(r) +
                '</div></div>');
            if (open)
                for (const k of kids)
                    walk(k, depth + 1);
        };
        for (const root of children.get(null) || [])
            walk(root, 0);
        body.innerHTML = html.join('');
        fitModelColumn();
        if (meta)
            meta.textContent =
                plural(rows.length, 'model') +
                    ' · ' +
                    rows.filter((r) => r.kind === 'learned').length +
                    ' learned · ' +
                    plural((children.get(null) || []).length, 'root') +
                    (shown < rows.length ? ' · ' + (rows.length - shown) + ' collapsed' : '');
    }
    // Provenance of a revision: its lineage with receipts and reference totals, and every logged learning run started from any revision
    // of that lineage, including runs that saved nothing or produced another branch.
    function builtInSource(a) {
        return (releaseOf(a)?.[1] ??
            (a.kind === 'shipped'
                ? 'Shipped composite: FIRE-row edit and sensor weights by OpenAI Astra 6 (experiments/v03–v06)'
                : a.kind === 'base'
                    ? 'Training root created by Claude Fable 5.1'
                    : a.kind === 'original'
                        ? 'NVIDIA Kumo-Tabular Small v1.0.0'
                        : null));
    }
    function releaseOf(a) {
        const k = Object.keys(RELEASES).find((k) => builtinOf(registry.builtins, k)?.id === a.id);
        return k ? RELEASES[k] : null;
    }
    async function exportProvenance(r) {
        if (!r || fileBusy)
            return;
        fileBusy = true;
        controls();
        try {
            const chain = [];
            for (let a = r; a; a = p(a.parentId))
                chain.unshift(a);
            const ids = new Set(chain.map((a) => a.id)), all = ((await registry.runs?.()) ?? []);
            const sum = (xs, k) => xs.reduce((s, x) => s + (x.progress?.[k] || 0), 0), fixed = (g) => g && { factor: +g.factor.toFixed(4), se: +g.se.toFixed(4) };
            const lineage = [];
            for (const a of chain) {
                const rec = reference.get(a.id);
                const receipt = a.kind !== 'learned' ? null : ((await registry.receipt?.(a.id).catch(() => null)) ?? null);
                lineage.push({
                    id: a.id,
                    name: name(a),
                    kind: a.kind,
                    precision: a.precision,
                    parentId: a.parentId,
                    source: builtInSource(a),
                    reference: rec
                        ? {
                            protocol: rec.protocol,
                            seeds: rec.tics.length,
                            survivalTics: rec.tics.reduce((x, y) => x + y, 0),
                            kills: rec.kills.reduce((x, y) => x + y, 0),
                            // VERIFIED: FP32 reference records carry the revision ID in `hash` (original-reference.ts); only W4 records hold a recipe hash.
                            recipeSHA256: a.precision === 'fp32' ? null : rec.hash,
                            totalVsFP32: fixed(rootGain(a)),
                            stepVsParent: a.kind === 'learned' ? fixed(stepGain(a)) : null,
                        }
                        : null,
                    receipt,
                    producedByRuns: all.filter((x) => x.outcome?.childId === a.id).map((x) => x.runId),
                });
            }
            const runs = all
                .filter((x) => ids.has(x.parentId))
                .sort((x, y) => String(x.startedAt).localeCompare(String(y.startedAt)));
            const doc = {
                format: 'agm.dnp.provenance/1',
                exportedAt: new Date().toISOString(),
                revision: {
                    id: r.id,
                    name: name(r),
                    kind: r.kind,
                    precision: r.precision,
                    parentId: r.parentId,
                    ops: r.ops ?? [],
                    controller: r.controller ?? null,
                },
                summary: {
                    lineage: lineage.length,
                    runs: runs.length,
                    promoted: runs.filter((x) => x.outcome?.status === 'promoted').length,
                    generations: runs.reduce((s, x) => s + (x.generations?.length || 0), 0),
                    games: sum(runs, 'games'),
                    decisions: sum(runs, 'decisions'),
                    wallSeconds: +runs.reduce((s, x) => s + (x.wallSeconds || 0), 0).toFixed(1),
                },
                lineage,
                runs,
                exportEnvironment: environment(),
                exportCode: await codeFingerprint(),
                note: 'Runs are the training-run logs of this browser: every learning run started from a revision of this lineage, including runs that saved nothing or produced another branch. Reference totals use the fixed reference seeds; held-out seeds are evaluated separately.',
            };
            const file = 'agm-provenance-' +
                String(name(r))
                    .replace(/[^\p{L}\p{N}-]+/gu, '-')
                    .slice(0, 40) +
                '-' +
                short(r.id) +
                '.json';
            download(new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' }), file);
            notify('Provenance saved · ' +
                plural(lineage.length, 'model') +
                ' in the line, ' +
                plural(runs.length, 'logged training run') +
                '.');
        }
        catch (e) {
            notify(errorText(e), true);
        }
        finally {
            fileBusy = false;
            controls();
        }
    }
    async function exportDiff(r) {
        if (!r || fileBusy)
            return;
        fileBusy = true;
        controls();
        try {
            if (!registry.diff)
                throw new Error('Diff export is not available in this storage.');
            const receipt = await registry.receipt?.(r.id);
            const diff = registry.diff(r, p(r.parentId), { receipt, shipped: registry.builtins.shipped });
            download(new Blob([JSON.stringify(diff, null, 2)], { type: 'application/json' }), registry.diffFileName(r));
            notify('Diff saved · ' +
                plural(diff.head?.changesVsParent?.length ?? 0, 'native parameter') +
                ' and ' +
                plural(diff.controller?.changesVsParent?.length ?? 0, 'controller parameter') +
                ' relative to ' +
                (name(p(r.parentId)) || 'the parent') +
                '.');
        }
        catch (e) {
            notify(errorText(e), true);
        }
        finally {
            fileBusy = false;
            controls();
        }
    }
    async function adopt(r) {
        const expected = tip;
        // canAdopt(r) implies both; the explicit checks let the types follow.
        if (!r || !expected || !canAdopt(r) || job || fileBusy)
            return;
        fileBusy = true;
        controls();
        try {
            const adopted = r.kind === 'learned' && r.parentId === expected.id
                ? await registry.promote({ parentId: expected.id, ops: r.ops, controller: r.controller, name: r.name })
                : await registry.adopt(r.id, { expectedLatestId: expected.id });
            await refresh(r.id);
            broadcast();
            notify('New training base: ' +
                name(adopted || r) +
                (r.kind === 'base'
                    ? ' · the next training run starts a separate line from sensor weights set to zero.'
                    : '.'));
        }
        catch (e) {
            notify(errorText(e), true);
            await refresh().catch(() => { });
        }
        finally {
            fileBusy = false;
            controls();
        }
    }
    $maybe('revision-tree-body')?.addEventListener('click', (e) => {
        const target = e.target, control = target?.closest?.('[data-action]'), row = target?.closest?.('.data-grid-row');
        if (!row)
            return;
        const r = p(row.dataset.id);
        if (!r)
            return;
        const action = control?.dataset.action;
        if (action === 'toggle') {
            if (!row.hasAttribute('aria-expanded'))
                return;
            const collapsed = collapsedIds();
            if (collapsed.has(r.id))
                collapsed.delete(r.id);
            else
                collapsed.add(r.id);
            save(collapsedKey, JSON.stringify([...collapsed]));
            renderTree();
            return;
        }
        selectRecord(r);
        if (action === 'adopt')
            void adopt(r);
        else if (action === 'explore')
            void explore(r);
        else if (action === 'diff')
            void exportDiff(r);
        else if (action === 'provenance')
            void exportProvenance(r);
        else if (action === 'delete')
            void requestDelete(r);
        else if (action === 'weights')
            void exportWeights(r);
        else
            renderTree();
    });
    $maybe('revision-tree-body')?.addEventListener('keydown', (e) => {
        const target = e.target;
        if ((e.key === 'Enter' || e.key === ' ') && target?.dataset?.action === 'toggle') {
            e.preventDefault();
            target.click();
        }
    });
    function controls() {
        const chosen = option(), ready = !!chosen, saving = job?.saving, bench = isBenchmarking();
        onActivity(!!job);
        select.disabled = !ready || fileBusy;
        $('revision-import').disabled = !registry?.persistent || fileBusy || !!saving;
        clearButton();
        // Selecting a parent model already means training from it ("Start Evolution" adopts it), so no separate button.
        $('revision-adopt').hidden = true;
        $('revision-adopt').disabled = !ready || !!job || fileBusy || bench || !registry?.persistent;
        $('revision-learn').hidden = !!job;
        $('training-overlay').hidden = !job;
        $('revision-learn').disabled = !registry?.persistent || !tip || fileBusy || bench || !!causesJob;
        if (causesButton && !causesJob)
            causesButton.disabled = !!job;
        $('revision-stop').hidden = !job;
        $('revision-stop').disabled = !!saving;
        const kept = job?.edno && !job.finishing ? job.kept.length : 0;
        const keptCell = $maybe('revision-kept');
        if (keptCell)
            keptCell.textContent = !job?.edno
                ? '—'
                : job.kept.length +
                    ' / 3' +
                    (job.kept.length ? ' · t ' + job.kept.map((c) => tStat(c.t)).join(' · ') : '') +
                    (job.finishing ? ' · final round' : '');
        // "Stop" ends the search and then evaluates the kept candidates; a second click aborts that evaluation too.
        const stopMode = job?.finishing
            ? 'abort'
            : !job?.edno
                ? 'stop'
                : kept > 1
                    ? 'check best ' + kept
                    : kept
                        ? 'check best candidate'
                        : 'final round';
        const stopButton = $('revision-stop');
        if (stopButton.dataset.stop !== stopMode) {
            stopButton.dataset.stop = stopMode;
            const b = document.createElement('b'), sub = document.createElement('small');
            b.textContent = stopMode === 'abort' ? 'Abort now' : 'Stop';
            sub.textContent =
                stopMode === 'abort'
                    ? 'Also aborts candidate evaluation.'
                    : stopMode === 'stop'
                        ? ''
                        : kept > 1
                            ? 'Evaluates the best ' + kept + ' candidates after stopping.'
                            : kept
                                ? 'Evaluates the best candidate after stopping.'
                                : 'Evaluates the best candidates after the current race.';
            stopButton.replaceChildren(b, ...(sub.textContent ? [sub] : []));
        }
        $('revision-stop').title = job?.finishing
            ? 'Aborts at once; nothing is saved.'
            : !job?.edno
                ? ''
                : 'Ends the run with a final round: up to three best candidates play against the parent on fresh seeds, and the best is validated and saved only if it passes. Without candidates the generation continues until its race.';
        $('revision-watch').disabled = !job || !!saving;
        laneSelect.disabled = !!job || fileBusy || bench;
        for (const el of [mutationSelect, searchSelect, prioritySelect])
            if (el)
                el.disabled = !!job || fileBusy || bench;
        // The adaptive strategy chooses selection and mutation per generation itself.
        if (mutationSelect && searchSelect?.value === 'edno-adaptive') {
            mutationSelect.disabled = true;
            mutationSelect.title = 'The strategy chooses the mutation for each generation itself';
        }
        else if (mutationSelect)
            mutationSelect.title = '';
        renderReference();
        $('revision-tip').textContent = tip ? renderName(tip) : 'Determining …';
        $('revision-active').textContent = active ? renderName(active) : 'Astra 6 Weight-Space Programming';
        if (chosen) {
            const parent = p(chosen.parentId);
            const detail = chosen.kind === 'original'
                ? 'Built-in original weights'
                : chosen.kind === 'shipped'
                    ? 'Built-in 4-bit model'
                    : chosen.kind === 'base'
                        ? 'Built-in 4-bit base with neutral sensor weights'
                        : 'Saved 4-bit model';
            $('revision-lineage').textContent =
                detail +
                    (parent ? ' · parent: ' + name(parent) : '') +
                    (rootGainText(chosen)
                        ? ' · ' + rootGainText(chosen) + ' relative to Original FP32 on the reference seeds'
                        : '') +
                    '.';
            $('revision-lineage').title = chosen.id + (chosen.parentId ? ' ← ' + chosen.parentId : '');
        }
    }
    const refresh = async (preferred) => {
        if (!registry)
            return;
        const round = ++refreshSerial;
        const [items, latest] = await Promise.all([registry.list(), registry.latest()]);
        if (round !== refreshSerial)
            return;
        // Virtual W4 bases are offered as roots until a lineage is started from them.
        virtualIds = new Set();
        for (const v of ['neutral', ...Object.keys(RELEASES)].map((k) => builtinOf(registry.builtins, k)))
            if (v && !items.some((r) => r.id === v.id)) {
                items.push(v);
                virtualIds.add(v.id);
            }
        rows = items;
        if (preferred)
            selectedId = preferred;
        tip = latest;
        await Promise.all([loadGains(), shippedReady]);
        if (round !== refreshSerial)
            return;
        relabel();
        fillExploreSelects();
        controls();
        renderTree();
        renderOwnCard();
        renderCardPerformance();
        if (job?.parentId && !job.saving && tip?.id !== job.parentId)
            stop('The training base was updated in another tab. Training run stopped.');
    };
    function broadcast() {
        channel?.postMessage('changed');
    }
    function setActive(record, play = true) {
        if (!record || isBenchmarking())
            return false;
        if (activate(record, play) === false)
            return false;
        active = record;
        save(activeKey, record.id);
        controls();
        renderTree();
        return true;
    }
    function selectRecord(record) {
        selectedId = record.id;
        save(selectionKey, record.id);
        controls();
        renderTree();
    }
    const quantizedParentMessage = 'Original FP32 was switched to the quantized 4-bit base with neutral sensor weights for training.';
    // FP32 is available for playback and export, but training uses its neutral 4-bit counterpart.
    function switchFP32TrainingParent() {
        if (option()?.precision !== 'fp32')
            return false;
        select.value = registry.builtins.neutral.id;
        return true;
    }
    select.addEventListener('change', () => {
        $('revision-save-file').hidden = true;
        const switched = switchFP32TrainingParent();
        // Only an explicit change in Parent model may override the neutral training default.
        trainingParentId = select.value;
        save(trainingParentKey, trainingParentId);
        const parent = option();
        if (parent)
            selectRecord(parent);
        notify(switched ? quantizedParentMessage : '');
        controls();
        renderTree();
    });
    $('revision-import').onclick = () => file.click();
    $('revision-clear').onclick = () => void clearAll();
    file.onchange = async () => {
        const chosen = file.files?.[0];
        file.value = '';
        if (!chosen || !registry || fileBusy)
            return;
        fileBusy = true;
        controls();
        notify('Checking weight file …');
        try {
            const r = await registry.importWeights(chosen);
            seenImports.add(r.id);
            save(importKey, JSON.stringify([...seenImports]));
            await refresh(r.id);
            selectRecord(r);
            broadcast();
            notify('Weights checked and loaded. “Play” in the model tree starts it. The training base is ' + name(tip) + '.');
            fileBusy = false;
            startReference();
        }
        catch (e) {
            notify(errorText(e), true);
        }
        finally {
            fileBusy = false;
            controls();
        }
    };
    // Export the clicked tree row independently of the training parent.
    const exportWeights = async (r) => {
        if (!r || fileBusy)
            return;
        fileBusy = true;
        controls();
        notify('Assembling the complete weight file …');
        try {
            const blob = await registry.exportWeights(r.id);
            const fileName = 'agm-' +
                name(r)
                    .replace(/[^\p{L}\p{N}-]+/gu, '-')
                    .slice(0, 52) +
                '-' +
                short(r.id) +
                '.agmweights';
            download(blob, fileName);
            notify('Download ready · ' + (blob.size / 1048576).toFixed(1) + ' MiB complete model file.');
        }
        catch (e) {
            notify(errorText(e), true);
        }
        finally {
            fileBusy = false;
            controls();
        }
    };
    $('revision-adopt').onclick = () => adopt(option());
    // The run log is saved once, when the run ends for any reason; a run that never reached its parent is not logged.
    function persistRun(target) {
        const run = target?.run;
        if (!run || run.saved || !run.parentId)
            return;
        run.saved = true;
        if (run.outcome.status === 'running')
            run.outcome = { status: 'stopped' };
        run.finishedAt = new Date().toISOString();
        run.wallSeconds = +((performance.now() - target.started) / 1000).toFixed(1);
        const { saved: _saved, ...log } = run;
        void codeFingerprint()
            .then((code) => {
            log.code ??= code;
            return registry.saveRun?.(log);
        })
            .catch(() => {
            /* The log is advisory; the revision itself is stored. */
        });
    }
    function logProgress(target, m) {
        const run = target.run;
        if (!run)
            return;
        const g = run.progress;
        if (Number.isFinite(m.games))
            g.games = m.games;
        if (Number.isFinite(m.decisions))
            g.decisions = Math.round(m.decisions);
        if (Number.isFinite(m.elapsed))
            g.elapsedSeconds = +m.elapsed.toFixed(1);
        if (Number.isFinite(m.lanes) && m.lanes > 0)
            g.lanes = m.lanes;
        if (Number.isFinite(m.rate) && m.rate > g.maxDecisionsPerSecond)
            g.maxDecisionsPerSecond = Math.round(m.rate);
        if (m.phase === 'round-end' && m.last && !run.generations.some((x) => x.generation === m.round))
            logReceipt(run, m.last, Array.isArray(m.kept) ? m.kept.length : null);
    }
    function logReceipt(run, rc, kept = null) {
        if (!rc)
            return;
        const g = run.progress, v = rc.validation;
        run.generations.push({
            generation: rc.round ?? null,
            kind: rc.kind ?? 'generation',
            status: rc.status ?? null,
            reason: rc.reason ?? null,
            games: g.games,
            decisions: g.decisions,
            elapsedSeconds: g.elapsedSeconds,
            // A final round's selection is an object with `chosen`; a generation's is the method name.
            selection: typeof rc.selection === 'object' && rc.selection?.chosen !== undefined ? 'final' : (rc.selection ?? null),
            mode: rc.mode ?? null,
            minutes: rc.minutes ?? null,
            validationGames: v?.games ?? null,
            validationT: v?.stats?.t ?? null,
            kept,
        });
        run.receipts.push(structuredClone(rc));
    }
    function endJob(target) {
        if (!target || target !== job)
            return;
        persistRun(target);
        target.worker?.terminate();
        clearInterval(target.clock);
        job = null;
        const toolbarRate = $maybe('decision-rate');
        if (toolbarRate)
            toolbarRate.textContent = '—';
        $('revision-progress').hidden = true;
        trainingView(false);
        controls();
    }
    function stop(reason = 'Training run stopped. No new model was saved.') {
        if (!job || job.saving)
            return;
        if (job.run?.outcome.status === 'running')
            job.run.outcome = { status: 'stopped', reason };
        endJob(job);
        notify(reason);
    }
    function updateTime(target) {
        const seconds = Math.floor((performance.now() - target.started) / 1000);
        $('revision-clock').textContent = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
    }
    const phaseNames = {
        loading: 'Start',
        search: 'Search',
        race: 'Race',
        validation: 'Validation',
        attribution: 'Causes',
        reference: 'Reference',
        final: 'Final round',
        'round-end': 'Generation done',
    };
    function showProgress(m) {
        $('revision-phase').textContent = phaseNames[m.phase] || m.phase || 'Training run';
        $('revision-progress-text').textContent = m.message || 'Comparing the parent and candidates …';
        if (Number.isFinite(m.round))
            $('revision-round').textContent = String(m.round);
        if (Number.isFinite(m.games))
            $('revision-games').textContent = String(m.games);
        if (Number.isFinite(m.decisions))
            $('revision-decisions').textContent = Math.round(m.decisions).toLocaleString('en-US');
        if (Number.isFinite(m.lanes))
            $('revision-lanes-active').textContent =
                (m.busyLanes ?? m.lanes) + ' / ' + m.lanes + (m.plan ? ' · ' + m.plan.pairs * 2 + ' candidates' : '');
        if (Number.isFinite(m.rate)) {
            const realtime = ((m.rate * 2) / 35).toFixed(0);
            $('training-overlay').textContent = m.rate > 0 ? 'Training... in ' + realtime + 'x realtime' : 'Training...';
            $('revision-rate').textContent =
                m.rate > 0 ? Math.round(m.rate).toLocaleString('en-US') + ' decisions/s · ' + realtime + '× real time' : '—';
            const toolbarRate = $maybe('decision-rate');
            if (toolbarRate)
                toolbarRate.textContent = m.rate > 0 ? Math.round(m.rate).toLocaleString('en-US') : '—';
        }
        if (m.last) {
            $('revision-receipt-text').textContent = JSON.stringify(m.last, null, 2);
            $('revision-receipt').hidden = false;
        }
    }
    function frame(m) {
        if (!$('revision-watch').checked || !m.pixels || m.width !== 320 || m.height !== 200)
            return;
        if (m.pixels.byteLength !== 320 * 200 * 4)
            return;
        trainingFrame(m);
    }
    // Name of a new child: line prefix, generation number and the kind of result.
    function childName(parentId, rc) {
        let generation = 1;
        for (let parent = p(parentId); parent?.kind === 'learned'; parent = p(parent.parentId))
            generation++;
        const root = lineageRoot(p(parentId)), prefix = root?.kind === 'base' ? (root.name.includes('neutral') ? 'ES neutral' : 'ES 4-bit') + ' · R' : 'DNP 4-bit · R';
        return (prefix +
            generation +
            (rc?.kind === 'cross' ? ' · crossing' : '') +
            (rc?.kind === 'final' ? ' · final round' : '') +
            (rc?.unconfirmed ? ' · unconfirmed' : '') +
            (rc?.priority === 'kills' ? ' · Hugs' : ''));
    }
    // A final-round candidate ahead of the parent but below the gate is stored as an unconfirmed child; the training base stays.
    async function keepUnconfirmed(parentId, m) {
        try {
            const recipe = { parentId, precision: 'w4', ops: m.candidate.ops, controller: m.candidate.tactical };
            if (m.receipt?.parentId !== parentId || (await revisionId(recipe)) !== m.receipt.unconfirmedId)
                throw new Error('The ID of the unconfirmed candidate does not match the training result.');
            const saved = await registry.keep({ ...recipe, name: childName(parentId, m.receipt), receipt: m.receipt });
            await refresh();
            broadcast();
            notify(finalText(m.receipt, 'Saved as unconfirmed model “' +
                name(saved) +
                '”; the training base stays ' +
                name(tip) +
                '. Performance is being measured on the reference seeds.'));
            startReference();
        }
        catch (e) {
            notify(errorText(e), true);
        }
    }
    async function winner(target, m) {
        if (target !== job || target.saving)
            return;
        target.saving = true;
        target.worker?.terminate(); // set before the worker could post this message
        controls();
        try {
            if (m.parentId !== target.parentId)
                throw new Error('The parent of the result does not match the training base.');
            const recipe = { parentId: target.parentId, precision: 'w4', ops: m.ops, controller: m.tactical };
            const digest = await revisionId(recipe);
            if (digest !== m.id ||
                m.receipt?.status !== 'promoted' ||
                m.receipt.winnerId !== digest ||
                m.receipt.parentId !== target.parentId)
                throw new Error('Model ID and confirmed training result do not match.');
            const saved = await registry.promote({
                ...recipe,
                name: childName(target.parentId, m.receipt),
                receipt: m.receipt ?? null,
            });
            if (target.run) {
                if (!target.run.generations.some((x) => x.generation === m.receipt?.round && x.kind === (m.receipt?.kind ?? 'generation')))
                    logReceipt(target.run, m.receipt);
                target.run.outcome = {
                    status: 'promoted',
                    childId: saved.id,
                    childName: name(saved),
                    kind: m.receipt?.kind ?? 'generation',
                };
            }
            await refresh(saved.id);
            selectRecord(saved);
            broadcast();
            $('revision-receipt-text').textContent = JSON.stringify(m.receipt ?? {}, null, 2);
            $('revision-receipt').hidden = false;
            endJob(target);
            notify('Confirmed model saved' +
                (m.receipt?.kind === 'final'
                    ? ' (final round: candidate ' + (m.receipt.proposal.kept + 1) + ' of ' + m.receipt.candidates.length + ')'
                    : '') +
                ': ' +
                renderName(saved) +
                '. Performance is being measured on the reference seeds.');
            bornView(saved, p(target.parentId), {
                seconds: (performance.now() - target.started) / 1000,
                decisions: target.run?.progress?.decisions ?? 0,
            });
            startReference();
        }
        catch (e) {
            if (target.run)
                target.run.outcome = { status: 'error', message: errorText(e) };
            endJob(target);
            notify(errorText(e), true);
            await refresh().catch(() => { });
        }
    }
    $('revision-learn').onclick = async () => {
        if (!registry?.persistent || job || fileBusy || isBenchmarking() || causesJob)
            return;
        // Keep the FP32 fallback at the training boundary as well as in the selector.
        const switched = switchFP32TrainingParent();
        // Adopt the selected quantized parent before starting the worker.
        const chosen = option();
        if (chosen && chosen.id !== tip?.id) {
            if (!canAdopt(chosen)) {
                notify('Choose a 4-bit parent model: ' + name(chosen) + ' cannot be trained.', true);
                return;
            }
            const before = tip?.id;
            await adopt(chosen);
            if (tip?.id === before || job || fileBusy)
                return;
        }
        stopReference();
        const plan = learning();
        // EDNO keeps its best candidates; stopping then plays a final round instead of discarding them.
        const target = {
            parentId: null,
            worker: null,
            saving: false,
            clock: 0,
            started: performance.now(),
            edno: plan.method === 'edno',
            kept: [],
            finishing: false,
        };
        job = target;
        // `run` is `target.run` for the rest of this run (assigned once, read in the callbacks below).
        const run = (target.run = {
            format: 'agm.dnp.training-run/1',
            runId: crypto.randomUUID(),
            startedAt: new Date().toISOString(),
            page: location.href.split('#')[0],
            settings: {
                learning: plan,
                priority: priority(),
                diversity: diversity(),
                lanesRequested: lanes(),
                watch: $('revision-watch').checked,
            },
            environment: environment(),
            code: null,
            parentId: null,
            parentName: null,
            searchSeed: null,
            lineageAnchors: [],
            generations: [],
            receipts: [],
            progress: { games: 0, decisions: 0, elapsedSeconds: 0, lanes: null, maxDecisionsPerSecond: 0 },
            outcome: { status: 'running' },
        });
        void codeFingerprint()
            .then((code) => {
            run.code ??= code;
        })
            .catch(() => { });
        notify(switched ? quantizedParentMessage : '');
        $('revision-progress').hidden = false;
        $('revision-receipt').hidden = true;
        $('revision-progress-text').textContent = 'Checking the latest 4-bit model …';
        $('revision-phase').textContent = 'Start';
        $('revision-round').textContent = '0';
        $('revision-games').textContent = '0';
        $('revision-decisions').textContent = '0';
        $('revision-lanes-active').textContent = lanes() + ' requested';
        $('revision-rate').textContent = '—';
        $('training-overlay').textContent = 'Training...';
        trainingView($('revision-watch').checked);
        updateTime(target);
        target.clock = setInterval(() => updateTime(target), 1000);
        controls();
        try {
            const parent = await registry.latest();
            if (job !== target)
                return;
            if (!parent || parent.precision !== 'w4' || !parent.controller)
                throw new Error('The latest 4-bit training base could not be loaded.');
            if (parent.id !== chosen?.id)
                throw new Error('The training base changed before the run started. Select the parent model and try again.');
            target.parentId = parent.id;
            tip = parent;
            controls();
            pauseGame();
            run.parentId = parent.id;
            run.parentName = name(parent);
            const w = new Worker(moduleUrl('workers/training-worker'), { type: 'module' });
            target.worker = w;
            w.onmessage = ({ data: m }) => {
                if (job !== target || target.saving)
                    return;
                if (m.type === 'progress') {
                    if (Array.isArray(m.kept)) {
                        target.kept = m.kept;
                        controls();
                    }
                    logProgress(target, m);
                    showProgress(m);
                }
                else if (m.type === 'frame')
                    frame(m);
                else if (m.type === 'winner')
                    void winner(target, m);
                else if (m.type === 'final-result' && m.receipt?.status !== 'promoted') {
                    logReceipt(run, m.receipt);
                    run.outcome = {
                        status: m.receipt?.unconfirmed ? 'unconfirmed' : 'retained',
                        reason: m.receipt?.reason ?? null,
                        childId: m.receipt?.unconfirmed ? (m.receipt.unconfirmedId ?? null) : null,
                        kind: 'final',
                    };
                    endJob(target);
                    $('revision-receipt-text').textContent = JSON.stringify(m.receipt, null, 2);
                    $('revision-receipt').hidden = false;
                    // target.parentId is parent.id from here on.
                    if (m.receipt?.unconfirmed && m.candidate)
                        void keepUnconfirmed(parent.id, m);
                    else
                        notify(finalText(m.receipt));
                }
                else if (m.type === 'stopped')
                    stop('Training run ended. No new model saved.');
                else if (m.type === 'error') {
                    run.outcome = { status: 'error', message: m.message || 'Training run failed.' };
                    endJob(target);
                    notify(m.message || 'Training run failed.', true);
                }
            };
            w.onerror = (e) => {
                if (job !== target)
                    return;
                endJob(target);
                notify(e.message || 'Training worker could not be started.', true);
            };
            const searchSeed = crypto.getRandomValues(new Uint32Array(1))[0], laneCount = lanes();
            run.searchSeed = searchSeed;
            $('revision-progress-text').textContent =
                'Training from ' +
                    renderName(parent) +
                    ' · search seed ' +
                    searchSeed +
                    ' · ' +
                    laneCount +
                    ' CPU core' +
                    (laneCount > 1 ? 's' : '') +
                    '.';
            // Every W4 ancestor is a lineage anchor (oldest first): a child must not fall behind any of them.
            const lineage = [];
            for (let a = p(parent.parentId); a; a = p(a.parentId))
                if (a.precision === 'w4')
                    lineage.unshift({
                        label: a.kind === 'shipped' ? 'shipped' : a.kind === 'base' ? 'lineage-root' : name(a) + ' · ' + short(a.id),
                        ops: a.ops,
                        controller: a.controller,
                    });
            // Credit learned while producing the parent continues in this run (protocol 5).
            run.lineageAnchors = lineage.map((x) => x.label);
            const credit = plan.method !== 'edno' && plan.credit
                ? ((await registry.receipt?.(parent.id).catch(() => null))?.credit ?? [])
                : [];
            if (job !== target)
                return;
            w.postMessage({
                type: 'start',
                parent: { id: parent.id, ops: parent.ops, tactical: parent.controller },
                searchSeed,
                watch: $('revision-watch').checked,
                lanes: laneCount,
                lineage,
                diversity: diversity(),
                priority: priority(),
                learning: plan,
                credit,
            });
        }
        catch (e) {
            if (job === target) {
                endJob(target);
                notify(errorText(e), true);
            }
        }
    };
    // EDNO: the first click finishes the run with the final round of the kept candidates; the second click stops at once.
    $('revision-stop').onclick = () => {
        const t = job;
        if (t && !t.saving && t.edno && !t.finishing && t.worker) {
            t.finishing = true;
            t.worker.postMessage({ type: 'finish' });
            controls();
            notify((t.kept.length
                ? 'The training run ends after the current game round: the ' +
                    (t.kept.length > 1 ? t.kept.length + ' best candidates play' : 'best candidate plays') +
                    ' against the parent on fresh seeds, and the best is validated as in every generation.'
                : 'The training run ends as soon as the race of this generation yields candidates: then the best ones play against the parent on fresh seeds, and the best is validated as in every generation.') +
                ' Click again to abort at once.');
            return;
        }
        stop();
    };
    const finalReasons = {
        'Candidate fell behind the parent early in validation': 'it fell behind the parent early in validation',
        'Candidate not significantly better than the parent': 'it is not clearly better than the parent',
        'Candidate did not raise utility': 'it does not raise fitness',
        'A lineage anchor is ahead on the same seeds': 'an ancestor is ahead on the same seeds',
    };
    function finalText(rc, saved = 'No model saved.') {
        const n = rc?.candidates?.length ?? 0, v = rc?.validation;
        if (!n)
            return 'Training run ended. No candidate was ahead of the parent yet; no model saved.';
        if (rc.selection?.chosen == null)
            return ('Training run ended. In the final round ' +
                (n > 1 ? 'none of the ' + n + ' candidates was' : 'the candidate was not') +
                ' ahead of the parent; no model saved.');
        // Below the gate: say whether the candidate was ahead at all on the fresh seeds.
        const short = rc.reason === 'Candidate not significantly better than the parent' && v
            ? v.stats.mean > 0
                ? 'it is ahead, but below the threshold t ≥ 2'
                : 'on average it is not ahead of the parent'
            : null;
        const why = short ||
            finalReasons[rc.reason] ||
            (/control goal/.test(rc.reason) ? 'it is clearly worse in the control goal' : rc.reason);
        return ('Training run ended. Best candidate of the final round (' +
            (rc.selection.chosen + 1) +
            ' of ' +
            n +
            ') not confirmed: ' +
            why +
            (v ? ' (t ' + tStat(v.stats.t) + ' on ' + v.games + ' fresh seeds)' : '') +
            '. ' +
            saved);
    }
    $('revision-watch').onchange = () => {
        const watching = $('revision-watch').checked;
        trainingView(!!job && watching);
        job?.worker?.postMessage({ type: 'watch', watch: watching });
    };
    const ready = (async () => {
        try {
            registry = await openRevisionStore();
            await refresh();
            const saved = p(read(activeKey)) || tip || registry.builtins.shipped;
            if (saved)
                setActive(saved, false);
            if (!registry.persistent)
                notify('Local model storage is not available. The built-in models can be played and downloaded.', true);
            if ('BroadcastChannel' in window) {
                channel = new BroadcastChannel('agm-model-revisions-v8');
                channel.onmessage = () => void refresh().catch((e) => notify(errorText(e), true));
            }
        }
        catch (e) {
            notify(errorText(e), true);
            controls();
        }
    })();
    window.addEventListener('focus', () => void refresh().catch((e) => notify(errorText(e), true)));
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden)
            void refresh().catch((e) => notify(errorText(e), true));
    });
    window.addEventListener('pagehide', () => {
        if (job && !job.saving)
            endJob(job);
    });
    return {
        ready,
        controls,
        get active() {
            return active;
        },
        get learning() {
            return !!job;
        },
        // Weight explorer from a model card: the model against its 4-bit base (Astra 6's composite: against the neutral 4-bit base).
        exploreBuiltin(key) {
            const r = builtinOf(registry?.builtins, key);
            if (!r)
                return false;
            void explore(r, key === 'shipped' ? registry.builtins.neutral : null);
            return true;
        },
        playModel(id) {
            const r = p(id);
            if (!r)
                return false;
            return setActive(r, true);
        },
        playBuiltin(key) {
            const r = builtinOf(registry.builtins, key);
            if (!r)
                return false;
            return setActive(r, true);
        },
        playChoice() {
            const r = p(selectedId);
            return r ? setActive(r, true) : false;
        },
        async restoreBuiltin(variant) {
            await ready;
            const r = variant === 'original' ? registry?.builtins.original : registry?.builtins.shipped;
            if (r) {
                selectRecord(r);
                setActive(r, false);
            }
        },
        async restore(id) {
            await ready;
            const r = p(id);
            if (r) {
                selectRecord(r);
                setActive(r, false);
            }
        },
    };
}

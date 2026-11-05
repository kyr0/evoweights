/** Page controller of the live arena: model picker, game worker, human play, backend choice and the inference benchmark. */
import { cpuThreadLimit } from '../model/cpu-limits.js';
import { moduleUrl, siteUrl } from '../shared/site.js';
import { installRecorder } from './recorder.js';
import { installRevisions } from './revisions-panel.js';
import { HuggingDoomView } from './huggingdoom.js';
import { PicnicAudio } from './picnic-audio.js';
/** The page's required elements; a missing one is a markup bug and fails at first use, as before. */
function $(selector) {
    return document.querySelector(selector);
}
const canvas = $('#screen'), ctx = canvas.getContext('2d', { alpha: false });
const names = ['LEFT', 'RIGHT', 'HONEY', 'WAIT'];
const picnicView = new HuggingDoomView();
const picnicAudio = new PicnicAudio();
let muted = false;
$('#picnic-sound').onclick = () => {
    muted = !muted;
    picnicAudio.setMuted(muted);
    $('#picnic-sound').textContent = muted ? 'Sound off' : 'Sound on';
    if (!muted)
        void picnicAudio.unlock().catch(() => { });
};
const variants = {
    dnp: 'Astra 6 Weight-Space Programming',
    original: 'Original weights (FP32)',
};
const headline = {
    idle: 'STANDBY',
    loading: 'LOADING',
    live: 'LIVE',
    paused: 'PAUSED',
    ended: 'FINISHED',
    error: 'OFFLINE',
};
const roleLabel = { parent: 'Elternrevision', plus: 'Kandidat +', minus: 'Kandidat −' };
let trainingPreview = false;
let benchWorker = null, timingBusy = false, revisions = null, activeRevision = null;
let worker = null, state = 'idle', variant = 'dnp', currentSeed = 9000, nextTimer = null;
let rateMark = null;
const recorder = installRecorder(canvas, { button: $('#download-recording') }, () => currentSeed);
const cpuLimit = cpuThreadLimit();
const vcpus = $('#vcpus'), gpu = $('#gpu'), wasm = $('#wasm'), seedInput = $('#seed'), benchmark = $('#benchmark');
for (let i = 2; i <= cpuLimit; i++)
    vcpus.add(new Option(String(i), String(i)));
function requestedBackend() {
    return gpu.checked ? 'gpu' : 'cpu' + vcpus.value;
}
function lockConfig(locked) {
    gpu.disabled = locked;
    wasm.disabled = locked;
    vcpus.disabled = locked || gpu.checked;
}
$('#regions').innerHTML = '<i></i>'.repeat(9);
$('#logits').innerHTML = names
    .map((n) => '<div class="logit" ' +
    (n === 'WAIT' ? 'hidden' : '') +
    '><span>' +
    n +
    '</span><div class="track"><i></i></div><output>—</output></div>')
    .join('');
// The model menu never scrolls: while it is shown, the game view grows to fit it (min-height; the canvas covers the extra space).
function fitPick() {
    const v = document.querySelector('#viewport'), pk = document.querySelector('#pick');
    if (!v || !pk)
        return;
    const shown = !pk.hidden && !$('#overlay').hidden;
    v.style.minHeight = shown ? Math.ceil(pk.parentElement.scrollHeight) + 24 + 'px' : '';
}
if (typeof ResizeObserver === 'function')
    new ResizeObserver(fitPick).observe($('#pick'));
function status(s, detail) {
    state = s;
    recorder.state(s);
    picnicAudio.setPlaying(s === 'live');
    benchmark.disabled = timingBusy || s === 'loading' || !!revisions?.learning;
    const previewing = trainingPreview && s !== 'live';
    const badge = $('#status');
    badge.lastChild.nodeValue = ' ' + (previewing ? 'LEARNING' : headline[s]);
    badge.dataset.live = s === 'live' || previewing ? 'yes' : 'no';
    const running = ['live', 'paused', 'ended'].includes(s);
    $('#toggle').disabled = !running;
    $('#restart').disabled = !running;
    $('#new-seed').disabled = s === 'loading';
    seedInput.disabled = s === 'loading';
    $('#toggle-text').textContent = s === 'ended' ? 'Play again' : s === 'paused' ? 'Resume' : 'Pause';
    // Pause shows the pause symbol, also while disabled; only Resume and Play again show ▶.
    $('#toggle .symbol').textContent = s === 'paused' || s === 'ended' ? '▶' : 'Ⅱ';
    $('#overlay').hidden = s === 'live' || previewing;
    $('#progress').hidden = s !== 'loading';
    const picking = s === 'idle' || s === 'paused';
    $('#picnic-summary').hidden = s !== 'ended';
    $('#pick').hidden = !picking;
    const launchButton = $('#launch');
    launchButton.hidden = s === 'loading' || s === 'idle' || s === 'paused'; // the header button resumes or plays again
    if (s !== 'live') {
        rateMark = null;
        if (!revisions?.learning)
            $('#decision-rate').textContent = '—';
    }
    launchButton.disabled = s === 'loading';
    const launchLabel = {
        idle: 'Start live run',
        error: 'Retry',
        paused: 'Resume',
        ended: 'Play again',
    };
    launchButton.innerHTML = '<span aria-hidden="true">▶</span> ' + (launchLabel[s] || 'Start live run');
    $('#overlay-eyebrow').textContent =
        {
            idle: 'WELCOME TO HUGGINGDOOM',
            loading: 'PREPARING LIVE SESSION',
            error: 'SESSION UNAVAILABLE',
            paused: 'SESSION PAUSED',
            ended: 'EVERYONE IS INVITED TO THE PICNIC',
        }[s] || '';
    $('#load-detail').textContent =
        detail ||
            { loading: human ? 'Opening the meadow…' : 'Loading the meadow and model…' }[s] ||
            '';
}
function activeLabel() {
    return activeRevision?.name || variants[variant];
}
function revisionArgs() {
    if (!activeRevision)
        return {};
    const args = { revisionId: activeRevision.id };
    if (activeRevision.kind !== 'original' && activeRevision.kind !== 'shipped' && activeRevision.controller)
        args.revision = { ops: activeRevision.ops, tactical: activeRevision.controller };
    return args;
}
export function activateRevision(record, play) {
    if (timingBusy)
        return false;
    const choice = record.kind === 'original' ? 'original' : 'dnp';
    if (activeRevision?.id === record.id && !(play && humanPlay())) {
        if (play && state !== 'live' && state !== 'loading')
            launch();
        return true;
    }
    const wasStarted = !!worker;
    leaveWorker();
    // Every model-play action leaves keyboard mode, including the new-model congratulations dialog.
    if (play)
        setHuman(false);
    variant = choice;
    activeRevision = record;
    $('#viewport').classList.remove('running');
    $('#stage-mode').textContent = 'Preview · ' + activeLabel();
    for (const id of ['health', 'ammo', 'kills', 'bears-fed', 'bears-befriended', 'times-bitten'])
        $('#' + id).textContent = '—';
    $('#health').setAttribute('aria-label', 'No hearts yet');
    $('#game-time').textContent = '0:00';
    $('#actual-backend').textContent = 'Awaiting action';
    $('#backend-detail').textContent = '';
    $('#guard-status').textContent =
        choice === 'dnp' ? 'Facing guard · awaiting first decision' : 'Original model · three raw action logits';
    status('idle');
    if (play) {
        if (wasStarted)
            seedInput.value = String(currentSeed);
        launch();
    }
    return true;
}
function seedValue() {
    const x = Number(seedInput.value);
    if (!Number.isInteger(x) || x < 0 || x > 4294967295 || seedInput.value.trim() === '') {
        throw new Error('Enter a seed from 0 to 4294967295.');
    }
    return x;
}
// Decisions per second of the live game, from the worker's step counter over windows of at least one second (rateMark: see globals).
function liveRate(p) {
    if (trainingPreview || !Number.isFinite(p.n))
        return;
    const now = performance.now();
    if (!rateMark || p.n < rateMark.n) {
        rateMark = { n: p.n, t: now };
        return;
    }
    if (now - rateMark.t >= 1000) {
        $('#decision-rate').textContent = Math.round(((p.n - rateMark.n) * 1000) / (now - rateMark.t)).toLocaleString('en-US');
        rateMark = { n: p.n, t: now };
    }
}
function showFrame(pixels, width, height) {
    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
    }
    ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
    $('#viewport').classList.add('running');
}
function showCounters(health, ammo, friends, tic, picnic) {
    const hearts = picnic?.hearts ?? Math.max(0, Math.ceil(health / 20));
    $('#health').textContent = '♥'.repeat(hearts) + '♡'.repeat(Math.max(0, 5 - hearts));
    $('#health').setAttribute('aria-label', hearts + ' of 5 hearts');
    $('#ammo').textContent = String(ammo);
    $('#kills').textContent = String(friends);
    $('#bears-fed').textContent = picnic ? String(picnic.bearsFed) : '—';
    $('#bears-befriended').textContent = picnic ? String(picnic.bearsBefriended) : '—';
    $('#times-bitten').textContent = picnic ? String(picnic.timesBitten) : '—';
    $('#game-time').textContent = gameClock(picnic?.activeTics ?? tic);
    $('#picnic-mode').textContent = picnic?.ending
        ? ''
        : ammo
            ? 'Honey is safe. Make every honeycomb count.'
            : humanPlay()
                ? 'Hugs are unlimited. Get close, then hold Space!'
                : 'Hugs are unlimited.';
    if (picnic)
        $('#picnic-summary').textContent =
            '🍯 ' +
                picnic.bearsFed +
                ' bears fed · 🤗 ' +
                picnic.bearsBefriended +
                ' bears befriended · 😬 ' +
                picnic.timesBitten +
                ' times bitten.';
}
function draw(p) {
    liveRate(p);
    showFrame(p.rgba, p.width, p.height);
    picnicView.draw(ctx, p);
    picnicAudio.update(p);
    showCounters(p.health, p.ammo, p.kills, p.tic, p.picnic);
    $('#stage-mode').textContent = 'Seed ' + p.seed + ' · ' + (p.decision?.human ? 'You play · keyboard' : activeLabel());
    $('#regions')
        .querySelectorAll('i')
        .forEach((b, i) => {
        const fraction = p.regions[i];
        b.style.setProperty('--fill', Math.min(100, 800 * fraction) + '%');
        b.title = 'Region ' + (i + 1) + ' · ' + (100 * fraction).toFixed(1) + '%';
    });
    showBackend(p.backend);
    if (p.threat) {
        $('#range').textContent = p.threat.visible
            ? 'Nearest · ' + Math.round(p.threat.distance) + ' map units'
            : 'No bear in sight';
    }
    const move = p.decision;
    const aimLabel = move?.action === 2 && move.weapon === 'fist' ? 'HUG' : names[move?.action];
    $('#maneuver').textContent = move
        ? (move.human ? 'YOU · ' : '') + (move.forward ? 'FORWARD + ' : move.backward ? 'BACK + ' : '') + aimLabel
        : '—';
    $('#weapon').textContent =
        (p.ammo > 0 ? 'Honey thrower' : 'Enormous soft arms') + (p.damage ? ' · Oops! One heart lost' : '');
    const mem = move?.memory;
    $('#intent').textContent = mem
        ? (mem.id
            ? 'Recall · #' + mem.id + ' · ' + mem.age + ' tics ago' + (mem.approachBonus > 0 ? ' · closing when seen' : '')
            : 'Tracked · ' + mem.count) + (move?.mode && move.mode !== 'prior' ? ' · ' + move.mode : '')
        : 'Memory off';
    const defense = move?.guard;
    $('#guard-status').textContent =
        variant === 'original'
            ? 'Original model · three raw action logits'
            : defense?.rearBlocked
                ? 'Facing guard · rear path blocked'
                : defense?.feature
                    ? 'Facing guard · retreat · ' + Math.round((defense.ageTics * 1000) / 35) + ' ms facing'
                    : defense?.facing
                        ? 'Facing guard · tracking bear orientation'
                        : p.weapon === 'fist'
                            ? 'Facing guard · no qualifying target'
                            : 'Facing guard · waiting for hug mode';
    const decision = p.decision;
    if (!decision)
        return;
    if (decision.human) {
        document.querySelectorAll('.logit').forEach((row) => {
            row.hidden = true;
        });
        $('#timing').textContent = 'Step ' + p.n + ' · keyboard control, no inference';
        return;
    }
    const z = decision.logits;
    const v = z.map((x) => Math.exp(x - Math.max(...z))), sum = v.reduce((a, b) => a + b, 0);
    [...document.querySelectorAll('.logit')].forEach((row, i) => {
        row.hidden = i >= z.length;
        if (row.hidden)
            return;
        const actionName = i === 2 && decision.weapon === 'fist' ? 'HUG' : names[i];
        row.querySelector('span').textContent = actionName;
        row.querySelector('output').textContent = z[i].toFixed(2);
        row.querySelector('i').style.width = (v[i] / sum) * 100 + '%';
        row.classList.toggle('active', i === decision.action);
        row.title = actionName + ' · ' + ((100 * v[i]) / sum).toFixed(1) + '% softmax';
    });
    $('#timing').textContent =
        'Step ' +
            p.n +
            ' · ' +
            (p.perfN
                ? 'p50 ' +
                    p.inferenceP50.toFixed(1) +
                    ' / p95 ' +
                    p.inferenceP95.toFixed(1) +
                    ' ms (' +
                    p.perfN +
                    ')'
                : 'warming up · ' + p.inferenceMs.toFixed(1) + ' ms');
}
function clearNext() {
    if (nextTimer)
        clearTimeout(nextTimer);
    nextTimer = null;
}
function gameClock(tic) {
    const seconds = Math.floor(tic / 35);
    return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}
// The learning run borrows the arena canvas while the live game is paused. Starting the game hands it back.
function trainingView(active) {
    trainingPreview = !!active;
    if (!trainingPreview)
        $('#stage-mode').textContent =
            (worker && state !== 'idle' ? 'Seed ' + currentSeed : 'Preview') + ' · ' + activeLabel();
    status(state);
}
function trainingFrame(m) {
    if (!trainingPreview || state === 'live' || state === 'loading')
        return;
    showFrame(m.pixels, m.width, m.height);
    picnicView.draw(ctx, m);
    showCounters(m.health, m.ammo, m.kills, m.tic, m.picnic);
    $('#stage-mode').textContent =
        'Training · Seed ' +
            m.seed +
            ' · Gen ' +
            m.round +
            ' · ' +
            (roleLabel[m.role] || m.role) +
            (m.phase === 'validation' ? ' · validation' : '') +
            (Number.isFinite(m.lane) ? ' · Core ' + (m.lane + 1) : '');
}
function leaveTrainingView() {
    if (trainingPreview) {
        const box = document.querySelector('#revision-watch');
        if (box)
            box.checked = false;
        trainingView(false);
    }
}
function leaveWorker() {
    clearNext();
    recorder.stop();
    picnicAudio.reset();
    if (worker) {
        worker.terminate();
        worker = null;
    }
}
function postToWorker(message) {
    worker?.postMessage(message);
}
function onWorker({ data: p }) {
    if (p.type === 'loading') {
        const pct = Math.round((100 * p.loaded) / p.total);
        $('#progress').value = pct;
        $('#load-detail').textContent = activeLabel() + ' · ' + pct + '%';
    }
    if (p.type === 'ready' || p.type === 'resumed')
        status('live');
    if (p.type === 'frame')
        draw(p);
    if (p.type === 'paused')
        status('paused');
    if (p.type === 'end')
        status('ended');
    if (p.type === 'error') {
        leaveWorker();
        status('error', p.message);
    }
}
/**
 * Fallback for model buttons: leave keyboard mode first, as activateRevision does, then launch.
 * VERIFIED: launch() keeps the current mode, so a refused model button used to resume the visitor's keyboard game.
 */
function launchModel() {
    if (humanPlay()) {
        leaveWorker();
        setHuman(false);
    }
    launch();
}
function launch() {
    if (timingBusy)
        return;
    if (state === 'loading')
        return;
    void picnicAudio.unlock().catch(() => { });
    leaveTrainingView();
    if (state === 'paused') {
        postToWorker({ type: 'resume' });
        return;
    }
    let seed;
    try {
        seed = seedValue();
    }
    catch (e) {
        $('#session-message').textContent = e.message;
        return;
    }
    if (state === 'ended') {
        restart(seed);
        return;
    }
    currentSeed = seed;
    picnicView.reset();
    picnicAudio.reset();
    leaveWorker();
    status('loading');
    $('#progress').value = 0;
    let started;
    try {
        started = new Worker(moduleUrl('workers/play-worker'), { type: 'module' });
    }
    catch (e) {
        status('error', e.message || 'Could not start the simulator.');
        return;
    }
    worker = started;
    started.onmessage = (e) => {
        if (e.currentTarget === worker)
            onWorker(e);
    };
    started.onerror = (e) => {
        if (e.currentTarget !== worker)
            return;
        leaveWorker();
        status('error', e.message || 'Could not start the simulator.');
    };
    postToWorker({
        type: 'init',
        seed,
        variant,
        policy: variant,
        backend: requestedBackend(),
        human: humanPlay(),
        limitTics: 0,
        ...revisionArgs(),
    });
}
// Human play: arrows or WASD move, Space / Alt / Ctrl attack. The page streams key states to the worker; episodes are not time-limited.
let human = false;
const humanPlay = () => human;
const keyMap = {
    ArrowLeft: 'left',
    KeyA: 'left',
    ArrowRight: 'right',
    KeyD: 'right',
    ArrowUp: 'forward',
    KeyW: 'forward',
    ArrowDown: 'backward',
    KeyS: 'backward',
    Space: 'fire',
    AltLeft: 'fire',
    AltRight: 'fire',
    ControlLeft: 'fire',
    ControlRight: 'fire',
};
const keys = { left: false, right: false, forward: false, backward: false, fire: false };
function sendKeys() {
    postToWorker({ type: 'control', keys: { ...keys } });
}
function releaseKeys() {
    let any = false;
    for (const k of Object.keys(keys)) {
        any ||= keys[k];
        keys[k] = false;
    }
    if (any)
        sendKeys();
}
function handleKey(e, down) {
    if (!humanPlay() || !(e.code in keyMap) || e.target?.closest?.('input,textarea,select'))
        return false;
    e.preventDefault();
    if (e.repeat)
        return true;
    const k = keyMap[e.code];
    if (keys[k] !== down) {
        keys[k] = down;
        sendKeys();
    }
    return true;
}
document.querySelectorAll('[data-control]').forEach((button) => {
    const key = button.dataset.control;
    const release = () => {
        keys[key] = false;
        sendKeys();
    };
    button.addEventListener('pointerdown', (e) => {
        if (!humanPlay() || state !== 'live')
            return;
        e.preventDefault();
        button.setPointerCapture(e.pointerId);
        keys[key] = true;
        sendKeys();
    });
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('lostpointercapture', release);
});
// The overlay menu chooses between a model and the visitor; the choice holds until the next pick.
function setHuman(on) {
    if (human === on)
        return;
    human = on;
    releaseKeys();
    if (worker && ['live', 'paused', 'ended'].includes(state))
        postToWorker({ type: 'human', on });
    $('#keys-hint').hidden = !on;
    $('#touch-controls').hidden = !on;
    if (on && state === 'live')
        $('#stage-mode').textContent = 'Seed ' + currentSeed + ' · You play · keyboard';
    else if (!on && state === 'live')
        $('#stage-mode').textContent = 'Seed ' + currentSeed + ' · ' + activeLabel();
}
document.addEventListener('keyup', (e) => {
    handleKey(e, false);
});
window.addEventListener('blur', releaseKeys);
function restart(seed) {
    if (timingBusy)
        return;
    clearNext();
    recorder.stop();
    leaveTrainingView();
    currentSeed = seed;
    picnicView.reset();
    picnicAudio.reset();
    if (worker && ['live', 'paused', 'ended'].includes(state)) {
        postToWorker({ type: 'reset', seed });
    }
    else if (state !== 'loading') {
        launch();
    }
}
function toggle() {
    if (state === 'live')
        postToWorker({ type: 'pause' });
    else if (state !== 'loading')
        launch();
}
$('#launch').onclick = async () => {
    void picnicAudio.unlock().catch(() => { });
    if (humanPlay() || state === 'ended') {
        launch();
        return;
    }
    await revisions?.ready;
    if (!revisions?.playChoice())
        launch();
};
// Overlay picker: each card plays one shipped model; the last button hands the controls to the visitor.
document.querySelectorAll('#pick [data-pick]').forEach((b) => (b.onclick = async () => {
    void picnicAudio.unlock().catch(() => { });
    await revisions?.ready;
    if (!revisions?.playBuiltin?.(b.dataset.pick))
        launchModel();
}));
// Each built-in model card opens its matching weight comparison.
document.querySelectorAll('#pick [data-explore]').forEach((b) => (b.onclick = async () => {
    await revisions?.ready;
    revisions?.exploreBuiltin?.(b.dataset.explore);
}));
// "Your own models": the card is filled by the revision panel; its button plays the chosen model.
document.addEventListener('click', async (e) => {
    const b = e.target?.closest?.('[data-own-play]');
    if (!b)
        return;
    void picnicAudio.unlock().catch(() => { });
    await revisions?.ready;
    const id = document.querySelector('#pick-own-select')?.value;
    if (!id || !revisions?.playModel?.(id))
        launchModel();
});
document.querySelector('#pick-human')?.addEventListener('click', () => {
    void picnicAudio.unlock().catch(() => { });
    setHuman(true);
    if (state === 'ended')
        restart(currentSeed);
    else
        launch();
});
$('#toggle').onclick = toggle;
// Restart ends the current game (its recording stays downloadable) and returns to the model menu.
function menu() {
    if (timingBusy || state === 'loading')
        return;
    leaveTrainingView();
    leaveWorker();
    $('#viewport').classList.remove('running');
    status('idle');
}
$('#restart').onclick = menu;
$('#new-seed').onclick = () => {
    const val = crypto.getRandomValues(new Uint32Array(1))[0];
    seedInput.value = String(val);
    restart(val);
};
seedInput.onkeydown = (e) => {
    if (e.key !== 'Enter')
        return;
    if (state === 'idle')
        launch();
    else
        try {
            restart(seedValue());
        }
        catch (err) {
            $('#session-message').textContent = err.message;
        }
};
$('#full').onclick = async () => {
    try {
        if (document.fullscreenElement)
            await document.exitFullscreen();
        else
            await $('#viewport').requestFullscreen();
    }
    catch {
        $('#session-message').textContent = 'Fullscreen is unavailable in this viewer.';
    }
};
document.addEventListener('keydown', (e) => {
    if (handleKey(e, true))
        return;
    if (e.code === 'Space' && !e.repeat && e.target === document.body) {
        e.preventDefault();
        toggle();
    }
});
document.addEventListener('visibilitychange', () => {
    if (document.hidden && state === 'live')
        postToWorker({ type: 'pause' });
});
window.addEventListener('pagehide', leaveWorker);
window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
        status('idle');
        $('#viewport').classList.remove('running');
    }
});
status('idle');
function backendName(r) {
    if (!r)
        return 'awaiting backend';
    if (r.backend === 'human')
        return 'Keyboard / touch · no model download';
    if (r.backend === 'webgpu-hybrid')
        return 'WebGPU hybrid';
    if (r.backend === 'wasm-simd-threaded')
        return 'WASM SIMD · ' + r.threads + ' threads';
    return 'WASM SIMD · 1 thread';
}
function showBackend(r) {
    if (!r)
        return;
    $('#actual-backend').textContent = backendName(r);
    const adapter = r.adapter;
    $('#backend-detail').textContent =
        r.reason ||
            (r.backend === 'webgpu-hybrid' && adapter ? String(adapter.description || adapter.device || adapter) : '');
}
// Static hosts may omit the isolation headers needed for a shared WebAssembly memory.
const isolationKey = 'agm-dnp-thread-reload-v2';
async function restoreThreadSelection() {
    try {
        const saved = sessionStorage.getItem(isolationKey);
        if (!saved)
            return;
        sessionStorage.removeItem(isolationKey);
        const item = JSON.parse(saved);
        if (!/^cpu[2-8]$/.test(item.backend))
            return;
        vcpus.value = String(Math.min(cpuLimit, Number(item.backend.slice(3))));
        seedInput.value = String(item.seed);
        currentSeed = item.seed;
        await revisions?.ready;
        if (item.revisionId)
            await revisions?.restore(item.revisionId);
        else if (item.variant in variants)
            await revisions?.restoreBuiltin(item.variant);
        if (!crossOriginIsolated)
            $('#backend-detail').textContent =
                'This origin cannot enable shared memory. CPU requests fall back to one thread.';
        if (item.running)
            launch();
    }
    catch {
        /* A browser that blocks session storage can still run single-thread WASM. */
    }
}
async function prepareThreads(request, wasActive) {
    if (!/^cpu[2-8]$/.test(request) ||
        crossOriginIsolated ||
        !window.isSecureContext ||
        window.top !== window ||
        !('serviceWorker' in navigator) ||
        navigator.serviceWorker.controller)
        return false;
    let timeout;
    try {
        lockConfig(true);
        benchmark.disabled = true;
        $('#backend-detail').textContent = 'Enabling shared memory; the page will reload once.';
        const enable = async () => {
            await navigator.serviceWorker.register(siteUrl('cpu-isolation.js'));
            await navigator.serviceWorker.ready;
        };
        await Promise.race([
            enable(),
            new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error('Activation timed out')), 8000);
            }),
        ]);
        const reload = {
            backend: request,
            seed: seedValue(),
            variant,
            revisionId: activeRevision?.id,
            running: wasActive,
        };
        sessionStorage.setItem(isolationKey, JSON.stringify(reload));
        location.reload();
        return true;
    }
    catch (e) {
        $('#backend-detail').textContent = 'Shared memory unavailable: ' + e.message;
        return false;
    }
    finally {
        clearTimeout(timeout);
        lockConfig(false);
        benchmark.disabled = timingBusy || state === 'loading';
    }
}
// The backend choice applies to the next game or training run; a running game keeps its backend.
async function changeBackend() {
    const request = requestedBackend();
    lockConfig(false);
    const running = !!worker && state !== 'idle';
    if (!running) {
        $('#actual-backend').textContent = 'Awaiting action';
        $('#backend-detail').textContent = '';
    }
    await prepareThreads(request, false);
}
for (const input of [wasm, gpu, vcpus])
    input.onchange = changeBackend;
revisions = installRevisions({
    activate: activateRevision,
    pauseGame() {
        clearNext();
        if (state === 'live')
            postToWorker({ type: 'pause' });
    },
    isBenchmarking: () => timingBusy,
    onActivity(learning) {
        benchmark.disabled = timingBusy || state === 'loading' || learning;
        lockConfig(timingBusy || learning);
        // During training the toolbar reads "Training" followed by the training rate instead of the game backend.
        $('#backend-label').textContent = learning ? 'Training' : 'Active';
        $('#actual-backend').hidden = learning;
    },
    trainingFrame,
    trainingView,
});
void restoreThreadSelection();
function finishBench() {
    benchWorker?.terminate();
    benchWorker = null;
    timingBusy = false;
    benchmark.disabled = state === 'loading';
    $('#cancel-bench').hidden = true;
    lockConfig(false);
    revisions?.controls();
}
$('#cancel-bench').onclick = () => {
    finishBench();
    $('#bench-status').textContent = 'Benchmark cancelled.';
};
// Performance tabs: the researcher's runs, or this machine. Run Benchmark switches to "Your machine" and starts.
function perfTab(key, focus = false) {
    for (const [k, id] of [
        ['research', '#perf-tab-research'],
        ['yours', '#perf-tab-yours'],
    ]) {
        const t = $(id), on = k === key;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        $('#' + t.getAttribute('aria-controls')).hidden = !on;
        if (on && focus)
            t.focus();
    }
}
$('#perf-tab-research').onclick = () => perfTab('research');
$('#perf-tab-yours').onclick = () => perfTab('yours');
$('.perf-tabs').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        perfTab(e.key === 'ArrowLeft' || e.key === 'Home' ? 'research' : 'yours', true);
    }
});
benchmark.addEventListener('click', () => perfTab('yours'));
function showBenchResult(r, modelLabel) {
    showBackend(r);
    $('#bench-table').hidden = false;
    const row = document.createElement('tr'), label = backendName(r);
    [
        modelLabel,
        label + (r.reason ? ' (fallback)' : ''),
        r.p50.toFixed(1) + ' ms',
        r.p95.toFixed(1) + ' ms',
        r.matched + ' / ' + r.samples,
    ].forEach((str) => {
        const td = document.createElement('td');
        td.textContent = str;
        row.append(td);
    });
    $('#bench-results').prepend(row);
    // A handle for inspecting the last result from the console.
    window.lastKumoBenchmark = r;
    $('#bench-status').textContent =
        (r.passed ? 'Parity passed' : 'Parity mismatch') +
            ' · ' +
            (r.referenceKind === 'pytorch-projected' ? 'PyTorch head projection' : 'PyTorch reference') +
            ' · max logit error ' +
            r.maxError.toPrecision(2) +
            (r.reason ? ' · ' + r.reason : '');
}
benchmark.onclick = () => {
    if (timingBusy || state === 'loading' || revisions?.learning)
        return;
    const requested = requestedBackend(), modelLabel = activeLabel();
    clearNext();
    if (state === 'live')
        postToWorker({ type: 'pause' });
    timingBusy = true;
    revisions?.controls();
    benchmark.disabled = true;
    lockConfig(true);
    $('#cancel-bench').hidden = false;
    $('#bench-status').textContent = 'Loading selected backend and reference observations…';
    const runningBench = new Worker(moduleUrl('workers/bench-worker'), { type: 'module' });
    benchWorker = runningBench;
    runningBench.onmessage = ({ data: r }) => {
        if (benchWorker !== runningBench)
            return;
        if (r.type === 'progress') {
            $('#bench-status').textContent = 'Benchmark · ' + r.completed + ' / ' + r.total + ' decisions';
            return;
        }
        if (r.type === 'result') {
            showBenchResult(r, modelLabel);
            finishBench();
            return;
        }
        $('#bench-status').textContent = r.message || 'Benchmark unavailable';
        finishBench();
    };
    runningBench.onerror = (e) => {
        if (benchWorker !== runningBench)
            return;
        $('#bench-status').textContent = e.message || 'Benchmark worker failed';
        finishBench();
    };
    const request = { backend: requested, policy: variant, ...revisionArgs() };
    runningBench.postMessage(request);
};
// Results tabs share the chart legend and show one metric at a time.
{
    const tabs = [...document.querySelectorAll('.res-tabs [role="tab"]')];
    function selectResult(tab, focus = false) {
        for (const item of tabs) {
            const selected = item === tab;
            item.setAttribute('aria-selected', String(selected));
            item.tabIndex = selected ? 0 : -1;
            $('#' + item.getAttribute('aria-controls')).hidden = !selected;
        }
        if (focus)
            tab.focus();
    }
    tabs.forEach((tab, index) => {
        tab.addEventListener('click', () => selectResult(tab));
        tab.addEventListener('keydown', (event) => {
            let next;
            switch (event.key) {
                case 'ArrowLeft':
                    next = (index + tabs.length - 1) % tabs.length;
                    break;
                case 'ArrowRight':
                    next = (index + 1) % tabs.length;
                    break;
                case 'Home':
                    next = 0;
                    break;
                case 'End':
                    next = tabs.length - 1;
                    break;
                default:
                    return;
            }
            event.preventDefault();
            selectResult(tabs[next], true);
        });
    });
}
// Bar charts that grow when they scroll into view (results chapter); without IntersectionObserver they show at once.
for (const chart of document.querySelectorAll('[data-animate-bars]')) {
    if (typeof IntersectionObserver !== 'function') {
        chart.classList.add('res-on');
        continue;
    }
    const io = new IntersectionObserver(([e]) => {
        if (e.isIntersecting) {
            chart.classList.add('res-on');
            io.disconnect();
        }
    }, { threshold: 0.25 });
    io.observe(chart);
}
// Use-case tabs (same markup as the deck): one panel at a time.
{
    const tabs = [...document.querySelectorAll('#use-cases .uc-tab')];
    tabs.forEach((t) => t.addEventListener('click', () => tabs.forEach((x) => {
        const on = x === t;
        x.setAttribute('aria-selected', String(on));
        document.getElementById(x.getAttribute('aria-controls')).hidden = !on;
    })));
}

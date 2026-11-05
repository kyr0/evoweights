/** Page controller of the live arena: model picker, game worker, human play, backend choice and the inference benchmark. */
import { cpuThreadLimit } from '../model/cpu-limits.ts';
import type { AdapterSummary } from '../model/webgpu.ts';
import type { BackendInfo } from '../policy/runtime.ts';
import type { RevisionRecord } from '../revisions/store.ts';
import { moduleUrl, siteUrl } from '../shared/site.ts';
import type { TrainingFrame } from '../training/live-es.ts';
import type { BenchReply, BenchRequest, BenchResult } from '../workers/bench-worker.ts';
import type { FramePacket, HumanKeys, PlayReply, PlayRequest } from '../workers/play-worker.ts';
import { installRecorder, type GameState } from './recorder.ts';
import { installRevisions } from './revisions-panel.ts';

/** The page's required elements; a missing one is a markup bug and fails at first use, as before. */
function $<T extends HTMLElement = HTMLElement>(selector: string): T {
  return document.querySelector(selector) as T;
}
const canvas = $<HTMLCanvasElement>('#screen'),
  ctx = canvas.getContext('2d', { alpha: false }) as CanvasRenderingContext2D;
const names = ['LEFT', 'RIGHT', 'FIRE', 'HOLD'];
const variants: Record<string, string> = { dnp: 'Latest DNP', original: 'Original weights (FP32)' };
const headline: Record<GameState, string> = {
  idle: 'STANDBY',
  loading: 'LOADING',
  live: 'LIVE',
  paused: 'PAUSED',
  ended: 'FINISHED',
  error: 'OFFLINE',
};
const roleLabel: Record<string, string> = { parent: 'Elternrevision', plus: 'Kandidat +', minus: 'Kandidat −' };
let trainingPreview = false;
let benchWorker: Worker | null = null,
  timingBusy = false,
  revisions: ReturnType<typeof installRevisions> | null = null,
  activeRevision: RevisionRecord | null = null;
let worker: Worker | null = null,
  state: GameState = 'idle',
  variant = 'dnp',
  currentSeed = 9000,
  nextTimer: ReturnType<typeof setTimeout> | null = null;
let rateMark: { n: number; t: number } | null = null;
const recorder = installRecorder(canvas, { button: $<HTMLButtonElement>('#download-recording') }, () => currentSeed);
const cpuLimit = cpuThreadLimit();
const vcpus = $<HTMLSelectElement>('#vcpus'),
  gpu = $<HTMLInputElement>('#gpu'),
  wasm = $<HTMLInputElement>('#wasm'),
  seedInput = $<HTMLInputElement>('#seed'),
  benchmark = $<HTMLButtonElement>('#benchmark');
for (let i = 2; i <= cpuLimit; i++) vcpus.add(new Option(String(i), String(i)));
function requestedBackend(): string {
  return gpu.checked ? 'gpu' : 'cpu' + vcpus.value;
}
function lockConfig(locked: boolean): void {
  gpu.disabled = locked;
  wasm.disabled = locked;
  vcpus.disabled = locked || gpu.checked;
}
$('#regions').innerHTML = '<i></i>'.repeat(9);
$('#logits').innerHTML = names
  .map(
    (n) =>
      '<div class="logit" ' +
      (n === 'HOLD' ? 'hidden' : '') +
      '><span>' +
      n +
      '</span><div class="track"><i></i></div><output>—</output></div>',
  )
  .join('');
// The model menu never scrolls: while it is shown, the game view grows to fit it (min-height; the canvas covers the extra space).
function fitPick(): void {
  const v = document.querySelector<HTMLElement>('#viewport'),
    pk = document.querySelector<HTMLElement>('#pick');
  if (!v || !pk) return;
  const shown = !pk.hidden && !$('#overlay').hidden;
  v.style.minHeight = shown ? Math.ceil((pk.parentElement as HTMLElement).scrollHeight) + 24 + 'px' : '';
}
if (typeof ResizeObserver === 'function') new ResizeObserver(fitPick).observe($('#pick'));
function status(s: GameState, detail?: string): void {
  state = s;
  recorder.state(s);
  benchmark.disabled = timingBusy || s === 'loading' || !!revisions?.learning;

  const previewing = trainingPreview && s !== 'live';
  const badge = $('#status');
  (badge.lastChild as ChildNode).nodeValue = ' ' + (previewing ? 'LEARNING' : headline[s]);
  badge.dataset.live = s === 'live' || previewing ? 'yes' : 'no';
  const running = ['live', 'paused', 'ended'].includes(s);
  $<HTMLButtonElement>('#toggle').disabled = !running;
  $<HTMLButtonElement>('#restart').disabled = !running;
  $<HTMLButtonElement>('#new-seed').disabled = s === 'loading';
  seedInput.disabled = s === 'loading';
  $('#toggle-text').textContent = s === 'ended' ? 'Play again' : s === 'paused' ? 'Resume' : 'Pause';
  // Pause shows the pause symbol, also while disabled; only Resume and Play again show ▶.
  $('#toggle .symbol').textContent = s === 'paused' || s === 'ended' ? '▶' : 'Ⅱ';
  $('#overlay').hidden = s === 'live' || previewing;
  $('#progress').hidden = s !== 'loading';
  const picking = s === 'idle' || s === 'paused' || s === 'ended';
  $('#pick').hidden = !picking;
  const launchButton = $<HTMLButtonElement>('#launch');
  launchButton.hidden = s === 'loading' || s === 'idle' || s === 'paused' || s === 'ended'; // the header button resumes or plays again
  if (s !== 'live') {
    rateMark = null;
    if (!revisions?.learning) $('#decision-rate').textContent = '—';
  }
  launchButton.disabled = s === 'loading';
  const launchLabel: Record<string, string> = {
    idle: 'Start live run',
    error: 'Retry',
    paused: 'Resume',
    ended: 'Play again',
  };
  launchButton.innerHTML = '<span aria-hidden="true">▶</span> ' + (launchLabel[s] || 'Start live run');
  $('#overlay-eyebrow').textContent =
    (
      {
        idle: 'CHOOSE A MODEL',
        loading: 'PREPARING LIVE SESSION',
        error: 'SESSION UNAVAILABLE',
        paused: 'SESSION PAUSED',
        ended: 'EPISODE COMPLETE',
      } as Record<string, string>
    )[s] || '';
  $('#load-detail').textContent =
    detail || ({ loading: 'Loading the game and model…' } as Record<string, string>)[s] || '';
}
function activeLabel(): string {
  return activeRevision?.name || variants[variant];
}
function revisionArgs(): Pick<PlayRequest & { type: 'init' }, 'revision' | 'revisionId'> {
  if (!activeRevision) return {};
  const args: Pick<PlayRequest & { type: 'init' }, 'revision' | 'revisionId'> = { revisionId: activeRevision.id };
  if (activeRevision.kind !== 'original' && activeRevision.kind !== 'shipped' && activeRevision.controller)
    args.revision = { ops: activeRevision.ops, tactical: activeRevision.controller };
  return args;
}
function activateRevision(record: RevisionRecord, play?: boolean): boolean {
  if (timingBusy) return false;
  const choice = record.kind === 'original' ? 'original' : 'dnp';
  if (activeRevision?.id === record.id) {
    if (play && state !== 'live' && state !== 'loading') launch();
    return true;
  }
  const wasStarted = !!worker;
  leaveWorker();
  variant = choice;
  activeRevision = record;
  $('#viewport').classList.remove('running');
  $('#stage-mode').textContent = 'Preview · ' + activeLabel();
  for (const id of ['health', 'ammo', 'kills']) $('#' + id).textContent = '—';
  $('#game-time').textContent = '0:00';
  $('#actual-backend').textContent = 'Awaiting action';
  $('#backend-detail').textContent = '';
  $('#guard-status').textContent =
    choice === 'dnp' ? 'Facing guard · awaiting first decision' : 'Original model · three raw action logits';
  status('idle');
  if (play) {
    if (wasStarted) seedInput.value = String(currentSeed);
    launch();
  }
  return true;
}
function seedValue(): number {
  const x = Number(seedInput.value);
  if (!Number.isInteger(x) || x < 0 || x > 4294967295 || seedInput.value.trim() === '') {
    throw new Error('Enter a seed from 0 to 4294967295.');
  }
  return x;
}
// Decisions per second of the live game, from the worker's step counter over windows of at least one second (rateMark: see globals).
function liveRate(p: FramePacket): void {
  if (trainingPreview || !Number.isFinite(p.n)) return;
  const now = performance.now();
  if (!rateMark || p.n < rateMark.n) {
    rateMark = { n: p.n, t: now };
    return;
  }
  if (now - rateMark.t >= 1000) {
    $('#decision-rate').textContent = Math.round(((p.n - rateMark.n) * 1000) / (now - rateMark.t)).toLocaleString(
      'en-US',
    );
    rateMark = { n: p.n, t: now };
  }
}
function showFrame(pixels: ArrayBuffer, width: number, height: number): void {
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  $('#viewport').classList.add('running');
}
function showCounters(health: number, ammo: number, kills: number, tic: number): void {
  $('#health').textContent = String(Math.max(0, health));
  $('#ammo').textContent = String(ammo);
  $('#kills').textContent = String(kills);
  $('#game-time').textContent = gameClock(tic);
}
function draw(p: FramePacket): void {
  liveRate(p);
  showFrame(p.rgba, p.width, p.height);
  showCounters(p.health, p.ammo, p.kills, p.tic);
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
      : 'No visible target';
  }
  const move = p.decision;
  const aimLabel = move?.action === 2 && move.weapon === 'fist' ? 'PUNCH' : names[move?.action as number];
  $('#maneuver').textContent = move
    ? (move.human ? 'YOU · ' : '') + (move.forward ? 'FORWARD + ' : move.backward ? 'BACK + ' : '') + aimLabel
    : '—';
  $('#weapon').textContent = 'Weapon · ' + (p.weapon || '—') + (p.damage ? ' · −' + p.damage + ' HP' : '');
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
          ? 'Facing guard · retreat · ' + Math.round(((defense.ageTics as number) * 1000) / 35) + ' ms facing'
          : defense?.facing
            ? 'Facing guard · tracking enemy orientation'
            : p.weapon === 'fist'
              ? 'Facing guard · no qualifying target'
              : 'Facing guard · waiting for fists';
  const decision = p.decision;
  if (!decision) return;
  if (decision.human) {
    document.querySelectorAll<HTMLElement>('.logit').forEach((row) => {
      row.hidden = true;
    });
    $('#timing').textContent = 'Step ' + p.n + ' · keyboard control, no inference';
    return;
  }
  const z = decision.logits;
  const v = z.map((x) => Math.exp(x - Math.max(...z))),
    sum = v.reduce((a, b) => a + b, 0);
  [...document.querySelectorAll<HTMLElement>('.logit')].forEach((row, i) => {
    row.hidden = i >= z.length;
    if (row.hidden) return;
    const actionName = i === 2 && decision.weapon === 'fist' ? 'PUNCH' : names[i];
    (row.querySelector('span') as HTMLElement).textContent = actionName;
    (row.querySelector('output') as HTMLOutputElement).textContent = z[i].toFixed(2);
    (row.querySelector('i') as HTMLElement).style.width = (v[i] / sum) * 100 + '%';
    row.classList.toggle('active', i === decision.action);
    row.title = actionName + ' · ' + ((100 * v[i]) / sum).toFixed(1) + '% softmax';
  });
  $('#timing').textContent =
    'Step ' +
    p.n +
    ' · ' +
    (p.perfN
      ? 'p50 ' +
        (p.inferenceP50 as number).toFixed(1) +
        ' / p95 ' +
        (p.inferenceP95 as number).toFixed(1) +
        ' ms (' +
        p.perfN +
        ')'
      : 'warming up · ' + p.inferenceMs.toFixed(1) + ' ms');
}
function clearNext(): void {
  if (nextTimer) clearTimeout(nextTimer);
  nextTimer = null;
}
function gameClock(tic: number): string {
  const seconds = Math.floor(tic / 35);
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}
// The learning run borrows the arena canvas while the live game is paused. Starting the game hands it back.
function trainingView(active: boolean): void {
  trainingPreview = !!active;
  if (!trainingPreview)
    $('#stage-mode').textContent =
      (worker && state !== 'idle' ? 'Seed ' + currentSeed : 'Preview') + ' · ' + activeLabel();
  status(state);
}
function trainingFrame(m: TrainingFrame): void {
  if (!trainingPreview || state === 'live' || state === 'loading') return;
  showFrame(m.pixels, m.width, m.height);
  showCounters(m.health, m.ammo, m.kills, m.tic);
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
function leaveTrainingView(): void {
  if (trainingPreview) {
    const box = document.querySelector<HTMLInputElement>('#revision-watch');
    if (box) box.checked = false;
    trainingView(false);
  }
}
function leaveWorker(): void {
  clearNext();
  recorder.stop();
  if (worker) {
    worker.terminate();
    worker = null;
  }
}
function postToWorker(message: PlayRequest): void {
  worker?.postMessage(message);
}
function onWorker({ data: p }: MessageEvent<PlayReply>): void {
  if (p.type === 'loading') {
    const pct = Math.round((100 * p.loaded) / p.total);
    $<HTMLProgressElement>('#progress').value = pct;
    $('#load-detail').textContent = activeLabel() + ' · ' + pct + '%';
  }
  if (p.type === 'ready' || p.type === 'resumed') status('live');
  if (p.type === 'frame') draw(p);
  if (p.type === 'paused') status('paused');
  if (p.type === 'end') status('ended');
  if (p.type === 'error') {
    leaveWorker();
    status('error', p.message);
  }
}
function launch(): void {
  if (timingBusy) return;
  if (state === 'loading') return;
  leaveTrainingView();
  if (state === 'paused') {
    postToWorker({ type: 'resume' });
    return;
  }
  let seed: number;
  try {
    seed = seedValue();
  } catch (e) {
    $('#session-message').textContent = (e as Error).message;
    return;
  }
  if (state === 'ended') {
    restart(seed);
    return;
  }
  currentSeed = seed;
  leaveWorker();
  status('loading');
  $<HTMLProgressElement>('#progress').value = 0;
  let started: Worker;
  try {
    started = new Worker(moduleUrl('workers/play-worker'), { type: 'module' });
  } catch (e) {
    status('error', (e as Error).message || 'Could not start the simulator.');
    return;
  }
  worker = started;
  started.onmessage = (e: MessageEvent<PlayReply>) => {
    if (e.currentTarget === worker) onWorker(e);
  };
  started.onerror = (e) => {
    if (e.currentTarget !== worker) return;
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
const keyMap: Record<string, keyof HumanKeys> = {
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
const keys: HumanKeys = { left: false, right: false, forward: false, backward: false, fire: false };
function sendKeys(): void {
  postToWorker({ type: 'control', keys: { ...keys } });
}
function releaseKeys(): void {
  let any = false;
  for (const k of Object.keys(keys) as (keyof HumanKeys)[]) {
    any ||= keys[k];
    keys[k] = false;
  }
  if (any) sendKeys();
}
function handleKey(e: KeyboardEvent, down: boolean): boolean {
  if (!humanPlay() || !(e.code in keyMap) || (e.target as Element | null)?.closest?.('input,textarea,select'))
    return false;
  e.preventDefault();
  if (e.repeat) return true;
  const k = keyMap[e.code];
  if (keys[k] !== down) {
    keys[k] = down;
    sendKeys();
  }
  return true;
}
// The overlay menu chooses between a model and the visitor; the choice holds until the next pick.
function setHuman(on: boolean): void {
  if (human === on) return;
  human = on;
  releaseKeys();
  if (worker && ['live', 'paused', 'ended'].includes(state)) postToWorker({ type: 'human', on });
  $('#keys-hint').hidden = !on;
  if (on && state === 'live') $('#stage-mode').textContent = 'Seed ' + currentSeed + ' · You play · keyboard';
  else if (!on && state === 'live') $('#stage-mode').textContent = 'Seed ' + currentSeed + ' · ' + activeLabel();
}
document.addEventListener('keyup', (e) => {
  handleKey(e, false);
});
window.addEventListener('blur', releaseKeys);
function restart(seed: number): void {
  if (timingBusy) return;
  clearNext();
  recorder.stop();
  leaveTrainingView();
  currentSeed = seed;
  if (worker && ['live', 'paused', 'ended'].includes(state)) {
    postToWorker({ type: 'reset', seed });
  } else if (state !== 'loading') {
    launch();
  }
}
function toggle(): void {
  if (state === 'live') postToWorker({ type: 'pause' });
  else if (state !== 'loading') launch();
}
$('#launch').onclick = async () => {
  await revisions?.ready;
  if (!revisions?.playChoice()) launch();
};
// Overlay picker: each card plays one shipped model; the last button hands the controls to the visitor.
document.querySelectorAll<HTMLElement>('#pick [data-pick]').forEach(
  (b) =>
    (b.onclick = async () => {
      setHuman(false);
      await revisions?.ready;
      if (!revisions?.playBuiltin?.(b.dataset.pick as string)) launch();
    }),
);
// Card meters: survival (tics) and kills summed over the 48 reference games. Width = share of the best card; label = change against FP32.
(async () => {
  try {
    const ref = (await (await fetch(siteUrl('data/reference-v1.json'))).json()) as {
        originalId: string;
        revisions: Record<string, Record<string, number[]> | undefined>;
      },
      cards = [...document.querySelectorAll<HTMLElement>('#pick [data-ref]')];
    const sum = (id: string | undefined, k: string) => ref.revisions[id as string]?.[k]?.reduce((a, b) => a + b, 0);
    for (const k of ['tics', 'kills']) {
      const max = Math.max(...cards.map((c) => sum(c.dataset.ref, k) || 0)),
        base = sum(ref.originalId, k);
      for (const c of cards) {
        const v = sum(c.dataset.ref, k);
        if (!v || !max || !base) return;
        (c.querySelector('b[data-k="' + k + '"]') as HTMLElement).style.setProperty(
          '--w',
          Math.max(v / max, 0.03).toFixed(4),
        );
        (c.querySelector('em[data-k="' + k + '"]') as HTMLElement).textContent =
          c.dataset.ref === ref.originalId
            ? 'baseline'
            : (v >= base ? '+' : '−') + Math.abs(Math.round((v / base - 1) * 100)).toLocaleString('en-US') + ' %';
      }
    }
    cards.forEach((c) => ((c.querySelector('.pick-meter') as HTMLElement).hidden = false));
  } catch {
    /* Without the reference file the cards keep their meters hidden. */
  }
})();
document.querySelectorAll<HTMLElement>('#pick [data-explore]').forEach(
  (b) =>
    (b.onclick = async () => {
      await revisions?.ready;
      revisions?.exploreBuiltin?.(b.dataset.explore as string);
    }),
);
// "Your own models": the card is filled by the revision panel; its button plays the chosen model.
document.addEventListener('click', async (e) => {
  const b = (e.target as Element | null)?.closest?.('[data-own-play]');
  if (!b) return;
  setHuman(false);
  await revisions?.ready;
  const id = document.querySelector<HTMLSelectElement>('#pick-own-select')?.value;
  if (!id || !revisions?.playModel?.(id)) launch();
});
document.querySelector('#pick-human')?.addEventListener('click', () => {
  setHuman(true);
  if (state === 'ended') restart(currentSeed);
  else launch();
});
$('#toggle').onclick = toggle;
// Restart ends the current game (its recording stays downloadable) and returns to the model menu.
function menu(): void {
  if (timingBusy || state === 'loading') return;
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
  if (e.key !== 'Enter') return;
  if (state === 'idle') launch();
  else
    try {
      restart(seedValue());
    } catch (err) {
      $('#session-message').textContent = (err as Error).message;
    }
};
$('#full').onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $('#viewport').requestFullscreen();
  } catch {
    $('#session-message').textContent = 'Fullscreen is unavailable in this viewer.';
  }
};
document.addEventListener('keydown', (e) => {
  if (handleKey(e, true)) return;
  if (e.code === 'Space' && !e.repeat && e.target === document.body) {
    e.preventDefault();
    toggle();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === 'live') postToWorker({ type: 'pause' });
});
window.addEventListener('pagehide', leaveWorker);
window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    status('idle');
    $('#viewport').classList.remove('running');
  }
});
status('idle');

function backendName(r: BackendInfo | null | undefined): string {
  if (!r) return 'awaiting backend';
  if (r.backend === 'webgpu-hybrid') return 'WebGPU hybrid';
  if (r.backend === 'wasm-simd-threaded') return 'WASM SIMD · ' + r.threads + ' threads';
  return 'WASM SIMD · 1 thread';
}
function showBackend(r: BackendInfo | null | undefined): void {
  if (!r) return;
  $('#actual-backend').textContent = backendName(r);
  const adapter = r.adapter as (AdapterSummary & { device?: string }) | null | undefined;
  $('#backend-detail').textContent =
    r.reason ||
    (r.backend === 'webgpu-hybrid' && adapter ? String(adapter.description || adapter.device || adapter) : '');
}
// Static hosts may omit the isolation headers needed for a shared WebAssembly memory.
const isolationKey = 'agm-dnp-thread-reload-v2';
interface IsolationReload {
  backend: string;
  seed: number;
  variant: string;
  revisionId?: string;
  running: boolean;
}
async function restoreThreadSelection(): Promise<void> {
  try {
    const saved = sessionStorage.getItem(isolationKey);
    if (!saved) return;
    sessionStorage.removeItem(isolationKey);
    const item = JSON.parse(saved) as IsolationReload;
    if (!/^cpu[2-8]$/.test(item.backend)) return;
    vcpus.value = String(Math.min(cpuLimit, Number(item.backend.slice(3))));
    seedInput.value = String(item.seed);
    currentSeed = item.seed;
    await revisions?.ready;
    if (item.revisionId) await revisions?.restore(item.revisionId);
    else if (item.variant in variants) await revisions?.restoreBuiltin(item.variant);
    if (!crossOriginIsolated)
      $('#backend-detail').textContent =
        'This origin cannot enable shared memory. CPU requests fall back to one thread.';
    if (item.running) launch();
  } catch {
    /* A browser that blocks session storage can still run single-thread WASM. */
  }
}
async function prepareThreads(request: string, wasActive: boolean): Promise<boolean> {
  if (
    !/^cpu[2-8]$/.test(request) ||
    crossOriginIsolated ||
    !window.isSecureContext ||
    window.top !== window ||
    !('serviceWorker' in navigator) ||
    navigator.serviceWorker.controller
  )
    return false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
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
    const reload: IsolationReload = {
      backend: request,
      seed: seedValue(),
      variant,
      revisionId: activeRevision?.id,
      running: wasActive,
    };
    sessionStorage.setItem(isolationKey, JSON.stringify(reload));
    location.reload();
    return true;
  } catch (e) {
    $('#backend-detail').textContent = 'Shared memory unavailable: ' + (e as Error).message;
    return false;
  } finally {
    clearTimeout(timeout);
    lockConfig(false);
    benchmark.disabled = timingBusy || state === 'loading';
  }
}
// The backend choice applies to the next game or training run; a running game keeps its backend.
async function changeBackend(): Promise<void> {
  const request = requestedBackend();
  lockConfig(false);
  const running = !!worker && state !== 'idle';
  if (!running) {
    $('#actual-backend').textContent = 'Awaiting action';
    $('#backend-detail').textContent = '';
  }
  await prepareThreads(request, false);
}
for (const input of [wasm, gpu, vcpus]) input.onchange = changeBackend;
revisions = installRevisions({
  activate: activateRevision,
  pauseGame() {
    clearNext();
    if (state === 'live') postToWorker({ type: 'pause' });
  },
  isBenchmarking: () => timingBusy,
  onActivity(learning: boolean) {
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
function finishBench(): void {
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
function perfTab(key: 'research' | 'yours', focus = false): void {
  for (const [k, id] of [
    ['research', '#perf-tab-research'],
    ['yours', '#perf-tab-yours'],
  ] as const) {
    const t = $(id),
      on = k === key;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $('#' + t.getAttribute('aria-controls')).hidden = !on;
    if (on && focus) t.focus();
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
function showBenchResult(r: BenchResult, modelLabel: string): void {
  showBackend(r);
  $('#bench-table').hidden = false;
  const row = document.createElement('tr'),
    label = backendName(r);
  [
    modelLabel,
    label + (r.reason ? ' (fallback)' : ''),
    (r.p50 as number).toFixed(1) + ' ms',
    (r.p95 as number).toFixed(1) + ' ms',
    r.matched + ' / ' + r.samples,
  ].forEach((str) => {
    const td = document.createElement('td');
    td.textContent = str;
    row.append(td);
  });
  $('#bench-results').prepend(row);
  // A handle for inspecting the last result from the console.
  (window as Window & { lastKumoBenchmark?: BenchResult }).lastKumoBenchmark = r;
  $('#bench-status').textContent =
    (r.passed ? 'Parity passed' : 'Parity mismatch') +
    ' · ' +
    (r.referenceKind === 'pytorch-projected' ? 'PyTorch head projection' : 'PyTorch reference') +
    ' · max logit error ' +
    r.maxError.toPrecision(2) +
    (r.reason ? ' · ' + r.reason : '');
}
benchmark.onclick = () => {
  if (timingBusy || state === 'loading' || revisions?.learning) return;
  const requested = requestedBackend(),
    modelLabel = activeLabel();
  clearNext();
  if (state === 'live') postToWorker({ type: 'pause' });
  timingBusy = true;
  revisions?.controls();
  benchmark.disabled = true;
  lockConfig(true);
  $('#cancel-bench').hidden = false;
  $('#bench-status').textContent = 'Loading selected backend and reference observations…';
  const runningBench = new Worker(moduleUrl('workers/bench-worker'), { type: 'module' });
  benchWorker = runningBench;
  runningBench.onmessage = ({ data: r }: MessageEvent<BenchReply>) => {
    if (benchWorker !== runningBench) return;
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
    if (benchWorker !== runningBench) return;
    $('#bench-status').textContent = e.message || 'Benchmark worker failed';
    finishBench();
  };
  const request: BenchRequest = { backend: requested, policy: variant, ...revisionArgs() };
  runningBench.postMessage(request);
};
// Bar charts that grow when they scroll into view (results chapter); without IntersectionObserver they show at once.
for (const chart of document.querySelectorAll('[data-animate-bars]')) {
  if (typeof IntersectionObserver !== 'function') {
    chart.classList.add('res-on');
    continue;
  }
  const io = new IntersectionObserver(
    ([e]) => {
      if (e.isIntersecting) {
        chart.classList.add('res-on');
        io.disconnect();
      }
    },
    { threshold: 0.25 },
  );
  io.observe(chart);
}
// Use-case tabs (same markup as the deck): one panel at a time.
{
  const tabs = [...document.querySelectorAll('#use-cases .uc-tab')];
  tabs.forEach((t) =>
    t.addEventListener('click', () =>
      tabs.forEach((x) => {
        const on = x === t;
        x.setAttribute('aria-selected', String(on));
        (document.getElementById(x.getAttribute('aria-controls') as string) as HTMLElement).hidden = !on;
      }),
    ),
  );
}

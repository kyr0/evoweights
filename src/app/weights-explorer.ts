// Buildless, dependency-free viewer. All numbers come from the released comparison.
import type { HeadOp } from '../model/kumo.ts';
import type { ReleasedHead } from '../revisions/patch-codec.ts';
import type { Controller, FacingWeights } from '../tactical/types.ts';

// ---- The released comparison document (`data/weights-explorer.json`) ----

/** Mean, RMS and maximum absolute error between two stages of the weights. */
export interface ErrorStats {
  meanAbsError: number;
  rmse: number;
  maxAbsError: number;
}
/** Errors between the three released stages: FP32, quantized 4-bit, and 4-bit after the direct edit (DNP). */
export interface StageErrors {
  fp32ToW4: ErrorStats;
  w4ToEdited: ErrorStats;
  fp32ToEdited: ErrorStats;
}
/** Whole-backbone counts of the release. */
export interface ReleaseSummary {
  parameters: number;
  parameterTensors: number;
  quantizedParameters: number;
  quantizedTensors: number;
  quantizationScales: number;
  quantizationChanged: number;
  quantizationUnchanged: number;
  directChanged: number;
  directUnchanged: number;
  directCloserToFP32: number;
  directFartherFromFP32: number;
  directSameAbsError: number;
  netChanged: number;
  netUnchanged: number;
  changedInBoth: number;
  recoveredToFP32: number;
  fp32EqualInQuantized: number;
  fp32EqualBeforeNewlyChanged: number;
  trainableByRegistration: number;
  frozenByRegistration: number;
  buffers: number;
  bufferScalars: number;
  serializedNames: number;
  serializedScalarEntries: number;
  errors: StageErrors;
}
/** Per-tensor counts of one native parameter tensor. */
export interface ReleaseTensor {
  name: string;
  family: string;
  shape: number[];
  numel: number;
  quantized: boolean;
  requiresGrad: boolean;
  quantizationChanged: number;
  directChanged: number;
  netChanged: number;
  changedInBoth: number;
  directCloserToFP32: number;
  directFartherFromFP32: number;
  directSameAbsError: number;
  fp32EqualBeforeNewlyChanged: number;
  recoveredToFP32: number;
  errors: StageErrors;
}
/** One channel (column) of the shown head row: its weight at each stage and its signed 4-bit codes. */
export interface Channel {
  column: number;
  group: number;
  /** The original FP32 weight; null in a revision comparison without the release row. */
  fp32: number | null;
  baseCode: number;
  editedCode: number;
  scale: number;
  w4: number;
  edited: number;
  delta: number;
  changed: boolean;
  /** Activation cluster of an edited channel; null when unassigned. */
  cluster: number | null;
}
/** A released FIRE-row channel always carries its FP32 weight. */
export interface ReleaseChannel extends Channel {
  fp32: number;
}
/** Edit statistics of one 64-channel quantization group of the shown head row. */
export interface GroupStats {
  group: number;
  first: number;
  last: number;
  changed: number;
  increases: number;
  decreases: number;
  /** Mean absolute weight edit per edited channel; null without edits. */
  meanAbsDelta: number | null;
  scale: number;
}
export interface ReleaseGroup extends GroupStats {
  meanAbsDeltaAll: number;
}
/** A quantization group together with its channels, as the views read it. */
export interface ChannelGroup<C extends Channel = Channel> extends GroupStats {
  cells: C[];
}
export type PreparedGroup = ReleaseGroup & ChannelGroup<ReleaseChannel>;
/** A co-activation cluster of edited channels. */
export interface ActivationCluster {
  cluster: number;
  size: number;
  columns: number[];
  meanPairCorrelation: number;
  meanAbsDelta: number;
  dominantGroup: number;
  dominantGroupCount: number;
}
/** How the activation clusters were derived. */
export interface ActivationClustering {
  states: number;
  uniqueFeatureRows?: number;
  supportStates: number;
  k: number;
  features: string[];
  developmentSeeds: number[];
  observationsPerEpisode: number[];
  algorithmSeed: number | null;
  layer: string;
  distance: string;
  linkage: string;
  ties: string;
  labels: string;
  sampling: string;
  interpretation: string;
  supportSHA256: string;
  traceSHA256: string;
}
/** The released head row (FIRE) with every channel, group and activation cluster. */
export interface ReleaseHead {
  name: string;
  row: number;
  rowLabel: string;
  shape: [rows: number, columns: number];
  groupSize: number;
  activeRows: number[];
  inactiveRows: number[];
  channels: ReleaseChannel[];
  groups: ReleaseGroup[];
  clusters?: ActivationCluster[];
  clusterCorrelationMatrix?: number[][];
  activationClustering?: ActivationClustering;
  fractionOfFIRERow: number;
  fractionOfActiveHead: number;
  fractionOfNativeHead: number;
}
/** One direct edit of the release patch. */
export interface DirectEdit {
  tensor: string;
  row: number;
  column: number;
  group: number;
  fp32: number;
  w4: number;
  edited: number;
  scale: number;
  delta: number;
  baseCode: number;
  editedCode: number;
}
/** A signed-code controller matrix: output rows × input columns, one scale per output row. */
export interface ControllerMatrix {
  name: string;
  inputs: string[];
  outputs: string[];
  codes: number[][];
  scales: number[];
  slots: number;
  nonzero: number;
  /** The base revision's codes, when two revisions are compared; differing cells are outlined. */
  baseCodes?: number[][];
  routing?: string;
}
/** A released controller matrix with its configuration. */
export interface ReleaseController extends ControllerMatrix {
  id: string;
  routing: string;
  sha256: string;
  config: Record<string, number>;
  mixingGains: Record<string, number>;
  approachSettings?: Record<string, number>;
  approachSourceSHA256?: string;
  flags?: Record<string, boolean>;
  controllerConstants?: Record<string, number>;
  sourceSHA256?: string;
  destinations?: { output: string; sign: number }[];
}
/** `data/weights-explorer.json`: FP32 → 4-bit → DNP for the whole backbone, the FIRE head row and the controllers. */
export interface ReleaseDocument {
  schema: string;
  summary: ReleaseSummary;
  tensors: ReleaseTensor[];
  head: ReleaseHead;
  directEdits: DirectEdit[];
  controllers: ReleaseController[];
  controllerTotals: { slots: number; nonzero: number; scales: number; mixingGains: number };
  provenance: Record<string, unknown>;
}

// ---- Comparison models the views render ----

/** A readout row: stage, signed parameter (or '—'), weight (null shows '—'). */
export type Stage = [stage: string, code: number | string, weight: number | null];
/** A label/value row of a fact list. */
export type Fact = [label: string, value: string | number];
export type ChannelFilter = 'all' | 'edited' | 'unedited';
/** The validated release comparison (`prepareComparison`). */
export interface PreparedComparison {
  summary: ReleaseSummary;
  tensors: ReleaseTensor[];
  head: ReleaseHead;
  channels: ReleaseChannel[];
  groups: PreparedGroup[];
  clusters: ActivationCluster[];
  controllers: ReleaseController[];
}
/** One side of a revision comparison: a W4 recipe's head edits and controller codes. */
export interface RevisionSide {
  ops?: readonly HeadOp[] | null;
  controller?: Controller | null;
  tactical?: Controller | null;
}
export interface RevisionComparisonInput {
  candidate: RevisionSide;
  base: RevisionSide;
  /** The release document; its FP32 weights are shown for row 2. */
  release?: ReleaseDocument | null;
  head: Pick<ReleasedHead, 'tensor' | 'actions' | 'codes' | 'scales'>;
  row?: number;
  labels?: { candidate?: string; base?: string };
}
export interface RevisionSummary {
  directChanged: number;
  rowChanges: number[];
  controllerChanged: number;
  controllerSlots: number;
  candidateNonzero: number;
  baseNonzero: number;
}
export interface RevisionHead {
  name: string;
  row: number;
  rowLabel: string;
  shape: [rows: number, columns: number];
  groupSize: number;
  activeRows: number[];
}
export interface RevisionController extends ControllerMatrix {
  id: keyof Controller;
  baseCodes: number[][];
  changed: number;
}
/** Two base-relative W4 recipes compared (`buildRevisionComparison`). */
export interface RevisionComparison {
  summary: RevisionSummary;
  head: RevisionHead;
  channels: Channel[];
  groups: ChannelGroup[];
  clusters: ActivationCluster[];
  controllers: RevisionController[];
  labels: { candidate: string; base: string };
  editedLabel: string;
  compact: true;
  intro: string;
  clusterNote: string;
  stages: (c: Channel) => Stage[];
  facts: (c: Channel) => Fact[];
}
export type ExplorerComparison = PreparedComparison | RevisionComparison;
export interface RevisionDiffOptions {
  /** The tab to open: m0–m2 controller matrices, r0–r2 output rows. */
  view?: string;
  onView?: (view: string) => void;
  /** Asked for an output row other than the built one; the host rebuilds the comparison for it. */
  onRow?: (row: number) => void;
}
export interface MountOptions {
  src?: string;
  data?: ReleaseDocument;
}
export interface ControllerCell {
  row: number;
  col: number;
  input: string;
  output: string;
  code: number;
  scale: number;
  weight: number;
}
/** What the channel view reads; the release comparison leaves the optional texts and builders to their defaults. */
interface ChannelViewModel {
  head: { name: string; row: number; activationClustering?: ActivationClustering };
  channels: Channel[];
  groups: ChannelGroup[];
  clusters: ActivationCluster[];
  editedLabel?: string;
  compact?: boolean;
  intro?: string;
  clusterNote?: string;
  stages?: (c: Channel) => Stage[];
  facts?: (c: Channel) => Fact[];
}
interface ControllerViewModel {
  controllers: ControllerMatrix[];
  labels?: { candidate: string; base: string };
}
type TabItem<V> = [value: V, label: string, title?: string];
type LegendPart = [kind: string, symbol: string, label: string];

const number = new Intl.NumberFormat('en-US');
const n = (value: number) => number.format(value);
const weight = (value: number) => (value === 0 ? '0' : Number(value.toPrecision(7)).toString());
const signed = (value: number) => (value > 0 ? '+' + weight(value) : weight(value));
const signClass = (value: number) => (value > 0 ? 'up' : value < 0 ? 'down' : 'same');
const ensure: (condition: unknown, detail: string) => asserts condition = (condition, detail) => {
  if (!condition) throw new Error('Invalid model comparison — ' + detail);
};
/** The facing guard is a single tied coordinate (`code`); the other controller readouts are matrices (`codes`). */
const isTied = (readout: Controller[keyof Controller]): readout is FacingWeights => 'code' in readout;

export function prepareComparison(data: ReleaseDocument): PreparedComparison {
  const { head, controllers, summary, tensors } = data;
  ensure(Array.isArray(head?.channels) && head.channels.length === head.shape?.[1], 'FIRE row size');
  ensure(Number.isInteger(head.row) && head.row >= 0 && head.row < head.shape[0], 'FIRE row index');
  const channels = [...head.channels].sort((a, b) => a.column - b.column);
  channels.forEach((c, i) => {
    ensure(c.column === i && c.group === Math.floor(i / 64), 'FIRE coordinate ' + i);
    ensure([c.fp32, c.w4, c.edited, c.scale, c.delta].every(Number.isFinite), 'weight values');
    ensure(
      [c.baseCode, c.editedCode].every((x) => Number.isInteger(x) && Math.abs(x) <= 7),
      'signed codes',
    );
    ensure(c.changed === (c.baseCode !== c.editedCode), 'edit flag');
    ensure(Math.abs(c.edited - c.w4 - c.delta) < 1e-6, 'weight delta');
  });
  const groups = [...head.groups]
    .sort((a, b) => a.group - b.group)
    .map((g, i) => {
      const first = i * 64,
        last = Math.min(channels.length, first + 64) - 1;
      ensure(g.group === i && g.first === first && g.last === last, 'group boundaries');
      const cells = channels.slice(first, last + 1);
      ensure(g.changed === cells.filter((c) => c.changed).length, 'group edit count');
      return { ...g, cells };
    });
  ensure(groups.length === Math.ceil(channels.length / 64), 'group coverage');
  const clusters = [...(head.clusters || [])].sort((a, b) => a.cluster - b.cluster);
  const clusterIds = new Set(clusters.map((c) => c.cluster));
  ensure(clusterIds.size === clusters.length, 'duplicate cluster');
  for (const cluster of clusters) {
    const members = channels.filter((c) => c.cluster === cluster.cluster);
    ensure(cluster.size === members.length && members.every((c) => c.changed), 'cluster assignment');
    if (cluster.columns)
      ensure(
        [...cluster.columns].sort((a, b) => a - b).join() === members.map((c) => c.column).join(),
        'cluster members',
      );
  }
  ensure(
    channels.every((c) => c.cluster == null || clusterIds.has(c.cluster)),
    'unknown activation cluster',
  );
  ensure(
    Array.isArray(controllers) &&
      controllers.every((m) => {
        const codeRows = m.codes;
        return (
          Array.isArray(codeRows) &&
          codeRows.length === m.outputs.length &&
          codeRows.length === m.scales.length &&
          codeRows.length > 0 &&
          m.inputs.length > 0 &&
          m.scales.every(Number.isFinite) &&
          codeRows.every((row) => row.length === m.inputs.length && row.every(Number.isFinite)) &&
          m.slots === m.inputs.length * m.outputs.length &&
          m.nonzero === codeRows.flat().filter((x) => x !== 0).length
        );
      }),
    'controller dimensions or counts',
  );
  ensure(Array.isArray(tensors) && tensors.length === summary.parameterTensors, 'tensor inventory');
  ensure(tensors.reduce((a, t) => a + t.numel, 0) === summary.parameters, 'native parameter count');
  for (const key of ['directChanged', 'quantizationChanged', 'netChanged'] as const)
    ensure(tensors.reduce((a, t) => a + t[key], 0) === summary[key], 'native ' + key);
  return { summary, tensors, head, channels, groups, clusters, controllers };
}

export function matchesChannel(c: Channel, filter: ChannelFilter = 'all', cluster = ''): boolean {
  const kind = filter === 'all' || (filter === 'edited' && c.changed) || (filter === 'unedited' && !c.changed);
  return kind && (cluster === '' || c.cluster === Number(cluster));
}

export function controllerCell(m: ControllerMatrix, row: number, col: number): ControllerCell {
  const code = m.codes[row][col],
    scale = m.scales[row];
  return { row, col, input: m.inputs[col], output: m.outputs[row], code, scale, weight: code * scale };
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== '') el.textContent = text;
  return el;
}
function btn(cls: string, text: string): HTMLButtonElement {
  const b = make('button', cls, text);
  b.type = 'button';
  return b;
}
function select(
  label: string,
  options: [value: number | string, text: string][],
  selected: number | string,
  change: (value: string) => void,
): HTMLLabelElement {
  const field = make('label', 'wx-field'),
    s = make('select');
  field.append(make('span', '', label), s);
  for (const [val, text] of options) s.add(new Option(text, String(val)));
  s.value = String(selected);
  s.addEventListener('change', () => change(s.value));
  return field;
}
/** A strip of tabs with roving focus; `items` are [value,label,title?]. Returns the strip and a function that marks the selected value. */
function tabStrip<V extends string | number>(
  label: string,
  items: TabItem<V>[],
  selected: V,
  choose: (value: V) => void,
  cls = '',
): { strip: HTMLDivElement; mark: (value: V) => void } {
  const strip = make('div', 'wx-tabs' + (cls ? ' ' + cls : ''));
  strip.setAttribute('role', 'tablist');
  strip.setAttribute('aria-label', label);
  const tabs = items.map(([value, text, title], i) => {
    const t = btn('wx-tab', text);
    t.setAttribute('role', 'tab');
    t.dataset.value = String(value);
    if (title) t.title = title;
    t.onclick = () => choose(value);
    t.onkeydown = (e) => {
      const arrows: Partial<Record<string, number>> = { ArrowLeft: -1, ArrowRight: 1 };
      const step = arrows[e.key] ?? (e.key === 'Home' ? -Infinity : e.key === 'End' ? Infinity : 0);
      if (!step) return;
      e.preventDefault();
      const j = Math.max(
        0,
        Math.min(tabs.length - 1, Number.isFinite(step) ? i + step : step < 0 ? 0 : tabs.length - 1),
      );
      choose(items[j][0]);
      tabs[j].focus();
    };
    strip.append(t);
    return t;
  });
  const mark = (value: V) => {
    for (const t of tabs) {
      const on = t.dataset.value === String(value);
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      if (on) t.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
  };
  mark(selected);
  return { strip, mark };
}
function metric(label: string, value: number, description: string): HTMLDivElement {
  const tile = make('div', 'wx-metric');
  tile.append(make('span', 'wx-eyebrow', label), make('strong', '', n(value)), make('small', '', description));
  return tile;
}
function facts(rows: Fact[]): HTMLDListElement {
  const dl = make('dl', 'wx-facts');
  for (const [k, v] of rows) dl.append(make('dt', '', k), make('dd', '', String(v)));
  return dl;
}

// Miniatures use four paths per 64-channel group. Row-major order is preserved
// even when a filter hides cells, so a channel never moves under a filter.
function miniGrid(cells: Channel[], match: (c: Channel) => boolean): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg',
    svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('aria-hidden', 'true');
  const paths = { up: '', down: '', same: '', dim: '' };
  cells.forEach((c, i) => {
    const x = (i % 8) * 4 + 0.4,
      y = Math.floor(i / 8) * 4 + 0.4;
    const type = match(c) ? signClass(c.editedCode - c.baseCode) : 'dim';
    // Opposite corners distinguish signed changes at a glance and in grayscale.
    const shape =
      type === 'up'
        ? 'h3.2v2.1l-1.1,1.1H' + x + 'z'
        : type === 'down'
          ? 'h2.1l1.1,1.1v2.1H' + x + 'z'
          : 'h3.2v3.2h-3.2z';
    paths[type] += 'M' + x + ' ' + y + shape;
  });
  for (const [cls, d] of Object.entries(paths))
    if (d) {
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('class', 'wx-fill-' + cls);
      p.setAttribute('d', d);
      svg.append(p);
    }
  return svg;
}
function legend(parts: LegendPart[]): HTMLDivElement {
  const el = make('div', 'wx-legend');
  for (const [kind, symbol, label] of parts) {
    const item = make('span');
    item.append(make('i', 'wx-swatch wx-' + kind, symbol), document.createTextNode(label));
    el.append(item);
  }
  return el;
}
function inventory(model: PreparedComparison): HTMLDetailsElement {
  const details = make('details', 'wx-inventory');
  details.append(make('summary', '', n(model.summary.parameterTensors) + ' native parameter tensors'));
  const body = make('div', 'wx-inventory-body'),
    info = make('div');
  const initial = Math.max(
    0,
    model.tensors.findIndex((t) => t.name === model.head.name),
  );
  const show = (i: number) => {
    const t = model.tensors[i];
    info.replaceChildren(
      facts([
        ['Shape', t.shape.length ? t.shape.join(' × ') : 'Scalar'],
        ['Parameters', n(t.numel)],
        ['FP32 → 4-bit changed', n(t.quantizationChanged)],
        ['4-bit → DNP changed', n(t.directChanged)],
        ['FP32 → DNP changed', n(t.netChanged)],
      ]),
    );
  };
  const picker = select(
    'Parameter tensor',
    model.tensors.map((t, i) => [i, t.name]),
    initial,
    (value) => show(Number(value)),
  );
  body.append(picker, info);
  details.append(body);
  show(initial);
  return details;
}
function nativeView(model: ChannelViewModel): HTMLDivElement {
  const { head, channels, groups, clusters } = model;
  // Every channel of the row is shown and selectable; changed ones are marked in the map and the zoom grid.
  let filter = 'all' as ChannelFilter,
    cluster = '',
    current = channels.find((c) => c.changed)?.column ?? 0;
  const root = make('div', 'wx-native');
  const filters = make('div', 'wx-filters'),
    status = make('p', 'wx-hint wx-status');
  status.setAttribute('role', 'status');
  const overview = make('div', 'wx-groups'),
    focus = make('div', 'wx-zoom'),
    values = make('div', 'wx-readout');
  const info = make('div', 'wx-map-info');
  const match = (c: Channel) => matchesChannel(c, filter, cluster);
  function setColumn(column: number, focusCell = false): void {
    current = column;
    render();
    if (focusCell) focus.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
  }
  function changeFilter(): void {
    const found = channels.find(match);
    if (found && !match(channels[current])) current = found.column;
    render(); // Keep both filter controls mounted so keyboard focus survives.
  }
  const editedLabel = model.editedLabel || 'edited';
  filters.append(
    make('span', 'wx-fixed', 'Coordinates · ' + (filter === 'edited' ? editedLabel + ' only' : 'all channels')),
  );
  // One tab per activation cluster (C0 … C7) replaces the cluster selector; channels are picked in the group map and the zoom grid.
  const tabHost = make('div', 'wx-tab-host');
  const clusterTabs = clusters.length
    ? tabStrip(
        'Activation clusters',
        [
          ['', 'All', 'All ' + n(channels.filter((c) => filter === 'all' || c.changed).length) + ' channels'],
          ...clusters.map((c): TabItem<string> => [
            String(c.cluster),
            'C' + c.cluster,
            'Cluster C' + c.cluster + ' · ' + n(c.size) + ' channels',
          ]),
        ],
        cluster,
        (v) => {
          cluster = String(v);
          changeFilter();
        },
        'wx-cluster-tabs',
      )
    : null;
  if (clusterTabs) tabHost.append(clusterTabs.strip);
  function syncTabs(): void {
    clusterTabs?.mark(cluster);
  }
  const mapPane = make('div', 'wx-pane'),
    coordPane = make('div', 'wx-pane');
  mapPane.append(
    make('h4', '', 'Class ' + head.row + ' channel map'),
    make('p', 'wx-hint', 'One tile per quantization group. Read channels left to right, top to bottom within a tile.'),
    overview,
    legend([
      ['up', '+', 'Parameter increased'],
      ['down', '−', 'Parameter decreased'],
      ['same', '·', 'Unchanged'],
      ['dim', '', 'Filtered out'],
    ]),
    info,
  );
  coordPane.append(focus, values);
  const panes = make('div', 'wx-panes');
  panes.append(mapPane, coordPane);
  // The revision view shows its summary tiles in place of the intro, coordinate filter and match count.
  if (model.compact) root.append(tabHost, panes);
  else
    root.append(
      make(
        'p',
        'wx-intro',
        model.intro ||
          head.name +
            ' · output row ' +
            head.row +
            ' · assigned to FIRE (attack) by the DOOM task. Select a cluster tab, then a group or a channel to inspect it.',
      ),
      filters,
      tabHost,
      status,
      panes,
    );
  function render(): void {
    const picked = channels[current],
      g = groups[picked.group],
      visible = channels.filter(match);
    const selectedCluster = clusters.find((c) => String(c.cluster) === cluster);
    status.textContent =
      n(visible.length) +
      ' of ' +
      n(channels.length) +
      ' channels match · ' +
      n(visible.filter((c) => c.changed).length) +
      ' ' +
      editedLabel +
      (selectedCluster && Number.isFinite(selectedCluster.meanPairCorrelation)
        ? ' · mean within-cluster Pearson r ' + weight(selectedCluster.meanPairCorrelation)
        : '');
    syncTabs();
    overview.replaceChildren();
    for (const group of groups) {
      const matches = group.cells.filter(match),
        b = btn('wx-group', '');
      b.dataset.group = String(group.group);
      b.disabled = !matches.length;
      b.setAttribute('aria-pressed', String(group.group === g.group && visible.length > 0));
      b.setAttribute(
        'aria-label',
        'Group ' +
          group.group +
          ', channels ' +
          group.first +
          ' to ' +
          group.last +
          ', ' +
          matches.length +
          ' match, ' +
          group.changed +
          ' edits total',
      );
      b.title =
        'Channels ' + group.first + '–' + group.last + ' · ' + group.changed + ' edits · ' + matches.length + ' match';
      b.append(
        miniGrid(group.cells, match),
        make('b', '', 'G' + String(group.group).padStart(2, '0')),
        make('small', '', group.first + '–' + group.last),
      );
      b.onclick = () => {
        const c = matches.find((c) => c.changed) ?? matches[0];
        setColumn(c.column);
        overview.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus();
      };
      overview.append(b);
    }
    const evidence = head.activationClustering;
    const sample = evidence?.states
      ? n(evidence.states) +
        ' archived development decisions' +
        (evidence.uniqueFeatureRows ? ' (' + n(evidence.uniqueFeatureRows) + ' distinct observations)' : '')
      : 'development observations';
    info.replaceChildren(
      make(
        'p',
        'wx-hint',
        model.clusterNote ||
          (clusters.length
            ? 'Activation clusters group edited channels by signed Pearson correlation across ' +
              sample +
              '. Cluster IDs describe co-activation on this sample. Unedited channels have no cluster.'
            : 'The release supplies no activation clusters.'),
      ),
    );
    focus.replaceChildren();
    values.replaceChildren();
    if (!visible.length) {
      focus.append(
        make('p', 'wx-empty', 'No channels match these filters. Choose another cluster or coordinate filter.'),
      );
      return;
    }
    const hdr = make('div', 'wx-zoom-head');
    hdr.append(
      make('h4', '', 'Group ' + String(g.group).padStart(2, '0')),
      make('span', 'wx-tag', g.changed + ' / ' + g.cells.length + ' edited'),
    );
    const grid = make('div', 'wx-grid');
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', 'Channels in group ' + g.group);
    for (const c of g.cells) {
      const delta = c.editedCode - c.baseCode,
        b = btn('wx-cell wx-' + signClass(delta), String(c.column));
      b.dataset.column = String(c.column);
      b.disabled = !match(c);
      b.tabIndex = c.column === current ? 0 : -1;
      b.setAttribute('aria-pressed', String(c.column === current));
      b.setAttribute('aria-label', 'Channel ' + c.column + ', parameter ' + c.baseCode + ' to ' + c.editedCode);
      b.title = 'Channel ' + c.column + ' · ' + c.baseCode + ' → ' + c.editedCode;
      b.onclick = () => setColumn(c.column, true);
      b.onkeydown = (e) => {
        const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -8, ArrowDown: 8 };
        let i = c.column;
        if (e.key === 'Home' || e.key === 'End') {
          const eligible = g.cells.filter(match);
          i = (e.key === 'Home' ? eligible[0] : eligible[eligible.length - 1]).column;
        } else if (Object.hasOwn(offsets, e.key)) {
          do {
            i += offsets[e.key];
          } while (i >= g.first && i <= g.last && !match(channels[i]));
        } else return;
        e.preventDefault();
        if (i >= g.first && i <= g.last) setColumn(i, true);
      };
      grid.append(b);
    }
    focus.append(hdr);
    if (Number.isFinite(g.increases) && Number.isFinite(g.decreases))
      focus.append(
        make(
          'p',
          'wx-hint',
          g.increases +
            ' increases · ' +
            g.decreases +
            ' decreases · ' +
            (g.meanAbsDelta == null
              ? 'No edits in this group'
              : 'mean absolute edit ' + weight(g.meanAbsDelta) + ' weight units per edited channel'),
        ),
      );
    focus.append(grid, make('p', 'wx-hint', 'Arrow keys move by cell or row. Home and End jump within the group.'));
    const readHead = make('div', 'wx-zoom-head');
    readHead.append(make('h4', '', 'Channel ' + current + ' ← ' + (picked.changed ? 'edited' : 'unedited')));
    const table = make('table', 'wx-values'),
      thead = table.createTHead().insertRow();
    for (const text of ['Stage', 'Parameter', 'Weight']) {
      const th = make('th', '', text);
      th.scope = 'col';
      thead.append(th);
    }
    const tbody = table.createTBody();
    const stages: Stage[] = model.stages
      ? model.stages(picked)
      : [
          ['Original FP32', '—', picked.fp32],
          ['Quantized 4-bit', picked.baseCode, picked.w4],
          ['After DNP', picked.editedCode, picked.edited],
        ];
    for (const [stage, code, val] of stages) {
      const r = tbody.insertRow(),
        label = make('th', '', stage);
      label.scope = 'row';
      r.append(label);
      r.insertCell().textContent = String(code);
      r.insertCell().textContent = val == null ? '—' : weight(val);
    }
    values.append(
      readHead,
      table,
      facts(
        model.facts
          ? model.facts(picked)
          : [
              ['Group scale', weight(picked.scale) + ' weight per step'],
              ['Quantization Δ', signed(picked.w4 - Number(picked.fp32))],
              ['Direct edit Δ', signed(picked.delta)],
              ['Net Δ from FP32', signed(picked.edited - Number(picked.fp32))],
              ['Activation cluster', picked.cluster == null ? 'Unassigned' : 'C' + picked.cluster],
            ],
      ),
    );
  }
  render();
  return root;
}
function controllerView(model: ControllerViewModel, opts: { index?: number; bare?: boolean } = {}): HTMLDivElement {
  const root = make('div', 'wx-controllers');
  if (!model.controllers.length) {
    root.append(make('p', 'wx-empty', 'No added controller matrix in this release.'));
    return root;
  }
  let index = opts.index ?? 0,
    row = 0,
    col = 0;
  const view = make('div', 'wx-controller-view');
  // One tab per added matrix; a cell is chosen in the matrix itself.
  // In the revision view the explorer's own tab bar chooses the matrix (opts.bare); elsewhere the view has its own matrix tabs.
  const matrixTabs = opts.bare
    ? null
    : tabStrip(
        'Added matrices',
        model.controllers.map((m, i): TabItem<number> => [i, m.name + (m.nonzero === 0 ? ' · off' : '')]),
        index,
        (v) => {
          index = Number(v);
          row = 0;
          col = 0;
          render();
        },
        'wx-matrix-tabs',
      );
  root.append(...(matrixTabs ? [matrixTabs.strip] : []), view);
  function render(): void {
    const m = model.controllers[index];
    matrixTabs?.mark(index);
    const zone = make('div', 'wx-matrix-scroll'),
      table = make('table', 'wx-matrix');
    table.setAttribute('aria-label', m.name + ' signed parameters, output rows by input columns');
    const header = table.createTHead().insertRow(),
      corner = make('th', '', 'Output / input');
    corner.scope = 'col';
    header.append(corner);
    m.inputs.forEach((name, i) => {
      const h = make('th', '', String(i));
      h.scope = 'col';
      h.title = name;
      h.setAttribute('aria-label', 'Input ' + i + ' ' + name);
      header.append(h);
    });
    const body = table.createTBody(),
      cells: HTMLButtonElement[][] = [];
    for (let r = 0; r < m.outputs.length; r++) {
      const tr = body.insertRow(),
        th = make('th', '', m.outputs[r]);
      th.scope = 'row';
      tr.append(th);
      cells[r] = [];
      for (let c = 0; c < m.inputs.length; c++) {
        const code = m.codes[r][c],
          baseCode = m.baseCodes?.[r]?.[c],
          b = btn(
            'wx-matrix-cell wx-' + signClass(code) + (baseCode !== undefined && baseCode !== code ? ' wx-changed' : ''),
            code === 0 ? '0' : signed(code),
          );
        b.title =
          m.outputs[r] +
          ' × ' +
          m.inputs[c] +
          ' · parameter ' +
          code +
          (baseCode !== undefined && baseCode !== code ? ' (was ' + baseCode + ')' : '');
        b.setAttribute('aria-label', b.title);
        b.dataset.row = String(r);
        b.dataset.col = String(c);
        b.onclick = () => pick(r, c, true);
        b.onkeydown = (e) => {
          const dr: Record<string, number> = { ArrowUp: -1, ArrowDown: 1 },
            dc: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };
          if (e.key === 'Home' || e.key === 'End') {
            e.preventDefault();
            pick(r, e.key === 'Home' ? 0 : m.inputs.length - 1, true);
          } else if (e.key in dr || e.key in dc) {
            e.preventDefault();
            pick(
              Math.max(0, Math.min(m.outputs.length - 1, r + (dr[e.key] || 0))),
              Math.max(0, Math.min(m.inputs.length - 1, c + (dc[e.key] || 0))),
              true,
            );
          }
        };
        tr.insertCell().append(b);
        cells[r][c] = b;
      }
    }
    zone.append(table);
    const hdr = make('div', 'wx-zoom-head');
    hdr.append(
      make('h4', '', m.name),
      make('span', 'wx-tag', m.outputs.length + ' rows × ' + m.inputs.length + ' inputs'),
    );
    const changedCount = m.baseCodes ? m.codes.flat().filter((v, i) => v !== m.baseCodes?.flat()[i]).length : null;
    const baseNonzero = m.baseCodes ? m.baseCodes.flat().filter((x) => x !== 0).length : null;
    const caption = make(
      'p',
      'wx-hint',
      n(m.nonzero) +
        ' nonzero parameters across ' +
        n(m.slots) +
        ' added slots. Columns are numbered from zero.' +
        (changedCount !== null ? ' ' + n(changedCount) + ' parameters differ from the base (outlined).' : ''),
    );
    // A readout whose parameters are all zero adds nothing to the action scores: say so instead of showing an empty-looking active matrix.
    const off = (side: string) =>
      make(
        'p',
        'wx-readout-off',
        side +
          ': all ' +
          n(m.slots) +
          ' weights of this matrix are 0, so it adds nothing to the decision (neutral sensor weights).',
      );
    const offNotes = [
      ...(m.nonzero === 0
        ? [off(model.labels?.candidate ? 'Candidate ' + model.labels.candidate : 'This revision')]
        : []),
      ...(baseNonzero === 0 ? [off('Base ' + model.labels?.base)] : []),
    ];
    const readings = make('div', 'wx-controller-reading');
    readings.setAttribute('aria-live', 'polite');
    view.replaceChildren(
      hdr,
      caption,
      ...offNotes,
      zone,
      legend([
        ['up', '+', 'Positive'],
        ['down', '−', 'Negative'],
        ['same', '0', 'Zero'],
        ...(m.baseCodes ? [['changed', 'Δ', 'Changed vs base'] satisfies LegendPart] : []),
      ]),
      readings,
    );
    if (m.routing) view.append(make('p', 'wx-hint', m.routing));
    function pick(r: number, c: number, focusCell = false): void {
      const prior = cells[row]?.[col];
      if (prior) {
        prior.tabIndex = -1;
        prior.setAttribute('aria-pressed', 'false');
      }
      row = r;
      col = c;
      const b = cells[r][c];
      b.tabIndex = 0;
      b.setAttribute('aria-pressed', 'true');
      if (focusCell) b.focus();
      const v = controllerCell(m, r, c);
      const baseCode = m.baseCodes?.[r]?.[c];
      readings.replaceChildren(
        make('h4', '', v.output + ' ← ' + v.input),
        facts([
          ['Coordinate', '[' + r + ', ' + c + ']'],
          ...((baseCode !== undefined
            ? [
                ['Base parameter', signed(baseCode)],
                ['Candidate parameter', signed(v.code)],
                ['Parameter Δ', signed(v.code - baseCode)],
              ]
            : [['Added signed parameter', signed(v.code)]]) satisfies Fact[]),
          ['Output-row scale', weight(v.scale) + ' weight per step'],
          ['Reconstructed weight', signed(v.weight)],
        ]),
      );
    }
    for (const line of cells)
      for (const b of line) {
        b.tabIndex = -1;
        b.setAttribute('aria-pressed', 'false');
      }
    pick(row, col);
  }
  render();
  return root;
}

function renderComparison(host: HTMLElement, model: PreparedComparison): PreparedComparison {
  const s = model.summary;
  const content = make('div', 'wx-content'),
    stats = make('div', 'wx-metrics');
  const totalSlots = model.controllers.reduce((a, c) => a + c.slots, 0),
    nonzero = model.controllers.reduce((a, c) => a + c.nonzero, 0);
  stats.append(
    metric('FP32 → 4-bit', s.quantizationChanged, 'native weight values changed during quantization'),
    metric('4-bit → DNP', s.directChanged, 'native weight coordinates directly edited'),
    metric(
      'Added sensor weights',
      totalSlots,
      n(nonzero) + ' nonzero parameters in ' + model.controllers.length + ' controller matrices',
    ),
  );
  const scope = make(
    'p',
    'wx-intro',
    'The native backbone contains ' +
      n(s.parameters) +
      ' parameters. Comparing the original FP32 values directly with the edited backbone gives ' +
      n(s.netChanged) +
      ' changed weights. A coordinate can change at both stages.',
  );
  const viewer = make('div', 'wx-viewer'),
    toolbar = make('div', 'wx-toolbar'),
    controls = make('div', 'wx-modes');
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Weight comparison view');
  const body = make('div', 'wx-body');
  const views: [label: string, view: (model: PreparedComparison) => HTMLElement][] = [
    ['Base model weights · row 2', nativeView],
    ['Extra weights added', controllerView],
  ];
  const cached: HTMLElement[] = [];
  views.forEach(([label, fn], i) => {
    const b = btn('wx-mode', label);
    b.setAttribute('aria-pressed', String(!i));
    b.dataset.view = String(i);
    b.onclick = () => {
      controls.querySelectorAll('button').forEach((t, j) => t.setAttribute('aria-pressed', String(i === j)));
      body.replaceChildren((cached[i] ??= fn(model)));
    };
    controls.append(b);
  });
  toolbar.append(controls);
  viewer.append(toolbar, body);
  body.append((cached[0] = nativeView(model)));
  content.append(stats, scope, viewer, inventory(model));
  host.replaceChildren(content);
  return model;
}

/** Compare two base-relative W4 recipes: every active head row plus the three controller matrices, with base codes for highlighting. */
export function buildRevisionComparison({
  candidate,
  base,
  release,
  head,
  row = 2,
  labels = {},
}: RevisionComparisonInput): RevisionComparison {
  ensure(head?.codes?.length === 3072 && head.scales?.length === 48, 'trusted head layout');
  const codesOf = (ops: RevisionSide['ops']) => {
    const codes = Int8Array.from(head.codes);
    for (const [r, c, , next] of ops || []) codes[r * 1024 + c] = next;
    return codes;
  };
  const baseCodes = codesOf(base.ops),
    candidateCodes = codesOf(candidate.ops);
  const releaseChannels =
    row === 2 && release?.head?.channels
      ? new Map(release.head.channels.map((c): [number, ReleaseChannel] => [c.column, c]))
      : null;
  const channels: Channel[] = [];
  for (let col = 0; col < 1024; col++) {
    const i = row * 1024 + col,
      scale = head.scales[i >>> 6],
      baseCode = baseCodes[i],
      editedCode = candidateCodes[i];
    const w4 = baseCode * scale,
      edited = editedCode * scale;
    channels.push({
      column: col,
      group: col >>> 6,
      fp32: releaseChannels?.get(col)?.fp32 ?? null,
      baseCode,
      editedCode,
      scale,
      w4,
      edited,
      delta: edited - w4,
      changed: baseCode !== editedCode,
      cluster: null,
    });
  }
  const groups = Array.from({ length: 16 }, (_, g): ChannelGroup => {
    const cells = channels.slice(g * 64, g * 64 + 64),
      changedCells = cells.filter((c) => c.changed);
    return {
      group: g,
      first: g * 64,
      last: g * 64 + 63,
      changed: changedCells.length,
      increases: changedCells.filter((c) => c.delta > 0).length,
      decreases: changedCells.filter((c) => c.delta < 0).length,
      meanAbsDelta: changedCells.length
        ? changedCells.reduce((a, c) => a + Math.abs(c.delta), 0) / changedCells.length
        : null,
      scale: head.scales[row * 16 + g],
      cells,
    };
  });
  const rowChanges = [0, 1, 2].map((r) => {
    let k = 0;
    for (let c = 0; c < 1024; c++) if (baseCodes[r * 1024 + c] !== candidateCodes[r * 1024 + c]) k++;
    return k;
  });
  const matrices: [key: keyof Controller, name: string][] = [
    ['graft', 'Aim sensor weights (graft)'],
    ['combat', 'Combat sensor weights'],
    ['facing', 'Facing guard'],
  ];
  const controllers = matrices.map(([key, name]): RevisionController => {
    const c = candidate.tactical?.[key] ?? candidate.controller?.[key],
      b = base.tactical?.[key] ?? base.controller?.[key];
    ensure(c && b, 'controller ' + key);
    const single = isTied(c);
    const inputs = single ? [c.input] : [...c.inputs],
      outputs = single ? [c.output] : [...c.outputs];
    const codes = single ? [[c.code]] : c.codes.map((r) => [...r]),
      baseCodesM = isTied(b) ? [[b.code]] : b.codes.map((r) => [...r]),
      scales = single ? [c.scale] : [...c.scales];
    return {
      id: key,
      name,
      inputs,
      outputs,
      codes,
      baseCodes: baseCodesM,
      scales,
      slots: inputs.length * outputs.length,
      nonzero: codes.flat().filter((x) => x !== 0).length,
      changed: codes.flat().filter((v, i) => v !== baseCodesM.flat()[i]).length,
    };
  });
  const candidateLabel = labels.candidate || 'Candidate',
    baseLabel = labels.base || 'Base';
  return {
    summary: {
      directChanged: rowChanges.reduce((a, b) => a + b, 0),
      rowChanges,
      controllerChanged: controllers.reduce((a, m) => a + m.changed, 0),
      controllerSlots: controllers.reduce((a, m) => a + m.slots, 0),
      candidateNonzero: controllers.reduce((a, m) => a + m.nonzero, 0),
      baseNonzero: controllers.reduce((a, m) => a + m.baseCodes.flat().filter((x) => x !== 0).length, 0),
    },
    head: {
      name: head.tensor,
      row,
      rowLabel: head.actions[row],
      shape: [10, 1024],
      groupSize: 64,
      activeRows: [0, 1, 2],
    },
    channels,
    groups,
    clusters: [],
    controllers,
    labels: { candidate: candidateLabel, base: baseLabel },
    editedLabel: 'changed',
    compact: true,
    intro:
      head.tensor +
      ' · output row ' +
      row +
      ' (' +
      head.actions[row] +
      ') · ' +
      baseLabel +
      ' → ' +
      candidateLabel +
      '. Parameters are relative to the immutable 4-bit base; select a group to inspect its channels.',
    clusterNote:
      'Activation clusters are only published for the shipped edit. This view compares two revisions parameter by parameter.',
    stages: (c) => [
      ...((c.fp32 == null ? [] : [['Original FP32', '—', c.fp32]]) satisfies Stage[]),
      [baseLabel, c.baseCode, c.w4],
      [candidateLabel, c.editedCode, c.edited],
    ],
    facts: (c) => [
      ['Group scale', weight(c.scale) + ' weight per step'],
      ['Parameter Δ', signed(c.editedCode - c.baseCode)],
      ['Weight Δ', signed(c.delta)],
      ['4-bit base parameter', String(head.codes[row * 1024 + c.column])],
    ],
  };
}
export function renderRevisionDiff(
  host: HTMLElement,
  model: RevisionComparison,
  opts: RevisionDiffOptions = {},
): RevisionComparison {
  const s = model.summary,
    content = make('div', 'wx-content'),
    stats = make('div', 'wx-metrics');
  stats.append(
    metric(
      'Base model weights',
      s.directChanged,
      'head coordinates that differ · rows ' + s.rowChanges.map((k, r) => r + ': ' + n(k)).join(' · '),
    ),
    metric(
      'Extra weights added',
      s.controllerChanged,
      'of ' +
        n(s.controllerSlots) +
        ' sensor weights differ · nonzero: candidate ' +
        n(s.candidateNonzero) +
        (s.candidateNonzero === 0 ? ' (neutral)' : '') +
        ', base ' +
        n(s.baseNonzero) +
        (s.baseNonzero === 0 ? ' (neutral)' : ''),
    ),
  );
  const viewer = make('div', 'wx-viewer'),
    toolbar = make('div', 'wx-toolbar'),
    body = make('div', 'wx-body');
  // One tab bar: the added sensor-weight matrices first, then the three output rows. A row other than the built one asks the host
  // to rebuild the comparison for that row (opts.onRow); every choice is reported so the host can keep it (opts.onView).
  const short = (name: string) => name.replace(/ sensor weights.*$/, '');
  const items: TabItem<string>[] = [
    ...model.controllers.map((m, i): TabItem<string> => [
      'm' + i,
      short(m.name) + (m.nonzero === 0 ? ' · off' : ''),
      m.name,
    ]),
    ['r0', 'Row Left'],
    ['r1', 'Row Right'],
    ['r2', 'Row Fire'],
  ];
  const cached: Partial<Record<string, HTMLElement>> = {};
  const show = (v: string) => {
    if (v.startsWith('r') && Number(v.slice(1)) !== model.head.row) {
      opts.onRow?.(Number(v.slice(1)));
      return;
    }
    tabs.mark(v);
    opts.onView?.(v);
    body.replaceChildren(
      (cached[v] ??= v.startsWith('r')
        ? nativeView(model)
        : controllerView(model, { index: Number(v.slice(1)), bare: true })),
    );
  };
  const first =
    opts.view !== undefined &&
    items.some(([v]) => v === opts.view) &&
    !(opts.view.startsWith('r') && Number(opts.view.slice(1)) !== model.head.row)
      ? opts.view
      : 'm0';
  const tabs = tabStrip('Explorer view', items, first, show, 'wx-view-tabs');
  // The three summary tiles sit inside the explorer, between its header and the selected view.
  toolbar.append(tabs.strip);
  viewer.append(toolbar, stats, body);
  show(first);
  content.append(viewer); // the selectors already name both models
  // Registered as mounted, so a late lazy mount of the release view does not replace this comparison.
  mounted.set(host, Promise.resolve(model));
  host.replaceChildren(content);
  return model;
}
export function remountWeightsExplorer(
  host: HTMLElement,
  options: MountOptions = {},
): Promise<ExplorerComparison | null> {
  mounted.delete(host);
  return mountWeightsExplorer(host, options);
}

const mounted = new WeakMap<HTMLElement, Promise<ExplorerComparison | null>>();
export function mountWeightsExplorer(
  host: HTMLElement,
  options: MountOptions = {},
): Promise<ExplorerComparison | null> {
  const existing = mounted.get(host);
  if (existing) return existing;
  const source = options.src || host.dataset.src;
  const status = make('p', 'wx-load', 'Loading weight comparison…');
  status.setAttribute('role', 'status');
  host.replaceChildren(status);
  const ready: Promise<PreparedComparison | null> = Promise.resolve()
    .then(async () => {
      if (options.data) return options.data;
      const response = await fetch(String(source), { credentials: 'same-origin' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json() as Promise<ReleaseDocument>;
    })
    .then((data) => (mounted.get(host) === ready ? renderComparison(host, prepareComparison(data)) : null))
    .catch((error: unknown) => {
      if (mounted.get(host) !== ready) return null;
      mounted.delete(host);
      const retry = btn('wx-mode', 'Retry');
      status.textContent = 'The comparison could not load. ';
      retry.onclick = () => mountWeightsExplorer(host, options).catch(() => {});
      status.append(retry);
      throw error;
    });
  mounted.set(host, ready);
  return ready;
}

if (typeof document !== 'undefined') {
  const mounts = [...document.querySelectorAll<HTMLElement>('[data-weights-explorer]')];
  const launch = (el: HTMLElement) =>
    mountWeightsExplorer(el).catch((error: Error) => console.error('Weights explorer:', error.message));
  if ('IntersectionObserver' in globalThis) {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            observer.unobserve(entry.target);
            launch(entry.target as HTMLElement);
          }
      },
      { rootMargin: '180px 0px' },
    );
    mounts.forEach((el) => observer.observe(el));
  } else mounts.forEach(launch);
}

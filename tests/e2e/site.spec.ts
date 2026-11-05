/** The built site in Chromium: every section renders, every live path runs, and nothing logs an error or fails to load. */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { RevisionRecord } from '../../src/revisions/store.ts';
import type { PlayRequest } from '../../src/workers/play-worker.ts';

const trainedPlaybackModel = JSON.parse(
  readFileSync(new URL('../fixtures/huggingdoom-trained-model.json', import.meta.url), 'utf8'),
) as { record: RevisionRecord };
const secondTrainedModel = JSON.parse(
  readFileSync(new URL('../fixtures/huggingdoom-trained-model-second.json', import.meta.url), 'utf8'),
) as { record: RevisionRecord };

const problems = new WeakMap<Page, string[]>();
/** Model pack requests, including those from workers (context-level events). */
const packs = new WeakMap<Page, string[]>();
const HUGGING_FACE_PACK =
  /^https:\/\/huggingface\.co\/kyr0\/evoweights-evolutionary-weight-space-fine-tuning\/resolve\/[0-9a-f]{40}\/base\/(4bit|fp32)\//;

test.beforeEach(async ({ page }) => {
  const seen: string[] = [];
  problems.set(page, seen);
  const requested: string[] = [];
  packs.set(page, requested);
  page.context().on('request', (r) => {
    if (r.url().endsWith('.pack')) requested.push(r.url());
  });
  page.on('console', (m) => {
    if (m.type() === 'error') seen.push('console: ' + m.text());
  });
  page.on('pageerror', (e) => seen.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => seen.push('requestfailed: ' + r.url() + ' ' + r.failure()?.errorText));
  page.on('response', (r) => {
    if (r.status() >= 400) seen.push('http ' + r.status() + ': ' + r.url());
  });
  await page.goto('./');
});

test.afterEach(async ({ page }) => {
  expect(problems.get(page)).toEqual([]);
});

/** Pack file names requested so far; fails when a pack came from anywhere but the pinned Hugging Face commit. */
function packNames(page: Page): string[] {
  const urls = packs.get(page) ?? [];
  for (const url of urls) expect(url).toMatch(HUGGING_FACE_PACK);
  return urls.map((url) => url.slice(url.lastIndexOf('/') + 1));
}

async function live(page: Page) {
  await expect(page.locator('#status')).toContainText('LIVE', { timeout: 60_000 });
}

test('every section renders and the static controls work', async ({ page }) => {
  await expect(page).toHaveTitle(/EvoWeights/);
  for (const id of [
    'arena',
    'model-tree',
    'architecture',
    'model-diff',
    'statistics',
    'results',
    'inference',
    'explore-weights',
    'performance',
    'use-cases',
  ])
    await expect(page.locator('#' + id)).toBeAttached();
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  // Weights explorer: the comparison replaces the loading note.
  const explorer = page.locator('[data-weights-explorer]');
  await explorer.scrollIntoViewIfNeeded();
  await expect(explorer.locator('.wx-load')).toHaveCount(0, { timeout: 30_000 });
  await expect(explorer.locator('.wx-viewer').first()).toBeVisible();
  // Revisions panel: the model list and tree load from storage and the shipped data.
  await expect(page.locator('#revision-select')).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator('#revision-tree-meta')).not.toHaveText('Loading …');
  // The site keeps its light appearance even with a saved dark preference.
  await page.evaluate(() =>
    localStorage.setItem('defuss-shadcn-theme', JSON.stringify({ format: 'defuss-store', value: 'dark' })),
  );
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
  await expect(page.locator('[data-portal-theme-toggle]')).toHaveCount(0);
  // Result tabs follow the keyboard pattern of a tablist: arrows move, End jumps to the last tab, one panel shows.
  await page.locator('#res-tab-survival').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#res-tab-hugs')).toBeFocused();
  await expect(page.locator('#res-hugs')).toBeVisible();
  await expect(page.locator('#res-survival')).toBeHidden();
  await page.keyboard.press('End');
  await expect(page.locator('#res-tab-time')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#res-time')).toBeVisible();
  await expect(page.locator('#res-hugs')).toBeHidden();
  await page.keyboard.press('Home');
  await expect(page.locator('#res-survival')).toBeVisible();
  // Use-case tabs show one panel at a time.
  await page.locator('#uc-tab-1').click();
  await expect(page.locator('#uc-panel-1')).toBeVisible();
  await expect(page.locator('#uc-panel-0')).toBeHidden();
  // Performance tabs: each shows its own panel (regression: the research panel used to enclose the other one).
  await page.locator('#perf-tab-yours').click();
  await expect(page.locator('#perf-yours')).toBeVisible();
  await expect(page.locator('#perf-research')).toBeHidden();
  await page.locator('#perf-tab-research').click();
  await expect(page.locator('#perf-research')).toBeVisible();
  await expect(page.locator('#perf-yours')).toBeHidden();
  // Packs load on demand: browsing the page downloads none.
  expect(packNames(page)).toEqual([]);
});

test('the weight explorer keeps one view tab bar and integrated statistics across comparisons', async ({ page }) => {
  const explorer = page.locator('[data-weights-explorer]'),
    candidate = page.locator('#explore-candidate'),
    base = page.locator('#explore-base'),
    tabs = explorer.getByRole('tab'),
    stats = explorer.locator('.wx-viewer > .wx-metrics');
  await explorer.scrollIntoViewIfNeeded();
  // A fresh visitor has no current evaluation scores. That must still open the unified revision explorer.
  await expect(candidate.locator('option:checked')).toContainText('Introvertor');
  await expect(base.locator('option:checked')).toContainText('Astra 6 Weight-Space Programming');
  await expect(tabs).toHaveText(['Aim', 'Combat', 'Facing guard', 'Row Left', 'Row Right', 'Row Fire']);
  await expect(explorer.getByRole('tablist')).toHaveCount(1);
  await expect(stats.locator('.wx-metric')).toHaveCount(2);
  await expect(stats).toContainText('Base model weights');
  await expect(stats).toContainText('Extra weights added');
  const summary = await stats.textContent();
  for (const [name, heading] of [
    ['Aim', 'Aim sensor weights (graft)'],
    ['Combat', 'Combat sensor weights'],
    ['Facing guard', 'Facing guard'],
    ['Row Left', 'Class 0 channel map'],
    ['Row Right', 'Class 1 channel map'],
    ['Row Fire', 'Class 2 channel map'],
  ]) {
    await explorer.getByRole('tab', { name, exact: true }).click();
    await expect(explorer.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(explorer.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(explorer.getByRole('tablist')).toHaveCount(1);
    await expect(stats).toHaveText(summary!);
  }
  // Row changes rebuild the view; keyboard focus must survive so every tab stays reachable.
  await explorer.getByRole('tab', { name: 'Facing guard', exact: true }).click();
  await explorer.getByRole('tab', { name: 'Facing guard', exact: true }).press('ArrowRight');
  await expect(explorer.getByRole('tab', { name: 'Row Left', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(explorer.getByRole('tab', { name: 'Row Fire', exact: true })).toBeFocused();
  // Rapid navigation must not be overwritten by a pending row rebuild.
  await explorer.getByRole('tab', { name: 'Facing guard', exact: true }).click();
  await page.evaluate(() => {
    for (const key of ['ArrowRight', 'End'])
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
  await expect(explorer.getByRole('tab', { name: 'Row Fire', exact: true })).toBeFocused();
  await expect(explorer.getByRole('tab', { name: 'Row Fire', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(explorer.getByRole('tab', { name: 'Aim', exact: true })).toBeFocused();
  await expect(explorer.locator('.wx-matrix-cell.wx-up').first()).toHaveCSS('background-color', 'rgb(182, 164, 252)');
  await expect(explorer.locator('.wx-matrix-cell.wx-down').first()).toHaveCSS('background-color', 'rgb(101, 211, 188)');
  await explorer.locator('.wx-viewer').screenshot({ path: 'output/weights-explorer-unified.png' });

  // Explicit release comparison uses the same design, exposing only its available native FIRE row.
  const introvertor = await candidate.inputValue();
  await candidate.selectOption('');
  await expect(tabs).toHaveText(['Aim', 'Combat', 'Facing guard', 'Row Fire']);
  await expect(stats.locator('.wx-metric')).toHaveCount(3);
  for (const name of ['Aim', 'Combat', 'Facing guard', 'Row Fire']) {
    await explorer.getByRole('tab', { name, exact: true }).click();
    await expect(explorer.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(explorer.getByRole('tablist')).toHaveCount(1);
  }
  await explorer.getByRole('combobox', { name: 'Activation cluster', exact: true }).selectOption('0');
  await expect(explorer.getByRole('status')).not.toContainText('1,024 of 1,024');
  await expect(explorer.locator('.wx-cell:disabled').first()).toBeAttached();
  await explorer.getByRole('combobox', { name: 'Activation cluster', exact: true }).selectOption('');
  await expect(explorer.getByRole('status')).toContainText('1,024 of 1,024');

  // Changing models and resizing keeps the unified controls and summaries usable.
  await candidate.selectOption(introvertor);
  await base.selectOption(introvertor);
  await expect(stats.locator('.wx-metric strong')).toHaveText(['0', '0']);
  await expect(tabs).toHaveCount(6);
  await page.setViewportSize({ width: 390, height: 844 });
  await explorer.getByRole('tab', { name: 'Row Fire', exact: true }).click();
  await expect(explorer.getByRole('heading', { name: 'Class 2 channel map', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await explorer.locator('.wx-viewer').screenshot({ path: 'output/weights-explorer-mobile.png' });
  expect(packNames(page)).toEqual([]);
});

test('every built-in game card opens its matching weight comparison', async ({ page }) => {
  const candidate = page.locator('#explore-candidate');
  for (const key of ['terminator', 'survivor', 'opus', 'shipped', 'original']) {
    const button = page.locator('#pick [data-explore="' + key + '"]');
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
    const id = await button.evaluate((el) => el.closest<HTMLElement>('.pick-card')!.dataset.ref!);
    await button.click();
    await expect(candidate).toHaveValue(key === 'original' ? '' : id);
    await expect(page.locator('[data-weights-explorer] .wx-load')).toHaveCount(0);
    await expect(page.locator('[data-weights-explorer] [role="tablist"]')).toHaveCount(1);
  }
  await expect(page.locator('#explore-note')).toContainText('Original FP32 weights');
  await expect(page.locator('[data-weights-explorer] .wx-viewer > .wx-metrics .wx-metric')).toHaveCount(3);
  // Opening comparisons uses the published weight data, without downloading inference model packs.
  expect(packNames(page)).toEqual([]);
});

test('the hero shows its completion card and can repeat the evolution', async ({ page }) => {
  const complete = page.locator('[data-evo="complete"]');
  await page.locator('[data-evo="canvas"]').scrollIntoViewIfNeeded();
  // Completion follows stalled generations, not a fixed wall-clock duration.
  await expect(complete).toBeVisible({ timeout: 60_000 });
  await expect(complete).toContainText('Local optimum reached');
  await expect(complete.locator('[data-evo="completion-detail"]')).toContainText('No validated child');
  await page.locator('.evo-plate').screenshot({ path: 'output/evolution-complete.png' });
  await complete.getByRole('button', { name: 'Repeat the evolution' }).click();
  await expect(complete).toBeHidden();
});

test('the shipped model plays, pauses, resumes and returns to the menu', async ({ page }) => {
  await page.locator('[data-pick="shipped"]').click();
  await live(page);
  await expect(page.locator('#actual-backend')).toHaveText('WASM SIMD · 1 thread');
  for (const width of [1440, 1600, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    // The complete native frame must fill the view, without pale strips or clipped corners.
    await expect
      .poll(() =>
        page.locator('#screen').evaluate((canvas: HTMLCanvasElement) => {
          const rect = canvas.getBoundingClientRect();
          return Math.abs(rect.width - (rect.height * canvas.width) / canvas.height);
        }),
      )
      .toBeLessThan(1);
    await expect(page.locator('#screen')).toHaveCSS('border-radius', '0px');
    await page.locator('#viewport').screenshot({ path: `output/huggingdoom-ai-edges-${width}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.locator('#game-time')).not.toHaveText('0:00', { timeout: 30_000 });
  await expect(page.locator('#maneuver')).not.toHaveText('—');
  await expect(page.locator('#decision-rate')).toHaveText(/^\d+$/, { timeout: 10_000 });
  await page.locator('#toggle').click();
  await expect(page.locator('#status')).toContainText('PAUSED');
  await page.locator('#toggle').click();
  await live(page);
  await page.locator('#restart').click();
  await expect(page.locator('#status')).toContainText('STANDBY');
  await expect(page.locator('#download-recording')).toBeEnabled();
  const names = packNames(page);
  expect(names).toContain('model-00.pack');
  expect(names.some((n) => n.startsWith('original-'))).toBe(false);
});

test('the original FP32 model plays its raw logits', async ({ page }) => {
  await page.locator('[data-pick="original"]').click();
  await live(page);
  await expect(page.locator('#actual-backend')).toHaveText('WASM SIMD · 1 thread');
  await expect(page.locator('#guard-status')).toHaveText('Original model · three raw action logits');
  await expect(page.locator('#game-time')).not.toHaveText('0:00', { timeout: 30_000 });
  expect(packNames(page)).toContain('original-00.pack');
  const downloaded = packNames(page);
  await page.locator('#restart').click();
  await page.reload();
  await page.locator('[data-pick="original"]').click();
  await live(page);
  expect(packNames(page)).toEqual(downloaded);
});

test('activating a newly trained model leaves human mode and loads its exact weights, including repeat plays', async ({
  page,
}) => {
  // Observe native Worker messages without replacing the worker or its responses.
  await page.evaluate(() => {
    const state = window as typeof window & { modelPlayRequests: PlayRequest[] };
    state.modelPlayRequests = [];
    const send = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message: PlayRequest, ...args: unknown[]) {
      if (message.type === 'init') state.modelPlayRequests.push(structuredClone(message));
      return Reflect.apply(send, this, [message, ...args]);
    };
  });
  await page.locator('#pick-human').click();
  await live(page);
  await expect(page.locator('#actual-backend')).toContainText('Keyboard / touch');
  // This fixture was promoted by the real HuggingDOOM training loop during bug reproduction.
  const record = await page.evaluate(async (model) => {
    const { openRevisionStore } = (await import(
      new URL('revisions/store.js', location.href).href
    )) as typeof import('../../src/revisions/store.ts');
    const store = await openRevisionStore();
    try {
      await store.adopt(model.parentId!, { expectedLatestId: (await store.latest()).id });
      return await store.promote({
        parentId: model.parentId!,
        ops: model.ops,
        controller: model.controller,
        name: model.name,
      });
    } finally {
      store.close();
    }
  }, trainedPlaybackModel.record);
  expect(record.id).toBe(trainedPlaybackModel.record.id);
  for (const repeat of [false, true]) {
    if (repeat) {
      await page.locator('#restart').click();
      await page.locator('#pick-human').click();
      await live(page);
      await expect(page.locator('#actual-backend')).toContainText('Keyboard / touch');
    }
    // Exercise the same application entry point used by the Congratulations button.
    expect(
      await page.evaluate(async (model) => {
        const { activateRevision } = (await import(new URL('app/main.js', location.href).href)) as {
          activateRevision: (record: RevisionRecord, play?: boolean) => boolean;
        };
        return activateRevision(model, true);
      }, record),
    ).toBe(true);
    await live(page);
    await expect(page.locator('#actual-backend')).toHaveText('WASM SIMD · 1 thread');
    await expect(page.locator('#keys-hint')).toBeHidden();
    await expect(page.locator('#touch-controls')).toBeHidden();
    await expect(page.locator('#stage-mode')).toContainText(record.name);
    const request = await page.evaluate(() =>
      (window as typeof window & { modelPlayRequests: PlayRequest[] }).modelPlayRequests.at(-1),
    );
    expect(request).toMatchObject({
      type: 'init',
      human: false,
      revisionId: record.id,
      revision: { ops: record.ops, tactical: record.controller },
    });
    await expect(page.locator('#decision-rate')).toHaveText(/^[1-9]\d*$/, { timeout: 10_000 });
  }
});

test('all models have survival ranks and performance bars, including selected local models after measurement', async ({
  page,
}) => {
  await expect(page.locator('#reference-measure')).toContainText('6 models');
  await expect(page.locator('#revision-tree .data-grid-header')).toHaveText([
    'Model',
    'Rank',
    'Performance',
    'Parent',
    'Δ Parameters',
    'Actions',
  ]);
  await expect(page.locator('#revision-tree-body .tree-rank')).toHaveText(['#6', '#3', '#5', '#4', '#2', '#1']);
  await expect(page.locator('.pick-card[data-ref] .model-performance')).toHaveCount(5);
  const models = [trainedPlaybackModel.record, secondTrainedModel.record];
  await page.evaluate(async (records) => {
    const { openRevisionStore } = (await import(
      new URL('revisions/store.js', location.href).href
    )) as typeof import('../../src/revisions/store.ts');
    const store = await openRevisionStore();
    try {
      for (const r of records)
        await store.keep({ parentId: r.parentId!, ops: r.ops, controller: r.controller, name: r.name });
    } finally {
      store.close();
    }
  }, models);
  await page.reload();
  await page.locator('#revision-lanes').selectOption('6');
  await page.locator('#reference-measure').click();
  await expect(page.locator('#reference-measure')).toHaveText('Performance measured · 8 models', { timeout: 90000 });
  const expected = await page.evaluate(async () => {
    const { REFERENCE } = (await import(
      new URL('revisions/reference.js', location.href).href
    )) as typeof import('../../src/revisions/reference.ts');
    const bundled = await (await fetch('data/huggingdoom-reference-v1.json')).json();
    const records = { ...bundled.revisions, ...JSON.parse(localStorage.getItem(REFERENCE.cacheKey) || '{}') } as Record<
      string,
      { tics: number[]; kills: number[] }
    >;
    const totals = Object.entries(records).map(([id, rec]) => ({
      id,
      tics: rec.tics.reduce((a, b) => a + b, 0),
      kills: rec.kills.reduce((a, b) => a + b, 0),
    }));
    const baseline = totals.find((r) => r.id === bundled.originalId)!;
    return totals.map((r) => ({
      id: r.id,
      rank: 1 + totals.filter((other) => other.tics > r.tics).length,
      values: [r.tics / baseline.tics - 1, r.kills / baseline.kills - 1].map(
        (v) => (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(1) + ' %',
      ),
    }));
  });
  for (const score of expected) {
    const row = page.locator('#revision-tree-body [data-id="' + score.id + '"]');
    await expect(row.locator('.tree-rank')).toHaveText('#' + score.rank);
    await expect(row.locator('.performance-metric strong')).toHaveText(score.values);
  }
  for (const model of models) {
    const score = expected.find((r) => r.id === model.id)!;
    await page.locator('#pick-own-select').selectOption(model.id);
    await expect(page.locator('#pick-own .performance-metric strong')).toHaveText(score.values);
    await expect(page.locator('#pick-own .performance-metric > span')).toHaveText(['Survival', 'Hugs']);
    await page.locator('#pick-own [data-own-explore]').click();
    await expect(page.locator('#explore-candidate')).toHaveValue(model.id);
    await expect(page.locator('#explore-base')).toHaveValue(model.parentId!);
  }
  expect(expected.find((r) => r.id === models[0].id)?.values).not.toEqual(
    expected.find((r) => r.id === models[1].id)?.values,
  );
  await page.reload();
  await expect(page.locator('#reference-measure')).toHaveText('Performance measured · 8 models');
  await expect(page.locator('#pick-own .model-performance')).toBeVisible();
});

test('cached weights survive reloads and are shared by play, benchmarking, training and export', async ({ page }) => {
  await page.locator('[data-pick="shipped"]').click();
  await live(page);
  const downloaded = packNames(page);
  expect(downloaded.length).toBeGreaterThan(0);
  expect(new Set(downloaded).size).toBe(downloaded.length);
  await page.locator('#restart').click();

  await page.reload();
  await page.locator('[data-pick="shipped"]').click();
  await live(page);
  expect(packNames(page)).toEqual(downloaded);
  await page.locator('#restart').click();
  await page.locator('#benchmark').click();
  await expect(page.locator('#bench-status')).toContainText('Parity passed', { timeout: 90_000 });
  expect(packNames(page)).toEqual(downloaded);

  await page.locator('#revision-lanes').selectOption('2');
  await page.locator('#revision-learn').click();
  await expect(page.locator('#revision-lanes-active')).toContainText('2', { timeout: 60_000 });
  await expect(page.locator('#revision-decisions')).toHaveText(/^[1-9][\d,]*$/, { timeout: 90_000 });
  await page.locator('#revision-stop').click();
  await expect(page.locator('#revision-stop')).toContainText('Abort now');
  await page.locator('#revision-stop').click();
  await expect(page.locator('#revision-learn')).toBeVisible({ timeout: 30_000 });
  expect(packNames(page)).toEqual(downloaded);

  const exported = await page.evaluate(async () => {
    const { openRevisionStore } = (await import(
      new URL('revisions/store.js', location.href).href
    )) as typeof import('../../src/revisions/store.ts');
    const store = await openRevisionStore();
    try {
      return (await store.exportWeights(store.builtins.shipped.id)).size;
    } finally {
      store.close();
    }
  });
  expect(exported).toBeGreaterThan(0);
  expect(packNames(page)).toEqual(downloaded);
});

test('a visitor plays with the keyboard', async ({ page }) => {
  await page.locator('#pick-human').click();
  await live(page);
  await expect(page.locator('#stage-mode')).toContainText('You play · keyboard');
  await page.keyboard.down('ArrowUp');
  await expect(page.locator('#maneuver')).toContainText('YOU · FORWARD', { timeout: 10_000 });
  await page.keyboard.up('ArrowUp');
});

test('the inference benchmark passes PyTorch parity', async ({ page }) => {
  await page.locator('#benchmark').click();
  await expect(page.locator('#bench-status')).toContainText('Parity passed', { timeout: 90_000 });
  await expect(page.locator('#bench-results tr')).toHaveCount(1);
});

test('choosing FP32 for training selects the quantized neutral model and explains the switch', async ({ page }) => {
  const select = page.locator('#revision-select');
  await expect(select).toBeEnabled({ timeout: 30_000 });
  const original = await select
    .locator('option')
    .filter({ hasText: /^Original FP32/ })
    .getAttribute('value');
  const neutral = await select
    .locator('option')
    .filter({ hasText: /4-bit base · neutral sensor weights/ })
    .getAttribute('value');
  const hugginator = await select
    .locator('option')
    .filter({ hasText: /EvoWeights Hugginator/ })
    .getAttribute('value');
  expect(original).toBeTruthy();
  expect(neutral).toBeTruthy();
  expect(hugginator).toBeTruthy();

  await select.selectOption(original!);
  await expect(select).toHaveValue(neutral!);
  await expect(page.locator('#revision-notice')).toContainText(
    'Original FP32 was switched to the quantized 4-bit base with neutral sensor weights for training.',
  );
  await expect(page.locator('#revision-notice')).toHaveAttribute('data-error', 'false');
  await expect(page.locator('#revision-stop')).toBeHidden();
  expect(packNames(page)).toEqual([]);

  await page.reload();
  await expect(select).toHaveValue(neutral!);
  await select.selectOption(hugginator!);
  await expect(select).toHaveValue(hugginator!);
  await expect(page.locator('#revision-notice')).toBeEmpty();
});

test('only the Parent model selector changes the training preference, including after reload', async ({ page }) => {
  const select = page.getByRole('combobox', { name: 'Parent model', exact: true });
  await expect(select).toBeEnabled({ timeout: 30_000 });
  const neutral = await select.locator('option:checked').getAttribute('value');
  await expect(select.locator('option:checked')).toContainText('4-bit base · neutral sensor weights');
  const hugginator = await select
    .locator('option')
    .filter({ hasText: /EvoWeights Hugginator/ })
    .getAttribute('value');
  expect(hugginator).toBeTruthy();

  // Old tree/playback selections must not become saved training preferences.
  await page.evaluate((id) => localStorage.setItem('agm-arena-choice-v8', id!), hugginator);
  await page.reload();
  await expect(select).toHaveValue(neutral!);
  await page
    .locator('#revision-tree-body .tree-name')
    .filter({ hasText: /^EvoWeights Hugginator/ })
    .click();
  await expect(select).toHaveValue(neutral!);

  await select.selectOption(hugginator!);
  await page
    .locator('#revision-tree-body .tree-name')
    .filter({ hasText: /^Original FP32$/ })
    .click();
  await expect(select).toHaveValue(hugginator!);
  const introvertor = page.locator('#revision-tree-body .data-grid-row').filter({
    has: page.locator('.tree-name').filter({ hasText: /^EvoWeights Introvertor/ }),
  });
  await introvertor.getByRole('button', { name: 'Explore', exact: true }).click();
  await expect(select).toHaveValue(hugginator!);
  await page.reload();
  await expect(select).toHaveValue(hugginator!);
  await select.selectOption(neutral!);
  await page.reload();
  await expect(select).toHaveValue(neutral!);
  expect(packNames(page)).toEqual([]);
});

test('training uses the neutral default or the explicitly selected parent regardless of tree selection', async ({
  page,
}) => {
  await expect(page.locator('#revision-learn')).toBeEnabled({ timeout: 30_000 });
  const select = page.locator('#revision-select');
  const neutral = await select.locator('option:checked').getAttribute('value');
  const hugginator = await select
    .locator('option')
    .filter({ hasText: /EvoWeights Hugginator/ })
    .getAttribute('value');
  expect(neutral).toBeTruthy();
  expect(hugginator).toBeTruthy();
  await page.locator('#revision-lanes').selectOption('2');
  for (const [parentId, name] of [
    [neutral!, '4-bit base · neutral sensor weights'],
    [hugginator!, 'EvoWeights Hugginator'],
  ]) {
    if (parentId === hugginator) await select.selectOption(parentId);
    await page
      .locator('#revision-tree-body .tree-name')
      .filter({ hasText: /^Original FP32$/ })
      .click();
    await expect(select).toHaveValue(parentId);
    await page.locator('#revision-learn').click();
    await expect(page.locator('#revision-stop')).toBeVisible();
    await expect(page.locator('#revision-tip')).toContainText(name);
    await expect(page.locator('#revision-lanes-active')).toContainText('2', { timeout: 60_000 });
    await expect(page.locator('#revision-decisions')).toHaveText(/^[1-9][\d,]*$/, { timeout: 90_000 });
    await expect(page.locator('#training-overlay')).toBeVisible();
    await expect(page.locator('#training-overlay')).toHaveText(/^Training\.\.\. in \d+x realtime$/);
    // The in-game badge reports the same measured throughput as the detailed training statistics.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const rate = document.querySelector('#revision-rate')?.textContent?.match(/(\d+)× real time/);
          return (
            !!rate &&
            document.querySelector('#training-overlay')?.textContent === 'Training... in ' + rate[1] + 'x realtime'
          );
        }),
      )
      .toBe(true);
    // The first click ends the search and schedules the final round; the second aborts at once.
    await page.locator('#revision-stop').click();
    await expect(page.locator('#revision-stop')).toContainText('Abort now');
    await page.locator('#revision-stop').click();
    await expect(page.locator('#revision-learn')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#revision-stop')).toBeHidden();
    await expect(page.locator('#training-overlay')).toBeHidden();
    await expect(select).toHaveValue(parentId);
  }
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const { openRevisionStore } = (await import(
          new URL('revisions/store.js', location.href).href
        )) as typeof import('../../src/revisions/store.ts');
        const store = await openRevisionStore();
        try {
          return (await store.runs()).map((run) => run.parentId).sort();
        } finally {
          store.close();
        }
      }),
    )
    .toEqual([neutral, hugginator].sort());
});

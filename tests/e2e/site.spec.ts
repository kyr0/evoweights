/** The built site in Chromium: every section renders, every live path runs, and nothing logs an error or fails to load. */
import { expect, test, type Page } from '@playwright/test';

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
  // Weights explorer: the release comparison replaces the loading note.
  const explorer = page.locator('[data-weights-explorer]');
  await expect(explorer.locator('.wx-load')).toHaveCount(0, { timeout: 30_000 });
  await expect(explorer.locator('.wx-viewer').first()).toBeVisible();
  // Revisions panel: the model list and tree load from storage and the shipped data.
  await expect(page.locator('#revision-select')).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator('#revision-tree-meta')).not.toHaveText('Loading …');
  // Theme toggle.
  const dark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  await page.locator('[data-portal-theme-toggle]').first().click();
  expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(!dark);
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

test('the shipped model plays, pauses, resumes and returns to the menu', async ({ page }) => {
  await page.locator('[data-pick="shipped"]').click();
  await live(page);
  await expect(page.locator('#actual-backend')).toHaveText('WASM SIMD · 1 thread');
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

test('a training run reports progress and stops on request', async ({ page }) => {
  await expect(page.locator('#revision-learn')).toBeEnabled({ timeout: 30_000 });
  await page.locator('#revision-lanes').selectOption('2');
  await page.locator('#revision-learn').click();
  await expect(page.locator('#revision-stop')).toBeVisible();
  await expect(page.locator('#revision-lanes-active')).toContainText('2', { timeout: 60_000 });
  await expect(page.locator('#revision-decisions')).toHaveText(/^[1-9][\d,]*$/, { timeout: 90_000 });
  // The first click ends the search and schedules the final round; the second aborts at once.
  await page.locator('#revision-stop').click();
  await expect(page.locator('#revision-stop')).toContainText('Abort now');
  await page.locator('#revision-stop').click();
  await expect(page.locator('#revision-learn')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#revision-stop')).toBeHidden();
});

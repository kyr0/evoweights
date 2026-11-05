import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

/** Like site.spec.ts: every spec fails on page errors, console errors, failed requests and HTTP errors. */
function collectProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push('pageerror: ' + error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push('console: ' + message.text());
  });
  page.on('requestfailed', (request) => problems.push('requestfailed: ' + request.url()));
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push('http ' + response.status() + ': ' + response.url());
  });
  return problems;
}

test('built renderer keeps bites as a red flash and draws one recessed pair of arms', async ({ page }) => {
  const errors = collectProblems(page);
  await page.goto('./');
  const result = await page.evaluate(async () => {
    const { createArena } = (await import(
      new URL('engine/arena.js', location.href).href
    )) as typeof import('../../src/engine/arena.ts');
    const { HuggingDoomView } = (await import(
      new URL('app/huggingdoom.js', location.href).href
    )) as typeof import('../../src/app/huggingdoom.ts');
    const game = await createArena({ seed: 9000 });
    const view = new HuggingDoomView();
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 200;
    const ctx = canvas.getContext('2d')!;
    let state = game.state();
    function render() {
      const pixels = new Uint8ClampedArray(game.frame());
      ctx.putImageData(new ImageData(pixels, 320, 200), 0, 0);
      view.draw(ctx, state);
      const drawn = ctx.getImageData(0, 0, 320, 200).data;
      return {
        image: canvas.toDataURL(),
        overlayPixels: drawn.reduce((n, value, i) => n + Number(value !== pixels[i]), 0),
        sky: [...pixels.slice(0, 3)],
        yaw: state.pose.yawDeg,
        ending: state.picnic.ending,
        armPixels: [...ctx.getImageData(64, 170, 48, 24).data],
      };
    }
    const before = render();
    for (let i = 0; i < 20; i++) state = game.step(3);
    const honeyReady = render();
    for (let i = 0; i < 8; i++) state = game.step(3, false, true);
    const honeyWalking = render();
    state = game.step(2);
    const honeyThrowing = render();
    state = game.reset(9000);
    view.reset();
    while (!state.picnic.timesBitten && !state.done) state = game.step(3);
    const bite = render();
    for (let i = 0; i < 11; i++) state = game.step(3);
    const recovered = render();

    state = game.reset(9000);
    // Aim at successive bears so the full original ammo budget is spent alive.
    while (state.ammo > 0 && !state.done) {
      const threat = state.threat;
      const action = threat.visible ? (Math.abs(threat.x) > 0.1 ? (threat.x < 0 ? 0 : 1) : 2) : 1;
      state = game.step(action);
    }
    for (let i = 0; i < 25; i++) state = game.step(3);
    view.reset();
    const arms = render();
    for (let i = 0; i < 8; i++) state = game.step(3, false, true);
    const walking = render();
    state = game.reset(9000);
    view.reset();
    for (let i = 0; i < 1000 && !state.picnic.hugging && !state.done; i++) {
      const threat = state.threat;
      const action = threat.visible ? (Math.abs(threat.x) > 0.1 ? (threat.x < 0 ? 0 : 1) : 2) : 1;
      state = game.step(action, false, state.ammo === 0 && threat.visible && Math.abs(threat.x) < 0.4);
    }
    const hugging = state.picnic.hugging;
    const hug = render();
    for (let i = 0; i < 3; i++) state = game.step(3);
    const squeeze = render();
    for (let i = 0; i < 3; i++) state = game.step(3);
    const release = render();
    for (let i = 0; i < 6; i++) state = game.step(3);
    const rest = render();
    return {
      frames: {
        before,
        honeyReady,
        honeyWalking,
        honeyThrowing,
        bite,
        recovered,
        arms,
        walking,
        hug,
        squeeze,
        release,
        rest,
      },
      hugging,
      ammo: state.ammo,
    };
  });
  for (const [name, frame] of Object.entries(result.frames))
    await writeFile(`output/huggingdoom-${name}.png`, Buffer.from(frame.image.split(',')[1], 'base64'));
  const { before, bite, recovered, arms, walking } = result.frames;
  expect(bite.sky[0]).toBeGreaterThan(before.sky[0]);
  expect(bite.sky[1]).toBeLessThan(before.sky[1]);
  expect(bite.sky[2]).toBeLessThan(before.sky[2]);
  expect(recovered.sky).toEqual(before.sky);
  expect(bite.yaw).toBe(before.yaw);
  expect(recovered.yaw).toBe(before.yaw);
  for (const frame of [bite, recovered, arms, walking]) {
    expect(frame.ending).toBe(false);
    expect(frame.overlayPixels).toBe(0);
  }
  expect(result.ammo).toBe(0);
  expect(result.hugging).toBe(true);
  expect(result.frames.squeeze.armPixels).not.toEqual(result.frames.hug.armPixels);
  expect(result.frames.release.armPixels).not.toEqual(result.frames.squeeze.armPixels);
  expect(errors).toEqual([]);
});

test('human picnic needs no model, preserves the original ammo budget, and exposes keyboard and touch controls', async ({
  page,
}) => {
  const errors = collectProblems(page);
  const modelRequests: string[] = [];
  page.context().on('request', (request) => {
    if (request.url().endsWith('.pack')) modelRequests.push(request.url());
  });
  await page.goto('./');
  await expect(page).toHaveTitle(/HuggingDOOM.*EvoWeights/);
  await expect(page.locator('#arena-title')).toHaveText('HuggingDOOM');
  await expect(page.locator('.pick-card h3').filter({ hasText: 'EvoWeights Hugginator' })).toBeVisible();
  await expect(page.locator('.pick-card h3').filter({ hasText: 'EvoWeights Introvertor' })).toBeVisible();
  await page.locator('#pick-human').click();
  await expect(page.locator('#status')).toContainText('LIVE');
  await expect(page.locator('#actual-backend')).toContainText('no model download');
  await expect(page.locator('#ammo')).toHaveText('26');
  // The hearts are announced by their accessible name, not only carried as an attribute.
  await expect(page.getByRole('img', { name: '5 of 5 hearts' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Touch controls' })).toBeVisible();
  await page.keyboard.down('Space');
  await expect(page.locator('#ammo')).toHaveText('25');
  await page.keyboard.up('Space');
  // A real pointer press on the touch button throws honey; releasing it stops.
  const fire = await page.locator('[data-control="fire"]').boundingBox();
  await page.mouse.move(fire!.x + fire!.width / 2, fire!.y + fire!.height / 2);
  await page.mouse.down();
  await expect(page.locator('#ammo')).not.toHaveText('25');
  await page.mouse.up();
  await page.locator('#picnic-sound').click();
  await expect(page.getByRole('button', { name: 'Sound off' })).toBeVisible();
  await page.locator('#toggle').click();
  await expect(page.locator('#status')).toContainText('PAUSED');
  await page.screenshot({ path: 'output/huggingdoom-human-controls.png', fullPage: false });
  expect(modelRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('five cartoon bites end in an emergency-honey picnic and the next game resets every counter', async ({ page }) => {
  const errors = collectProblems(page);
  await page.goto('./');
  await page.locator('#pick-human').click();
  await expect(page.locator('#status')).toContainText('LIVE');
  await expect(page.locator('#times-bitten')).toHaveText('5', { timeout: 60_000 });
  await expect(page.locator('#status')).toContainText('FINISHED', { timeout: 10_000 });
  await expect(page.locator('#picnic-summary')).toContainText('5 times bitten.');
  await expect(page.locator('#picnic-mode')).toBeEmpty();
  await expect(page.getByRole('img', { name: '0 of 5 hearts' })).toBeVisible();
  await page.screenshot({ path: 'output/huggingdoom-emergency-honey.png', fullPage: false });
  await page.locator('#launch').click();
  await expect(page.locator('#status')).toContainText('LIVE');
  await expect(page.locator('#times-bitten')).toHaveText('0');
  await expect(page.locator('#bears-fed')).toHaveText('0');
  await expect(page.locator('#bears-befriended')).toHaveText('0');
  await expect(page.locator('#ammo')).toHaveText('26');
  expect(errors).toEqual([]);
});

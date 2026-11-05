import { expect, test } from '@playwright/test';

interface PlayedSound {
  node: AudioBufferSourceNode;
  offset: number;
  ended: boolean;
}
interface AudioProbe {
  sources: PlayedSound[];
  gains: GainNode[];
  analyser?: AnalyserNode;
}
declare global {
  interface Window {
    picnicAudioProbe: AudioProbe;
  }
}

test('real game audio loops, follows transport and mute, and uses the supplied random bite voices', async ({
  page,
}) => {
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('requestfailed', (request) => errors.push(request.url()));
  page.on('request', (request) => {
    if (/\.(mp3|wav)$/.test(request.url())) requests.push(request.url());
  });
  // Observe native nodes without replacing decoding, playback, timing or network responses.
  await page.addInitScript(() => {
    const probe: AudioProbe = { sources: [], gains: [] };
    window.picnicAudioProbe = probe;
    const createGain = AudioContext.prototype.createGain;
    AudioContext.prototype.createGain = function () {
      const node = createGain.call(this);
      probe.gains.push(node);
      return node;
    };
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when = 0, offset = 0, duration?: number) {
      const sound: PlayedSound = { node: this, offset, ended: false };
      start.call(this, when, offset, duration);
      probe.sources.push(sound);
      this.addEventListener('ended', () => (sound.ended = true), { once: true });
    };
  });
  await page.goto('./');
  expect(requests).toEqual([]);
  await page.locator('#pick-human').click();
  await expect(page.locator('#status')).toContainText('LIVE');
  const activeMusic = () =>
    page.evaluate(() => window.picnicAudioProbe.sources.filter((s) => s.node.loop && !s.ended).length);
  await expect.poll(activeMusic).toBe(1);
  await page.evaluate(() => {
    const probe = window.picnicAudioProbe;
    probe.analyser = probe.gains[0].context.createAnalyser();
    probe.gains[0].connect(probe.analyser);
  });
  const peak = () =>
    page.evaluate(() => {
      const analyser = window.picnicAudioProbe.analyser!;
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      return Math.max(...samples.map(Math.abs));
    });
  await expect.poll(peak).toBeGreaterThan(0.0001);
  await page.locator('#picnic-sound').click();
  await expect.poll(peak).toBeLessThan(0.0000001);
  await expect.poll(activeMusic).toBe(1);
  await page.locator('#picnic-sound').click();
  await expect.poll(peak).toBeGreaterThan(0.0001);
  expect(await page.evaluate(() => window.picnicAudioProbe.sources.filter((s) => s.node.loop).length)).toBe(1);

  await page.locator('#toggle').click();
  await expect(page.locator('#status')).toContainText('PAUSED');
  await expect.poll(activeMusic).toBe(0);
  await page.locator('#toggle').click();
  await expect(page.locator('#status')).toContainText('LIVE');
  await expect.poll(activeMusic).toBe(1);
  expect(
    await page.evaluate(() => window.picnicAudioProbe.sources.findLast((s) => s.node.loop)!.offset),
  ).toBeGreaterThan(0);
  await page.locator('#restart').click();
  await expect(page.locator('#status')).toContainText('STANDBY');
  await expect.poll(activeMusic).toBe(0);

  const episodeStart = await page.evaluate(() => window.picnicAudioProbe.sources.length);
  await page.locator('#pick-human').click();
  await expect.poll(activeMusic).toBe(1);
  expect(await page.evaluate(() => window.picnicAudioProbe.sources.findLast((s) => s.node.loop)!.offset)).toBe(0);
  await expect(page.locator('#status')).toContainText('FINISHED', { timeout: 30_000 });
  await expect(page.locator('#times-bitten')).toHaveText('5');
  await expect.poll(activeMusic).toBe(0);
  const bites = await page.evaluate(async (first) => {
    const { OUCH_SOUNDS } = await import(new URL('app/picnic-audio.js', location.href).href);
    const probe = window.picnicAudioProbe;
    const context = probe.gains[0].context as AudioContext;
    const expected = await Promise.all(
      (OUCH_SOUNDS as string[]).map(async (name) => {
        const response = await fetch(new URL(`assets/huggingdoom/gamemusic/${name}.mp3`, location.href));
        return context.decodeAudioData(await response.arrayBuffer());
      }),
    );
    const same = (a: AudioBuffer, b: AudioBuffer) =>
      a.length === b.length &&
      a.numberOfChannels === b.numberOfChannels &&
      Array.from({ length: a.numberOfChannels }, (_, channel) => channel).every((channel) => {
        const x = a.getChannelData(channel),
          y = b.getChannelData(channel);
        return x.every((sample, i) => sample === y[i]);
      });
    return probe.sources
      .slice(first)
      .filter((sound) => !sound.node.loop)
      .map((sound) => expected.findIndex((buffer) => same(buffer, sound.node.buffer!)))
      .filter((variant) => variant >= 0);
  }, episodeStart);
  expect(bites).toHaveLength(5);
  expect(requests.some((url) => /\/(chomp|dizzy)\.wav$/.test(url))).toBe(false);

  await page.locator('#restart').click();
  await page.locator('[data-pick="shipped"]').click();
  await expect(page.locator('#status')).toContainText('LIVE', { timeout: 60_000 });
  await expect.poll(activeMusic).toBe(1);
  expect(requests.filter((url) => url.endsWith('/gamemusic_huggingdoom.mp3'))).toHaveLength(1);
  await page.locator('#restart').click();
  await expect.poll(activeMusic).toBe(0);
  await page.screenshot({ path: 'output/huggingdoom-audio-verified.png' });
  expect(errors).toEqual([]);
});

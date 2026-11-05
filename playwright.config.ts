import { defineConfig, devices } from '@playwright/test';

/** The built docs/ is served by scripts/serve.ts (with the isolation headers) on a port of its own. */
const port = Number(process.env.E2E_PORT ?? 8091);

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'output/playwright',
  reporter: [['list'], ['html', { outputFolder: 'output/playwright-report', open: 'never' }]],
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: `http://localhost:${port}/`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'bun scripts/serve.ts',
    env: { PORT: String(port) },
    url: `http://localhost:${port}/`,
    reuseExistingServer: false,
    stdout: 'ignore',
  },
});

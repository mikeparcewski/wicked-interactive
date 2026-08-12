import { defineConfig, devices } from '@playwright/test';
const rawPort = process.env.E2E_PORT ?? '4334';
const PORT = Number.parseInt(rawPort, 10);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error(`E2E_PORT must be a port number (1-65535), got "${rawPort}"`);
}
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  /* Local dev boxes often run other heavy work; unbounded workers starve the
     30s test budget. CI keeps Playwright's own default for the runner size. */
  workers: process.env.CI ? undefined : 4,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // --host 127.0.0.1 pins IPv4: bare `astro preview` binds localhost, which
    // resolves to ::1-only on some hosts and never answers the 127.0.0.1 probe.
    command: `npm run preview -- --port ${PORT} --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});

// Responsive checks in Chromium at phone (360×640) and desktop (1280×800) sizes, against the mock dev server started below.
// Can run in the Playwright Docker image (its version must match @playwright/test). Screenshots go to test-results/screens/.
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.ASTER_UI_PORT ?? 4173);
// ASTER_UI_BASE_URL runs the checks against a live appliance instead (no dev server; select non-mock tests with -g).
const external = process.env.ASTER_UI_BASE_URL;
const baseURL = external ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './test',
  outputDir: './test-results',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    // Layout failures need a picture; passing runs keep only the screenshots the tests save.
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'phone', use: { ...devices['Pixel 5'], viewport: { width: 360, height: 640 } } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
  ],
  webServer: external
    ? undefined
    : {
        command: `npm run dev:mock -- --port ${PORT} --strictPort`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        stdout: 'ignore',
        stderr: 'pipe',
      },
});

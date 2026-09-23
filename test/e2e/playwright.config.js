// @ts-check
// Aster — Playwright against the running end-to-end stack: the two projects of packages/ui/playwright.config.js
// — the phone (360×640, touch) and the desktop (1280×800) — pointed at ASTER_UI_BASE_URL, with
// ui.spec.js as the only test and one worker, because the config round trip edits a real file and two workers would
// race for its hash. Run from the repository root: npx playwright test -c test/e2e/playwright.config.js
import { defineConfig } from '@playwright/test';
import base from '../../packages/ui/playwright.config.js';

export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: 'ui.spec.js',
  outputDir: './test-results',
  workers: 1,
  retries: 0,
  webServer: undefined,
  use: { ...base.use, baseURL: process.env.ASTER_UI_BASE_URL ?? 'http://127.0.0.1' },
});

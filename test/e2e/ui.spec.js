// @ts-check
// Aster — the browser against the whole running stack: the login and the overview as the real controller
// serves them, a configuration change applied to the real Asterisk and taken back, and every route held to no
// sideways scroll at its own width and at 320 px — in both projects of packages/ui/playwright.config.js, the phone by
// touch and the desktop with a mouse. The layout and the operation of each page are covered against the mock by
// packages/ui/test/responsive.spec.js; what this adds is the real API behind them.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// The login screen is in the default language (English); after login the UI follows test/e2e/aster.yaml (Russian).
const en = JSON.parse(readFileSync(new URL('../../packages/ui/src/i18n/en.json', import.meta.url), 'utf8'));
const ru = JSON.parse(readFileSync(new URL('../../packages/ui/src/i18n/ru.json', import.meta.url), 'utf8'));
const PASSWORD = process.env.ASTER_E2E_PASSWORD ?? 'a-long-enough-password';
/** Every path the app routes (router.js); the detail page is the modem test/e2e/aster.yaml has. */
const ROUTES = ['/', '/modems', '/modems/gsm_test', '/phones', '/messages', '/calls', '/config', '/settings', '/activity', '/logs'];
const NARROW = { width: 320, height: 640 };

test.describe.configure({ mode: 'serial' });

/** @param {import('@playwright/test').Page} page */
async function login(page) {
  await page.goto('/');
  await page.getByLabel(en['login.password']).fill(PASSWORD);
  await page.getByRole('button', { name: en['login.submit'] }).click();
  await expect(page.getByRole('heading', { name: ru['overview.modems'] })).toBeVisible({ timeout: 15_000 });
}

/** @param {import('@playwright/test').Page} page */
async function noSidewaysScroll(page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `the page scrolls sideways at ${clientWidth} px`).toBeLessThanOrEqual(clientWidth);
}

test('the login and the overview come from the real controller', async ({ page }, info) => {
  await login(page);
  // A modem card is named by the modem's id, with its driver under it (Overview.svelte).
  for (const { id, driver } of [{ id: 'gsm_test', driver: 'quectel' }, { id: 'gsm_dongle', driver: 'dongle' }]) {
    const card = page.getByRole('listitem').filter({ has: page.getByText(id, { exact: true }) });
    await expect(card.getByText(driver, { exact: true })).toBeVisible();
  }
  await page.screenshot({ path: `test-results/screens/${info.project.name}-overview.png`, fullPage: true });
});

test('every route lays out at its own width and at 320 px', async ({ page }, info) => {
  await login(page);
  for (const route of ROUTES) {
    await page.goto(route);
    await expect(page.locator('main#content')).toBeVisible();
    await noSidewaysScroll(page);
    await page.setViewportSize(NARROW);
    await expect(page.locator('main#content')).toBeVisible();
    await noSidewaysScroll(page);
    const size = info.project.use.viewport;
    if (size) await page.setViewportSize(size);
  }
});

test('the config editor applies a change to Asterisk and takes it back', async ({ page }, info) => {
  await login(page);
  await page.goto('/config');
  // The file list is a button per file, one of two views on a phone.
  await page.getByRole('button', { name: /^extensions\.conf/ }).filter({ visible: true }).first().click();
  const editor = page.getByLabel(ru['config.content'].replace('{name}', 'extensions.conf'));
  await expect(editor).toHaveValue(/\[smoke\]/);
  const before = await editor.inputValue();
  const marker = `; e2e ${info.project.name} ${Date.now()}`;

  await editor.fill(`${before.replace(/\n*$/, '\n')}${marker}\n`);
  await page.getByRole('button', { name: ru['config.apply'], exact: true }).click();
  await expect(page.getByText(ru['config.applied'].replace('{name}', 'extensions.conf'))).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `test-results/screens/${info.project.name}-config-applied.png`, fullPage: true });

  await page.getByRole('button', { name: ru['config.restore'] }).click();
  await expect(page.getByText(ru['config.restored'].replace('{name}', 'extensions.conf'))).toBeVisible({ timeout: 30_000 });
  await expect(editor).not.toHaveValue(new RegExp(marker.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await expect(editor).toHaveValue(/\[smoke\]/);
});

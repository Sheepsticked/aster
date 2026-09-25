// Layout, keyboard and behaviour checks against the mock: no route scrolls sideways (down to 320 px, WCAG 1.4.10) and the
// nav stays reachable; every route is screenshotted to test-results/screens/.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

/** The catalogs, so the test looks for what a user actually sees without hard-coding a translation twice. */
const ru = JSON.parse(readFileSync(new URL('../src/i18n/ru.json', import.meta.url), 'utf8'));
const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));

/** Every path the app routes (router.js); `/modems/gsm1` is the detail page of the modem the mock always has. */
const ROUTES = ['/', '/modems', '/modems/gsm1', '/phones', '/messages', '/calls', '/config', '/settings', '/activity', '/logs'];
/** Long enough for the mock to accept it (src/mock/index.js). */
const PASSWORD = 'a-long-enough-password';
const NARROW = { width: 320, height: 640 };
/** Where the sidebar has just appeared (`md`), and a small laptop. */
const BETWEEN = [768, 900, 1024];

/**
 * Waits until the animations of an element and its descendants (the drawer's slide-in) have finished.
 * @param {import('@playwright/test').Locator} locator
 */
async function settled(locator) {
  await locator.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished)));
}

/** @param {import('@playwright/test').Page} page */
async function noSidewaysScroll(page) {
  // The document may be no wider than the viewport; inner boxes (log view, config editor) may scroll.
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `the page scrolls sideways at ${clientWidth} px`).toBeLessThanOrEqual(clientWidth);
}

/**
 * Status badges must stay on one line; a text node with line boxes at more than one height has wrapped.
 * @param {import('@playwright/test').Page} page
 */
async function badgesOnOneLine(page) {
  const wrapped = await page.evaluate(() =>
    [...document.querySelectorAll('span.rounded-full.ring-inset')]
      .filter((badge) => badge.getClientRects().length > 0)
      .filter((badge) =>
        [...badge.childNodes].some((node) => {
          if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) return false;
          const range = document.createRange();
          range.selectNodeContents(node);
          return new Set([...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top))).size > 1;
        }))
      .map((badge) => badge.textContent?.trim()));
  expect(wrapped, 'a status badge wraps onto a second line').toEqual([]);
  // One-line badges make a column wider; the table must still fit its card rather than run out of it.
  const spilled = await page.evaluate(() =>
    [...document.querySelectorAll('table')]
      .filter((table) => table.getClientRects().length > 0 && table.parentElement)
      .filter((table) => {
        // The card's content edge, not its border: a table that runs into the padding already looks cut off.
        const card = /** @type {HTMLElement} */ (table.parentElement);
        const edge = card.getBoundingClientRect().right - parseFloat(getComputedStyle(card).paddingRight);
        return table.getBoundingClientRect().right > edge + 0.5;
      })
      .map((table) => table.querySelector('caption')?.textContent?.trim() ?? 'a table'));
  expect(spilled, 'a table is wider than its card').toEqual([]);
}

/**
 * Opens a collapsible section (lib/Section.svelte) the way a user does, if it is folded.
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 */
async function openSection(page, id) {
  const section = page.locator(`#${id}`);
  await expect(section).toBeVisible();
  if (await section.evaluate((element) => /** @type {HTMLDetailsElement} */ (element).open)) return section;
  await section.locator('summary').click();
  await expect(section).toHaveJSProperty('open', true);
  return section;
}

/** @param {import('@playwright/test').Page} page */
async function login(page) {
  // Login is in the default language; the mock appliance is set to Russian for its longer labels.
  await page.goto('/');
  await page.getByLabel(en['login.password']).fill(PASSWORD);
  await page.getByRole('button', { name: en['login.submit'] }).click();
  await expect(page.getByRole('heading', { name: ru['overview.modems'] })).toBeVisible();
}

test.describe('the login screen', () => {
  test('refuses a password the controller would refuse, and says so', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel(en['login.password']).fill('short');
    await page.getByRole('button', { name: en['login.submit'] }).click();
    await expect(page.getByRole('alert')).toHaveText(en['login.wrong']);
    await noSidewaysScroll(page);
    await page.setViewportSize(NARROW);
    await noSidewaysScroll(page);
  });

  test('says how long to wait once five wrong passwords hold the login, even for the right one', async ({ page }) => {
    await page.goto('/');
    const field = page.getByLabel(en['login.password']);
    const submit = page.getByRole('button', { name: en['login.submit'] });
    for (let i = 0; i < 5; i += 1) {
      await field.fill('short');
      await submit.click();
      await expect(page.getByRole('alert')).toHaveText(en['login.wrong']);
      await expect(field).toHaveValue('');
    }
    await field.fill(PASSWORD);
    await submit.click();
    await expect(page.getByRole('alert')).toHaveText(en['login.too_many'].replace('{minutes}', '10'));
  });

  test('can be completed with the keyboard alone', async ({ page }, info) => {
    await page.goto('/');
    await page.screenshot({ path: `test-results/screens/${info.project.name}-login.png`, fullPage: true });
    // The password field takes focus when the screen opens: typing and Enter are all a keyboard user needs.
    await expect(page.getByLabel(en['login.password'])).toBeFocused();
    await page.keyboard.type(PASSWORD);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: ru['overview.modems'] })).toBeVisible();
  });

  test('offers the language switch before there is a session', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel(en['lang.label']).selectOption('ru');
    // Everything on the screen changes, the switch's own label included — which is why it is looked up again by its new name.
    await expect(page.getByRole('button', { name: ru['login.submit'] })).toBeVisible();
    await page.getByLabel(ru['lang.label']).selectOption('en');
    await expect(page.getByRole('button', { name: en['login.submit'] })).toBeVisible();
  });
});

test.describe('every route', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  for (const route of ROUTES) {
    test(`${route} lays out at every width, badges on one line`, async ({ page }, info) => {
      await page.goto(route);
      await expect(page.locator('main#content')).toBeVisible();
      // The lists have loaded, so their rows and badges are what gets measured.
      await expect(page.getByText(ru['app.loading'])).toHaveCount(0);
      await noSidewaysScroll(page);
      await badgesOnOneLine(page);

      // In-between widths (tablet, small laptop): no table may overflow its card.
      for (const width of BETWEEN) {
        await page.setViewportSize({ width, height: 800 });
        await noSidewaysScroll(page);
        await badgesOnOneLine(page);
      }

      await page.setViewportSize(NARROW);
      await expect(page.locator('main#content')).toBeVisible();
      await noSidewaysScroll(page);
      await badgesOnOneLine(page);

      const size = info.project.use.viewport;
      if (size) await page.setViewportSize(size);
      await page.screenshot({
        path: `test-results/screens/${info.project.name}${route === '/' ? '-overview' : route.replaceAll('/', '-')}.png`,
        fullPage: true,
      });
    });
  }
});

/**
 * How light an element's background is, 0 (black) to 1 (white): the colour is painted on a canvas, so any CSS colour syntax works.
 * @param {import('@playwright/test').Locator} element
 */
const lightness = (element) => element.evaluate((node) => {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  context.fillStyle = getComputedStyle(node).backgroundColor;
  context.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
});

test.describe('the theme', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await login(page);
  });

  test('follows the system\'s dark setting; Light and Dark pin one, kept after a reload', async ({ page }, info) => {
    const body = page.locator('body');
    expect(await lightness(body)).toBeLessThan(0.2);
    await page.screenshot({ path: `test-results/screens/${info.project.name}-overview-dark.png`, fullPage: true });

    const menu = page.getByRole('button', { name: ru['nav.open_menu'] });
    const choose = async (/** @type {string} */ value) => {
      if (info.project.use.isMobile) await menu.tap();
      await page.getByLabel(ru['theme.label']).filter({ visible: true }).selectOption(value);
      if (info.project.use.isMobile) await page.keyboard.press('Escape');
    };
    await choose('light');
    await expect.poll(() => lightness(body)).toBeGreaterThan(0.8);
    await page.reload();
    await expect(page.getByRole('heading', { name: ru['overview.modems'] })).toBeVisible();
    await expect.poll(() => lightness(body)).toBeGreaterThan(0.8);
    await choose('system');
    await expect.poll(() => lightness(body)).toBeLessThan(0.2);
  });

  test('keeps the phone\'s top bar dark in the dark theme too', async ({ page }, info) => {
    test.skip(!info.project.use.isMobile, 'the top bar is the phone layout');
    const bar = page.locator('header').first();
    expect(await lightness(bar)).toBeLessThan(0.2);
    // Its text stays light, so the bar reads the same in both themes.
    const title = await bar.locator('h1').evaluate((node) => getComputedStyle(node).color);
    expect(title).toMatch(/255|oklch\(1 |#fff/);
  });
});

test.describe('the navigation', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('leads to a section and marks where one is', async ({ page }, info) => {
    const drawer = page.getByRole('button', { name: ru['nav.open_menu'] });
    const phone = Boolean(info.project.use.isMobile);

    if (phone) {
      // Below `md` the nav is behind the menu button, and a phone user opens it by touch.
      await expect(drawer).toBeVisible();
      await drawer.tap();
      await expect(page.getByRole('dialog')).toBeVisible();
      await settled(page.getByRole('dialog'));
      await page.screenshot({ path: 'test-results/screens/phone-drawer.png' });
      await page.getByRole('dialog').getByRole('link', { name: ru['nav.messages'] }).tap();
    } else {
      await expect(drawer).toBeHidden();
      await page.getByRole('link', { name: ru['nav.messages'] }).click();
    }

    await expect(page).toHaveURL(/\/messages$/);
    // The drawer is gone once it has navigated — it would otherwise cover the page it opened.
    await expect(page.getByRole('dialog')).toBeHidden();
    const current = page.locator('a[aria-current="page"]');
    await expect(current.first()).toHaveAttribute('href', '/messages');
  });

  test('closes when the page behind it changes', async ({ page }, info) => {
    if (!info.project.use.isMobile) {
      test.skip(true, 'the drawer only exists below md');
      return;
    }
    const drawer = page.getByRole('button', { name: ru['nav.open_menu'] });
    const dialog = page.getByRole('dialog');
    await drawer.tap();
    await dialog.getByRole('link', { name: ru['nav.messages'] }).tap();
    await expect(page).toHaveURL(/\/messages$/);
    // Navigating back must close an open drawer too.
    await drawer.tap();
    await expect(dialog).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(dialog).toBeHidden();
  });

  test('slides in and out, unless the device asks for less motion', async ({ page }, info) => {
    if (!info.project.use.isMobile) {
      test.skip(true, 'the drawer only exists below md');
      return;
    }
    const drawer = page.getByRole('button', { name: ru['nav.open_menu'] });
    const dialog = page.getByRole('dialog');
    // The animation of the drawer's panel and of its backdrop.
    const animations = () => dialog.evaluate((el) =>
      [getComputedStyle(/** @type {Element} */ (el.firstElementChild)).animationName, getComputedStyle(el, '::backdrop').animationName]);
    // A close as it happens: the two animations once `data-closing` is set, and how long until the dialog really closes.
    const recordClose = () => dialog.evaluate((el) => {
      const log = /** @type {any} */ (window).closeLog = /** @type {any[]} */ ([]);
      let since = 0;
      new MutationObserver((_changes, observer) => {
        if (el.hasAttribute('data-closing') && log.length === 0) {
          since = performance.now();
          log.push([getComputedStyle(/** @type {Element} */ (el.firstElementChild)).animationName, getComputedStyle(el, '::backdrop').animationName]);
        }
        if (!el.hasAttribute('open')) {
          log.push(performance.now() - since);
          observer.disconnect();
        }
      }).observe(el, { attributes: true, attributeFilter: ['open', 'data-closing'] });
    });
    const closeLog = () => page.evaluate(() => /** @type {any} */ (window).closeLog);

    await drawer.tap();
    await expect(dialog).toBeVisible();
    expect(await animations()).toEqual(['drawer-in', 'fade-in']);
    await settled(dialog);
    expect((await dialog.locator(':scope > div').boundingBox())?.x, 'the panel ends at the left edge').toBe(0);
    // Esc, and a link that navigates (the shell closes the drawer then), both slide it out before it closes.
    await recordClose();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    const [escNames, escMs] = await closeLog();
    expect(escNames).toEqual(['drawer-out', 'fade-out']);
    expect(escMs, 'the dialog stays open while it slides out').toBeGreaterThanOrEqual(100);
    await drawer.tap();
    await settled(dialog);
    await recordClose();
    await dialog.getByRole('link', { name: ru['nav.messages'] }).tap();
    await expect(page).toHaveURL(/\/messages$/);
    await expect(dialog).toBeHidden();
    expect((await closeLog())[0]).toEqual(['drawer-out', 'fade-out']);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await drawer.tap();
    await expect(dialog).toBeVisible();
    expect(await animations()).toEqual(['none', 'none']);
    await recordClose();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect((await closeLog())[0]).toEqual(['none', 'none']);
  });

  test('opens and closes with the keyboard', async ({ page }, info) => {
    if (!info.project.use.isMobile) {
      test.skip(true, 'the drawer only exists below md');
      return;
    }
    const drawer = page.getByRole('button', { name: ru['nav.open_menu'] });
    await drawer.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // Esc is the browser's own for a modal <dialog>; the app must not have broken it.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});

test.describe('the overview', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('shows the modems, their state and the devices no modem owns', async ({ page }) => {
    // A modem card is named by the modem's id, with its driver under it.
    const gsm1 = page.getByRole('listitem').filter({ has: page.getByText('gsm1', { exact: true }) });
    await expect(gsm1.getByText('quectel', { exact: true })).toBeVisible();
    await expect(page.getByText(ru['state.ready'], { exact: true })).toBeVisible();
    await expect(page.getByText(ru['state.flapping'], { exact: true })).toBeVisible();
    // Table row and card are both in the DOM; use the visible one.
    await expect(page.getByText('1-3', { exact: true }).filter({ visible: true })).toBeVisible();
    await expect(page.getByRole('link', { name: ru['overview.assign'] }).filter({ visible: true }))
      .toHaveAttribute('href', '/modems?assign=1-3');
  });

  test('starts a scan and shows what the event stream reports', async ({ page }) => {
    await page.getByRole('button', { name: ru['overview.scan'] }).click();
    await expect(page.getByText(ru['overview.scan_started'])).toBeVisible();
    // The mock ends the operation a moment later; the toast for it is the event stream's, not the request's.
    await expect(page.getByText(ru['toast.op_done'].replace('{op}', ru['op.scan']))).toBeVisible({ timeout: 10_000 });
  });

  test('has a health strip that opens', async ({ page }) => {
    await page.getByRole('button', { name: new RegExp(ru['health.degraded']) }).click();
    // The strip names the first reason beside the chip from `md` up; the list inside it holds them all.
    await expect(page.locator('#health-details').getByText('AMI is not configured', { exact: false })).toBeVisible();
    // And behind the chip, the two things the strip is for: what each modem is doing, and what is still in flight.
    await expect(page.locator('#health-details').getByRole('link', { name: /gsm1/ })).toBeVisible();
    await expect(page.locator('#health-details').getByText(ru['health.sms_waiting'].replace('{n}', '1'))).toBeVisible();
  });
});

test.describe('the modems page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('assigns the device the Overview offers, by touch on a phone', async ({ page }, info) => {
    const assign = page.getByRole('link', { name: ru['overview.assign'] }).filter({ visible: true });
    if (info.project.use.isMobile) await assign.tap();
    else await assign.click();

    await expect(page).toHaveURL(/\/modems$/);
    const dialog = page.getByRole('dialog');
    // The device's own IMEI, driver and port are filled in from the scan; only the id is the admin's to choose.
    await expect(dialog.getByLabel(ru['device.imei'])).toHaveValue('867435040099999');
    await expect(dialog.getByLabel(ru['modem.port'], { exact: true })).toHaveValue('1-3');
    const id = dialog.getByLabel(ru['modems.id'], { exact: true });
    await expect(id).toHaveValue('gsm3');
    await page.screenshot({ path: `test-results/screens/${info.project.name}-assign.png` });

    const submit = dialog.getByRole('button', { name: ru['modems.assign'] });
    if (info.project.use.isMobile) await submit.tap();
    else await submit.click();

    // A new modem lands on its own page, where the rest of it is configured.
    await expect(page).toHaveURL(/\/modems\/gsm3$/);
    await expect(page.getByRole('heading', { name: /gsm3/ })).toBeVisible();
    // Back inside the app (a reload would start the mock over), the new modem is in the list.
    await page.getByRole('link', { name: `← ${ru['nav.modems']}` }).click();
    await expect(page.getByRole('link', { name: 'gsm3', exact: true }).filter({ visible: true })).toBeVisible();
  });

  test('lists the devices the last scan found and assigns one from its row', async ({ page }) => {
    await page.goto('/modems');
    const devices = page.locator('section[aria-labelledby="devices-heading"]');
    await expect(devices.getByRole('heading', { name: ru['overview.unassigned'] })).toBeVisible();
    await expect(devices.getByText('1-3', { exact: true }).filter({ visible: true })).toBeVisible();
    await expect(devices.getByText('867435040099999', { exact: true }).filter({ visible: true })).toBeVisible();

    await devices.getByRole('button', { name: ru['overview.assign'], exact: true }).filter({ visible: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel(ru['device.imei'])).toHaveValue('867435040099999');
    await expect(dialog.getByLabel(ru['modem.port'], { exact: true })).toHaveValue('1-3');
  });

  test('refuses an id that is already taken, in the controller’s own words', async ({ page }) => {
    await page.goto('/modems');
    await page.getByRole('button', { name: ru['modems.assign'] }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(ru['modems.id'], { exact: true }).fill('gsm1');
    await dialog.getByLabel(ru['device.imei']).fill('867435040099999');
    await dialog.getByRole('button', { name: ru['modems.assign'] }).click();
    await expect(dialog.getByRole('alert')).toContainText('gsm1 already has that id');
  });
});

test.describe('the modem page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('says why a failing modem does not connect with the driver\'s last error, and shows none for a working one', async ({ page }, info) => {
    await page.goto('/modems/gsm2');
    const box = page.locator('#modem-driver-error');
    await expect(box.getByText(ru['modem.driver_error'], { exact: false })).toBeVisible();
    await expect(box.getByText('Getting IMSI number failed')).toBeVisible();
    await expect(box.getByText(ru['modem.driver_error_count'].replace('{n}', '240'))).toBeVisible();
    await page.screenshot({ path: `test-results/screens/${info.project.name}-modem-driver-error.png` });
    await page.goto('/modems/gsm1');
    await expect(page.getByText(ru['modem.signal'])).toBeVisible();
    await expect(page.locator('#modem-driver-error')).toHaveCount(0);
  });

  test('shows forwarding only when the modem confirmed it', async ({ page }, info) => {
    // gsm2 has no SIM, so its query is never answered and no number may be shown.
    await page.goto('/modems/gsm2');
    const unverified = await openSection(page, 'modem-forwarding');
    await unverified.getByRole('button', { name: ru['forwarding.query'] }).click();
    // Check reads all four conditions, and none of them can be confirmed.
    await expect(unverified.getByText(ru['forwarding.unverified'])).toHaveCount(4, { timeout: 15_000 });
    await expect(unverified.getByText(ru['forwarding.checked'].replace('{when}', ''), { exact: false }).first()).toBeVisible();
    await page.screenshot({ path: `test-results/screens/${info.project.name}-forwarding-unverified.png`, fullPage: true });

    // gsm1 answers, so the number it is forwarded to is shown with the time it was read from the modem.
    await page.goto('/modems/gsm1');
    const verified = await openSection(page, 'modem-forwarding');
    await verified.getByLabel(ru['forwarding.number']).fill('+375291112233');
    await verified.getByRole('button', { name: ru['forwarding.set'] }).click();
    await expect(page.getByText(ru['forwarding.on'].replace('{number}', '+375291112233'))).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(ru['forwarding.unverified'])).toBeHidden();
    // Always overrides the other conditions, and the page says so.
    await expect(verified.getByText(ru['forwarding.always_wins'])).toBeVisible();
  });

  test('forwards on no answer after the chosen wait, and only that condition changes', async ({ page }, info) => {
    await page.goto('/modems/gsm1');
    const box = await openSection(page, 'modem-forwarding');
    await expect(box.getByLabel(ru['forwarding.time'])).toHaveCount(0);
    await box.getByLabel(ru['forwarding.condition']).selectOption('no_reply');
    await box.getByLabel(ru['forwarding.time']).selectOption('25');
    await box.getByLabel(ru['forwarding.number']).fill('+375291112233');
    await box.getByRole('button', { name: ru['forwarding.set'] }).click();
    const forwarded = ru['forwarding.on_after'].replace('{number}', '+375291112233').replace('{time}', '25');
    await expect(box.getByText(forwarded)).toBeVisible({ timeout: 15_000 });
    await expect(box.getByText(ru['forwarding.off'], { exact: true })).toHaveCount(2);
    await expect(box.getByText(ru['forwarding.not_checked'])).toHaveCount(1);
    await expect(box.getByText(ru['forwarding.other_services'].replace('{number}', '+375290000099'))).toBeVisible();
    await expect(box.getByText(ru['forwarding.always_wins'])).toHaveCount(0);
    await page.screenshot({ path: `test-results/screens/${info.project.name}-forwarding-no-answer.png`, fullPage: true });
  });

  test('runs an AT command and shows what the modem answered', async ({ page }) => {
    await page.goto('/modems/gsm1');
    const at = await openSection(page, 'modem-at');
    await at.getByLabel(ru['at.command']).fill('AT+CSQ');
    // The USSD box has a Send of its own: the button that is meant is the one inside this section.
    await at.getByRole('button', { name: ru['at.send'] }).click();
    await expect(at.getByText('+CSQ: 21,99')).toBeVisible({ timeout: 15_000 });
  });

  test('walks a USSD menu: a menu says the operator waits and offers Cancel; the final answer and Cancel end it', async ({ page }, info) => {
    await page.goto('/modems/gsm1');
    const box = await openSection(page, 'modem-ussd');
    const code = box.getByLabel(ru['ussd.code']);
    const send = box.getByRole('button', { name: ru['ussd.send'] });
    await code.fill('*111#');
    await send.click();
    await expect(box.getByText(ru['ussd.waiting'])).toBeVisible({ timeout: 15_000 });
    await expect(code).toHaveValue('');
    await page.screenshot({ path: `test-results/screens/${info.project.name}-ussd-menu.png`, fullPage: true });
    await code.fill('1');
    await send.click();
    await expect(box.getByText('Ваш баланс 12.34 EUR', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(box.getByText(ru['ussd.waiting'])).toHaveCount(0);
    await expect(box.getByRole('button', { name: ru['ussd.cancel'] })).toHaveCount(0);

    await code.fill('*111#');
    await send.click();
    await box.getByRole('button', { name: ru['ussd.cancel'] }).click();
    await expect(box.getByText(ru['ussd.cancelled'])).toBeVisible({ timeout: 15_000 });
    await expect(box.getByText(ru['ussd.waiting'])).toHaveCount(0);
    // A code after Cancel is a new request again, not an answer to the menu.
    await code.fill('2');
    await send.click();
    await expect(box.getByText('Ваш баланс 12.34 EUR. Запрос 2', { exact: true })).toBeVisible({ timeout: 15_000 });
  });

  test('restarts, disables and enables the modem from the buttons at the top', async ({ page }) => {
    await page.goto('/modems/gsm1');
    const quick = page.getByRole('group', { name: ru['modem.quick_actions'] });
    await quick.getByRole('button', { name: ru['modem.action_restart'] }).click();
    await expect(page.getByText(ru['modem.action_started'].replace('{action}', ru['modem.action_restart']), { exact: true })).toBeVisible({ timeout: 15_000 });

    await quick.getByRole('button', { name: ru['modem.action_disable'] }).click();
    await expect(page.getByText(ru['modem.disabled_done'], { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(quick.getByRole('button', { name: ru['modem.action_enable'] })).toBeVisible();
    // Enable is what a disabled modem's page is for, so it is the blue button (app.css "Buttons").
    await expect(quick.getByRole('button', { name: ru['modem.action_enable'] })).toHaveClass(/(^|\s)btn-primary(\s|$)/);
    // A disabled modem has no quick Start: its radio stays off either way, and Start and Enable would both read «Включить».
    await expect(quick.getByRole('button')).toHaveCount(2);
    // Only `enabled` was saved: the settings form agrees with the stored entry, so the Save bar has nothing left to save.
    const settings = await openSection(page, 'modem-settings');
    await expect(settings.getByLabel(ru['modems.enabled'], { exact: true })).not.toBeChecked();
    await expect(page.getByRole('button', { name: ru['common.saved'] })).toBeDisabled();

    await quick.getByRole('button', { name: ru['modem.action_enable'] }).click();
    await expect(page.getByText(ru['modem.enabled_done'], { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(quick.getByRole('button', { name: ru['modem.action_disable'] })).toBeVisible();
    await expect(quick.getByRole('button')).toHaveCount(3);
    await expect(settings.getByLabel(ru['modems.enabled'], { exact: true })).toBeChecked();
  });

  test('saves only what changed, and says so until it is saved', async ({ page }) => {
    await page.goto('/modems/gsm1');
    const settings = await openSection(page, 'modem-settings');
    // Nothing has been changed yet, so there is nothing to apply.
    await expect(page.getByRole('button', { name: ru['common.saved'] })).toBeDisabled();
    await settings.getByLabel(ru['modem.ring_timeout'], { exact: true }).fill('90');
    await page.getByRole('button', { name: ru['common.save'], exact: true }).click();
    await expect(page.getByText(ru['modem.saved'])).toBeVisible({ timeout: 15_000 });
    // The page read the stored entry again and the form matches it: there is nothing left to save.
    await expect(page.getByRole('button', { name: ru['common.saved'] })).toBeDisabled();
    await expect(settings.getByLabel(ru['modem.ring_timeout'], { exact: true })).toHaveValue('90');
  });

  test('drops the edits of one modem when the health strip opens another', async ({ page }) => {
    await page.goto('/modems/gsm1');
    const settings = await openSection(page, 'modem-settings');
    await settings.getByLabel(ru['modem.own_recipients'], { exact: true }).check();
    await settings.locator('#modem-recipients').fill('555000111');
    await expect(page.getByRole('button', { name: ru['common.save'], exact: true })).toBeEnabled();

    // Same route, another id: the page must be gsm2's, not gsm1's form saved onto gsm2.
    await page.getByRole('button', { name: new RegExp(ru['health.degraded']) }).click();
    await page.locator('#health-details').getByRole('link', { name: /gsm2/ }).click();
    await expect(page).toHaveURL(/\/modems\/gsm2$/);
    const other = await openSection(page, 'modem-settings');
    await expect(other.getByLabel(ru['device.imei'], { exact: true })).toHaveValue('356938031234560');
    await expect(other.getByLabel(ru['modem.own_recipients'], { exact: true })).not.toBeChecked();
    await expect(page.getByRole('button', { name: ru['common.saved'] })).toBeDisabled();
  });
});

test.describe('the buttons', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('are coloured by how much they matter, not by the kind of action', async ({ page }) => {
    // A whole class name: `btn-danger` must not match `btn-danger-solid`.
    const is = (/** @type {string} */ style) => new RegExp(`(^|\\s)${style}(\\s|$)`);

    await page.goto('/modems/gsm1');
    // The modem's own actions are plain buttons, apart from what takes it off the air.
    const quick = page.getByRole('group', { name: ru['modem.quick_actions'] });
    await expect(quick.getByRole('button', { name: ru['modem.action_start'], exact: true })).toHaveClass(is('btn-plain'));
    await expect(quick.getByRole('button', { name: ru['modem.action_restart'], exact: true })).toHaveClass(is('btn-plain'));
    await expect(quick.getByRole('button', { name: ru['modem.action_disable'], exact: true })).toHaveClass(is('btn-danger'));
    const actions = await openSection(page, 'modem-actions');
    for (const action of ['start', 'restart', 'reset', 'remap']) {
      await expect(actions.getByRole('button', { name: ru[`modem.action_${action}`], exact: true })).toHaveClass(is('btn-plain'));
    }
    await expect(actions.getByRole('button', { name: ru['modem.action_stop'], exact: true })).toHaveClass(is('btn-danger'));
    // Setting the number is the forwarding box's main action; deleting it is the one that loses something.
    const forwarding = await openSection(page, 'modem-forwarding');
    await expect(forwarding.getByRole('button', { name: ru['forwarding.set'], exact: true })).toHaveClass(is('btn-primary'));
    for (const key of ['forwarding.enable', 'forwarding.disable', 'forwarding.query']) {
      await expect(forwarding.getByRole('button', { name: ru[key], exact: true })).toHaveClass(is('btn-plain'));
    }
    await expect(forwarding.getByRole('button', { name: ru['forwarding.erase'], exact: true })).toHaveClass(is('btn-danger'));
    // The only solid red is the button that commits a delete, inside its dialog.
    await page.getByRole('button', { name: ru['modem.delete'], exact: true }).filter({ visible: true }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: ru['modem.delete'], exact: true })).toHaveClass(is('btn-danger-solid'));
    await dialog.getByRole('button', { name: ru['common.cancel'], exact: true }).click();
    await expect(dialog).toBeHidden();

    await page.goto('/phones');
    await expect(page.getByRole('button', { name: ru['common.delete'], exact: true }).filter({ visible: true }).first()).toHaveClass(is('btn-danger'));

    // Sending an uncertain SMS again is an ordinary action on its row; the dialog it opens says what the risk is.
    await page.goto('/messages');
    await expect(page.getByRole('button', { name: ru['messages.retry'], exact: true }).filter({ visible: true }).first()).toHaveClass(is('btn-plain'));

    // Scan is the same button on the overview and on the modems page, and Assign the same action in both lists.
    for (const route of ['/', '/modems']) {
      await page.goto(route);
      await expect(page.getByRole('button', { name: ru['overview.scan'], exact: true }).filter({ visible: true }).first()).toHaveClass(is('btn-plain'));
      await expect(page.getByRole(route === '/' ? 'link' : 'button', { name: ru['overview.assign'], exact: true }).filter({ visible: true }).first())
        .toHaveClass(is('btn-primary'));
    }
  });
});

test.describe('the phones page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/phones');
  });

  test('shows what is connected to each phone and its call', async ({ page }, info) => {
    // The mock's 101 is a desk phone in a call and 102 is not registered (src/mock/fixtures.js).
    await expect(page.getByText('Yealink SIP-T31P 124.86.0.40').filter({ visible: true })).toBeVisible();
    await expect(page.getByText('192.0.2.21:5060').filter({ visible: true })).toBeVisible();
    await expect(page.getByText(ru['phones.call_talking'].replace('{who}', '+375290000001')).filter({ visible: true })).toBeVisible();
    await expect(page.getByText(ru['phones.not_connected'], { exact: true }).filter({ visible: true })).toHaveCount(1);
    await page.screenshot({ path: `test-results/screens/${info.project.name}-phones-connected.png`, fullPage: true });
  });

  test('edits one, without letting the number be changed', async ({ page }) => {
    await page.getByRole('button', { name: ru['common.edit'] }).filter({ visible: true }).first().click();
    const dialog = page.getByRole('dialog');
    // The number is the SIP account name: an edit cannot change it (the API refuses it too).
    await expect(dialog.getByLabel(ru['phones.number'], { exact: true })).toHaveAttribute('readonly', '');
    await dialog.getByLabel(ru['phones.label']).fill('Приёмная 2');
    await dialog.getByRole('button', { name: ru['common.save'], exact: true }).click();
    await expect(page.getByText(ru['phones.saved'].replace('{number}', '101'))).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Приёмная 2').filter({ visible: true })).toBeVisible();
  });

  test('adds a phone through the dialog', async ({ page }, info) => {
    const add = page.getByRole('button', { name: ru['phones.add'] });
    if (info.project.use.isMobile) await add.tap();
    else await add.click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(ru['phones.number'], { exact: true }).fill('103');
    await dialog.getByLabel(ru['phones.secret']).fill('sip-103-secret');
    await dialog.getByLabel(ru['phones.label']).fill('Бухгалтерия');
    await page.screenshot({ path: `test-results/screens/${info.project.name}-phone-form.png` });
    await dialog.getByRole('button', { name: ru['common.save'], exact: true }).click();
    await expect(page.getByText(ru['phones.added'].replace('{number}', '103'))).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Бухгалтерия').filter({ visible: true })).toBeVisible();
  });

  test('sets which modems ring a phone from its own dialog', async ({ page }) => {
    // 102 is the second row at both widths and rings only for gsm2 in the fixtures; ticking gsm1 puts it into gsm1's ring list.
    await page.getByRole('button', { name: ru['common.edit'] }).filter({ visible: true }).nth(1).click();
    const dialog = page.getByRole('dialog');
    const gsm1 = dialog.getByRole('checkbox', { name: 'gsm1', exact: true });
    const gsm2 = dialog.getByRole('checkbox', { name: 'gsm2', exact: true });
    await expect(gsm1).not.toBeChecked();
    await expect(gsm2).toBeChecked();
    // Both fixture modems route calls to a context of their own, and the dialog says the list is not dialed for them then.
    await expect(dialog.getByText(ru['phones.rings_for_own_context'].replace('{context}', 'from-gsm1'))).toBeVisible();
    await gsm1.check();
    await dialog.getByRole('button', { name: ru['common.save'], exact: true }).click();
    await expect(page.getByText(ru['phones.saved'].replace('{number}', '102'))).toBeVisible({ timeout: 15_000 });
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: ru['common.edit'] }).filter({ visible: true }).nth(1).click();
    await expect(page.getByRole('dialog').getByRole('checkbox', { name: 'gsm1', exact: true })).toBeChecked();
    await expect(page.getByRole('dialog').getByRole('checkbox', { name: 'gsm2', exact: true })).toBeChecked();
  });

  test('refuses to delete a phone a modem rings', async ({ page }) => {
    // 101 is in both fixture ring groups, so the delete is refused and the controller's message is shown.
    await page.getByRole('button', { name: ru['common.delete'] }).filter({ visible: true }).first().click();
    await page.getByRole('dialog').getByRole('button', { name: ru['common.delete'] }).click();
    await expect(page.getByText('rings phone 101', { exact: false })).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('the settings page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/settings');
  });

  test('saves the registry fields and leaves the secrets alone', async ({ page }, info) => {
    const retention = await openSection(page, 'settings-retention');
    await expect(page.getByRole('button', { name: ru['common.saved'] })).toBeDisabled();
    await retention.getByLabel(ru['settings.retention_operations']).fill('60');
    await retention.getByLabel(ru['settings.retention_messages']).fill('365');
    await page.screenshot({ path: `test-results/screens/${info.project.name}-settings-open.png`, fullPage: true });
    await page.getByRole('button', { name: ru['common.save'], exact: true }).click();
    await expect(page.getByText(ru['settings.saved'])).toBeVisible({ timeout: 15_000 });
    // The settings were read again and the form matches them; the token was not part of the change and is still set.
    await expect(page.getByRole('button', { name: ru['common.saved'] })).toBeDisabled();
    await expect(retention.getByLabel(ru['settings.retention_operations'])).toHaveValue('60');
    await expect(retention.getByLabel(ru['settings.retention_messages'])).toHaveValue('365');
    await expect(page.getByText(ru['settings.token_set']).first()).toBeVisible();
  });

  test('keeps the sections folded on a phone and open where there is room', async ({ page }, info) => {
    // the long pages stack collapsible sections on a phone; on a desktop folding them would hide what there is room for.
    const open = await page.locator('#settings-retention').evaluate((element) => /** @type {HTMLDetailsElement} */ (element).open);
    expect(open).toBe(!info.project.use.isMobile);
  });

  test('refuses a recipient the registry would refuse, and one that is already in the list', async ({ page }) => {
    const notifications = await openSection(page, 'settings-notifications');
    const field = notifications.getByLabel(ru['settings.recipients']);
    await field.fill('not-a-chat-id');
    await notifications.getByRole('button', { name: ru['list.add'] }).click();
    await expect(notifications.getByRole('alert')).toHaveText(ru['list.invalid']);
    // The fixture already has this one; adding it twice would send a list the registry refuses.
    await field.fill('123456789');
    await notifications.getByRole('button', { name: ru['list.add'] }).click();
    await expect(notifications.getByRole('alert')).toHaveText(ru['list.duplicate']);
    await field.fill('987654321');
    await notifications.getByRole('button', { name: ru['list.add'] }).click();
    await expect(notifications.getByRole('button', { name: ru['list.remove'].replace('{item}', '987654321') })).toBeVisible();
  });

  test('checks the new password against itself before it sends anything', async ({ page }) => {
    const password = await openSection(page, 'settings-password');
    await password.getByLabel(ru['settings.password_current']).fill('a-long-enough-password');
    await password.getByLabel(ru['settings.password_next'], { exact: true }).fill('another-long-password');
    await password.getByLabel(ru['settings.password_again']).fill('a-different-one');
    await password.getByRole('button', { name: ru['settings.password_change'] }).click();
    await expect(page.getByRole('alert').filter({ hasText: ru['settings.password_mismatch'] })).toBeVisible();
  });

  test('offers the backup as a download the browser handles', async ({ page }) => {
    const backup = await openSection(page, 'settings-backup');
    const link = backup.getByRole('link', { name: ru['settings.backup_download'] });
    await expect(link).toHaveAttribute('href', '/api/backup');
    await expect(link).toHaveAttribute('download', '');
  });
});

test.describe('the keyboard', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('reaches the page from the skip link and opens a dialog and closes it again', async ({ page }) => {
    await page.goto('/messages');
    // The skip link only exists once the shell has rendered (after GET /api/me).
    await expect(page.locator('#messages-list')).toBeVisible();
    // The skip link is the first thing a keyboard user meets, and it lands on the page itself.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: ru['app.skip'] })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('main#content')).toBeFocused();

    // Every control of the page is reachable by tabbing: the compose button is the last one, and Enter opens its dialog.
    const compose = page.getByRole('button', { name: ru['messages.compose'] });
    await compose.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // The focus is inside the dialog (the browser's own trap, because it is a real <dialog>), and Esc closes it.
    await expect(dialog.locator(':focus')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('operates the filters and the list of a page without a mouse', async ({ page }) => {
    await page.goto('/calls');
    const filters = await openSection(page, 'calls-filters');
    const outcome = filters.getByLabel(ru['calls.outcome']);
    await outcome.focus();
    await expect(outcome).toBeFocused();
    await outcome.selectOption('answered');
    await expect(page.locator('#calls-list').getByText(ru['calls.outcome_missed']).filter({ visible: true })).toBeHidden();
  });
});

test.describe('the messages page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/messages');
  });

  test('shows what was received and what was sent, and filters by direction with the tabs', async ({ page }, info) => {
    const list = page.locator('#messages-list');
    await expect(list.getByText('Баланс 12.34 EUR').filter({ visible: true })).toBeVisible();
    await expect(list.getByText(ru['sms.status_delivered']).filter({ visible: true }).first()).toBeVisible();
    // The pager says where the page sits even when everything fits on one.
    await expect(list.getByText(ru['list.range'].replace('{first}', '1').replace('{last}', '5').replace('{total}', '5'))).toBeVisible();
    await page.screenshot({ path: `test-results/screens/${info.project.name}-messages-list.png`, fullPage: true });
    // The text of an SMS is shown whole, however long, in the table and on a card: nothing is cut off behind an ellipsis.
    const text = list.getByText(/Склад закрыт до понедельника/).filter({ visible: true });
    await expect(text).toContainText('Номер тот же, что и в прошлый раз.');
    expect(await text.evaluate((element) => element.scrollHeight - element.clientHeight), 'the SMS text is cut off').toBeLessThanOrEqual(1);

    await page.getByRole('tab', { name: ru['messages.inbox'] }).click();
    await expect(list.getByText('Баланс 12.34 EUR').filter({ visible: true })).toBeVisible();
    // A received message has no delivery status: the outbox rows are gone with the tab.
    await expect(list.getByText(ru['sms.status_delivered']).filter({ visible: true })).toBeHidden();

    // The arrow keys move between the tabs, which is the pattern a keyboard user expects.
    await page.getByRole('tab', { name: ru['messages.inbox'] }).press('ArrowRight');
    await expect(page.getByRole('tab', { name: ru['messages.outbox'] })).toHaveAttribute('aria-selected', 'true');
    await expect(list.getByText('Баланс 12.34 EUR').filter({ visible: true })).toBeHidden();
  });

  test('composes an SMS with the segment estimate beside Send', async ({ page }, info) => {
    const compose = page.getByRole('button', { name: ru['messages.compose'] });
    if (info.project.use.isMobile) await compose.tap();
    else await compose.click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(ru['messages.number']).fill('+375291112233');
    await dialog.getByLabel(ru['messages.text'], { exact: true }).fill('Привет');
    // Cyrillic forces Unicode: 70 characters to a message, so six of them leave 64.
    await expect(dialog.getByText(ru['messages.segments'].replace('{parts}', '1').replace('{left}', '64'))).toBeVisible();
    await dialog.getByLabel(ru['messages.text'], { exact: true }).fill('Hello');
    await expect(dialog.getByText(ru['messages.segments'].replace('{parts}', '1').replace('{left}', '155'))).toBeVisible();
    await page.screenshot({ path: `test-results/screens/${info.project.name}-compose.png` });

    const send = dialog.getByRole('button', { name: ru['messages.send'], exact: true });
    if (info.project.use.isMobile) await send.tap();
    else await send.click();
    await expect(page.getByText(ru['messages.queued'].replace('{number}', '+375291112233'))).toBeVisible({ timeout: 15_000 });
  });

  test('retries a failed SMS at once and an uncertain one only after the confirmation', async ({ page }, info) => {
    // The failed one: the controller allows it, so no dialog appears.
    const rows = page.getByRole('button', { name: ru['messages.retry'] }).filter({ visible: true });
    await rows.last().click();
    await expect(page.getByText(ru['messages.retry_queued'].replace('{id}', '10'))).toBeVisible({ timeout: 15_000 });

    // The uncertain one: the controller answers 409 confirm-required, which is what opens the dialog.
    await page.getByRole('button', { name: ru['messages.retry'] }).filter({ visible: true }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByText(ru['sms.status_uncertain'], { exact: false })).toBeVisible();
    await page.screenshot({ path: `test-results/screens/${info.project.name}-retry-confirm.png` });
    const confirm = dialog.getByRole('button', { name: ru['messages.retry_confirm'] });
    if (info.project.use.isMobile) await confirm.tap();
    else await confirm.click();
    await expect(page.getByText(ru['messages.retry_queued'].replace('{id}', '11'))).toBeVisible({ timeout: 15_000 });
  });

  test('deletes one SMS of either direction, the failed ones with the purge, and the whole list with Delete all', async ({ page }, info) => {
    const list = page.locator('#messages-list');
    const press = async (/** @type {import('@playwright/test').Locator} */ button) => (info.project.use.isMobile ? button.tap() : button.click());
    const row = (/** @type {string} */ text) => list.locator('tr, li').filter({ hasText: text }).filter({ visible: true });
    const deleteIn = (/** @type {string} */ text) => row(text).getByRole('button', { name: ru['common.delete'], exact: true });
    // Every fixture SMS has ended, so each one has a Delete.
    const deletes = list.getByRole('button', { name: ru['common.delete'], exact: true }).filter({ visible: true });
    await expect(deletes).toHaveCount(5);
    await press(deleteIn('+375291110000'));
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(ru['messages.delete_title'].replace('{number}', '+375291110000'))).toBeVisible();
    await page.screenshot({ path: `test-results/screens/${info.project.name}-delete-confirm.png` });
    await press(dialog.getByRole('button', { name: ru['common.delete'], exact: true }));
    await expect(page.getByText(ru['messages.deleted'].replace('{number}', '+375291110000'))).toBeVisible({ timeout: 15_000 });
    await expect(list.getByText('+375291110000').filter({ visible: true })).toBeHidden();

    await press(deleteIn('Баланс 12.34 EUR'));
    await expect(dialog.getByText(ru['messages.delete_in_title'].replace('{number}', '+1234567890'))).toBeVisible();
    await press(dialog.getByRole('button', { name: ru['common.delete'], exact: true }));
    await expect(page.getByText(ru['messages.deleted_in'])).toBeVisible({ timeout: 15_000 });
    await expect(deletes).toHaveCount(3);

    // The purge takes the uncertain one and leaves the delivered one.
    await press(list.getByRole('button', { name: ru['messages.purge'] }));
    await expect(dialog.getByText(ru['messages.purge_title'])).toBeVisible();
    await press(dialog.getByRole('button', { name: ru['messages.purge'] }));
    await expect(page.getByText(ru['messages.purged'].replace('{n}', '1'))).toBeVisible({ timeout: 15_000 });
    await expect(deletes).toHaveCount(2);
    await expect(list.getByText(ru['sms.status_delivered']).filter({ visible: true })).toBeVisible();

    await press(list.getByRole('button', { name: ru['common.delete_all'] }));
    await expect(dialog.getByText(ru['messages.clear_title'].replace('{n}', '2'))).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: `test-results/screens/${info.project.name}-messages-clear-confirm.png` });
    await press(dialog.getByRole('button', { name: ru['common.delete_all'] }));
    await expect(page.getByText(ru['messages.purged'].replace('{n}', '2'))).toBeVisible({ timeout: 15_000 });
    await expect(list.getByText(ru['messages.none'])).toBeVisible();
    await expect(list.getByRole('button', { name: ru['common.delete_all'] })).toBeHidden();
  });
});

test.describe('the calls page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/calls');
  });

  test('shows every outcome as a word and filters by it', async ({ page }) => {
    const list = page.locator('#calls-list');
    await expect(list.getByText(ru['calls.outcome_answered']).filter({ visible: true }).first()).toBeVisible();
    await expect(list.getByText(ru['calls.outcome_missed']).filter({ visible: true })).toBeVisible();

    const filters = await openSection(page, 'calls-filters');
    await filters.getByLabel(ru['calls.outcome']).selectOption('missed');
    await expect(list.getByText(ru['calls.outcome_answered']).filter({ visible: true })).toHaveCount(0);
    await expect(list.getByText('+375447654321').filter({ visible: true })).toBeVisible();
  });

  test('shows each call\'s direction, filters by it, and adds up the talk time per SIM', async ({ page }, info) => {
    const list = page.locator('#calls-list');
    const row = (/** @type {string} */ text) => list.locator('tr, li').filter({ hasText: text }).filter({ visible: true });
    await expect(row('+1234567891').getByRole('img', { name: ru['calls.direction_out'] })).toBeVisible();
    await expect(row('+1234567892').getByText(ru['calls.outcome_unanswered'])).toBeVisible();
    await expect(row('+375447654321').getByRole('img', { name: ru['calls.direction_in'] })).toBeVisible();

    const filters = await openSection(page, 'calls-filters');
    await filters.getByLabel(ru['calls.direction']).selectOption('out');
    await expect(list.getByText('+375447654321').filter({ visible: true })).toBeHidden();
    await expect(list.getByText('504').filter({ visible: true })).toBeVisible();

    // gsm1: one outgoing call of 312 s and one incoming of 96 s; this month or last, as the mock's times fall
    const talk = await openSection(page, 'calls-talk');
    const gsm1 = talk.locator('tr, li').filter({ hasText: 'gsm1' }).filter({ visible: true });
    const value = (/** @type {number} */ m, /** @type {number} */ s) =>
      ru['calls.talk_value'].replace('{time}', `${m} ${ru['time.m']} ${s} ${ru['time.s']}`).replace('{n}', '1');
    await expect(gsm1.getByText(value(5, 12))).toBeVisible();
    await expect(gsm1.getByText(value(1, 36))).toBeVisible();
    await page.screenshot({ path: `test-results/screens/${info.project.name}-calls-talk.png`, fullPage: true });
  });

  test('shows 25 calls a page, pages on, and keeps a rows-per-page choice after a reload', async ({ page }, info) => {
    const list = page.locator('#calls-list');
    const range = (/** @type {number} */ first, /** @type {number} */ last) =>
      ru['list.range'].replace('{first}', String(first)).replace('{last}', String(last)).replace('{total}', '35');
    const press = async (/** @type {import('@playwright/test').Locator} */ button) => (info.project.use.isMobile ? button.tap() : button.click());
    await expect(list.getByText(range(1, 25))).toBeVisible();
    await press(list.getByRole('button', { name: ru['list.next'] }));
    await expect(list.getByText(range(26, 35))).toBeVisible();

    await list.getByLabel(ru['list.per_page']).selectOption('50');
    await expect(list.getByText(range(1, 35))).toBeVisible();
    await expect(list.getByRole('button', { name: ru['list.next'] })).toHaveCount(0);
    await page.reload();
    await expect(page.locator('#calls-list').getByText(range(1, 35))).toBeVisible();
    await expect(page.locator('#calls-list').getByLabel(ru['list.per_page'])).toHaveValue('50');
  });

  test('deletes one call after the confirmation, and with a filter Delete all takes only what the list shows', async ({ page }, info) => {
    const list = page.locator('#calls-list');
    const press = async (/** @type {import('@playwright/test').Locator} */ button) => (info.project.use.isMobile ? button.tap() : button.click());
    const row = (/** @type {string} */ text) => list.locator('tr, li').filter({ hasText: text }).filter({ visible: true });
    await press(row('+375447654321').getByRole('button', { name: ru['common.delete'], exact: true }));
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(ru['calls.delete_title'].replace('{caller}', '+375447654321'))).toBeVisible();
    await press(dialog.getByRole('button', { name: ru['common.delete'], exact: true }));
    await expect(page.getByText(ru['calls.deleted'])).toBeVisible({ timeout: 15_000 });
    await expect(list.getByText('+375447654321').filter({ visible: true })).toBeHidden();

    const filters = await openSection(page, 'calls-filters');
    await filters.getByLabel(ru['calls.outcome']).selectOption('failed');
    await expect(list.getByText(ru['calls.outcome_answered']).filter({ visible: true })).toHaveCount(0);
    await press(list.getByRole('button', { name: ru['common.delete_all'] }));
    await expect(dialog.getByText(ru['calls.clear_title'].replace('{n}', '1'))).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: `test-results/screens/${info.project.name}-calls-clear-confirm.png` });
    await press(dialog.getByRole('button', { name: ru['common.delete_all'] }));
    await expect(page.getByText(ru['calls.purged'].replace('{n}', '1'))).toBeVisible({ timeout: 15_000 });
    await expect(list.getByText(ru['calls.none'])).toBeVisible();

    await filters.getByLabel(ru['calls.outcome']).selectOption('');
    await expect(list.getByText(ru['calls.outcome_answered']).filter({ visible: true }).first()).toBeVisible();
  });
});

test.describe('the config page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/config');
  });

  /** The file list is one of two views on a phone; on both it is a button per file. */
  const pick = (/** @type {import('@playwright/test').Page} */ page, /** @type {string} */ name) =>
    page.getByRole('button', { name: new RegExp(`^${name.replace('.', '\\.')}`) }).filter({ visible: true }).first();

  test('opens a hand-owned file, refuses a broken one with the line, and applies a good one', async ({ page }, info) => {
    await pick(page, 'extensions.conf').click();
    const editor = page.getByLabel(ru['config.content'].replace('{name}', 'extensions.conf'));
    await expect(editor).toHaveValue(/\[smoke\]/);
    await page.screenshot({ path: `test-results/screens/${info.project.name}-config.png`, fullPage: true });

    // A section header without its closing bracket is a lint problem, and the controller names the line it is on.
    await editor.fill('[broken\nexten => 100,1,Hangup()\n');
    await page.getByRole('button', { name: ru['config.apply'], exact: true }).click();
    await expect(page.getByText(ru['config.line'].replace('{n}', '1'), { exact: false })).toBeVisible({ timeout: 15_000 });

    await editor.fill('[smoke]\nexten => 100,1,Hangup()\n');
    await page.getByRole('button', { name: ru['config.apply'], exact: true }).click();
    await expect(page.getByText(ru['config.applied'].replace('{name}', 'extensions.conf'))).toBeVisible({ timeout: 15_000 });
  });

  test('keeps the changed-on-disk warning until one of its two answers is used', async ({ page }, info) => {
    await pick(page, 'rtp.conf').click();
    const editor = page.getByLabel(ru['config.content'].replace('{name}', 'rtp.conf'));
    await editor.fill('[general]\nrtpstart = 11000\nrtpend = 11200\n');
    await page.getByRole('button', { name: ru['config.apply'], exact: true }).click();

    // Someone else wrote the file in between: the page says so and offers the only two honest ways out.
    const warning = page.getByRole('alert').filter({ hasText: ru['config.conflict'] });
    await expect(warning).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: `test-results/screens/${info.project.name}-config-conflict.png`, fullPage: true });
    await expect(warning.getByRole('button', { name: ru['config.reload_file'] })).toBeVisible();
    const force = warning.getByRole('button', { name: ru['config.force'] });
    if (info.project.use.isMobile) await force.tap();
    else await force.click();
    await expect(page.getByText(ru['config.applied'].replace('{name}', 'rtp.conf'))).toBeVisible({ timeout: 15_000 });
    await expect(warning).toBeHidden();
  });

  test('asks before a file that only takes effect after a restart is applied', async ({ page }) => {
    await pick(page, 'modules.conf').click();
    const editor = page.getByLabel(ru['config.content'].replace('{name}', 'modules.conf'));
    await editor.fill('[modules]\nautoload = yes\n');
    await page.getByRole('button', { name: ru['config.apply'], exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(ru['config.restart_text'].replace('{name}', 'modules.conf'))).toBeVisible();
    await dialog.getByRole('button', { name: ru['config.restart_confirm'] }).click();
    await expect(page.getByText(ru['config.applied'].replace('{name}', 'modules.conf'))).toBeVisible({ timeout: 15_000 });
  });

  test('shows a generated file read-only and says which page does change it', async ({ page }) => {
    await pick(page, 'aster.d/phones.conf').click();
    await expect(page.getByLabel(ru['config.content'].replace('{name}', 'aster.d/phones.conf'))).toHaveAttribute('readonly', '');
    await expect(page.getByText(ru['config.generated'])).toBeVisible();
    await expect(page.getByRole('button', { name: ru['config.apply'], exact: true })).toBeHidden();
  });
});

test.describe('the activity page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/activity');
  });

  test('lists the operations with their outcome and opens one in full', async ({ page }, info) => {
    const list = page.locator('#activity-list');
    await expect(list.getByText(ru['activity.status_uncertain']).filter({ visible: true }).first()).toBeVisible();
    await page.screenshot({ path: `test-results/screens/${info.project.name}-activity.png`, fullPage: true });
    await list.getByRole('button', { name: ru['activity.details'] }).filter({ visible: true }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(ru['activity.params'])).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByText('outbox_id', { exact: false })).toBeVisible();
  });

  test('shows the notifications on their own tab, with the reason a failed one gives', async ({ page }) => {
    await page.getByRole('tab', { name: ru['activity.notifications'] }).click();
    const list = page.locator('#activity-list');
    await expect(list.getByText(ru['activity.notify_failed']).filter({ visible: true })).toBeVisible({ timeout: 15_000 });
    await expect(list.getByText('Модем gsm2 недоступен', { exact: false }).filter({ visible: true })).toBeVisible();
  });
});

test.describe('the logs page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/logs');
  });

  test('tails both logs and narrows them to what a line contains', async ({ page }, info) => {
    const output = page.locator('#logs-output');
    await expect(output.getByText('chan_quectel.c', { exact: false })).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: `test-results/screens/${info.project.name}-logs.png`, fullPage: true });

    await page.getByLabel(ru['logs.grep']).fill('dongle');
    await expect(output.getByText('chan_dongle.c', { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(output.getByText('chan_quectel.c')).toBeHidden();

    await page.getByRole('tab', { name: ru['logs.controller'] }).click();
    await page.getByLabel(ru['logs.grep']).fill('');
    await expect(output.getByText('operation finished', { exact: false })).toBeVisible({ timeout: 15_000 });
  });

  test('scrolls its output sideways without the page scrolling', async ({ page }) => {
    await expect(page.locator('#logs-output')).toBeVisible();
    // The box is what scrolls: the page itself never does, at any width.
    await noSidewaysScroll(page);
    await page.setViewportSize(NARROW);
    await noSidewaysScroll(page);
  });
});

// Phone-layout regressions (360×640).
test.describe('the phone layout', () => {
  test.beforeEach(async ({ page }, info) => {
    test.skip(!info.project.use.isMobile, 'these are the rules of the phone layout');
    await login(page);
  });

  /** @param {import('@playwright/test').Locator} locator */
  async function box(locator) {
    const found = await locator.boundingBox();
    if (found === null) throw new Error('the element is not laid out');
    return found;
  }

  test('keeps a dialog’s buttons side by side and above the keyboard', async ({ page }) => {
    // Chrome on Android shrinks the layout for the keyboard only when the page asks for it.
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /interactive-widget=resizes-content/);
    await page.goto('/messages');
    await page.getByRole('button', { name: ru['messages.compose'] }).tap();
    const dialog = page.getByRole('dialog');
    const cancel = await box(dialog.getByRole('button', { name: ru['common.cancel'] }));
    const send = await box(dialog.getByRole('button', { name: ru['messages.send'], exact: true }));
    expect(Math.abs(cancel.y - send.y)).toBeLessThan(1);

    // What the keyboard leaves of a 640 px screen: Send is still on it, and the form keeps more room than the footer.
    await page.setViewportSize({ width: 360, height: 340 });
    await dialog.getByLabel(ru['messages.text'], { exact: true }).focus();
    const footer = await box(dialog.getByRole('button', { name: ru['messages.send'], exact: true }).locator('xpath=../..'));
    const body = await box(dialog.getByLabel(ru['messages.number']).locator('xpath=ancestor::div[contains(@class,"overflow-y-auto")]'));
    expect(footer.y + footer.height).toBeLessThanOrEqual(340);
    expect(body.height).toBeGreaterThan(footer.height);
  });

  test('floats the Save bar only while there is something to save, and keeps a toast off it', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByRole('button', { name: ru['common.saved'] }).locator('..')).toHaveCSS('position', 'static');
    const retention = await openSection(page, 'settings-retention');
    await retention.getByLabel(ru['settings.retention_operations']).fill('60');
    const bar = page.getByRole('button', { name: ru['common.save'], exact: true }).locator('..');
    await expect(bar).toHaveCSS('position', 'sticky');

    // A failure has no timer, so a toast that lands on the bar hides Save until it is dismissed.
    const telegram = await openSection(page, 'settings-telegram');
    await telegram.getByLabel(ru['settings.test']).fill('abc');
    await telegram.getByRole('button', { name: ru['settings.test_send'] }).tap();
    const toast = page.getByText(ru['settings.chat_id_invalid']).locator('..');
    await expect(toast).toBeVisible();
    const over = await box(toast);
    const under = await box(bar);
    expect(over.y + over.height <= under.y + 1 || over.y >= under.y + under.height - 1, 'the toast covers the Save bar').toBe(true);
  });

  test('cuts neither a section’s hint, a file’s name nor a checkbox', async ({ page }) => {
    await page.goto('/modems/gsm1');
    const at = await openSection(page, 'modem-at');
    // The AT box's hint is its warning; once the section is open all of it is there.
    const hint = at.locator('summary').getByText(ru['at.hint']);
    expect(await hint.evaluate((element) => element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth)).toBe(true);

    // Nothing below depends on mock state, so reloading via `goto` is fine.
    await page.setViewportSize(NARROW);
    await page.goto('/config');
    const name = page.getByText('aster.d/phones.conf', { exact: true }).filter({ visible: true });
    await expect(name).toBeVisible();
    expect(await name.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

    await page.goto('/logs');
    await expect(page.locator('#logs-output')).toBeVisible();
    for (const checkbox of await page.locator('main input[type=checkbox]').all()) {
      expect((await box(checkbox)).width).toBeGreaterThanOrEqual(19);
    }
  });

  test('puts a list bar on one row, the log output on the first screen and the config text at 16 px', async ({ page }) => {
    await page.goto('/modems');
    // Poll rather than measure once: the bar reflows while the list loads, and what matters is where it settles.
    await expect.poll(async () => {
      const scan = await box(page.getByRole('button', { name: ru['overview.scan'], exact: true }));
      const assign = await box(page.getByRole('button', { name: ru['modems.assign'], exact: true }));
      return Math.abs(scan.y - assign.y);
    }).toBeLessThan(1);

    await page.goto('/logs');
    await expect(page.locator('#logs-output').getByText('chan_quectel.c', { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    expect((await box(page.locator('#logs-output'))).y).toBeLessThan(640);

    await page.goto('/config');
    await page.getByRole('button', { name: /^extensions\.conf/ }).filter({ visible: true }).first().tap();
    // Below 16 px iOS Safari zooms the page into the field it focuses.
    await expect(page.getByLabel(ru['config.content'].replace('{name}', 'extensions.conf'))).toHaveCSS('font-size', '16px');
  });
});

<!-- Modems page: registry modems with live state, plus unassigned devices from the last scan and an Assign dialog
     (also opened via `?assign=<port or tty>`). Saves are a registry-apply; a 202 is awaited via lib/ops.js. -->
<script>
  import { onMount } from 'svelte';
  import { api } from '../api.js';
  import { t } from '../i18n/index.js';
  import DeviceTable from '../lib/DeviceTable.svelte';
  import Dialog from '../lib/Dialog.svelte';
  import Field from '../lib/Field.svelte';
  import ResponsiveTable from '../lib/ResponsiveTable.svelte';
  import StateBadge from '../lib/StateBadge.svelte';
  import StickyActions from '../lib/StickyActions.svelte';
  import { messageOf, problemsElsewhere, problemsFor, problemsOf } from '../lib/errors.js';
  import { ago, orNone } from '../lib/format.js';
  import { live } from '../lib/live.svelte.js';
  import { settleChange } from '../lib/ops.js';
  import { toasts } from '../lib/toasts.svelte.js';
  import { navigate } from '../router.js';

  /** Client-side patterns for early feedback; the controller still validates. */
  const ID = /^[a-z][a-z0-9_]{0,15}$/;
  const IMEI = /^[0-9]{15}$/;
  /** The fields the dialog shows problems for; anything else the controller refuses is shown above the form. */
  const FIELDS = Object.freeze(['id', 'imei', 'driver', 'usb_port']);

  /** @type {any[]} */
  let modems = $state([]);
  /** @type {any[]} */
  let devices = $state([]);
  /** The last scan as `GET /api/scan/latest` returns it (when, and what went wrong); null = never run. */
  /** @type {any | null} */
  let scan = $state(null);
  /** @type {string | null} */
  let error = $state(null);
  let loading = $state(false);
  let scanning = $state(false);

  let open = $state(false);
  let saving = $state(false);
  /** @type {{ path: string, message: string }[]} */
  let problems = $state([]);
  /** @type {string | null} */
  let refused = $state(null);
  /** The device the dialog was opened on, by its USB port or its data port; '' = filled in by hand. */
  let picked = $state('');
  let form = $state(blank());

  function blank() {
    return { id: '', driver: 'quectel', imei: '', usb_port: '', enabled: true, uac: false };
  }

  /** Suggests the first free `gsm<n>` id; the admin can type another. */
  function suggestId() {
    const taken = new Set(modems.map((modem) => modem.id));
    for (let n = 1; n <= 99; n += 1) {
      if (!taken.has(`gsm${n}`)) return `gsm${n}`;
    }
    return '';
  }

  async function load() {
    loading = true;
    try {
      const data = await api.modems();
      modems = data?.modems ?? [];
      error = null;
    } catch (err) {
      error = messageOf(err);
    } finally {
      loading = false;
    }
  }

  /** The devices the list and the assign dialog offer; a scan that never ran is simply an empty list. */
  async function loadDevices() {
    try {
      const data = await api.scanLatest();
      scan = data?.scan ?? null;
      devices = scan?.unassigned ?? [];
    } catch (err) {
      scan = null;
      devices = [];
      error = messageOf(err);
    }
  }

  $effect(() => {
    void live.resume;
    void live.finished;
    void load();
    void loadDevices();
  });

  // Open Assign for a device passed in the query, then drop the query so a reload does not reopen it.
  onMount(() => {
    const wanted = new URLSearchParams(window.location.search).get('assign');
    if (wanted === null) return;
    navigate('/modems', { replace: true });
    void openFor(wanted);
  });

  /** @param {string} wanted  a USB port or a data tty, as the Overview's link carries it */
  async function openFor(wanted) {
    if (devices.length === 0) await loadDevices();
    const device = devices.find((entry) => entry.usb_port === wanted || entry.data_tty === wanted);
    openAssign(device ?? null);
    if (device === undefined || device === null) toasts.push({ kind: 'error', text: t('modems.device_gone', { device: wanted }) });
  }

  /** @param {any | null} device */
  function openAssign(device) {
    problems = [];
    refused = null;
    form = blank();
    form.id = suggestId();
    picked = device === null ? '' : (device.usb_port ?? device.data_tty ?? '');
    if (device !== null) fillFrom(device);
    open = true;
  }

  /** @param {any} device */
  function fillFrom(device) {
    form.imei = device.imei ?? '';
    form.driver = device.suggested_driver ?? form.driver;
    form.usb_port = device.usb_port ?? '';
    // Only a quectel can use UAC audio, and it then needs the USB port it is plugged into.
    form.uac = form.driver === 'quectel' && form.usb_port !== '';
  }

  /** @param {string} value  the picked device's port, or '' for a modem typed in by hand */
  function pick(value) {
    picked = value;
    const device = devices.find((entry) => (entry.usb_port ?? entry.data_tty) === value);
    if (device) fillFrom(device);
  }

  /** What the dialog sends: the registry fields of a new modem, with the empty ones left out. */
  function body() {
    /** @type {Record<string, unknown>} */
    const fields = { id: form.id.trim(), driver: form.driver, imei: form.imei.trim(), enabled: form.enabled, uac: form.uac };
    const port = form.usb_port.trim();
    if (port !== '') fields.usb_port = port;
    return fields;
  }

  function check() {
    /** @type {{ path: string, message: string }[]} */
    const found = [];
    if (!ID.test(form.id.trim())) found.push({ path: 'id', message: t('modems.id_invalid') });
    if (!IMEI.test(form.imei.trim())) found.push({ path: 'imei', message: t('modems.imei_invalid') });
    if (form.uac && form.driver === 'dongle') found.push({ path: 'driver', message: t('modems.uac_quectel') });
    return found;
  }

  async function submit(/** @type {SubmitEvent} */ event) {
    event.preventDefault();
    if (saving) return;
    problems = check();
    refused = null;
    if (problems.length > 0) return;
    saving = true;
    const id = form.id.trim();
    try {
      const { applied } = await settleChange(await api.assignModem(body()));
      await load();
      if (applied) {
        // Any ring group on the new modem comes from the controller's default phone links.
        const ring = modems.find((modem) => modem.id === id)?.ring ?? [];
        const text = ring.length === 0 ? t('modems.assigned', { id }) : t('modems.assigned_linked', { id, phones: ring.join(', ') });
        toasts.push({ kind: 'success', text });
        open = false;
        // Continue on the detail page for ring group, context and recipients.
        navigate(`/modems/${encodeURIComponent(id)}`);
      }
    } catch (err) {
      problems = problemsOf(err);
      refused = messageOf(err);
    } finally {
      saving = false;
    }
  }

  async function startScan() {
    scanning = true;
    try {
      await api.scan();
      toasts.push({ text: t('overview.scan_started') });
    } catch (err) {
      toasts.push({ kind: 'error', text: messageOf(err) });
    } finally {
      scanning = false;
    }
  }

  /** The registry entry with the newest observation of the stream on top of it (the Overview merges the same way). */
  const rows = $derived(
    modems.map((modem) => {
      const seen = live.modems[modem.id];
      return seen ? { ...modem, state: seen.state ?? modem.state, rssi: seen.rssi, observed_at: seen.observed_at } : modem;
    }),
  );

  const columns = $derived([
    { key: 'id', label: t('modems.id'), primary: true },
    { key: 'state', label: t('modems.state') },
    { key: 'driver', label: t('device.driver') },
    { key: 'imei', label: t('device.imei') },
    { key: 'port', label: t('modem.port') },
    { key: 'ring', label: t('modems.ring') },
    { key: 'seen', label: t('modem.seen') },
  ]);
</script>

<h1 class="mb-4 hidden text-2xl font-semibold tracking-tight md:block">{t('modems.title')}</h1>

{#if error !== null}
  <p class="card mb-4 border-rose-200 bg-rose-50 p-4 text-rose-900" role="alert">{error}</p>
{/if}

<section class="list-panel" aria-labelledby="modems-heading">
  <h2 id="modems-heading" class="sr-only">{t('modems.title')}</h2>
  <ResponsiveTable
    tableFrom="56rem"
    {columns}
    rows={rows}
    rowKey={(modem) => modem.id}
    label={t('modems.title')}
    empty={loading && modems.length === 0 ? t('app.loading') : t('modems.none')}
  >
    {#snippet cell(/** @type {any} */ modem, /** @type {{ key: string }} */ column)}
      {#if column.key === 'id'}
        <a class="font-semibold text-sky-800 underline-offset-2 hover:underline" href="/modems/{encodeURIComponent(modem.id)}">
          {modem.id}
        </a>
      {:else if column.key === 'state'}
        <StateBadge state={modem.state} />
      {:else if column.key === 'driver'}
        {modem.driver}
      {:else if column.key === 'imei'}
        <span class="tabular-nums">{orNone(modem.imei)}</span>
      {:else if column.key === 'port'}
        <span class="tabular-nums">{orNone(modem.usb_port)}</span>
      {:else if column.key === 'ring'}
        <span class="tabular-nums">{modem.ring?.length > 0 ? modem.ring.join(', ') : t('common.none')}</span>
      {:else if column.key === 'seen'}
        {modem.observed_at ? ago(modem.observed_at) : t('modem.never_seen')}
      {/if}
    {/snippet}

    {#snippet actions(/** @type {any} */ modem)}
      <a class="btn btn-plain px-3 text-sm" href="/modems/{encodeURIComponent(modem.id)}">{t('modems.open')}</a>
    {/snippet}
  </ResponsiveTable>
</section>

<section class="mt-6" aria-labelledby="devices-heading">
  <div class="mb-2 flex flex-wrap items-baseline justify-between gap-2">
    <h2 id="devices-heading" class="text-lg font-semibold">{t('overview.unassigned')}</h2>
    <p class="text-sm text-slate-500">
      {t('overview.last_scan', { when: scan === null ? t('overview.never') : ago(scan.at) })}
    </p>
  </div>
  <p class="mb-2 text-sm text-slate-500">{t('overview.unassigned_hint')}</p>

  {#if scan !== null && scan.errors?.length > 0}
    <p class="card mb-3 border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      {t('overview.scan_errors', { errors: scan.errors.join('; ') })}
    </p>
  {/if}

  <div class="list-panel">
    <DeviceTable {devices} label={t('overview.unassigned')} empty={t('overview.no_unassigned')}>
      {#snippet actions(/** @type {any} */ device)}
        <button type="button" class="btn btn-primary px-3 text-sm" onclick={() => openAssign(device)}>{t('overview.assign')}</button>
      {/snippet}
    </DeviceTable>
  </div>
</section>

<!-- On a phone both buttons share one row and wrap their labels inside. -->
<StickyActions>
  <button type="button" class="btn btn-plain flex-1 md:flex-none" onclick={startScan} disabled={scanning}>
    {scanning ? t('overview.scanning') : t('overview.scan')}
  </button>
  <button type="button" class="btn btn-primary flex-1 md:flex-none" onclick={() => openAssign(devices[0] ?? null)}>{t('modems.assign')}</button>
</StickyActions>

<Dialog bind:open title={t('modems.assign_title')}>
  <form id="assign-form" class="flex flex-col gap-4" onsubmit={submit} novalidate>
    {#if refused !== null}
      <p class="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900" role="alert">{refused}</p>
    {/if}
    {#each problemsElsewhere(problems, FIELDS) as problem (problem.path + problem.message)}
      <p class="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900">{problem.path}: {problem.message}</p>
    {/each}

    <Field id="assign-device" label={t('modems.device')} hint={devices.length === 0 ? t('modems.no_devices_hint') : undefined}>
      {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
        <select id="assign-device" class="input" value={picked} aria-describedby={field.describedBy} onchange={(event) => pick(event.currentTarget.value)}>
          <option value="">{t('modems.by_hand')}</option>
          {#each devices as device (device.data_tty)}
            {@const value = device.usb_port ?? device.data_tty}
            <option {value}>{value} · {device.suggested_driver ?? '?'} · {orNone(device.imei)}</option>
          {/each}
        </select>
      {/snippet}
    </Field>

    <Field id="assign-id" label={t('modems.id')} hint={t('modems.id_hint')} problems={problemsFor(problems, 'id')}>
      {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
        <input id="assign-id" class="input" bind:value={form.id} autocomplete="off" spellcheck="false" aria-describedby={field.describedBy} />
      {/snippet}
    </Field>

    <Field id="assign-driver" label={t('device.driver')} problems={problemsFor(problems, 'driver')}>
      {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
        <select id="assign-driver" class="input" bind:value={form.driver} aria-describedby={field.describedBy}>
          <option value="quectel">quectel</option>
          <option value="dongle">dongle</option>
        </select>
      {/snippet}
    </Field>

    <Field id="assign-imei" label={t('device.imei')} hint={t('modems.imei_hint')} problems={problemsFor(problems, 'imei')}>
      {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
        <input id="assign-imei" class="input tabular-nums" bind:value={form.imei} inputmode="numeric" maxlength="15" autocomplete="off" aria-describedby={field.describedBy} />
      {/snippet}
    </Field>

    <Field id="assign-port" label={t('modem.port')} hint={t('modems.port_hint')} problems={problemsFor(problems, 'usb_port')}>
      {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
        <input id="assign-port" class="input tabular-nums" bind:value={form.usb_port} inputmode="text" autocomplete="off" spellcheck="false" aria-describedby={field.describedBy} />
      {/snippet}
    </Field>

    <label class="flex min-h-11 items-center gap-3">
      <input type="checkbox" class="h-5 w-5" bind:checked={form.enabled} />
      <span>{t('modems.enabled')}</span>
    </label>

    <label class="flex min-h-11 items-center gap-3">
      <input type="checkbox" class="h-5 w-5" bind:checked={form.uac} disabled={form.driver === 'dongle'} />
      <span>{t('modems.uac')}</span>
    </label>
  </form>

  {#snippet footer()}
    <div class="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
      <button type="button" class="btn btn-plain sm:order-1" disabled={saving} onclick={() => (open = false)}>{t('common.cancel')}</button>
      <button type="submit" form="assign-form" class="btn btn-primary sm:order-2" disabled={saving}>
        {saving ? t('common.saving') : t('modems.assign')}
      </button>
    </div>
  {/snippet}
</Dialog>

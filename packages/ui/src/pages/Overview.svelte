<!-- Overview: modem cards and unassigned devices from GET /api/overview. Live `modem.state` events merge into the cards;
     missed events trigger a refetch. Read-only: Assign links to the Modems page. -->
<script>
  import { api } from '../api.js';
  import { t } from '../i18n/index.js';
  import DeviceTable from '../lib/DeviceTable.svelte';
  import ModemNumber from '../lib/ModemNumber.svelte';
  import SignalBars from '../lib/SignalBars.svelte';
  import StateBadge from '../lib/StateBadge.svelte';
  import StickyActions from '../lib/StickyActions.svelte';
  import { ago, orNone } from '../lib/format.js';
  import { live } from '../lib/live.svelte.js';
  import { toasts } from '../lib/toasts.svelte.js';

  /** @type {Record<string, any> | null} */
  let data = $state(null);
  /** @type {string | null} */
  let error = $state(null);
  let loading = $state(false);
  let scanning = $state(false);

  async function load() {
    loading = true;
    try {
      data = await api.overview();
      error = null;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  // Load on open and again whenever the stream says data may be stale.
  $effect(() => {
    void live.resume;
    void live.finished;
    void load();
  });

  /** The card as the controller last sent it, with the newest observation from the stream on top. */
  const modems = $derived(
    (data?.modems ?? []).map((/** @type {any} */ modem) => {
      const seen = live.modems[modem.id];
      if (!seen) return modem;
      return {
        ...modem,
        state: seen.state ?? modem.state,
        rssi: seen.rssi,
        provider: seen.provider,
        number: seen.number,
        data_tty: seen.data_tty,
        observed_at: seen.observed_at,
        detail: seen.detail ?? modem.detail,
      };
    }),
  );
  const devices = $derived(data?.unassigned ?? []);
  const scan = $derived(data?.scan ?? null);
  const invalid = $derived(data !== null && data.registry?.valid === false);

  async function startScan() {
    scanning = true;
    try {
      await api.scan();
      toasts.push({ text: t('overview.scan_started') });
    } catch (err) {
      toasts.push({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      scanning = false;
    }
  }
</script>

<h1 class="mb-4 hidden text-2xl font-semibold tracking-tight md:block">{t('overview.title')}</h1>

{#if error !== null}
  <p class="card mb-4 border-rose-200 bg-rose-50 p-4 text-rose-900" role="alert">{error}</p>
{/if}

{#if invalid}
  <p class="card mb-4 border-amber-200 bg-amber-50 p-4 text-amber-900" role="alert">{t('overview.registry_invalid')}</p>
{/if}

<section aria-labelledby="modems-heading">
  <h2 id="modems-heading" class="mb-2 text-lg font-semibold">{t('overview.modems')}</h2>

  {#if modems.length === 0}
    <div class="card p-6 text-center">
      <p class="font-medium">{data === null && loading ? t('app.loading') : t('overview.no_modems')}</p>
      {#if data !== null}
        <p class="mt-1 text-sm text-slate-500">{t('overview.no_modems_hint')}</p>
      {/if}
    </div>
  {:else}
    <ul class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {#each modems as modem (modem.id)}
        <li class="card flex flex-col gap-3 p-4">
          <div class="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
            <div class="min-w-0">
              <p class="truncate text-base font-semibold">{modem.id}</p>
              <p class="truncate text-sm text-slate-500">{modem.driver}</p>
            </div>
            <StateBadge state={modem.state} />
          </div>

          <dl class="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
            <div class="col-span-2 flex items-center justify-between gap-3">
              <dt class="text-slate-500">{t('modem.signal')}</dt>
              <dd><SignalBars rssi={modem.rssi} /></dd>
            </div>
            <div class="col-span-2 flex items-center justify-between gap-3">
              <dt class="text-slate-500">{t('modem.provider')}</dt>
              <dd class="min-w-0 truncate">{orNone(modem.provider)}</dd>
            </div>
            <div class="col-span-2 flex items-center justify-between gap-3">
              <dt class="text-slate-500">{t('modem.number')}</dt>
              <dd class="min-w-0 truncate tabular-nums"><ModemNumber reported={modem.number} entered={modem.phone_number} /></dd>
            </div>
            <div class="col-span-2 flex items-center justify-between gap-3">
              <dt class="text-slate-500">{t('modem.port')}</dt>
              <dd class="min-w-0 truncate tabular-nums">{orNone(modem.usb_port)}</dd>
            </div>
            <div class="col-span-2 flex items-center justify-between gap-3">
              <dt class="text-slate-500">{t('modem.seen')}</dt>
              <dd class="min-w-0 truncate">{modem.observed_at ? ago(modem.observed_at) : t('modem.never_seen')}</dd>
            </div>
          </dl>

          <p class="text-sm text-slate-500">
            {modem.ring.length > 0 ? t('modem.ring', { phones: modem.ring.join(', ') }) : t('modem.ring_none')}
          </p>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<section class="mt-6" aria-labelledby="unassigned-heading">
  <div class="mb-2 flex flex-wrap items-baseline justify-between gap-2">
    <h2 id="unassigned-heading" class="text-lg font-semibold">{t('overview.unassigned')}</h2>
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

  <DeviceTable {devices} label={t('overview.unassigned')} empty={t('overview.no_unassigned')}>
    {#snippet actions(/** @type {any} */ device)}
      <a class="btn btn-primary px-3 text-sm" href="/modems?assign={encodeURIComponent(device.usb_port ?? device.data_tty)}">
        {t('overview.assign')}
      </a>
    {/snippet}
  </DeviceTable>
</section>

<StickyActions>
  <button type="button" class="btn btn-plain" onclick={startScan} disabled={scanning}>
    {scanning ? t('overview.scanning') : t('overview.scan')}
  </button>
</StickyActions>

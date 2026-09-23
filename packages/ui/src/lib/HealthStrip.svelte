<!-- Health strip above every page: an ok/degraded/unknown chip that expands to reasons, modems and pending work.
     Modems and counters (`summary`) need a session; reasons are the controller's own text. -->
<script>
  import { health } from './health.svelte.js';
  import { t } from '../i18n/index.js';
  import { time } from './format.js';
  import SignalBars from './SignalBars.svelte';
  import StateBadge from './StateBadge.svelte';

  /** How many modems fit beside the chip before the rest become a count. */
  const CHIPS = 3;

  let open = $state(false);

  const tone = $derived(
    health.status === 'ok'
      ? { dot: 'bg-emerald-500', text: t('health.ok') }
      : health.status === 'degraded'
        ? { dot: 'bg-amber-500', text: t('health.degraded') }
        : { dot: 'bg-slate-400', text: health.error === 'offline' ? t('health.unreachable') : t('health.unknown') },
  );
  const reasons = $derived(health.reasons);
  const data = $derived(health.data);
  /** Null without a session (or from an older controller): the strip then shows only the chip and reasons. */
  const summary = $derived(data?.summary ?? null);
  const modems = $derived(summary?.modems ?? []);

  /** Non-zero counters only; when all are zero `health.idle` is shown instead. */
  const work = $derived(
    [
      { key: 'sms_waiting', n: summary?.sms?.waiting ?? 0, bad: false },
      { key: 'sms_failed', n: summary?.sms?.failed ?? 0, bad: true },
      { key: 'notify_waiting', n: summary?.notifications?.waiting ?? 0, bad: false },
      { key: 'notify_failed', n: summary?.notifications?.failed ?? 0, bad: true },
      { key: 'ops_running', n: summary?.operations?.running ?? 0, bad: false },
      { key: 'ops_waiting', n: summary?.operations?.waiting ?? 0, bad: false },
    ].filter((line) => line.n > 0),
  );
</script>

<section class="border-b border-slate-200 bg-white" aria-label={t('health.title')}>
  <div class="mx-auto flex max-w-6xl items-center gap-2 px-4 md:py-1.5">
    <button
      type="button"
      class="btn btn-ghost -mx-2 min-w-0 flex-1 justify-start gap-2 px-2 text-left font-normal"
      aria-expanded={open}
      aria-controls="health-details"
      onclick={() => (open = !open)}
    >
      <span class="h-2.5 w-2.5 shrink-0 rounded-full {tone.dot}" aria-hidden="true"></span>
      <span class="font-medium">{tone.text}</span>
      {#if reasons.length > 0}
        <span class="hidden min-w-0 truncate text-sm text-slate-500 md:inline">{reasons[0]}</span>
        {#if reasons.length > 1}
          <span class="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900">+{reasons.length - 1}</span>
        {/if}
      {:else if modems.length > 0}
        <span class="hidden min-w-0 items-center gap-3 md:flex">
          {#each modems.slice(0, CHIPS) as modem (modem.id)}
            <span class="inline-flex min-w-0 items-center gap-1.5">
              <span class="max-w-32 truncate text-sm text-slate-500">{modem.id}</span>
              <StateBadge state={modem.state} />
            </span>
          {/each}
          {#if modems.length > CHIPS}
            <span class="text-sm text-slate-500">+{modems.length - CHIPS}</span>
          {/if}
        </span>
      {/if}
      <span class="ml-auto text-sm text-slate-500">{open ? t('health.hide') : t('health.details')}</span>
    </button>
  </div>

  {#if open}
    <div id="health-details" class="mx-auto max-w-6xl px-4 pb-3 text-sm">
      {#if reasons.length > 0}
        <ul class="mb-3 list-disc space-y-1 pl-5 text-slate-700">
          {#each reasons as reason (reason)}
            <li>{reason}</li>
          {/each}
        </ul>
      {/if}

      {#if summary !== null}
        <h3 class="mb-1 font-medium text-slate-500">{t('health.modems')}</h3>
        {#if modems.length === 0}
          <p class="mb-3 text-slate-500">{t('health.no_modems')}</p>
        {:else}
          <ul class="mb-3 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200">
            {#each modems as modem (modem.id)}
              <li>
                <!-- Each modem links to its page. -->
                <a class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 hover:bg-slate-50" href="/modems/{modem.id}">
                  <span class="min-w-0 flex-1 truncate font-medium">{modem.id}</span>
                  <StateBadge state={modem.state} />
                  <SignalBars rssi={modem.rssi} />
                  {#if modem.provider}
                    <span class="min-w-0 max-w-40 truncate text-slate-500">{modem.provider}</span>
                  {/if}
                </a>
              </li>
            {/each}
          </ul>
        {/if}

        <h3 class="mb-1 font-medium text-slate-500">{t('health.work')}</h3>
        {#if work.length === 0}
          <p class="mb-3 text-slate-500">{t('health.idle')}</p>
        {:else}
          <ul class="mb-3 flex flex-wrap gap-x-5 gap-y-1">
            {#each work as line (line.key)}
              <li class={line.bad ? 'font-medium text-rose-800' : 'text-slate-700'}>{t(`health.${line.key}`, { n: line.n })}</li>
            {/each}
          </ul>
        {/if}
      {/if}

      <div class="mt-3 flex items-center gap-3">
        <button type="button" class="btn btn-plain px-3 text-sm" onclick={() => health.refresh()} disabled={health.loading}>
          {health.loading ? t('health.checking') : t('health.refresh')}
        </button>
        {#if data?.checked_at}
          <span class="text-slate-500">{t('health.checked_at', { time: time(data.checked_at) })}</span>
        {/if}
      </div>
    </div>
  {/if}
</section>

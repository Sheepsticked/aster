<!-- Calls page: incoming and outgoing calls, newest first, with the controller-derived outcome (never re-derived here), and
     the talk time per SIM of this month and last month. Filters, substring search on caller/DID; delete per row or "Delete
     all" for the current filter. -->
<script>
  import { api } from '../api.js';
  import { t } from '../i18n/index.js';
  import Confirm from '../lib/Confirm.svelte';
  import Field from '../lib/Field.svelte';
  import Pager from '../lib/Pager.svelte';
  import ResponsiveTable from '../lib/ResponsiveTable.svelte';
  import Search from '../lib/Search.svelte';
  import Section from '../lib/Section.svelte';
  import StatusBadge from '../lib/StatusBadge.svelte';
  import { messageOf } from '../lib/errors.js';
  import { dateTime } from '../lib/format.js';
  import { live } from '../lib/live.svelte.js';
  import { perPage } from '../lib/perPage.svelte.js';
  import { toasts } from '../lib/toasts.svelte.js';

  /** The outcomes (calls/outcome.js) and the tone each one is shown with. */
  const TONE = Object.freeze(/** @type {Record<string, 'ok' | 'warn' | 'bad' | 'neutral'>} */ ({
    answered: 'ok', missed: 'warn', unanswered: 'neutral', failed: 'bad',
  }));
  /** The talk-time columns: which direction and which month. */
  const TALK = Object.freeze(/** @type {const} */ ([
    { key: 'talk_out_month', direction: 'out', month: 'month' }, { key: 'talk_out_last', direction: 'out', month: 'last' },
    { key: 'talk_in_month', direction: 'in', month: 'month' }, { key: 'talk_in_last', direction: 'in', month: 'last' },
  ]));

  /** @type {any} */
  let data = $state(null);
  /** @type {any[]} */
  let modems = $state([]);
  /** @type {string | null} */
  let error = $state(null);
  let loading = $state(false);
  let page = $state(1);
  let filters = $state({ modem: '', direction: '', outcome: '', q: '' });
  /** GET /api/calls/summary of this month and last month (the browser's months, as every time on the page). */
  let talk = $state(/** @type {{ month: any[], last: any[] } | null} */ (null));
  /** @type {string | null} */
  let talkError = $state(null);

  /** Pending deletes; "Delete all" is bounded by the newest call so one ending meanwhile is kept. */
  let deleting = $state(/** @type {any | null} */ (null));
  let deleteOpen = $state(false);
  let clearing = $state(/** @type {{ total: number, before: number } | null} */ (null));
  let clearOpen = $state(false);
  let busy = $state(false);

  async function load() {
    loading = true;
    try {
      data = await api.calls({ page, per_page: perPage.value, ...filters });
      error = null;
    } catch (err) {
      error = messageOf(err);
    } finally {
      loading = false;
    }
  }

  async function loadTalk() {
    const now = new Date();
    const month = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const last = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
    try {
      const [thisMonth, lastMonth] = await Promise.all([api.callsSummary({ since: month }), api.callsSummary({ since: last, until: month })]);
      talk = { month: thisMonth?.items ?? [], last: lastMonth?.items ?? [] };
      talkError = null;
    } catch (err) {
      talkError = messageOf(err);
    }
  }

  $effect(() => {
    void live.resume;
    void live.finished;
    void loadTalk();
  });

  $effect(() => {
    void live.resume;
    void live.finished;
    void page;
    void perPage.value;
    void filters.modem;
    void filters.direction;
    void filters.outcome;
    void filters.q;
    void load();
  });

  $effect(() => {
    void (async () => {
      try {
        modems = (await api.modems())?.modems ?? [];
      } catch {
        modems = [];
      }
    })();
  });

  function refilter(/** @type {() => void} */ change) {
    change();
    page = 1;
  }

  async function deleteConfirmed() {
    if (deleting === null) return;
    busy = true;
    try {
      await api.deleteCall(deleting.id);
      toasts.push({ kind: 'success', text: t('calls.deleted') });
      deleteOpen = false;
      await Promise.all([load(), loadTalk()]);
    } catch (err) {
      deleteOpen = false;
      toasts.push({ kind: 'error', text: messageOf(err) });
    } finally {
      busy = false;
    }
  }

  async function askClear() {
    busy = true;
    try {
      const newest = await api.calls({ ...filters, per_page: 1 });
      if (!newest?.total) {
        toasts.push({ text: t('calls.purge_none') });
        await load();
        return;
      }
      clearing = { total: newest.total, before: newest.items[0].ended_at };
      clearOpen = true;
    } catch (err) {
      toasts.push({ kind: 'error', text: messageOf(err) });
    } finally {
      busy = false;
    }
  }

  async function clearConfirmed() {
    if (clearing === null) return;
    busy = true;
    try {
      const deleted = Number((await api.purgeCalls({ ...filters, before: clearing.before })).data?.deleted ?? 0);
      toasts.push(deleted > 0 ? { kind: 'success', text: t('calls.purged', { n: deleted }) } : { text: t('calls.purge_none') });
      clearOpen = false;
      page = 1;
      await Promise.all([load(), loadTalk()]);
    } catch (err) {
      clearOpen = false;
      toasts.push({ kind: 'error', text: messageOf(err) });
    } finally {
      busy = false;
    }
  }

  /** Call duration in minutes and seconds. @param {unknown} seconds */
  function duration(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return t('common.none');
    const minutes = Math.floor(seconds / 60);
    return minutes === 0 ? `${seconds} ${t('time.s')}` : `${minutes} ${t('time.m')} ${seconds % 60} ${t('time.s')}`;
  }

  /** One summary entry as "34 m 12 s · 5 calls", or none when nothing was answered. @param {any} entry */
  const talkValue = (entry) => (entry?.answered > 0 ? t('calls.talk_value', { time: duration(entry.answered_sec), n: entry.answered }) : t('common.none'));
  /** One row per modem of the registry or of the summary, with its entry for each talk-time column. */
  const talkRows = $derived.by(() => {
    if (talk === null) return [];
    const { month, last } = talk;
    const ids = new Set([...modems.map((modem) => modem.id), ...month.map((entry) => entry.modem_id), ...last.map((entry) => entry.modem_id)]);
    return [...ids].sort().map((id) => ({
      id,
      ...Object.fromEntries(TALK.map(({ key, direction, month: which }) => [key,
        (which === 'month' ? month : last).find((entry) => entry.modem_id === id && entry.direction === direction)])),
    }));
  });
  const talkColumns = $derived([
    { key: 'modem', label: t('nav.modem'), primary: true },
    ...TALK.map(({ key }) => ({ key, label: t(`calls.${key}`) })),
  ]);

  const items = $derived(data?.items ?? []);
  const columns = $derived([
    { key: 'caller', label: t('calls.caller'), primary: true },
    { key: 'outcome', label: t('calls.outcome') },
    { key: 'did', label: t('calls.did') },
    { key: 'duration', label: t('calls.duration') },
    { key: 'modem', label: t('nav.modem') },
    { key: 'at', label: t('calls.at') },
  ]);
</script>

<h1 class="mb-4 hidden text-2xl font-semibold tracking-tight md:block">{t('calls.title')}</h1>

{#if error !== null}
  <p class="card mb-4 border-rose-200 bg-rose-50 p-4 text-rose-900" role="alert">{error}</p>
{/if}

<Section id="calls-talk" title={t('calls.talk')} subtitle={t('calls.talk_hint')}>
  {#if talkError !== null}
    <p class="text-sm text-rose-800" role="alert">{talkError}</p>
  {/if}
  <ResponsiveTable
    columns={talkColumns}
    rows={talkRows}
    rowKey={(row) => row.id}
    label={t('calls.talk')}
    empty={talk === null ? t('app.loading') : t('calls.none')}
  >
    {#snippet cell(/** @type {any} */ row, /** @type {{ key: string }} */ column)}
      {#if column.key === 'modem'}
        {row.id}
      {:else}
        <span class="tabular-nums">{talkValue(row[column.key])}</span>
      {/if}
    {/snippet}
  </ResponsiveTable>
</Section>

<Section id="calls-filters" class="mt-3" title={t('list.filters')} subtitle={t('list.filters_hint')}>
  <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
    <Field id="calls-modem" label={t('nav.modem')}>
      {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
        <select id="calls-modem" class="input" aria-describedby={field.describedBy} value={filters.modem} onchange={(event) => refilter(() => (filters.modem = event.currentTarget.value))}>
          <option value="">{t('list.any')}</option>
          {#each modems as modem (modem.id)}
            <option value={modem.id}>{modem.id}</option>
          {/each}
        </select>
      {/snippet}
    </Field>

    <Field id="calls-direction" label={t('calls.direction')}>
      {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
        <select id="calls-direction" class="input" aria-describedby={field.describedBy} value={filters.direction} onchange={(event) => refilter(() => (filters.direction = event.currentTarget.value))}>
          <option value="">{t('list.any')}</option>
          <option value="in">{t('calls.direction_in')}</option>
          <option value="out">{t('calls.direction_out')}</option>
        </select>
      {/snippet}
    </Field>

    <Field id="calls-outcome" label={t('calls.outcome')}>
      {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
        <select id="calls-outcome" class="input" aria-describedby={field.describedBy} value={filters.outcome} onchange={(event) => refilter(() => (filters.outcome = event.currentTarget.value))}>
          <option value="">{t('list.any')}</option>
          {#each Object.keys(TONE) as outcome (outcome)}
            <option value={outcome}>{t(`calls.outcome_${outcome}`)}</option>
          {/each}
        </select>
      {/snippet}
    </Field>

    <Field id="calls-q" label={t('list.search')} hint={t('calls.search_hint')}>
      {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
        <Search id="calls-q" value={filters.q} describedBy={field.describedBy} onsearch={(value) => refilter(() => (filters.q = value))} />
      {/snippet}
    </Field>
  </div>
</Section>

<section id="calls-list" class="list-panel mt-3" aria-labelledby="calls-heading">
  <h2 id="calls-heading" class="sr-only">{t('calls.title')}</h2>
  <ResponsiveTable
    {columns}
    rows={items}
    rowKey={(call) => call.id}
    label={t('calls.title')}
    empty={loading && items.length === 0 ? t('app.loading') : t('calls.none')}
  >
    {#snippet cell(/** @type {any} */ call, /** @type {{ key: string }} */ column)}
      {#if column.key === 'caller'}
        {@const direction = t(call.direction === 'out' ? 'calls.direction_out' : 'calls.direction_in')}
        <!-- The direction as an arrow, as phones show it, so the table needs no column of its own. -->
        <span class="inline-flex items-center gap-1.5">
          <svg class="h-4 w-4 shrink-0 text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
            stroke-linejoin="round" role="img" aria-label={direction}>
            <title>{direction}</title>
            {#if call.direction === 'out'}
              <path d="M7 17 17 7M9 7h8v8" />
            {:else}
              <path d="M17 7 7 17M15 17H7V9" />
            {/if}
          </svg>
          <span class="tabular-nums">{call.caller || t('calls.unknown_caller')}</span>
        </span>
      {:else if column.key === 'outcome'}
        <StatusBadge
          text={t(`calls.outcome_${call.outcome}`)}
          tone={TONE[call.outcome] ?? 'neutral'}
          title={[call.dialstatus, call.disposition].filter(Boolean).join(' · ') || undefined}
        />
      {:else if column.key === 'did'}
        <span class="tabular-nums">{call.did || t('common.none')}</span>
      {:else if column.key === 'duration'}
        <span class="tabular-nums">{duration(call.answered_sec)}</span>
      {:else if column.key === 'modem'}
        {call.modem_id ?? t('common.none')}
      {:else if column.key === 'at'}
        <span class="whitespace-nowrap tabular-nums">{dateTime(call.ended_at)}</span>
      {/if}
    {/snippet}

    {#snippet actions(/** @type {any} */ call)}
      <button type="button" class="btn btn-danger px-3 text-sm" disabled={busy} onclick={() => { deleting = call; deleteOpen = true; }}>{t('common.delete')}</button>
    {/snippet}
  </ResponsiveTable>

  {#if data !== null}
    <Pager page={data.page} pages={data.pages} total={data.total} per_page={data.per_page} busy={loading} onpage={(next) => (page = next)} />
  {/if}
  {#if data?.total > 0}
    <div class="mt-3 flex justify-end">
      <button type="button" class="btn btn-danger px-3 text-sm" disabled={busy} onclick={askClear}>{t('common.delete_all')}</button>
    </div>
  {/if}
</section>

<Confirm
  bind:open={deleteOpen}
  title={deleting?.caller ? t('calls.delete_title', { caller: deleting.caller }) : t('calls.delete_title_unknown')}
  text={t('calls.delete_text')}
  confirmLabel={t('common.delete')}
  danger
  {busy}
  onconfirm={deleteConfirmed}
/>

<Confirm
  bind:open={clearOpen}
  title={t('calls.clear_title', { n: clearing?.total ?? 0 })}
  text={t('calls.clear_text')}
  confirmLabel={t('common.delete_all')}
  danger
  {busy}
  onconfirm={clearConfirmed}
/>

<!-- Activity page: operations and notification deliveries, with full details (GET /api/operations/:id) in a dialog.
     Refetches when an operation finishes, so no stale "running" rows. -->
<script>
  import { api } from '../api.js';
  import { t } from '../i18n/index.js';
  import Dialog from '../lib/Dialog.svelte';
  import Field from '../lib/Field.svelte';
  import Pager from '../lib/Pager.svelte';
  import ResponsiveTable from '../lib/ResponsiveTable.svelte';
  import Search from '../lib/Search.svelte';
  import Section from '../lib/Section.svelte';
  import StatusBadge from '../lib/StatusBadge.svelte';
  import Tabs from '../lib/Tabs.svelte';
  import { messageOf } from '../lib/errors.js';
  import { dateTime } from '../lib/format.js';
  import { live } from '../lib/live.svelte.js';
  import { perPage } from '../lib/perPage.svelte.js';

  /** The operation statuses and the notification statuses, with the tone each is shown with. */
  const OP_TONE = Object.freeze(/** @type {Record<string, 'ok' | 'info' | 'warn' | 'bad' | 'neutral'>} */ ({
    queued: 'neutral', running: 'info', interrupted: 'warn', done: 'ok', failed: 'bad', uncertain: 'warn',
  }));
  const NOTIFY_TONE = Object.freeze(/** @type {Record<string, 'ok' | 'info' | 'warn' | 'bad' | 'neutral'>} */ ({
    pending: 'neutral', sending: 'info', sent: 'ok', retry: 'warn', failed: 'bad',
  }));
  const ACTORS = Object.freeze(['admin', 'cli', 'system']);
  const KINDS = Object.freeze(['sms', 'call', 'alert', 'test']);

  let tab = $state('operations');
  /** @type {any} */
  let data = $state(null);
  /** @type {any[]} */
  let modems = $state([]);
  /** @type {string | null} */
  let error = $state(null);
  let loading = $state(false);
  let page = $state(1);
  let ops = $state({ modem: '', status: '', actor: '', q: '' });
  let notes = $state({ status: '', kind: '', q: '' });

  /** The operation shown in full, once its own request has answered. */
  let detail = $state(/** @type {any} */ (null));
  let detailOpen = $state(false);

  async function load() {
    loading = true;
    try {
      data = tab === 'operations'
        ? await api.operations({ page, per_page: perPage.value, modem: ops.modem, status: ops.status, actor: ops.actor, q: ops.q })
        : await api.notifications({ page, per_page: perPage.value, status: notes.status, kind: notes.kind, q: notes.q });
      error = null;
    } catch (err) {
      error = messageOf(err);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void live.resume;
    void live.finished;
    void tab;
    void page;
    void perPage.value;
    void ops.modem;
    void ops.status;
    void ops.actor;
    void ops.q;
    void notes.status;
    void notes.kind;
    void notes.q;
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

  /** @param {any} row */
  async function openDetail(row) {
    detail = { ...row, params: null, result: null, loading: true };
    detailOpen = true;
    try {
      const answer = await api.operation(row.id);
      detail = { ...row, ...answer.operation, loading: false };
    } catch (err) {
      detail = { ...row, loading: false, error: messageOf(err) };
    }
  }

  const items = $derived(data?.items ?? []);
  const tabs = $derived([
    { id: 'operations', label: t('activity.operations') },
    { id: 'notifications', label: t('activity.notifications') },
  ]);

  const opColumns = $derived([
    { key: 'kind', label: t('activity.kind'), primary: true },
    { key: 'status', label: t('modems.state') },
    { key: 'modem', label: t('nav.modem') },
    { key: 'actor', label: t('activity.actor') },
    { key: 'created', label: t('activity.created') },
    { key: 'finished', label: t('activity.finished') },
  ]);
  const noteColumns = $derived([
    { key: 'chat', label: t('activity.chat'), primary: true },
    { key: 'status', label: t('modems.state') },
    { key: 'kind', label: t('activity.source') },
    { key: 'text', label: t('messages.text'), class: 'max-w-md', block: true },
    { key: 'attempts', label: t('activity.attempts') },
    { key: 'created', label: t('activity.created') },
  ]);
</script>

<h1 class="mb-4 hidden text-2xl font-semibold tracking-tight md:block">{t('activity.title')}</h1>

{#if error !== null}
  <p class="card mb-4 border-rose-200 bg-rose-50 p-4 text-rose-900" role="alert">{error}</p>
{/if}

<Tabs {tabs} current={tab} panel="activity-list" onselect={(id) => refilter(() => (tab = id))} />

<Section id="activity-filters" class="mt-3" title={t('list.filters')} subtitle={t('list.filters_hint')}>
  {#if tab === 'operations'}
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-4">
      <Field id="ops-modem" label={t('nav.modem')}>
        {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
          <select id="ops-modem" class="input" aria-describedby={field.describedBy} value={ops.modem} onchange={(event) => refilter(() => (ops.modem = event.currentTarget.value))}>
            <option value="">{t('list.any')}</option>
            {#each modems as modem (modem.id)}
              <option value={modem.id}>{modem.id}</option>
            {/each}
          </select>
        {/snippet}
      </Field>
      <Field id="ops-status" label={t('modems.state')}>
        {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
          <select id="ops-status" class="input" aria-describedby={field.describedBy} value={ops.status} onchange={(event) => refilter(() => (ops.status = event.currentTarget.value))}>
            <option value="">{t('list.any')}</option>
            {#each Object.keys(OP_TONE) as status (status)}
              <option value={status}>{t(`activity.status_${status}`)}</option>
            {/each}
          </select>
        {/snippet}
      </Field>
      <Field id="ops-actor" label={t('activity.actor')}>
        {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
          <select id="ops-actor" class="input" aria-describedby={field.describedBy} value={ops.actor} onchange={(event) => refilter(() => (ops.actor = event.currentTarget.value))}>
            <option value="">{t('list.any')}</option>
            {#each ACTORS as actor (actor)}
              <option value={actor}>{t(`activity.actor_${actor}`)}</option>
            {/each}
          </select>
        {/snippet}
      </Field>
      <Field id="ops-q" label={t('list.search')} hint={t('activity.search_hint')}>
        {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
          <Search id="ops-q" value={ops.q} describedBy={field.describedBy} onsearch={(value) => refilter(() => (ops.q = value))} />
        {/snippet}
      </Field>
    </div>
  {:else}
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Field id="notes-status" label={t('modems.state')}>
        {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
          <select id="notes-status" class="input" aria-describedby={field.describedBy} value={notes.status} onchange={(event) => refilter(() => (notes.status = event.currentTarget.value))}>
            <option value="">{t('list.any')}</option>
            {#each Object.keys(NOTIFY_TONE) as status (status)}
              <option value={status}>{t(`activity.notify_${status}`)}</option>
            {/each}
          </select>
        {/snippet}
      </Field>
      <Field id="notes-kind" label={t('activity.source')}>
        {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
          <select id="notes-kind" class="input" aria-describedby={field.describedBy} value={notes.kind} onchange={(event) => refilter(() => (notes.kind = event.currentTarget.value))}>
            <option value="">{t('list.any')}</option>
            {#each KINDS as kind (kind)}
              <option value={kind}>{t(`activity.source_${kind}`)}</option>
            {/each}
          </select>
        {/snippet}
      </Field>
      <Field id="notes-q" label={t('list.search')} hint={t('activity.notify_search_hint')}>
        {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
          <Search id="notes-q" value={notes.q} describedBy={field.describedBy} onsearch={(value) => refilter(() => (notes.q = value))} />
        {/snippet}
      </Field>
    </div>
  {/if}
</Section>

<!-- The panel is a `div`, not a `section`: a sectioning element cannot take an interactive ARIA role. -->
<div id="activity-list" role="tabpanel" aria-labelledby="tab-{tab}" class="list-panel mt-3">
  <h2 class="sr-only">{tab === 'operations' ? t('activity.operations') : t('activity.notifications')}</h2>

  {#if tab === 'operations'}
    <ResponsiveTable
      tableFrom="56rem"
      columns={opColumns}
      rows={items}
      rowKey={(row) => row.id}
      label={t('activity.operations')}
      empty={loading && items.length === 0 ? t('app.loading') : t('activity.none')}
    >
      {#snippet cell(/** @type {any} */ row, /** @type {{ key: string }} */ column)}
        {#if column.key === 'kind'}
          <span>{t(`op.${row.kind}`)}</span>
          <span class="ml-1 text-xs text-slate-400 tabular-nums">#{row.id}</span>
        {:else if column.key === 'status'}
          <StatusBadge text={t(`activity.status_${row.status}`)} tone={OP_TONE[row.status] ?? 'neutral'} title={row.error ?? undefined} />
        {:else if column.key === 'modem'}
          {row.modem_id ?? t('common.none')}
        {:else if column.key === 'actor'}
          {t(`activity.actor_${row.actor}`)}
        {:else if column.key === 'created'}
          <span class="whitespace-nowrap tabular-nums">{dateTime(row.created_at)}</span>
        {:else if column.key === 'finished'}
          <span class="whitespace-nowrap tabular-nums">{row.finished_at ? dateTime(row.finished_at) : t('common.none')}</span>
        {/if}
      {/snippet}

      {#snippet actions(/** @type {any} */ row)}
        <button type="button" class="btn btn-plain px-3 text-sm" onclick={() => openDetail(row)}>{t('activity.details')}</button>
      {/snippet}
    </ResponsiveTable>
  {:else}
    <ResponsiveTable
      columns={noteColumns}
      rows={items}
      rowKey={(row) => row.id}
      label={t('activity.notifications')}
      empty={loading && items.length === 0 ? t('app.loading') : t('activity.no_notifications')}
    >
      {#snippet cell(/** @type {any} */ row, /** @type {{ key: string }} */ column)}
        {#if column.key === 'chat'}
          <span class="tabular-nums">{row.chat_id}</span>
          {#if row.part_count > 1}<span class="ml-1 text-xs whitespace-nowrap text-slate-500">{t('activity.part', { n: row.part_no, of: row.part_count })}</span>{/if}
        {:else if column.key === 'status'}
          <StatusBadge text={t(`activity.notify_${row.status}`)} tone={NOTIFY_TONE[row.status] ?? 'neutral'} title={row.error ?? undefined} />
        {:else if column.key === 'kind'}
          {t(`activity.source_${row.source_kind}`)}
        {:else if column.key === 'text'}
          <span class="line-clamp-3 break-words">{row.text}</span>
        {:else if column.key === 'attempts'}
          <span class="tabular-nums">{row.attempts}</span>
        {:else if column.key === 'created'}
          <span class="whitespace-nowrap tabular-nums">{dateTime(row.created_at)}</span>
        {/if}
      {/snippet}
    </ResponsiveTable>
  {/if}

  {#if data !== null}
    <Pager page={data.page} pages={data.pages} total={data.total} per_page={data.per_page} busy={loading} onpage={(next) => (page = next)} />
  {/if}
</div>

<Dialog bind:open={detailOpen} title={detail === null ? t('activity.details') : t('activity.detail_title', { kind: t(`op.${detail.kind}`), id: detail.id })}>
  {#if detail !== null}
    <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      <dt class="text-slate-500">{t('modems.state')}</dt>
      <dd><StatusBadge text={t(`activity.status_${detail.status}`)} tone={OP_TONE[detail.status] ?? 'neutral'} /></dd>
      <dt class="text-slate-500">{t('activity.actor')}</dt>
      <dd>{t(`activity.actor_${detail.actor}`)}</dd>
      <dt class="text-slate-500">{t('activity.created')}</dt>
      <dd class="tabular-nums">{dateTime(detail.created_at)}</dd>
      <dt class="text-slate-500">{t('activity.finished')}</dt>
      <dd class="tabular-nums">{detail.finished_at ? dateTime(detail.finished_at) : t('common.none')}</dd>
    </dl>

    {#if detail.error}
      <p class="card mt-3 border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">{detail.error}</p>
    {/if}

    {#if detail.loading}
      <p class="mt-3 text-sm text-slate-500">{t('app.loading')}</p>
    {:else}
      {#if detail.params}
        <h3 class="mt-3 text-sm font-medium">{t('activity.params')}</h3>
        <pre class="mt-1 overflow-x-auto rounded-lg bg-slate-50 p-2 font-mono text-xs">{JSON.stringify(detail.params, null, 2)}</pre>
      {/if}
      {#if detail.result}
        <h3 class="mt-3 text-sm font-medium">{t('activity.result')}</h3>
        <pre class="mt-1 overflow-x-auto rounded-lg bg-slate-50 p-2 font-mono text-xs">{JSON.stringify(detail.result, null, 2)}</pre>
      {/if}
    {/if}
  {/if}
</Dialog>

<!-- Messages page: inbox and outbox as one list (tabs = `direction` filter), compose (POST /api/sms, result via events),
     retry (409 `confirm-required` asks for confirmation), and per-row, filtered and failed-only deletes. -->
<script>
  import { api, ApiError } from '../api.js';
  import { t } from '../i18n/index.js';
  import Confirm from '../lib/Confirm.svelte';
  import Dialog from '../lib/Dialog.svelte';
  import Field from '../lib/Field.svelte';
  import Pager from '../lib/Pager.svelte';
  import ResponsiveTable from '../lib/ResponsiveTable.svelte';
  import Search from '../lib/Search.svelte';
  import Section from '../lib/Section.svelte';
  import StatusBadge from '../lib/StatusBadge.svelte';
  import StickyActions from '../lib/StickyActions.svelte';
  import Tabs from '../lib/Tabs.svelte';
  import { messageOf } from '../lib/errors.js';
  import { dateTime } from '../lib/format.js';
  import { health } from '../lib/health.svelte.js';
  import { live } from '../lib/live.svelte.js';
  import { perPage } from '../lib/perPage.svelte.js';
  import { segments } from '../lib/sms.js';
  import { toasts } from '../lib/toasts.svelte.js';

  /** Outbox status tones. `undelivered_expired` means no report arrived in time, not a failure report, so it is a warning. */
  const TONE = Object.freeze(/** @type {Record<string, 'ok' | 'info' | 'warn' | 'bad' | 'neutral'>} */ ({
    queued: 'neutral', submitting: 'info', submitted: 'info', accepted: 'info', delivered: 'ok',
    rejected: 'bad', failed: 'bad', undelivered: 'bad', undelivered_expired: 'warn', uncertain: 'warn',
  }));
  /** What can be retried at all (sms/outbox.js): freely, or after the confirmation this page asks for. */
  const RETRY_FREELY = Object.freeze(['failed']);
  const RETRY_WITH_CONFIRM = Object.freeze(['uncertain', 'rejected', 'undelivered', 'undelivered_expired']);
  /** The sent SMS that can be deleted (sms/outbox.js REMOVABLE): every status a sending ended in. */
  const REMOVABLE = Object.freeze(['delivered', ...RETRY_FREELY, ...RETRY_WITH_CONFIRM]);
  const NUMBER = /^\+?[0-9]{2,20}$/;

  /** @type {any} */
  let data = $state(null);
  /** @type {any[]} */
  let modems = $state([]);
  /** @type {string | null} */
  let error = $state(null);
  let loading = $state(false);

  let direction = $state('all');
  let filters = $state({ modem: '', status: '', q: '' });
  let page = $state(1);

  let composing = $state(false);
  let sending = $state(false);
  /** @type {string | null} */
  let composeProblem = $state(null);
  let compose = $state({ modem_id: '', number: '', text: '' });

  /** The row a retry was asked for, and whether the controller wants it confirmed first. */
  let retrying = $state(/** @type {any | null} */ (null));
  let confirmOpen = $state(false);
  let retryBusy = $state(false);

  /** The row a delete was asked for; the purge and "Delete all" have their own dialogs. */
  let deleting = $state(/** @type {any | null} */ (null));
  let deleteOpen = $state(false);
  let purgeOpen = $state(false);
  let deleteBusy = $state(false);
  /** "Delete all" is bounded by the newest row so an SMS arriving meanwhile is kept. */
  let clearing = $state(/** @type {{ total: number, before: number } | null} */ (null));
  let clearOpen = $state(false);

  const estimate = $derived(segments(compose.text));

  const listFilters = () => ({ direction: direction === 'all' ? '' : direction, modem: filters.modem, status: filters.status, q: filters.q });

  async function load() {
    loading = true;
    try {
      data = await api.messages({ page, per_page: perPage.value, ...listFilters() });
      error = null;
    } catch (err) {
      error = messageOf(err);
    } finally {
      loading = false;
    }
  }

  async function loadModems() {
    try {
      modems = (await api.modems())?.modems ?? [];
    } catch {
      modems = []; // the page error explains the empty modem choices
    }
  }

  $effect(() => {
    void live.resume;
    void live.finished;
    void page;
    void perPage.value;
    void direction;
    void filters.modem;
    void filters.status;
    void filters.q;
    void load();
  });

  $effect(() => {
    void loadModems();
  });

  /** A filter change resets to the first page. */
  function refilter(/** @type {() => void} */ change) {
    change();
    page = 1;
  }

  async function openCompose() {
    composeProblem = null;
    // Wait for the modem list so the compose box has modems to offer.
    if (modems.length === 0) await loadModems();
    compose = { modem_id: modems.find((modem) => modem.state === 'ready')?.id ?? modems[0]?.id ?? '', number: '', text: '' };
    composing = true;
  }

  async function send(/** @type {SubmitEvent} */ event) {
    event.preventDefault();
    if (sending) return;
    composeProblem = null;
    if (compose.modem_id === '') {
      composeProblem = t('messages.no_modem');
      return;
    }
    if (!NUMBER.test(compose.number.trim())) {
      composeProblem = t('messages.number_invalid');
      return;
    }
    if (compose.text.trim() === '') {
      composeProblem = t('messages.text_empty');
      return;
    }
    sending = true;
    try {
      await api.sendSms({ modem_id: compose.modem_id, number: compose.number.trim(), text: compose.text });
      toasts.push({ text: t('messages.queued', { number: compose.number.trim() }) });
      composing = false;
      await load();
    } catch (err) {
      composeProblem = messageOf(err);
    } finally {
      sending = false;
    }
  }

  /**
   * First try without confirmation; the controller's 409 `confirm-required` opens the dialog.
   * @param {any} row
   */
  async function retry(row) {
    retrying = row;
    retryBusy = true;
    try {
      await api.retrySms(row.id, false);
      toasts.push({ text: t('messages.retry_queued', { id: row.id }) });
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.body?.code === 'confirm-required') {
        confirmOpen = true;
      } else {
        toasts.push({ kind: 'error', text: messageOf(err) });
      }
    } finally {
      retryBusy = false;
    }
  }

  async function retryConfirmed() {
    if (retrying === null) return;
    retryBusy = true;
    try {
      await api.retrySms(retrying.id, true);
      toasts.push({ text: t('messages.retry_queued', { id: retrying.id }) });
      confirmOpen = false;
      await load();
    } catch (err) {
      confirmOpen = false;
      toasts.push({ kind: 'error', text: messageOf(err) });
    } finally {
      retryBusy = false;
    }
  }

  /** @param {any} row */
  function askDelete(row) {
    deleting = row;
    deleteOpen = true;
  }

  async function deleteConfirmed() {
    if (deleting === null) return;
    deleteBusy = true;
    try {
      if (deleting.direction === 'in') {
        await api.deleteReceivedSms(deleting.id);
        toasts.push({ kind: 'success', text: t('messages.deleted_in') });
      } else {
        await api.deleteSms(deleting.id);
        toasts.push({ kind: 'success', text: t('messages.deleted', { number: deleting.number }) });
      }
      deleteOpen = false;
      void health.refresh(); // its "SMS not sent" count may have been this one
      await load();
    } catch (err) {
      deleteOpen = false;
      toasts.push({ kind: 'error', text: messageOf(err) });
    } finally {
      deleteBusy = false;
    }
  }

  async function purgeConfirmed() {
    deleteBusy = true;
    try {
      const deleted = Number((await api.purgeSms(filters.modem)).data?.deleted ?? 0);
      toasts.push(deleted > 0 ? { kind: 'success', text: t('messages.purged', { n: deleted }) } : { text: t('messages.purge_none') });
      purgeOpen = false;
      void health.refresh();
      await load();
    } catch (err) {
      purgeOpen = false;
      toasts.push({ kind: 'error', text: messageOf(err) });
    } finally {
      deleteBusy = false;
    }
  }

  async function askClear() {
    deleteBusy = true;
    try {
      const newest = await api.messages({ ...listFilters(), per_page: 1 });
      if (!newest?.total) {
        toasts.push({ text: t('messages.purge_none') });
        await load();
        return;
      }
      clearing = { total: newest.total, before: newest.items[0].at };
      clearOpen = true;
    } catch (err) {
      toasts.push({ kind: 'error', text: messageOf(err) });
    } finally {
      deleteBusy = false;
    }
  }

  async function clearConfirmed() {
    if (clearing === null) return;
    deleteBusy = true;
    try {
      const { deleted = 0, kept = 0 } = (await api.purgeMessages({ ...listFilters(), before: clearing.before })).data ?? {};
      toasts.push(deleted === 0 && kept === 0 ? { text: t('messages.purge_none') }
        : { kind: 'success', text: t(kept > 0 ? 'messages.cleared_kept' : 'messages.purged', { n: deleted, kept }) });
      clearOpen = false;
      void health.refresh();
      page = 1;
      await load();
    } catch (err) {
      clearOpen = false;
      toasts.push({ kind: 'error', text: messageOf(err) });
    } finally {
      deleteBusy = false;
    }
  }

  /** @param {any} row */
  const removable = (row) => row.direction === 'in' || REMOVABLE.includes(row.status);

  /** @param {any} row */
  const retryable = (row) => row.direction === 'out' && (RETRY_FREELY.includes(row.status) || RETRY_WITH_CONFIRM.includes(row.status));

  const items = $derived(data?.items ?? []);
  const tabs = $derived([
    { id: 'all', label: t('messages.all') },
    { id: 'in', label: t('messages.inbox') },
    { id: 'out', label: t('messages.outbox') },
  ]);
  const columns = $derived([
    // Direction and modem sit under the number to leave room for the message text.
    { key: 'number', label: t('messages.number'), primary: true },
    { key: 'text', label: t('messages.text'), block: true },
    { key: 'status', label: t('modems.state') },
    { key: 'at', label: t('messages.at') },
  ]);
</script>

<h1 class="mb-4 hidden text-2xl font-semibold tracking-tight md:block">{t('messages.title')}</h1>

{#if error !== null}
  <p class="card mb-4 border-rose-200 bg-rose-50 p-4 text-rose-900" role="alert">{error}</p>
{/if}

<Tabs {tabs} current={direction} panel="messages-list" onselect={(id) => refilter(() => (direction = id))} />

<Section id="messages-filters" class="mt-3" title={t('list.filters')} subtitle={t('list.filters_hint')}>
  <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
    <Field id="messages-modem" label={t('nav.modem')}>
      {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
        <select id="messages-modem" class="input" aria-describedby={field.describedBy} value={filters.modem} onchange={(event) => refilter(() => (filters.modem = event.currentTarget.value))}>
          <option value="">{t('list.any')}</option>
          {#each modems as modem (modem.id)}
            <option value={modem.id}>{modem.id}</option>
          {/each}
        </select>
      {/snippet}
    </Field>

    <Field id="messages-status" label={t('messages.status')}>
      {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
        <select id="messages-status" class="input" aria-describedby={field.describedBy} value={filters.status} onchange={(event) => refilter(() => (filters.status = event.currentTarget.value))}>
          <option value="">{t('list.any')}</option>
          {#each Object.keys(TONE) as status (status)}
            <option value={status}>{t(`sms.status_${status}`)}</option>
          {/each}
        </select>
      {/snippet}
    </Field>

    <Field id="messages-q" label={t('list.search')} hint={t('messages.search_hint')}>
      {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
        <Search id="messages-q" value={filters.q} describedBy={field.describedBy} onsearch={(value) => refilter(() => (filters.q = value))} />
      {/snippet}
    </Field>
  </div>
</Section>

<!-- The panel is a `div`, not a `section`: a sectioning element cannot take an interactive ARIA role. -->
<div id="messages-list" role="tabpanel" aria-labelledby="tab-{direction}" class="list-panel mt-3">
  <h2 class="sr-only">{t('messages.title')}</h2>
  <ResponsiveTable
    tableFrom="56rem"
    {columns}
    rows={items}
    rowKey={(row) => `${row.direction}-${row.id}`}
    label={t('messages.title')}
    empty={loading && items.length === 0 ? t('app.loading') : t('messages.none')}
  >
    {#snippet cell(/** @type {any} */ row, /** @type {{ key: string }} */ column)}
      {#if column.key === 'number'}
        <span class="block min-w-[16ch] wrap-anywhere tabular-nums">{row.number ?? t('common.none')}</span>
        <span class="mt-1 flex items-center gap-1.5 text-xs font-normal text-slate-500">
          <StatusBadge text={row.direction === 'in' ? t('messages.in') : t('messages.out')} tone={row.direction === 'in' ? 'info' : 'neutral'} class="px-2 py-0.5 text-xs" />
          <span title={t('nav.modem')}>{row.modem_id ?? t('common.none')}</span>
        </span>
      {:else if column.key === 'text'}
        <span class="block min-w-48 whitespace-pre-line wrap-anywhere">{row.text}</span>
      {:else if column.key === 'status'}
        {#if row.direction === 'out'}
          <StatusBadge text={t(`sms.status_${row.status}`)} tone={TONE[row.status] ?? 'neutral'} title={row.last_error ?? undefined} />
          {#if row.attempt_no > 1}<span class="ml-1 text-xs whitespace-nowrap text-slate-500 tabular-nums">{t('messages.attempt', { n: row.attempt_no })}</span>{/if}
        {:else}
          <span class="text-slate-400">—</span>
        {/if}
      {:else if column.key === 'at'}
        <span class="whitespace-nowrap tabular-nums">{dateTime(row.at)}</span>
      {/if}
    {/snippet}

    {#snippet actions(/** @type {any} */ row)}
      {#if retryable(row)}
        <button type="button" class="btn btn-plain px-3 text-sm" disabled={retryBusy} onclick={() => retry(row)}>{t('messages.retry')}</button>
      {/if}
      {#if removable(row)}
        <button type="button" class="btn btn-danger px-3 text-sm" disabled={deleteBusy} onclick={() => askDelete(row)}>{t('common.delete')}</button>
      {/if}
    {/snippet}
  </ResponsiveTable>

  {#if data !== null}
    <Pager page={data.page} pages={data.pages} total={data.total} per_page={data.per_page} busy={loading} onpage={(next) => (page = next)} />
  {/if}
  <!-- Clean-up actions stay with the list, not in the floating action bar. -->
  <div class="mt-3 flex flex-wrap justify-end gap-2">
    {#if direction !== 'in'}
      <button type="button" class="btn btn-danger px-3 text-sm" disabled={deleteBusy} onclick={() => (purgeOpen = true)}>{t('messages.purge')}</button>
    {/if}
    {#if data?.total > 0}
      <button type="button" class="btn btn-danger px-3 text-sm" disabled={deleteBusy} onclick={askClear}>{t('common.delete_all')}</button>
    {/if}
  </div>
</div>

<StickyActions>
  <button type="button" class="btn btn-primary" onclick={openCompose}>{t('messages.compose')}</button>
</StickyActions>

<Dialog bind:open={composing} title={t('messages.compose_title')}>
  <form id="compose-form" class="flex flex-col gap-4" onsubmit={send} novalidate>
    {#if composeProblem !== null}
      <p class="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900" role="alert">{composeProblem}</p>
    {/if}

    <Field id="compose-modem" label={t('messages.through')}>
      {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
        <select id="compose-modem" class="input" bind:value={compose.modem_id} aria-describedby={field.describedBy}>
          {#each modems as modem (modem.id)}
            <option value={modem.id}>{modem.id}</option>
          {/each}
        </select>
      {/snippet}
    </Field>

    <Field id="compose-number" label={t('messages.number')} hint={t('messages.number_hint')}>
      {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
        <input id="compose-number" class="input tabular-nums" type="tel" inputmode="tel" autocomplete="off" bind:value={compose.number} aria-describedby={field.describedBy} />
      {/snippet}
    </Field>

    <Field id="compose-text" label={t('messages.text')}>
      {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
        <textarea id="compose-text" class="input min-h-32 py-2 leading-6" rows="5" bind:value={compose.text} aria-describedby={field.describedBy}></textarea>
      {/snippet}
    </Field>
  </form>

  {#snippet footer()}
    <!-- Cancel and Send share one row on a phone too, leaving room for the text box above the keyboard. -->
    <div class="grid grid-cols-2 gap-2 sm:flex sm:items-center sm:justify-end">
      <!-- The SMS-count estimate sits next to Send. -->
      <p class="col-span-2 text-sm text-slate-600 sm:mr-auto" aria-live="polite">
        {t('messages.segments', { parts: estimate.parts, left: estimate.left })}
        <span class="text-slate-400">· {estimate.encoding === 'gsm' ? t('messages.gsm') : t('messages.unicode')}</span>
      </p>
      <button type="button" class="btn btn-plain sm:order-1" disabled={sending} onclick={() => (composing = false)}>{t('common.cancel')}</button>
      <button type="submit" form="compose-form" class="btn btn-primary sm:order-2" disabled={sending}>
        {sending ? t('messages.sending') : t('messages.send')}
      </button>
    </div>
  {/snippet}
</Dialog>

<Confirm
  bind:open={confirmOpen}
  title={t('messages.retry_title', { id: retrying?.id ?? '' })}
  text={t('messages.retry_text', { status: retrying === null ? '' : t(`sms.status_${retrying.status}`) })}
  confirmLabel={t('messages.retry_confirm')}
  busy={retryBusy}
  onconfirm={retryConfirmed}
/>

<Confirm
  bind:open={deleteOpen}
  title={deleting?.direction !== 'in' ? t('messages.delete_title', { number: deleting?.number ?? '' })
    : deleting.number ? t('messages.delete_in_title', { number: deleting.number }) : t('messages.delete_in_title_unknown')}
  text={deleting?.direction === 'in' ? t('messages.delete_in_text') : t('messages.delete_text')}
  confirmLabel={t('common.delete')}
  danger
  busy={deleteBusy}
  onconfirm={deleteConfirmed}
/>

<Confirm
  bind:open={purgeOpen}
  title={filters.modem === '' ? t('messages.purge_title') : t('messages.purge_title_modem', { modem: filters.modem })}
  text={t('messages.purge_text')}
  confirmLabel={t('messages.purge')}
  danger
  busy={deleteBusy}
  onconfirm={purgeConfirmed}
/>

<Confirm
  bind:open={clearOpen}
  title={t('messages.clear_title', { n: clearing?.total ?? 0 })}
  text={t('messages.clear_text')}
  confirmLabel={t('common.delete_all')}
  danger
  busy={deleteBusy}
  onconfirm={clearConfirmed}
/>

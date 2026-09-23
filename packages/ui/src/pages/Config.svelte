<!-- Config page: edit and apply hand-owned Asterisk files; generated aster.d/* files are read-only.
     Applies send the opened file's hash (409 on conflict: reload or force); restart-only files need confirmed `restart: true`. -->
<script>
  import { api } from '../api.js';
  import { t } from '../i18n/index.js';
  import Confirm from '../lib/Confirm.svelte';
  import StatusBadge from '../lib/StatusBadge.svelte';
  import StickyActions from '../lib/StickyActions.svelte';
  import { messageOf } from '../lib/errors.js';
  import { dateTime } from '../lib/format.js';
  import { live } from '../lib/live.svelte.js';
  import { settleChange } from '../lib/ops.js';
  import { toasts } from '../lib/toasts.svelte.js';

  /** The file states of `GET /api/config/files` and the tone each one is shown with. */
  const TONE = Object.freeze(/** @type {Record<string, 'ok' | 'info' | 'warn' | 'bad' | 'neutral'>} */ ({
    applied: 'ok', modified: 'warn', generated: 'info', missing: 'bad',
  }));

  /** @type {any[]} */
  let files = $state([]);
  /** @type {any} */
  let file = $state(null);
  /** @type {string | null} */
  let selected = $state(null);
  let draft = $state('');
  let wrap = $state(true);
  /** Below `md` the list and the editor are two views of one page; from `md` they sit side by side. */
  let view = $state('list');

  /** @type {string | null} */
  let error = $state(null);
  /** @type {string | null} */
  let refused = $state(null);
  /** @type {{ line: number, message: string }[]} */
  let problems = $state([]);
  /** @type {string[]} */
  let log = $state([]);
  /** The controller refused the apply because the file changed on disk since it was opened. */
  let conflict = $state(false);
  let busy = $state(false);
  /** 'apply' | 'restore' while a restart has to be confirmed first. */
  let confirming = $state(/** @type {null | 'apply' | 'restore'} */ (null));
  let confirmOpen = $state(false);

  const dirty = $derived(file !== null && file.editable && draft !== (file.content ?? ''));
  const restartNeeded = $derived(file?.restart_required === true);

  async function loadFiles() {
    try {
      files = (await api.configFiles())?.files ?? [];
      error = null;
    } catch (err) {
      error = messageOf(err);
    }
  }

  /** @param {string} name @param {{ keepDraft?: boolean }} [options] */
  async function open(name, { keepDraft = false } = {}) {
    selected = name;
    view = 'editor';
    refused = null;
    problems = [];
    log = [];
    conflict = false;
    try {
      const answer = await api.configFile(name);
      file = answer;
      if (!keepDraft) draft = answer?.content ?? '';
      error = null;
    } catch (err) {
      // A missing file is a 404 with its entry; applying content creates it.
      const body = /** @type {any} */ (err)?.body;
      file = body?.file ?? null;
      if (!keepDraft) draft = '';
      error = messageOf(err);
    }
  }

  $effect(() => {
    void live.resume;
    void live.finished;
    void loadFiles();
  });

  /** The apply itself; `force` is the second answer to a conflict, `restart` the acknowledgement of a graceful restart. */
  async function apply({ force = false } = {}) {
    if (file === null || busy) return;
    if (restartNeeded && confirming === null) {
      confirming = 'apply';
      confirmOpen = true;
      return;
    }
    busy = true;
    refused = null;
    problems = [];
    log = [];
    try {
      const answer = await api.applyConfig(file.name, {
        content: draft,
        base_hash: file.hash ?? null,
        ...(force ? { force: true } : {}),
        ...(restartNeeded ? { restart: true } : {}),
      });
      const { applied, operation } = await settleChange(answer);
      log = operation?.result?.log ?? [];
      if (applied) {
        conflict = false;
        toasts.push({ kind: 'success', text: t('config.applied', { name: file.name }) });
        await loadFiles();
        await open(file.name);
      }
    } catch (err) {
      refused = messageOf(err);
      const result = /** @type {any} */ (err)?.body?.operation?.result ?? null;
      problems = Array.isArray(result?.problems) ? result.problems : [];
      log = Array.isArray(result?.log) ? result.log : [];
      // Keep the "changed on disk" conflict visible until the user picks reload or force.
      conflict = typeof result?.current_hash === 'string' || /changed on disk/.test(refused ?? '');
    } finally {
      busy = false;
      confirming = null;
    }
  }

  async function restore() {
    if (file === null || busy) return;
    if (restartNeeded && confirming === null) {
      confirming = 'restore';
      confirmOpen = true;
      return;
    }
    busy = true;
    refused = null;
    problems = [];
    log = [];
    try {
      const answer = await api.restoreConfig(file.name, { base_hash: file.hash ?? null, ...(restartNeeded ? { restart: true } : {}) });
      const { applied, operation } = await settleChange(answer);
      log = operation?.result?.log ?? [];
      if (applied) {
        toasts.push({ kind: 'success', text: t('config.restored', { name: file.name }) });
        await loadFiles();
        await open(file.name);
      }
    } catch (err) {
      refused = messageOf(err);
      const result = /** @type {any} */ (err)?.body?.operation?.result ?? null;
      problems = Array.isArray(result?.problems) ? result.problems : [];
      log = Array.isArray(result?.log) ? result.log : [];
    } finally {
      busy = false;
      confirming = null;
    }
  }

  /** Read the file again, throwing away this edit: the other answer to a conflict. */
  async function reload() {
    if (selected === null) return;
    await open(selected);
    toasts.push({ text: t('config.reloaded') });
  }

  function confirmRestart() {
    const what = confirming;
    confirmOpen = false;
    if (what === 'apply') void apply();
    else if (what === 'restore') void restore();
  }
</script>

<h1 class="mb-4 hidden text-2xl font-semibold tracking-tight md:block">{t('config.title')}</h1>

{#if error !== null && file === null}
  <p class="card mb-4 border-rose-200 bg-rose-50 p-4 text-rose-900" role="alert">{error}</p>
{/if}

<div class="grid grid-cols-1 gap-3 md:grid-cols-[18rem_1fr]">
  <!-- The file list: one of the two views below `md`, the left column from `md` up. -->
  <section class="card p-2 {view === 'list' ? '' : 'hidden'} md:block" aria-labelledby="config-files-heading">
    <h2 id="config-files-heading" class="px-2 py-1 text-sm font-medium text-slate-500">{t('config.files')}</h2>
    <ul class="flex flex-col">
      {#each files as entry (entry.name)}
        <li>
          <button
            type="button"
            class="flex w-full min-h-11 flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-lg px-2 py-1.5 text-left hover:bg-slate-50 {entry.name === selected ? 'bg-sky-50 ring-1 ring-sky-200 ring-inset' : ''}"
            aria-current={entry.name === selected ? 'true' : undefined}
            onclick={() => open(entry.name)}
          >
            <!-- Never truncate the name; badges wrap under it when needed. -->
            <span class="min-w-0 font-mono text-sm break-all">{entry.name}</span>
            <span class="ml-auto flex shrink-0 items-center gap-2">
              {#if entry.restart_required}
                <span class="text-xs text-amber-700" title={t('config.restart_required')}>⏻</span>
              {/if}
              <StatusBadge text={t(`config.status_${entry.status}`)} tone={TONE[entry.status] ?? 'neutral'} class="px-2 py-0.5 text-xs" />
            </span>
          </button>
        </li>
      {/each}
    </ul>
  </section>

  <!-- The editor: the other view below `md`. -->
  <section class="card flex min-w-0 flex-col p-3 {view === 'editor' ? '' : 'hidden'} md:flex" aria-labelledby="config-editor-heading">
    {#if file === null}
      <h2 id="config-editor-heading" class="text-sm font-medium text-slate-500">{t('config.editor')}</h2>
      <p class="py-8 text-center text-slate-500">{t('config.pick')}</p>
    {:else}
      <!-- On a phone the file name gets its own row so it is not truncated. -->
      <div class="mb-2 flex flex-wrap items-center gap-2">
        <button type="button" class="btn btn-plain px-3 text-sm md:hidden" onclick={() => (view = 'list')}>← {t('config.files')}</button>
        <h2 id="config-editor-heading" class="order-last basis-full font-mono text-base font-semibold break-all md:order-none md:min-w-0 md:flex-1 md:basis-auto md:truncate">{file.name}</h2>
        <StatusBadge text={t(`config.status_${file.status}`)} tone={TONE[file.status] ?? 'neutral'} class="ml-auto md:ml-0" />
      </div>

      <p class="mb-2 text-sm text-slate-500">
        {file.editable ? t('config.hand') : t('config.generated')}
        {#if file.modified_at}· {dateTime(file.modified_at)}{/if}
        {#if file.reload?.length > 0}· {t('config.reload', { actions: file.reload.join(', ') })}{/if}
      </p>

      {#if conflict}
        <!-- The warning stays above the editor until one of its two buttons is used. -->
        <div class="card mb-2 border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="alert">
          <p class="font-medium">{t('config.conflict')}</p>
          <p class="mt-1">{t('config.conflict_text')}</p>
          <div class="mt-2 flex flex-col gap-2 sm:flex-row">
            <button type="button" class="btn btn-plain" disabled={busy} onclick={reload}>{t('config.reload_file')}</button>
            <!-- Both choices discard something, so neither is styled as the safe one. -->
            <button type="button" class="btn btn-plain" disabled={busy} onclick={() => apply({ force: true })}>{t('config.force')}</button>
          </div>
        </div>
      {/if}

      {#if refused !== null && !conflict}
        <p class="card mb-2 border-rose-200 bg-rose-50 p-3 text-sm text-rose-900" role="alert">{refused}</p>
      {/if}

      {#if problems.length > 0}
        <ul class="card mb-2 border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
          {#each problems as problem (problem.line + problem.message)}
            <li><span class="font-mono tabular-nums">{t('config.line', { n: problem.line })}</span> — {problem.message}</li>
          {/each}
        </ul>
      {/if}

      {#if log.length > 0}
        <div class="card mb-2 border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p class="font-medium">{t('config.asterisk_said')}</p>
          <pre class="mt-1 overflow-x-auto font-mono text-xs whitespace-pre">{log.join('\n')}</pre>
        </div>
      {/if}

      <div class="mb-2 flex items-center justify-between gap-2">
        <label class="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" class="h-5 w-5" bind:checked={wrap} />
          {t('config.wrap')}
        </label>
        {#if !file.editable}
          <span class="text-sm text-slate-500">{t('config.read_only')}</span>
        {/if}
      </div>

      <textarea
        class="input min-h-[24rem] flex-1 py-2 font-mono leading-6 md:text-sm md:leading-5 {wrap ? '' : 'overflow-x-auto whitespace-pre'}"
        style={wrap ? '' : 'white-space: pre; overflow-wrap: normal;'}
        aria-label={t('config.content', { name: file.name })}
        spellcheck="false"
        readonly={!file.editable}
        bind:value={draft}
      ></textarea>
    {/if}
  </section>
</div>

{#if file !== null && file.editable}
  <StickyActions floating={dirty}>
    {#if file.restorable}
      <button type="button" class="btn btn-plain mr-auto" disabled={busy} onclick={restore}>{t('config.restore')}</button>
    {/if}
    <button type="button" class="btn btn-primary" disabled={busy || !dirty} onclick={() => apply()}>
      {busy ? t('config.applying') : dirty ? t('config.apply') : t('config.applied_short')}
    </button>
  </StickyActions>
{/if}

<Confirm
  bind:open={confirmOpen}
  title={t('config.restart_title')}
  text={t('config.restart_text', { name: file?.name ?? '' })}
  confirmLabel={t('config.restart_confirm')}
  busy={busy}
  onconfirm={confirmRestart}
  oncancel={() => (confirming = null)}
/>

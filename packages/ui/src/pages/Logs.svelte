<!-- Logs page: tails of the Asterisk log and the controller's in-memory log, with line count, substring filter,
     optional auto-refresh (only while visible) and a wrap toggle. Lines are shown verbatim. -->
<script>
  import { api } from '../api.js';
  import { t } from '../i18n/index.js';
  import Field from '../lib/Field.svelte';
  import Search from '../lib/Search.svelte';
  import Tabs from '../lib/Tabs.svelte';
  import { messageOf } from '../lib/errors.js';
  import { live } from '../lib/live.svelte.js';

  /** How many lines can be asked for (the controller's own cap is 2000). */
  const SIZES = Object.freeze([100, 200, 500, 1000, 2000]);
  const REFRESH_MS = 5_000;

  let tab = $state('asterisk');
  let lines = $state(200);
  let grep = $state('');
  let auto = $state(false);
  /** Lines wrap by default below `md`; the toggle still works. */
  let wrap = $state(typeof window.matchMedia === 'function' && !window.matchMedia('(min-width: 48rem)').matches);

  /** @type {any} */
  let data = $state(null);
  /** @type {string | null} */
  let error = $state(null);
  let loading = $state(false);

  async function load() {
    loading = true;
    try {
      data = await api.logs(/** @type {'asterisk' | 'controller'} */ (tab), { lines, grep });
      error = null;
    } catch (err) {
      data = null;
      error = messageOf(err);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void live.resume;
    void tab;
    void lines;
    void grep;
    void load();
  });

  // Auto-refresh only while enabled and the tab is visible.
  $effect(() => {
    if (!auto) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  });

  const tabs = $derived([
    { id: 'asterisk', label: t('logs.asterisk') },
    { id: 'controller', label: t('logs.controller') },
  ]);
  const text = $derived((data?.lines ?? []).join('\n'));
</script>

<h1 class="mb-4 hidden text-2xl font-semibold tracking-tight md:block">{t('logs.title')}</h1>

<Tabs {tabs} current={tab} panel="logs-output" onselect={(id) => (tab = id)} />

<div class="card mt-3 p-3">
  <!-- Compact control rows below `xl` so the output starts on the first phone screen; one row from `xl`. -->
  <div class="grid grid-cols-2 gap-3 xl:grid-cols-[10rem_1fr_auto_auto_auto] xl:items-end">
    <Field id="logs-lines" label={t('logs.lines')}>
      {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
        <select id="logs-lines" class="input" aria-describedby={field.describedBy} value={String(lines)} onchange={(event) => (lines = Number(event.currentTarget.value))}>
          {#each SIZES as size (size)}
            <option value={String(size)}>{size}</option>
          {/each}
        </select>
      {/snippet}
    </Field>

    <div class="flex items-end justify-end xl:order-last">
      <button type="button" class="btn btn-plain px-3 text-sm" disabled={loading} onclick={load}>{t('health.refresh')}</button>
    </div>

    <Field id="logs-grep" class="col-span-2 xl:col-span-1" label={t('logs.grep')} hint={t('logs.grep_hint')}>
      {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
        <Search id="logs-grep" class="font-mono" value={grep} describedBy={field.describedBy} onsearch={(value) => (grep = value)} />
      {/snippet}
    </Field>

    <label class="flex min-h-11 items-center gap-2">
      <input type="checkbox" class="h-5 w-5" bind:checked={auto} />
      {t('logs.auto', { seconds: REFRESH_MS / 1000 })}
    </label>

    <label class="flex min-h-11 items-center gap-2">
      <input type="checkbox" class="h-5 w-5" bind:checked={wrap} />
      {t('logs.wrap')}
    </label>
  </div>

  {#if error !== null}
    <p class="card mt-3 border-rose-200 bg-rose-50 p-3 text-sm text-rose-900" role="alert">{error}</p>
  {/if}

  {#if data !== null}
    <p class="mt-3 text-sm text-slate-500" aria-live="polite">
      {t('logs.shown', { n: data.lines?.length ?? 0 })}
      {#if data.file}· <span class="font-mono text-xs">{data.file}</span>{/if}
      {#if data.truncated}· {t('logs.truncated')}{/if}
      {#if data.dropped}· {t('logs.dropped', { n: data.dropped })}{/if}
    </p>
  {/if}

  <!-- The only sideways-scrolling box; focusable for keyboard scrolling, and the tab panel of the strip above. -->
  <div id="logs-output" role="tabpanel" aria-labelledby="tab-{tab}" tabindex="0" class="mt-2 max-h-[60dvh] overflow-auto rounded-lg bg-slate-900 scheme-light">
    <pre class="p-3 font-mono text-xs leading-5 text-slate-100 {wrap ? 'break-words whitespace-pre-wrap' : 'whitespace-pre'}">{text || (loading ? t('app.loading') : t('logs.empty'))}</pre>
  </div>
</div>

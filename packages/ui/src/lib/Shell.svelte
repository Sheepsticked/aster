<!-- Page frame: sidebar from `md` up, a drawer (Dialog) below; health strip, toasts, skip link and focusable <main>.
     The drawer closes on navigation. -->
<script>
  import { api } from '../api.js';
  import { LANGUAGES, language, setLanguage, t } from '../i18n/index.js';
  import Dialog from './Dialog.svelte';
  import HealthStrip from './HealthStrip.svelte';
  import Logo from './Logo.svelte';
  import Nav from './Nav.svelte';
  import Toasts from './Toasts.svelte';
  import { live } from './live.svelte.js';
  import { session } from './session.svelte.js';
  import { THEMES, theme } from './theme.svelte.js';
  import { toasts } from './toasts.svelte.js';

  /** @type {{ path: string, title: string, children: import('svelte').Snippet }} */
  const { path, title, children } = $props();

  let drawer = $state(false);

  $effect(() => {
    // Reading `path` is what subscribes this effect to a navigation.
    void path;
    drawer = false;
  });

  /** The appliance keeps the language in its registry, so a switch is also a settings change. */
  async function switchLanguage(/** @type {string} */ next) {
    const before = language();
    setLanguage(next);
    try {
      await api.saveSettings({ ui_language: next });
    } catch (err) {
      setLanguage(before);
      toasts.push({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  }
</script>

{#snippet account()}
  <div class="flex flex-col gap-2 border-t border-slate-200 p-3">
    <select
      class="input"
      aria-label={t('lang.label')}
      value={language()}
      onchange={(event) => switchLanguage(event.currentTarget.value)}
    >
      {#each LANGUAGES as code (code)}
        <option value={code}>{t(`lang.${code}`)}</option>
      {/each}
    </select>
    <select class="input" aria-label={t('theme.label')} value={theme.value} onchange={(event) => theme.set(event.currentTarget.value)}>
      {#each THEMES as name (name)}
        <option value={name}>{t(`theme.${name}`)}</option>
      {/each}
    </select>
    <button type="button" class="btn btn-plain w-full" onclick={() => session.logout()}>{t('nav.logout')}</button>
    {#if !live.connected}
      <p class="text-sm text-amber-700">{t('live.lost')}</p>
    {/if}
  </div>
{/snippet}

<div class="flex min-h-dvh flex-col md:flex-row">
  <a href="#content" class="sr-only rounded-lg bg-sky-700 px-4 py-2 text-white focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50">
    {t('app.skip')}
  </a>

  <aside class="hidden border-r border-slate-200 bg-white md:flex md:w-64 md:shrink-0 md:flex-col">
    <div class="flex items-center gap-2 px-4 py-4">
      <Logo />
      <div class="flex min-w-0 items-baseline gap-2">
        <span class="text-xl font-semibold tracking-tight">{t('app.title')}</span>
        <span class="text-sm text-slate-500">{t('app.subtitle')}</span>
      </div>
    </div>
    <Nav {path} />
    <div class="mt-auto">
      {@render account()}
    </div>
  </aside>

  <div class="flex min-w-0 flex-1 flex-col">
    <header class="sticky top-0 z-30 flex items-center gap-1 bg-slate-900 px-2 text-white scheme-light pt-safe md:hidden">
      <button
        type="button"
        class="btn btn-ghost w-11 px-0 text-white hover:bg-white/10"
        aria-label={t('nav.open_menu')}
        aria-expanded={drawer}
        onclick={() => (drawer = true)}
      >
        <svg viewBox="0 0 24 24" class="h-6 w-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
      <h1 class="min-w-0 flex-1 truncate py-3 text-base font-semibold">{title}</h1>
      {#if !live.connected}
        <span class="mr-1 h-2.5 w-2.5 shrink-0 rounded-full bg-amber-400" title={t('live.lost')} aria-label={t('live.lost')} role="img"></span>
      {/if}
    </header>

    <HealthStrip />

    <main id="content" tabindex="-1" class="mx-auto w-full max-w-6xl flex-1 px-4 py-4 focus:outline-none">
      {@render children()}
    </main>
  </div>
</div>

<Dialog
  bind:open={drawer}
  title={t('nav.menu')}
  labelHidden={false}
  closeLabel={t('nav.close_menu')}
  panelClass="m-0 h-dvh w-[17rem] max-w-[85vw] rounded-none motion-safe:animate-drawer-in motion-safe:data-closing:animate-drawer-out"
  dialogClass="motion-safe:backdrop:animate-fade-in motion-safe:data-closing:backdrop:animate-fade-out"
  animateClose
>
  <Nav {path} onnavigate={() => (drawer = false)} />
  {@render account()}
</Dialog>

<Toasts />

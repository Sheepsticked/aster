<!-- Root component: waits for the session check, then shows the login screen (remembering the requested path) or the app.
     The event stream follows the session; the health poll runs either way. -->
<script>
  import { onMount } from 'svelte';
  import { t } from './i18n/index.js';
  import HealthStrip from './lib/HealthStrip.svelte';
  import Shell from './lib/Shell.svelte';
  import { health } from './lib/health.svelte.js';
  import { live } from './lib/live.svelte.js';
  import { session } from './lib/session.svelte.js';
  import Login from './pages/Login.svelte';
  import { currentPath, match, navigate, start } from './router.js';

  let path = $state(currentPath());
  /** Where to go after a login: the path that was asked for, unless that was the login screen itself. */
  let intended = $state(currentPath() === '/login' ? '/' : currentPath());

  const found = $derived(match(path));
  const title = $derived(found.route === null ? t('error.not_found') : t(`nav.${found.route.name}`));

  // The router is a plain module; its changes become reactive state here.
  $effect(() => start((next) => (path = next)));

  onMount(() => {
    void session.check();
    return health.start();
  });

  $effect(() => {
    if (session.status === 'in') live.start();
    else live.stop();
  });

  // /api/health includes more detail with a session, so refresh it on login and logout.
  $effect(() => {
    if (session.status === 'unknown') return;
    void health.refresh();
  });

  $effect(() => {
    if (session.status === 'in' && path === '/login') {
      navigate(intended === '/login' ? '/' : intended, { replace: true });
      return;
    }
    if (session.status === 'out' && path !== '/login') {
      intended = path;
      navigate('/login', { replace: true });
    }
  });
</script>

{#if session.status === 'unknown'}
  <div class="flex min-h-dvh flex-col">
    <HealthStrip />
    <div class="flex flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
      {#if session.error === null}
        <p class="text-slate-600">{t('app.loading')}</p>
      {:else}
        <p class="max-w-md text-slate-700">{session.errorStatus === 0 ? t('error.network') : session.error}</p>
        <button type="button" class="btn btn-primary" onclick={() => session.check()}>{t('common.retry')}</button>
      {/if}
    </div>
  </div>
{:else if session.status === 'out'}
  <Login />
{:else}
  <Shell {path} {title}>
    {#if found.route === null || found.route.anonymous}
      <section class="card p-6">
        <h1 class="text-xl font-semibold">{t('error.not_found')}</h1>
        <p class="mt-2 text-slate-600">{t('error.not_found_text')}</p>
      </section>
    {:else}
      {@const Page = found.route.component}
      <!-- keyed by path: /modems/gsm1 → /modems/gsm2 is a new page, not gsm1's form under gsm2's id -->
      {#key path}
        <Page name={found.route.name} {...found.params} />
      {/key}
    {/if}
  </Shell>
{/if}

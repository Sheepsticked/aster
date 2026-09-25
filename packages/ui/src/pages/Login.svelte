<!-- Login screen: a 401 is shown as a translated "wrong password", a 429 as "too many" with the wait, other failures in
     the controller's words.
     Also explains an expired session and shows the health strip. -->
<script>
  import { onMount } from 'svelte';
  import { LANGUAGES, language, setLanguage, t } from '../i18n/index.js';
  import HealthStrip from '../lib/HealthStrip.svelte';
  import Logo from '../lib/Logo.svelte';
  import { session } from '../lib/session.svelte.js';

  let password = $state('');
  let busy = $state(false);
  let empty = $state(false);
  /** @type {HTMLInputElement | null} */
  let field = $state(null);

  const expired = $derived(session.error === null && session.errorStatus === 401);
  const problem = $derived(
    session.error === null
      ? null
      : session.errorStatus === 401
        ? t('login.wrong')
        : session.errorStatus === 429
          ? t('login.too_many', { minutes: Math.max(1, Math.ceil((session.retryAfter ?? 60) / 60)) })
          : session.errorStatus === 0
            ? t('error.network')
            : session.error,
  );

  onMount(() => field?.focus());

  async function submit(/** @type {SubmitEvent} */ event) {
    event.preventDefault();
    empty = password === '';
    if (empty || busy) return;
    busy = true;
    const ok = await session.login(password);
    busy = false;
    if (!ok) {
      password = '';
      field?.focus();
    }
  }
</script>

<div class="flex min-h-dvh flex-col">
  <HealthStrip />
  <div class="flex flex-1 items-center justify-center px-4 py-8">
    <div class="card w-full max-w-sm p-6">
      <div class="flex items-center gap-3">
        <Logo class="h-8 w-8 shrink-0" />
        <h1 class="text-2xl font-semibold tracking-tight">{t('app.title')}</h1>
      </div>
      <p class="mt-1 text-slate-500">{t('login.subtitle')}</p>

      <form class="mt-6 flex flex-col gap-4" onsubmit={submit} novalidate>
        <div>
          <label class="mb-1 block font-medium" for="login-password">{t('login.password')}</label>
          <input
            bind:this={field}
            bind:value={password}
            id="login-password"
            class="input"
            type="password"
            name="password"
            autocomplete="current-password"
            aria-describedby={problem || empty ? 'login-problem' : undefined}
            aria-invalid={problem !== null || empty ? 'true' : undefined}
            oninput={() => (empty = false)}
          />
        </div>

        {#if empty || problem || expired}
          <p id="login-problem" class="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900" role="alert">
            {empty ? t('login.empty') : (problem ?? t('error.unauthorized'))}
          </p>
        {/if}

        <button type="submit" class="btn btn-primary w-full" disabled={busy}>
          {busy ? t('login.busy') : t('login.submit')}
        </button>
      </form>

      <div class="mt-6 border-t border-slate-200 pt-4">
        <label class="mb-1 block text-sm text-slate-500" for="login-language">{t('lang.label')}</label>
        <select id="login-language" class="input" value={language()} onchange={(event) => setLanguage(event.currentTarget.value)}>
          {#each LANGUAGES as code (code)}
            <option value={code}>{t(`lang.${code}`)}</option>
          {/each}
        </select>
      </div>
    </div>
  </div>
</div>

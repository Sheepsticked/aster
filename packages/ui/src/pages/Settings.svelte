<!-- Settings page, saved separately: registry fields (one apply), the Telegram token (write-only secret), the admin
     password (ends all sessions) and the backup download link. The test message's result arrives via the event stream. -->
<script>
  import { api } from '../api.js';
  import { LANGUAGES, language, setLanguage, t } from '../i18n/index.js';
  import ChipList from '../lib/ChipList.svelte';
  import Field from '../lib/Field.svelte';
  import Section from '../lib/Section.svelte';
  import StickyActions from '../lib/StickyActions.svelte';
  import { messageOf, problemsElsewhere, problemsFor, problemsOf } from '../lib/errors.js';
  import { orNone, uptime } from '../lib/format.js';
  import { health } from '../lib/health.svelte.js';
  import { live } from '../lib/live.svelte.js';
  import { settleChange } from '../lib/ops.js';
  import { session } from '../lib/session.svelte.js';
  import { toasts } from '../lib/toasts.svelte.js';

  /** A Telegram chat id: digits, and a leading `-` for a group. */
  const CHAT_ID = /^-?[0-9]{1,20}$/;
  /** The registry fields this page shows problems beside. */
  const FIELDS = Object.freeze(['ui_language', 'timezone', 'operations', 'notifications', 'default_recipients', 'alerts']);

  /** @type {any} */
  let settings = $state(null);
  /** @type {string | null} */
  let error = $state(null);
  let saving = $state(false);
  /** @type {{ path: string, message: string }[]} */
  let problems = $state([]);
  /** @type {string | null} */
  let refused = $state(null);

  let form = $state(/** @type {any} */ (null));

  /** The About box reuses the polled health data (lib/health.svelte.js). */
  const about = $derived(health.data);

  let token = $state('');
  let tokenBusy = $state(false);
  let chatId = $state('');
  let testBusy = $state(false);

  let current = $state('');
  let next = $state('');
  let again = $state('');
  let passwordBusy = $state(false);
  /** @type {string | null} */
  let passwordProblem = $state(null);

  /** The retention_days fields, in the order the form shows them. */
  const RETENTION = /** @type {const} */ (['messages', 'calls', 'operations', 'notifications']);

  /** IANA zones known to the browser; free text if unsupported. */
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];

  /** @param {any} data  what GET /api/settings answers */
  const editable = (data) => ({
    ui_language: data.ui_language,
    timezone: data.timezone,
    messages: String(data.retention_days?.messages ?? ''),
    calls: String(data.retention_days?.calls ?? ''),
    operations: String(data.retention_days?.operations ?? ''),
    notifications: String(data.retention_days?.notifications ?? ''),
    default_recipients: [...(data.default_recipients ?? [])],
    alerts: Boolean(data.alerts),
  });

  async function load() {
    try {
      const data = await api.settings();
      settings = data;
      error = null;
      if (form === null && data !== null) form = editable(data);
    } catch (err) {
      error = messageOf(err);
    }
  }

  $effect(() => {
    void live.resume;
    void live.finished;
    void load();
  });

  /** What the registry would change to; only what differs is sent. */
  const changes = $derived.by(() => {
    /** @type {Record<string, unknown>} */
    const out = {};
    if (settings === null || form === null) return out;
    if (form.ui_language !== settings.ui_language) out.ui_language = form.ui_language;
    if (form.timezone.trim() !== settings.timezone) out.timezone = form.timezone.trim();
    /** @type {Record<string, number>} */
    const retention = {};
    for (const key of RETENTION) {
      const value = Number(form[key]);
      if (Number.isInteger(value) && value !== settings.retention_days?.[key]) retention[key] = value;
    }
    if (Object.keys(retention).length > 0) out.retention_days = retention;
    if (form.default_recipients.join(',') !== (settings.default_recipients ?? []).join(',')) out.default_recipients = [...form.default_recipients];
    if (form.alerts !== Boolean(settings.alerts)) out.alerts = form.alerts;
    return out;
  });

  const dirty = $derived(Object.keys(changes).length > 0);

  function check() {
    /** @type {{ path: string, message: string }[]} */
    const found = [];
    if (form === null) return found;
    if (form.timezone.trim() === '') found.push({ path: 'timezone', message: t('settings.timezone_empty') });
    for (const key of RETENTION) {
      const value = Number(form[key]);
      if (!Number.isInteger(value) || value < 1 || value > 3650) found.push({ path: key, message: t('settings.retention_invalid') });
    }
    return found;
  }

  async function save(/** @type {SubmitEvent} */ event) {
    event.preventDefault();
    if (saving || !dirty) return;
    problems = check();
    refused = null;
    if (problems.length > 0) return;
    saving = true;
    const wanted = /** @type {string | undefined} */ (changes.ui_language);
    try {
      const { applied } = await settleChange(await api.saveSettings(changes));
      if (applied) {
        // Saving the appliance language also switches the UI language.
        if (typeof wanted === 'string') setLanguage(wanted);
        toasts.push({ kind: 'success', text: t('settings.saved') });
        form = null;
      }
      await load();
    } catch (err) {
      problems = problemsOf(err);
      refused = messageOf(err);
    } finally {
      saving = false;
    }
  }

  /** @param {boolean} clear */
  async function saveToken(clear) {
    if (tokenBusy) return;
    tokenBusy = true;
    try {
      await settleChange(await api.saveSettings({ telegram_token: clear ? null : token.trim() }));
      token = '';
      await load();
      toasts.push({ kind: 'success', text: clear ? t('settings.token_cleared') : t('settings.token_saved') });
    } catch (err) {
      toasts.push({ kind: 'error', text: messageOf(err) });
    } finally {
      tokenBusy = false;
    }
  }

  async function sendTest() {
    if (testBusy) return;
    const id = chatId.trim();
    if (!CHAT_ID.test(id)) {
      toasts.push({ kind: 'error', text: t('settings.chat_id_invalid') });
      return;
    }
    testBusy = true;
    try {
      await api.notifyTest(id);
      toasts.push({ text: t('settings.test_queued', { chat: id }) });
    } catch (err) {
      toasts.push({ kind: 'error', text: messageOf(err) });
    } finally {
      testBusy = false;
    }
  }

  async function changePassword(/** @type {SubmitEvent} */ event) {
    event.preventDefault();
    if (passwordBusy) return;
    passwordProblem = null;
    if (current === '' || next === '') {
      passwordProblem = t('settings.password_empty');
      return;
    }
    if (next !== again) {
      passwordProblem = t('settings.password_mismatch');
      return;
    }
    passwordBusy = true;
    try {
      await api.saveSettings({ password: { current, next } });
      current = '';
      next = '';
      again = '';
      // A password change ends every session, including this one: back to the login screen.
      toasts.push({ kind: 'success', text: t('settings.password_changed') });
      session.expired();
    } catch (err) {
      passwordProblem = messageOf(err);
    } finally {
      passwordBusy = false;
    }
  }
</script>

<h1 class="mb-4 hidden text-2xl font-semibold tracking-tight md:block">{t('settings.title')}</h1>

{#if error !== null}
  <p class="card mb-4 border-rose-200 bg-rose-50 p-4 text-rose-900" role="alert">{error}</p>
{/if}

{#if settings === null || form === null}
  <p class="card p-6 text-center text-slate-500">{t('app.loading')}</p>
{:else}
  <div class="flex max-w-2xl flex-col gap-3">
    <form id="settings-form" class="contents" onsubmit={save} novalidate>
      {#if refused !== null}
        <p class="card border-rose-200 bg-rose-50 p-4 text-rose-900" role="alert">{refused}</p>
      {/if}
      {#each problemsElsewhere(problems, FIELDS) as problem (problem.path + problem.message)}
        <p class="card border-rose-200 bg-rose-50 p-4 text-sm text-rose-900">{problem.path}: {problem.message}</p>
      {/each}

      <Section id="settings-appearance" title={t('settings.appearance')} subtitle={t('settings.appearance_hint')}>
        <div class="flex flex-col gap-4">
          <Field id="settings-language" label={t('lang.label')} problems={problemsFor(problems, 'ui_language')}>
            {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
              <select id="settings-language" class="input" bind:value={form.ui_language} aria-describedby={field.describedBy}>
                {#each LANGUAGES as code (code)}
                  <option value={code}>{t(`lang.${code}`)}</option>
                {/each}
              </select>
            {/snippet}
          </Field>

          <Field id="settings-timezone" label={t('settings.timezone')} hint={t('settings.timezone_hint')} problems={problemsFor(problems, 'timezone')}>
            {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
              <input
                id="settings-timezone"
                class="input"
                bind:value={form.timezone}
                list={zones.length > 0 ? 'settings-zones' : undefined}
                autocomplete="off"
                spellcheck="false"
                aria-describedby={field.describedBy}
              />
              {#if zones.length > 0}
                <datalist id="settings-zones">
                  {#each zones as zone (zone)}
                    <option value={zone}></option>
                  {/each}
                </datalist>
              {/if}
            {/snippet}
          </Field>
        </div>
      </Section>

      <Section id="settings-notifications" title={t('settings.notifications')} subtitle={t('settings.notifications_hint')}>
        <div class="flex flex-col gap-4">
          <Field id="settings-recipients" label={t('settings.recipients')} hint={t('settings.recipients_hint')} problems={problemsFor(problems, 'default_recipients')}>
            {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
              <ChipList
                id="settings-recipients"
                items={form.default_recipients}
                pattern={CHAT_ID}
                inputmode="numeric"
                placeholder={t('settings.chat_id')}
                describedBy={field.describedBy}
                onchange={(items) => (form.default_recipients = items)}
              />
            {/snippet}
          </Field>

          <label class="flex min-h-11 items-center gap-3">
            <input type="checkbox" class="h-5 w-5" bind:checked={form.alerts} />
            <span>{t('settings.alerts')}</span>
          </label>
          <p class="-mt-3 text-sm text-slate-500">{t('settings.alerts_hint')}</p>
        </div>
      </Section>

      <Section id="settings-retention" title={t('settings.retention')} subtitle={t('settings.retention_hint')}>
        <div class="flex flex-col gap-4">
          <Field id="settings-retention-messages" label={t('settings.retention_messages')} problems={problemsFor(problems, 'messages')}>
            {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
              <input id="settings-retention-messages" class="input tabular-nums" bind:value={form.messages} inputmode="numeric" aria-describedby={field.describedBy} />
            {/snippet}
          </Field>
          <Field id="settings-retention-calls" label={t('settings.retention_calls')} problems={problemsFor(problems, 'calls')}>
            {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
              <input id="settings-retention-calls" class="input tabular-nums" bind:value={form.calls} inputmode="numeric" aria-describedby={field.describedBy} />
            {/snippet}
          </Field>
          <Field id="settings-retention-operations" label={t('settings.retention_operations')} problems={problemsFor(problems, 'operations')}>
            {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
              <input id="settings-retention-operations" class="input tabular-nums" bind:value={form.operations} inputmode="numeric" aria-describedby={field.describedBy} />
            {/snippet}
          </Field>
          <Field id="settings-retention-notifications" label={t('settings.retention_notifications')} problems={problemsFor(problems, 'notifications')}>
            {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
              <input id="settings-retention-notifications" class="input tabular-nums" bind:value={form.notifications} inputmode="numeric" aria-describedby={field.describedBy} />
            {/snippet}
          </Field>
        </div>
      </Section>
    </form>

    <!-- The token is a secret, not a registry field: it has its own button and is never read back. -->
    <Section id="settings-telegram" title={t('settings.telegram')} subtitle={settings.telegram_token_set ? t('settings.token_set') : t('settings.token_unset')}>
      <div class="flex flex-col gap-4">
        <Field id="settings-token" label={t('settings.token')} hint={t('settings.token_hint')}>
          {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
            <input id="settings-token" class="input font-mono" type="password" bind:value={token} autocomplete="off" spellcheck="false" placeholder="123456:ABC…" aria-describedby={field.describedBy} />
          {/snippet}
        </Field>
        <div class="flex flex-col gap-2 sm:flex-row">
          <button type="button" class="btn btn-primary" disabled={tokenBusy || token.trim() === ''} onclick={() => saveToken(false)}>
            {tokenBusy ? t('common.saving') : t('settings.token_save')}
          </button>
          <button type="button" class="btn btn-danger" disabled={tokenBusy || !settings.telegram_token_set} onclick={() => saveToken(true)}>
            {t('settings.token_clear')}
          </button>
        </div>

        <Field id="settings-test-chat" label={t('settings.test')} hint={t('settings.test_hint')}>
          {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
            <div class="flex gap-2">
              <input id="settings-test-chat" class="input tabular-nums" bind:value={chatId} inputmode="numeric" autocomplete="off" placeholder={t('settings.chat_id')} aria-describedby={field.describedBy} />
              <button type="button" class="btn btn-primary shrink-0" disabled={testBusy} onclick={sendTest}>
                {testBusy ? t('common.working') : t('settings.test_send')}
              </button>
            </div>
          {/snippet}
        </Field>
      </div>
    </Section>

    <Section id="settings-password" title={t('settings.password')} subtitle={t('settings.password_hint')}>
      <form class="flex flex-col gap-4" onsubmit={changePassword} novalidate>
        <Field id="settings-password-current" label={t('settings.password_current')}>
          {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
            <input id="settings-password-current" class="input" type="password" bind:value={current} autocomplete="current-password" aria-describedby={field.describedBy} />
          {/snippet}
        </Field>
        <Field id="settings-password-next" label={t('settings.password_next')}>
          {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
            <input id="settings-password-next" class="input" type="password" bind:value={next} autocomplete="new-password" aria-describedby={field.describedBy} />
          {/snippet}
        </Field>
        <Field id="settings-password-again" label={t('settings.password_again')}>
          {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
            <input id="settings-password-again" class="input" type="password" bind:value={again} autocomplete="new-password" aria-describedby={field.describedBy} />
          {/snippet}
        </Field>
        {#if passwordProblem !== null}
          <p class="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900" role="alert">{passwordProblem}</p>
        {/if}
        <button type="submit" class="btn btn-primary w-full sm:w-auto sm:self-start" disabled={passwordBusy}>
          {passwordBusy ? t('common.saving') : t('settings.password_change')}
        </button>
      </form>
    </Section>

    <Section id="settings-backup" title={t('settings.backup')} subtitle={t('settings.backup_hint')}>
      <!-- An ordinary link: the download is the browser's, and the router leaves /api/… alone (router.js). -->
      <a class="btn btn-plain w-full sm:w-auto" href="/api/backup" download>{t('settings.backup_download')}</a>
    </Section>

    <!-- Diagnostics (versions, uptime, disk) that are not shown in the health strip. -->
    <Section id="settings-about" title={t('settings.about')} subtitle={t('settings.about_hint')}>
      <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
        <div>
          <dt class="text-slate-500">{t('health.controller')}</dt>
          <dd class="font-medium">{orNone(about?.versions?.controller)}</dd>
        </div>
        <div>
          <dt class="text-slate-500">{t('health.asterisk')}</dt>
          <dd class="truncate font-medium" title={orNone(about?.versions?.asterisk)}>{orNone(about?.versions?.asterisk)}</dd>
        </div>
        <div>
          <dt class="text-slate-500">{t('health.node')}</dt>
          <dd class="font-medium">{orNone(about?.versions?.node)}</dd>
        </div>
        <div>
          <dt class="text-slate-500">{t('health.uptime')}</dt>
          <dd class="font-medium">{uptime(about?.uptime_s)}</dd>
        </div>
        <div>
          <dt class="text-slate-500">{t('health.disk')}</dt>
          <dd class="font-medium">
            {about?.disk_free_mb === null || about?.disk_free_mb === undefined ? t('common.none') : t('health.mb', { mb: about.disk_free_mb })}
          </dd>
        </div>
        <div>
          <dt class="text-slate-500">{t('health.ami')}</dt>
          <dd class="font-medium">{orNone(about?.ami?.state)}</dd>
        </div>
        <div>
          <dt class="text-slate-500">{t('health.spool')}</dt>
          <dd class="font-medium">{orNone(about?.spool_backlog)}</dd>
        </div>
        <div>
          <dt class="text-slate-500">{t('health.schema')}</dt>
          <dd class="font-medium">{orNone(about?.database?.schema_version)}</dd>
        </div>
      </dl>
    </Section>
  </div>

  <StickyActions floating={dirty}>
    <button type="submit" form="settings-form" class="btn btn-primary" disabled={saving || !dirty}>
      {saving ? t('common.saving') : dirty ? t('common.save') : t('common.saved')}
    </button>
  </StickyActions>
{/if}

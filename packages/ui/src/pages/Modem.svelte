<!-- Modem detail page in collapsible sections: registry fields (only changes are sent, one registry-apply), device actions,
     and AT/USSD/forwarding operations. Forwarding shows only states the modem verified via a +CCFC query. -->
<script>
  import { api } from '../api.js';
  import { t } from '../i18n/index.js';
  import ActionIcon from '../lib/ActionIcon.svelte';
  import ChipList from '../lib/ChipList.svelte';
  import Confirm from '../lib/Confirm.svelte';
  import Field from '../lib/Field.svelte';
  import Section from '../lib/Section.svelte';
  import SignalBars from '../lib/SignalBars.svelte';
  import StateBadge from '../lib/StateBadge.svelte';
  import StickyActions from '../lib/StickyActions.svelte';
  import { messageOf, problemsElsewhere, problemsFor, problemsOf } from '../lib/errors.js';
  import { ago, dateTime, orNone, time } from '../lib/format.js';
  import { live } from '../lib/live.svelte.js';
  import { runOperation, settleChange } from '../lib/ops.js';
  import { toasts } from '../lib/toasts.svelte.js';
  import { navigate } from '../router.js';

  /** @type {{ id: string }} */
  const { id } = $props();

  /** The registry patterns that a page can check before it sends anything. */
  const IMEI = /^[0-9]{15}$/;
  const FORWARD_NUMBER = /^\+[0-9]{6,15}$/;
  /** The forwarding conditions the page lists, the ones the form changes (conditional = the last three at once) and the no-reply waits. */
  const FORWARD_CONDITIONS = Object.freeze(['unconditional', 'busy', 'no_reply', 'not_reachable']);
  const FORWARD_REASONS = Object.freeze([...FORWARD_CONDITIONS, 'conditional']);
  const FORWARD_TIMED = Object.freeze(['no_reply', 'conditional']);
  const FORWARD_TIMES = Object.freeze([5, 10, 15, 20, 25, 30]);
  const USSD_CODE = /^[0-9*#]{1,64}$/;
  /** Action rows: on/off, then recovery. `when` applies only to actions that can wait for a call to end. */
  const ACTION_ROWS = Object.freeze([['start', 'stop'], ['restart', 'reset', 'remap']]);
  const TIMED = Object.freeze(['stop', 'restart']);
  /** Button style per action: all plain except Stop, which takes the modem off the air. */
  const ACTION_STYLE = Object.freeze(/** @type {Record<string, string>} */ ({
    start: 'btn-plain', stop: 'btn-danger', restart: 'btn-plain', reset: 'btn-plain', remap: 'btn-plain',
  }));
  const WHEN = Object.freeze(['gracefully', 'now', 'when convenient']);
  /** The form fields the page shows problems beside. */
  const FIELDS = Object.freeze(['imei', 'usb_port', 'ring', 'ring_timeout', 'incoming_context', 'group', 'recipients', 'driver', 'uac', 'enabled']);

  /** @type {any} */
  let modem = $state(null);
  /** @type {any[]} */
  let phones = $state([]);
  /** @type {any[]} */
  let devices = $state([]);
  /** @type {string | null} */
  let error = $state(null);
  let missing = $state(false);
  let saving = $state(false);
  let deleting = $state(false);
  let confirming = $state(false);
  /** @type {{ path: string, message: string }[]} */
  let problems = $state([]);
  /** @type {string | null} */
  let refused = $state(null);
  /** @type {string | null} */
  let acting = $state(null);
  let when = $state('gracefully');
  /** A Disable or Enable from the quick buttons is being saved. */
  let toggling = $state(false);

  /** The editable copy of the registry entry; `null` until the modem has been read once. */
  let form = $state(/** @type {any} */ (null));

  /** Forwarding verdicts from operations run here; newer than the modem view until the next refresh. */
  let ranForwarding = $state(/** @type {any} */ (null));
  let forwardingBusy = $state(false);
  let forwardReason = $state('unconditional');
  let forwardNumber = $state('');
  let forwardTime = $state(20);
  /** @type {string | null} */
  let forwardProblem = $state(null);

  let atCommand = $state('');
  let atTimeout = $state('');
  let atBusy = $state(false);
  let atResult = $state(/** @type {any} */ (null));
  /** @type {string | null} */
  let atProblem = $state(null);

  let ussdCode = $state('');
  let ussdBusy = $state(false);
  let ussdResult = $state(/** @type {any} */ (null));
  /** @type {string | null} */
  let ussdProblem = $state(null);

  /** @param {any} entry  a modem as `modemView` sends it */
  function editable(entry) {
    return {
      driver: entry.driver,
      imei: entry.imei,
      enabled: entry.enabled,
      uac: entry.uac,
      usb_port: entry.usb_port ?? '',
      ring: [...(entry.ring ?? [])],
      ring_timeout: String(entry.ring_timeout ?? ''),
      incoming_context: entry.incoming_context ?? '',
      group: entry.group === null || entry.group === undefined ? '' : String(entry.group),
      ownRecipients: Array.isArray(entry.recipients),
      recipients: [...(entry.recipients ?? [])],
    };
  }

  async function load() {
    try {
      const data = await api.modem(id);
      modem = data?.modem ?? null;
      missing = false;
      error = null;
      // A refetch never overwrites a form being edited.
      if (form === null && modem !== null) form = editable(modem);
    } catch (err) {
      error = messageOf(err);
      missing = /** @type {any} */ (err)?.status === 404;
    }
  }

  async function loadPhones() {
    try {
      phones = (await api.phones())?.phones ?? [];
    } catch {
      phones = []; // the page error explains the empty ring group
    }
  }

  async function loadDevices() {
    try {
      devices = (await api.scanLatest())?.scan?.unassigned ?? [];
    } catch {
      devices = [];
    }
  }

  $effect(() => {
    void id;
    void live.resume;
    void live.finished;
    void load();
    void loadPhones();
    void loadDevices();
  });

  /** The modem as it is now: what was fetched, with the newest observation of the stream over it. */
  const shown = $derived.by(() => {
    if (modem === null) return null;
    const seen = live.modems[modem.id];
    if (!seen) return modem;
    return { ...modem, state: seen.state ?? modem.state, rssi: seen.rssi, provider: seen.provider, number: seen.number,
      data_tty: seen.data_tty, observed_at: seen.observed_at, detail: seen.detail ?? modem.detail };
  });

  /** Summary radio line: a disabled modem keeps its radio off, confirmed only by the driver's `Radio off` state.
      `pending` marks a state not reached yet. */
  const radio = $derived.by(() => {
    if (shown === null || !shown.detail) return { text: orNone(null), pending: false };
    if (shown.detail.radio === null || shown.detail.radio === undefined) return { text: t('modem.radio_unsupported'), pending: true };
    if (shown.enabled) return { text: t('modem.radio_on'), pending: false };
    return shown.driver_state === 'Radio off' ? { text: t('modem.radio_off'), pending: false } : { text: t('modem.radio_off_pending'), pending: true };
  });

  /** What the registry would change to, as the fields the API takes; only what differs from the stored entry is sent. */
  const changes = $derived.by(() => {
    if (modem === null || form === null) return /** @type {Record<string, unknown>} */ ({});
    /** @type {Record<string, unknown>} */
    const out = {};
    if (form.driver !== modem.driver) out.driver = form.driver;
    if (form.imei !== modem.imei) out.imei = form.imei.trim();
    if (form.enabled !== modem.enabled) out.enabled = form.enabled;
    if (form.uac !== modem.uac) out.uac = form.uac;
    const port = form.usb_port.trim() === '' ? null : form.usb_port.trim();
    if (port !== modem.usb_port) out.usb_port = port;
    if (form.ring.join(',') !== (modem.ring ?? []).join(',')) out.ring = [...form.ring];
    const timeout = Number(form.ring_timeout);
    if (Number.isInteger(timeout) && timeout !== modem.ring_timeout) out.ring_timeout = timeout;
    const context = form.incoming_context.trim() === '' ? null : form.incoming_context.trim();
    if (context !== modem.incoming_context) out.incoming_context = context;
    const group = form.group.trim() === '' ? null : Number(form.group);
    if (group !== modem.group && (group === null || Number.isInteger(group))) out.group = group;
    const recipients = form.ownRecipients ? [...form.recipients] : null;
    const stored = modem.recipients === null ? null : [...modem.recipients];
    if (JSON.stringify(recipients) !== JSON.stringify(stored)) out.recipients = recipients;
    return out;
  });

  const dirty = $derived(Object.keys(changes).length > 0);

  /** Client-side checks for early feedback beside each field. */
  function check() {
    /** @type {{ path: string, message: string }[]} */
    const found = [];
    if (form === null) return found;
    if (!IMEI.test(form.imei.trim())) found.push({ path: 'imei', message: t('modems.imei_invalid') });
    const timeout = Number(form.ring_timeout);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) found.push({ path: 'ring_timeout', message: t('modem.ring_timeout_invalid') });
    if (form.group.trim() !== '' && !Number.isInteger(Number(form.group))) found.push({ path: 'group', message: t('modem.group_invalid') });
    if (form.uac && form.driver === 'dongle') found.push({ path: 'uac', message: t('modems.uac_quectel') });
    return found;
  }

  async function save(/** @type {SubmitEvent} */ event) {
    event.preventDefault();
    if (saving || !dirty) return;
    problems = check();
    refused = null;
    if (problems.length > 0) return;
    saving = true;
    try {
      const { applied } = await settleChange(await api.saveModem(id, changes));
      if (applied) {
        toasts.push({ kind: 'success', text: t('modem.saved') });
        form = null; // load() refills the form from the stored entry
      }
      await load();
    } catch (err) {
      problems = problemsOf(err);
      refused = messageOf(err);
    } finally {
      saving = false;
    }
  }

  async function remove() {
    deleting = true;
    try {
      const { applied } = await settleChange(await api.deleteModem(id));
      if (applied) {
        toasts.push({ kind: 'success', text: t('modem.deleted', { id }) });
        confirming = false;
        navigate('/modems');
        return;
      }
      await load();
    } catch (err) {
      refused = messageOf(err);
      confirming = false;
    } finally {
      deleting = false;
    }
  }

  /** Anything that would race the quick buttons: an action being sent, a Disable/Enable or a Save being applied. */
  const busy = $derived(acting !== null || toggling || saving);

  /** Disable/Enable from the quick buttons: saves only `enabled`, leaving other form edits pending (the form's checkbox
   *  is synced so it does not count as a change).
   *  @param {boolean} next */
  async function setEnabled(next) {
    if (busy) return;
    toggling = true;
    try {
      const { applied } = await settleChange(await api.saveModem(id, { enabled: next }));
      if (applied) {
        toasts.push({ kind: 'success', text: t(next ? 'modem.enabled_done' : 'modem.disabled_done') });
        if (form !== null) form.enabled = next;
      }
      await load();
    } catch (err) {
      toasts.push({ kind: 'error', text: messageOf(err) });
    } finally {
      toggling = false;
    }
  }

  /** @param {string} verb  one of ACTIONS */
  async function act(verb) {
    if (acting !== null) return;
    acting = verb;
    try {
      await api.modemAction(id, verb, TIMED.includes(verb) ? { when } : {});
      toasts.push({ text: t('modem.action_started', { action: t(`modem.action_${verb}`) }) });
    } catch (err) {
      toasts.push({ kind: 'error', text: messageOf(err) });
    } finally {
      acting = null;
    }
  }

  /** The verdict per condition: the stored one, unless a query this page just ran is newer (the refresher merges it in later). */
  const forwarding = $derived.by(() => {
    const stored = shown?.forwarding ?? null;
    if (ranForwarding === null) return stored;
    /** @type {Record<string, any>} */
    const merged = { ...stored };
    for (const [condition, verdict] of Object.entries(ranForwarding)) {
      const old = merged[condition];
      if (!old || (verdict.observed_at ?? 0) >= (old.observed_at ?? 0)) merged[condition] = verdict;
    }
    return merged;
  });

  /** Check reads every condition; the other actions change the one chosen in the form. @param {'set' | 'enable' | 'disable' | 'erase' | 'query'} action */
  async function forward(action) {
    if (forwardingBusy) return;
    forwardProblem = null;
    const number = forwardNumber.trim();
    if (action === 'set' && !FORWARD_NUMBER.test(number)) {
      forwardProblem = t('forwarding.number_invalid');
      return;
    }
    /** @type {Record<string, unknown>} */
    const body = { action, reason: action === 'query' ? 'all' : forwardReason };
    if (action === 'set') {
      body.number = number;
      if (FORWARD_TIMED.includes(forwardReason)) body.time = forwardTime;
    }
    forwardingBusy = true;
    try {
      const run = await runOperation(() => api.runForwarding(id, body));
      // Whatever the outcome, the result carries the queries it ran, which is what this panel shows.
      if (run.result?.forwarding) ranForwarding = { ...ranForwarding, ...run.result.forwarding };
      if (run.status === 'refused' || run.status === 'failed') forwardProblem = run.error;
      else if (run.status === 'pending') forwardProblem = t('op.still_running');
      else if (run.status === 'uncertain') forwardProblem = run.error ?? t('op.uncertain');
      await load();
    } finally {
      forwardingBusy = false;
    }
  }

  async function sendAt(/** @type {SubmitEvent} */ event) {
    event.preventDefault();
    if (atBusy) return;
    atProblem = null;
    atResult = null;
    const command = atCommand.trim();
    if (command === '') {
      atProblem = t('at.command_empty');
      return;
    }
    const timeout = atTimeout.trim() === '' ? undefined : Number(atTimeout);
    if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1 || timeout > 60)) {
      atProblem = t('at.timeout_invalid');
      return;
    }
    atBusy = true;
    try {
      const run = await runOperation(() => api.at(id, timeout === undefined ? { command } : { command, timeout }));
      atResult = run.result;
      atProblem = run.status === 'done' ? null : (run.error ?? (run.status === 'pending' ? t('op.still_running') : t('op.uncertain')));
    } finally {
      atBusy = false;
    }
  }

  async function sendUssd(/** @type {SubmitEvent} */ event) {
    event.preventDefault();
    if (ussdBusy) return;
    ussdProblem = null;
    ussdResult = null;
    const code = ussdCode.trim();
    if (!USSD_CODE.test(code)) {
      ussdProblem = t('ussd.code_invalid');
      return;
    }
    ussdBusy = true;
    try {
      const run = await runOperation(() => api.ussd(id, { code }));
      ussdResult = run.result;
      ussdProblem = run.status === 'done' ? null : (run.error ?? (run.status === 'pending' ? t('op.still_running') : t('op.uncertain')));
    } finally {
      ussdBusy = false;
    }
  }

  const history = $derived(live.historyOf(id));
  /** Free ports from the last scan plus this modem's current one. */
  const ports = $derived.by(() => {
    const free = devices.map((device) => device.usb_port).filter((port) => typeof port === 'string' && port !== '');
    const own = form?.usb_port ?? '';
    return own !== '' && !free.includes(own) ? [own, ...free] : free;
  });
</script>

{#if missing}
  <section class="card p-6">
    <h1 class="text-xl font-semibold">{t('modem.not_found')}</h1>
    <p class="mt-2 text-slate-600">{error}</p>
    <a class="btn btn-plain mt-4" href="/modems">{t('modem.back')}</a>
  </section>
{:else}
  <div class="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
    <a class="-my-2 inline-flex min-h-11 items-center text-sm text-sky-800 underline-offset-2 hover:underline" href="/modems">← {t('nav.modems')}</a>
    <h1 class="min-w-0 flex-1 truncate text-xl font-semibold tracking-tight md:text-2xl">{id}</h1>
    {#if shown !== null}<StateBadge state={shown.state} />{/if}
  </div>

  {#if error !== null && !missing}
    <p class="card mb-4 border-rose-200 bg-rose-50 p-4 text-rose-900" role="alert">{error}</p>
  {/if}

  {#if shown === null}
    <p class="card p-6 text-center text-slate-500">{t('app.loading')}</p>
  {:else}
    <div class="flex flex-col gap-3">
      <section class="card p-4">
        <h2 class="sr-only">{t('modem.summary')}</h2>
        <dl class="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
          <div class="flex items-center justify-between gap-3">
            <dt class="text-slate-500">{t('modem.signal')}</dt>
            <dd><SignalBars rssi={shown.rssi} /></dd>
          </div>
          <div class="flex items-center justify-between gap-3">
            <dt class="text-slate-500">{t('modem.provider')}</dt>
            <dd class="min-w-0 truncate">{orNone(shown.provider)}</dd>
          </div>
          <div class="flex items-center justify-between gap-3">
            <dt class="text-slate-500">{t('modem.number')}</dt>
            <dd class="min-w-0 truncate tabular-nums">{orNone(shown.number)}</dd>
          </div>
          <div class="flex items-center justify-between gap-3">
            <dt class="text-slate-500">{t('device.tty')}</dt>
            <dd class="min-w-0 truncate font-mono text-xs">{orNone(shown.data_tty)}</dd>
          </div>
          <div class="flex items-center justify-between gap-3">
            <dt class="text-slate-500">{t('modem.driver_state')}</dt>
            <dd class="min-w-0 truncate">{orNone(shown.driver_state)}</dd>
          </div>
          <div class="flex items-center justify-between gap-3">
            <dt class="text-slate-500">{t('modem.radio')}</dt>
            <dd class="min-w-0 truncate text-right {radio.pending ? 'text-amber-800' : ''}">{radio.text}</dd>
          </div>
          <div class="flex items-center justify-between gap-3">
            <dt class="text-slate-500">{t('modem.seen')}</dt>
            <dd>{shown.observed_at ? ago(shown.observed_at) : t('modem.never_seen')}</dd>
          </div>
        </dl>
        <!-- Quick actions: Start, Restart and Disable/Enable. Start is hidden while disabled (Enable brings the radio back,
             and is the primary button then). Two per row on a phone, one row from `sm`. -->
        <div
          class="mt-3 grid grid-cols-2 gap-2 border-t border-slate-200 pt-3 *:px-2 [&>:last-child:nth-child(odd)]:col-span-2
            sm:flex sm:flex-wrap sm:*:px-4"
          role="group"
          aria-label={t('modem.quick_actions')}
        >
          {#if shown.enabled}
            <button type="button" class="btn btn-plain w-full sm:w-auto" disabled={busy} onclick={() => act('start')}>
              <ActionIcon name="start" />{t('modem.action_start')}
            </button>
          {/if}
          <button type="button" class="btn btn-plain w-full sm:w-auto" disabled={busy} onclick={() => act('restart')}>
            <ActionIcon name="restart" />{t('modem.action_restart')}
          </button>
          <button
            type="button"
            class="btn w-full sm:w-auto {shown.enabled ? 'btn-danger' : 'btn-primary'}"
            disabled={busy}
            onclick={() => setEnabled(!shown.enabled)}
          >
            <ActionIcon name={shown.enabled ? 'disable' : 'enable'} />
            {toggling ? t('common.saving') : shown.enabled ? t('modem.action_disable') : t('modem.action_enable')}
          </button>
        </div>
      </section>

      <Section id="modem-settings" title={t('modem.settings')} subtitle={t('modem.settings_hint')}>
        <form id="modem-form" class="flex flex-col gap-4" onsubmit={save} novalidate>
          {#if refused !== null}
            <p class="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900" role="alert">{refused}</p>
          {/if}
          {#each problemsElsewhere(problems, FIELDS) as problem (problem.path + problem.message)}
            <p class="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900">{problem.path}: {problem.message}</p>
          {/each}

          {#if form !== null}
            <Field id="modem-id" label={t('modems.id')} hint={t('modem.id_fixed')}>
              {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
                <input id="modem-id" class="input bg-slate-50" value={id} readonly aria-describedby={field.describedBy} />
              {/snippet}
            </Field>

            <Field id="modem-driver" label={t('device.driver')} problems={problemsFor(problems, 'driver')}>
              {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
                <select id="modem-driver" class="input" bind:value={form.driver} aria-describedby={field.describedBy}>
                  <option value="quectel">quectel</option>
                  <option value="dongle">dongle</option>
                </select>
              {/snippet}
            </Field>

            <Field id="modem-imei" label={t('device.imei')} problems={problemsFor(problems, 'imei')}>
              {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
                <input id="modem-imei" class="input tabular-nums" bind:value={form.imei} inputmode="numeric" maxlength="15" autocomplete="off" aria-describedby={field.describedBy} />
              {/snippet}
            </Field>

            <Field id="modem-port" label={t('modem.port')} hint={t('modems.port_hint')} problems={problemsFor(problems, 'usb_port')}>
              {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
                <div class="flex gap-2">
                  <input id="modem-port" class="input tabular-nums" bind:value={form.usb_port} autocomplete="off" spellcheck="false" aria-describedby={field.describedBy} />
                  {#if ports.length > 0}
                    <select class="input w-auto shrink-0" aria-label={t('modem.port_from_scan')} value="" onchange={(event) => { form.usb_port = event.currentTarget.value; event.currentTarget.value = ''; }}>
                      <option value="">{t('modem.port_from_scan')}</option>
                      {#each ports as port (port)}
                        <option value={port}>{port}</option>
                      {/each}
                    </select>
                  {/if}
                </div>
              {/snippet}
            </Field>

            <fieldset>
              <legend class="mb-1 block font-medium">{t('modem.ring_group')}</legend>
              {#if phones.length === 0}
                <p class="text-sm text-slate-500">{t('modem.ring_no_phones')}</p>
              {:else}
                <!-- a grid of phones: each cell fits a 6-digit number with its label truncated below -->
                <ul class="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-x-4">
                  {#each phones as phone (phone.number)}
                    <li class="min-w-0">
                      <label class="flex min-h-11 items-center gap-3" title={phone.label ?? undefined}>
                        <input
                          type="checkbox"
                          class="h-5 w-5"
                          checked={form.ring.includes(phone.number)}
                          onchange={(event) => {
                            form.ring = event.currentTarget.checked
                              ? [...form.ring, phone.number]
                              : form.ring.filter((/** @type {string} */ number) => number !== phone.number);
                          }}
                        />
                        <span class="flex min-w-0 flex-col">
                          <span class="tabular-nums">{phone.number}</span>
                          {#if phone.label}<span class="truncate text-xs text-slate-500">{phone.label}</span>{/if}
                        </span>
                      </label>
                    </li>
                  {/each}
                </ul>
              {/if}
              {#each problemsFor(problems, 'ring') as problem (problem.message)}
                <p class="mt-1 text-sm text-rose-800">{problem.message}</p>
              {/each}
            </fieldset>

            <Field id="modem-ring-timeout" label={t('modem.ring_timeout')} problems={problemsFor(problems, 'ring_timeout')}>
              {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
                <input id="modem-ring-timeout" class="input tabular-nums" bind:value={form.ring_timeout} inputmode="numeric" aria-describedby={field.describedBy} />
              {/snippet}
            </Field>

            <Field id="modem-context" label={t('modem.incoming_context')} hint={t('modem.incoming_context_hint')} problems={problemsFor(problems, 'incoming_context')}>
              {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
                <input id="modem-context" class="input font-mono" bind:value={form.incoming_context} autocomplete="off" spellcheck="false" placeholder="aster-ring-{id}" aria-describedby={field.describedBy} />
              {/snippet}
            </Field>

            <Field id="modem-group" label={t('modem.group')} hint={t('modem.group_hint')} problems={problemsFor(problems, 'group')}>
              {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
                <input id="modem-group" class="input tabular-nums" bind:value={form.group} inputmode="numeric" aria-describedby={field.describedBy} />
              {/snippet}
            </Field>

            <div>
              <label class="flex min-h-11 items-center gap-3">
                <input type="checkbox" class="h-5 w-5" bind:checked={form.enabled} aria-describedby="modem-enabled-hint" />
                <span>{t('modems.enabled')}</span>
              </label>
              <p id="modem-enabled-hint" class="text-sm text-slate-500">{t('modem.enabled_hint')}</p>
            </div>

            <label class="flex min-h-11 items-center gap-3">
              <input type="checkbox" class="h-5 w-5" bind:checked={form.uac} disabled={form.driver === 'dongle'} />
              <span>{t('modems.uac')}</span>
            </label>
            {#each problemsFor(problems, 'uac') as problem (problem.message)}
              <p class="-mt-2 text-sm text-rose-800">{problem.message}</p>
            {/each}

            <div>
              <label class="flex min-h-11 items-center gap-3">
                <input type="checkbox" class="h-5 w-5" bind:checked={form.ownRecipients} />
                <span>{t('modem.own_recipients')}</span>
              </label>
              <p class="mb-2 text-sm text-slate-500">{t('modem.recipients_hint')}</p>
              {#if form.ownRecipients}
                <ChipList
                  id="modem-recipients"
                  items={form.recipients}
                  pattern={/^-?[0-9]{1,20}$/}
                  inputmode="numeric"
                  placeholder={t('settings.chat_id')}
                  onchange={(items) => (form.recipients = items)}
                />
              {/if}
              {#each problemsFor(problems, 'recipients') as problem (problem.message)}
                <p class="mt-1 text-sm text-rose-800">{problem.message}</p>
              {/each}
            </div>
          {/if}
        </form>
      </Section>

      <Section id="modem-actions" title={t('modem.actions')} subtitle={t('modem.actions_hint')}>
        <div class="flex flex-col gap-3">
          {#if !shown.enabled}
            <!-- a disabled modem stays supervised by its driver (radio off); Stop would let it register again after a restart -->
            <p class="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{t('modem.actions_disabled', { stop: t('modem.action_stop') })}</p>
          {/if}
          <Field id="modem-when" label={t('modem.when')} hint={t('modem.when_hint')}>
            {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
              <select id="modem-when" class="input" bind:value={when} aria-describedby={field.describedBy}>
                {#each WHEN as option (option)}
                  <option value={option}>{t(`modem.when_${option.replace(' ', '_')}`)}</option>
                {/each}
              </select>
            {/snippet}
          </Field>
          <!-- Start/Stop on one row, recovery actions on the next; two buttons per row on a phone. -->
          {#each ACTION_ROWS as row, index (index)}
            <div class="grid grid-cols-2 gap-2 *:px-2 [&>:last-child:nth-child(odd)]:col-span-2 sm:flex sm:flex-wrap sm:*:px-4">
              {#each row as action (action)}
                <button type="button" class="btn {ACTION_STYLE[action]} w-full sm:w-auto" disabled={acting !== null} onclick={() => act(action)}>
                  <ActionIcon name={action} />{t(`modem.action_${action}`)}
                </button>
              {/each}
            </div>
          {/each}
        </div>
      </Section>

      <Section id="modem-forwarding" title={t('forwarding.title')} subtitle={t('forwarding.hint')}>
        <div class="flex flex-col gap-3">
          <!-- Only a state the modem answered in a query is shown as verified. -->
          {#if forwarding === null}
            <p class="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{t('forwarding.never')}</p>
          {:else}
            <dl class="divide-y divide-slate-200 rounded-lg bg-slate-50 text-sm">
              {#each FORWARD_CONDITIONS as condition (condition)}
                {@const verdict = forwarding[condition] ?? null}
                <div class="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                  <dt class="font-medium">{t(`forwarding.reason_${condition}`)}</dt>
                  <dd class="min-w-0 break-words sm:text-right">
                    {#if verdict === null}
                      <span class="text-slate-500">{t('forwarding.not_checked')}</span>
                    {:else if verdict.verified}
                      <span class={verdict.enabled ? 'font-medium text-emerald-800' : 'text-slate-700'}>
                        {#if !verdict.enabled}
                          {t('forwarding.off')}
                        {:else if verdict.time}
                          {t('forwarding.on_after', { number: orNone(verdict.number), time: verdict.time })}
                        {:else}
                          {t('forwarding.on', { number: orNone(verdict.number) })}
                        {/if}
                      </span>
                      <!-- Forwarding the operator keeps for other kinds of calls on the same condition, e.g. video calls to its own service. -->
                      {#each (verdict.entries ?? []).filter((/** @type {any} */ entry) => entry.status === 1 && (entry.class & 1) === 0 && entry.number !== verdict.number) as other, index (index)}
                        <span class="block text-xs text-slate-600">{t('forwarding.other_services', { number: orNone(other.number) })}</span>
                      {/each}
                    {:else}
                      <span class="font-medium text-amber-800">{t('forwarding.unverified')}</span>
                      <span class="block text-amber-900">{t(`forwarding.outcome_${verdict.outcome ?? 'uncertain'}`)}{verdict.error ? `: ${verdict.error}` : ''}</span>
                    {/if}
                    {#if verdict !== null}
                      <span class="block text-xs text-slate-500">{t('forwarding.checked', { when: dateTime(verdict.observed_at) })}</span>
                    {/if}
                  </dd>
                </div>
              {/each}
            </dl>
            {#if forwarding.unconditional?.verified && forwarding.unconditional.enabled}
              <p class="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{t('forwarding.always_wins')}</p>
            {/if}
          {/if}
          <button type="button" class="btn btn-plain w-full sm:w-auto sm:self-start" disabled={forwardingBusy} onclick={() => forward('query')}>
            {forwardingBusy ? t('common.working') : t('forwarding.query')}
          </button>

          <Field id="forward-reason" label={t('forwarding.condition')}>
            {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
              <select id="forward-reason" class="input" bind:value={forwardReason} aria-describedby={field.describedBy}>
                {#each FORWARD_REASONS as reason (reason)}
                  <option value={reason}>{t(`forwarding.reason_${reason}`)}</option>
                {/each}
              </select>
            {/snippet}
          </Field>
          <div class="grid gap-3 sm:grid-cols-2">
            <Field id="forward-number" label={t('forwarding.number')} hint={t('forwarding.number_hint')}>
              {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
                <input id="forward-number" class="input tabular-nums" bind:value={forwardNumber} inputmode="tel" autocomplete="off" placeholder="+1234567890" aria-describedby={field.describedBy} />
              {/snippet}
            </Field>
            {#if FORWARD_TIMED.includes(forwardReason)}
              <Field id="forward-time" label={t('forwarding.time')} hint={t('forwarding.time_hint')}>
                {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
                  <select id="forward-time" class="input tabular-nums" bind:value={forwardTime} aria-describedby={field.describedBy}>
                    {#each FORWARD_TIMES as seconds (seconds)}
                      <option value={seconds}>{t('forwarding.seconds', { n: seconds })}</option>
                    {/each}
                  </select>
                {/snippet}
              </Field>
            {/if}
          </div>

          {#if forwardProblem !== null}
            <p class="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900" role="alert">{forwardProblem}</p>
          {/if}

          <!-- Set is the main action; Erase deletes the number, so it is red and set apart (Disable keeps it). -->
          <div class="grid grid-cols-2 gap-2 *:px-2 sm:flex sm:flex-wrap sm:*:px-4">
            <button type="button" class="btn btn-primary w-full sm:w-auto" disabled={forwardingBusy} onclick={() => forward('set')}>{t('forwarding.set')}</button>
            <button type="button" class="btn btn-plain w-full sm:w-auto" disabled={forwardingBusy} onclick={() => forward('enable')}>{t('forwarding.enable')}</button>
            <button type="button" class="btn btn-plain w-full sm:w-auto" disabled={forwardingBusy} onclick={() => forward('disable')}>{t('forwarding.disable')}</button>
            <button type="button" class="btn btn-danger w-full sm:ml-auto sm:w-auto" disabled={forwardingBusy} onclick={() => forward('erase')}>{t('forwarding.erase')}</button>
          </div>
        </div>
      </Section>

      <Section id="modem-ussd" title={t('ussd.title')} subtitle={t('ussd.hint')}>
        <form class="flex flex-col gap-3" onsubmit={sendUssd} novalidate>
          <Field id="ussd-code" label={t('ussd.code')}>
            {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
              <input id="ussd-code" class="input tabular-nums" bind:value={ussdCode} inputmode="tel" autocomplete="off" placeholder="*100#" aria-describedby={field.describedBy} />
            {/snippet}
          </Field>
          {#if ussdProblem !== null}
            <p class="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900" role="alert">{ussdProblem}</p>
          {/if}
          {#if ussdResult !== null}
            <div class="rounded-lg bg-slate-50 px-3 py-2 text-sm">
              <p class="font-medium">{t('ussd.answer')}</p>
              <p class="mt-1 break-words whitespace-pre-wrap">{ussdResult.text ?? t('common.none')}</p>
            </div>
          {/if}
          <button type="submit" class="btn btn-primary w-full sm:w-auto sm:self-start" disabled={ussdBusy}>
            {ussdBusy ? t('common.working') : t('ussd.send')}
          </button>
        </form>
      </Section>

      <Section id="modem-at" title={t('at.title')} subtitle={t('at.hint')}>
        <form class="flex flex-col gap-3" onsubmit={sendAt} novalidate>
          <Field id="at-command" label={t('at.command')}>
            {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
              <input id="at-command" class="input font-mono" bind:value={atCommand} autocomplete="off" spellcheck="false" placeholder="AT+CSQ" aria-describedby={field.describedBy} />
            {/snippet}
          </Field>
          <Field id="at-timeout" label={t('at.timeout')} hint={t('at.timeout_hint')}>
            {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
              <input id="at-timeout" class="input tabular-nums" bind:value={atTimeout} inputmode="numeric" aria-describedby={field.describedBy} />
            {/snippet}
          </Field>
          {#if atProblem !== null}
            <p class="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900" role="alert">{atProblem}</p>
          {/if}
          {#if atResult !== null}
            <div class="rounded-lg bg-slate-50 px-3 py-2 text-sm">
              <p class="font-medium">{t('at.answer', { outcome: atResult.outcome ?? '' })}</p>
              <pre class="mt-1 overflow-x-auto font-mono text-xs">{(atResult.lines ?? []).join('\n') || t('at.no_lines')}</pre>
              {#if atResult.reply}<p class="mt-1 text-slate-500">{atResult.reply}</p>{/if}
            </div>
          {/if}
          <button type="submit" class="btn btn-primary w-full sm:w-auto sm:self-start" disabled={atBusy}>
            {atBusy ? t('common.working') : t('at.send')}
          </button>
        </form>
      </Section>

      <Section id="modem-history" title={t('modem.history')} subtitle={t('modem.history_hint')}>
        {#if history.length === 0}
          <p class="text-sm text-slate-500">{t('modem.history_empty')}</p>
        {:else}
          <ol class="flex flex-wrap gap-2">
            {#each history as entry, index (entry.at + '-' + index)}
              <li class="flex items-center gap-1.5">
                <StateBadge state={entry.state} />
                <span class="text-xs text-slate-500 tabular-nums">{time(entry.at)}</span>
              </li>
            {/each}
          </ol>
        {/if}
      </Section>
    </div>

    <StickyActions floating={dirty}>
      <button type="button" class="btn btn-danger mr-auto" onclick={() => (confirming = true)}>{t('modem.delete')}</button>
      <button type="submit" form="modem-form" class="btn btn-primary" disabled={saving || !dirty}>
        {saving ? t('common.saving') : dirty ? t('common.save') : t('common.saved')}
      </button>
    </StickyActions>
  {/if}
{/if}

<Confirm
  bind:open={confirming}
  title={t('modem.delete_title', { id })}
  text={t('modem.delete_text')}
  confirmLabel={t('modem.delete')}
  danger
  busy={deleting}
  onconfirm={remove}
/>

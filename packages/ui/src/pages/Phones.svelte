<!-- Phones page: the registry's PJSIP phones, with ring groups derived from the modems (edited via `rings_for`) and live
     registrations/calls. The number is fixed after creation; a phone that a modem rings cannot be deleted. -->
<script>
  import { api } from '../api.js';
  import { t } from '../i18n/index.js';
  import Confirm from '../lib/Confirm.svelte';
  import Dialog from '../lib/Dialog.svelte';
  import Field from '../lib/Field.svelte';
  import ResponsiveTable from '../lib/ResponsiveTable.svelte';
  import StickyActions from '../lib/StickyActions.svelte';
  import { messageOf, problemsElsewhere, problemsFor, problemsOf } from '../lib/errors.js';
  import { orNone, time } from '../lib/format.js';
  import { live } from '../lib/live.svelte.js';
  import { settleChange } from '../lib/ops.js';
  import { toasts } from '../lib/toasts.svelte.js';

  /** The patterns: the number is an extension of 3 to 6 digits, the secret printable ASCII without a space or `;`. */
  const NUMBER = /^[0-9]{3,6}$/;
  const SECRET = /^[\x21-\x3a\x3c-\x7e]{1,128}$/;
  const FIELDS = Object.freeze(['number', 'secret', 'label', 'outbound', 'rings_for', 'context', 'direct_media']);

  /** @type {any[]} */
  let phones = $state([]);
  /** @type {any[]} */
  let modems = $state([]);
  /** @type {string | null} */
  let error = $state(null);
  let loading = $state(false);
  /** Registrations and calls by phone number; null while Asterisk cannot be asked. @type {Record<string, any> | null} */
  let connections = $state(null);
  /** @type {string | null} */
  let connectionsError = $state(null);
  let connectionsRead = 0;

  let open = $state(false);
  let saving = $state(false);
  /** The number being edited, or null while a new phone is being added. */
  let editing = $state(/** @type {string | null} */ (null));
  let showSecret = $state(false);
  /** @type {{ path: string, message: string }[]} */
  let problems = $state([]);
  /** @type {string | null} */
  let refused = $state(null);
  let form = $state(blank());

  /** The phone being confirmed, kept separate from `open` so it outlives the closing animation. */
  let confirming = $state(/** @type {any | null} */ (null));
  let confirmOpen = $state(false);
  let deleting = $state(false);

  function blank() {
    return { number: '', secret: '', label: '', outbound: '', rings_for: /** @type {string[]} */ ([]), context: '', direct_media: false };
  }

  async function load() {
    loading = true;
    try {
      const data = await api.phones();
      phones = data?.phones ?? [];
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
      modems = []; // "dials out through" then offers only "internal only"
    }
  }

  $effect(() => {
    void live.resume;
    void live.finished;
    void load();
    void loadModems();
  });

  async function loadConnections() {
    const read = ++connectionsRead;
    try {
      const data = await api.connections();
      if (read !== connectionsRead) return; // a newer answer is on its way
      connections = data?.available ? Object.fromEntries(data.phones.map((/** @type {any} */ entry) => [entry.number, entry])) : null;
      connectionsError = data?.available ? null : (data?.error ?? null);
    } catch (err) {
      if (read !== connectionsRead) return;
      connections = null;
      connectionsError = messageOf(err);
    }
  }

  $effect(() => {
    void live.resume;
    void live.finished;
    void live.phones;
    void loadConnections();
  });

  /** @param {{ address: string, port: number | null }} contact */
  const address = (contact) => {
    const host = contact.address.includes(':') ? `[${contact.address}]` : contact.address;
    return contact.port === null ? host : `${host}:${contact.port}`;
  };

  /** @param {{ state: string, number: string | null, name: string | null, since: number }} call */
  const callText = (call) => {
    const who = call.number !== null && call.name !== null ? `${call.name} (${call.number})` : (call.number ?? call.name ?? t('phones.call_unknown'));
    return t(`phones.call_${call.state}`, { who });
  };

  /** @param {any | null} phone  null: a new phone */
  function edit(phone) {
    problems = [];
    refused = null;
    showSecret = false;
    editing = phone === null ? null : phone.number;
    form = phone === null
      ? blank()
      : { number: phone.number, secret: phone.secret ?? '', label: phone.label ?? '', outbound: phone.outbound ?? '',
          rings_for: [...(phone.rings_for ?? [])], context: phone.context ?? '', direct_media: Boolean(phone.direct_media) };
    open = true;
  }

  function check() {
    /** @type {{ path: string, message: string }[]} */
    const found = [];
    if (editing === null && !NUMBER.test(form.number.trim())) found.push({ path: 'number', message: t('phones.number_invalid') });
    if (!SECRET.test(form.secret)) found.push({ path: 'secret', message: t('phones.secret_invalid') });
    return found;
  }

  /** All fields for a new phone; only changed fields (never the number) for an edit. */
  function body() {
    const label = form.label.trim() === '' ? null : form.label.trim();
    const context = form.context.trim() === '' ? null : form.context.trim();
    const outbound = form.outbound === '' ? null : form.outbound;
    if (editing === null) {
      return { number: form.number.trim(), secret: form.secret, label, outbound, rings_for: [...form.rings_for], context, direct_media: form.direct_media };
    }
    const stored = phones.find((phone) => phone.number === editing);
    /** @type {Record<string, unknown>} */
    const out = {};
    if (form.secret !== (stored?.secret ?? '')) out.secret = form.secret;
    if (label !== (stored?.label ?? null)) out.label = label;
    if (outbound !== (stored?.outbound ?? null)) out.outbound = outbound;
    // Compare as a set: a different tick order is not a change.
    const storedRings = stored?.rings_for ?? [];
    if (form.rings_for.length !== storedRings.length || form.rings_for.some((/** @type {string} */ id) => !storedRings.includes(id))) {
      out.rings_for = [...form.rings_for];
    }
    if (context !== (stored?.context ?? null)) out.context = context;
    if (form.direct_media !== Boolean(stored?.direct_media)) out.direct_media = form.direct_media;
    return out;
  }

  async function submit(/** @type {SubmitEvent} */ event) {
    event.preventDefault();
    if (saving) return;
    problems = check();
    refused = null;
    if (problems.length > 0) return;
    const fields = body();
    // Skip the request when nothing changed (the API refuses an empty body).
    if (editing !== null && Object.keys(fields).length === 0) {
      open = false;
      return;
    }
    saving = true;
    const number = editing ?? form.number.trim();
    try {
      const answer = editing === null ? await api.addPhone(fields) : await api.savePhone(editing, fields);
      const { applied } = await settleChange(answer);
      await load();
      if (applied) {
        toasts.push({ kind: 'success', text: editing === null ? t('phones.added', { number }) : t('phones.saved', { number }) });
        open = false;
      }
    } catch (err) {
      problems = problemsOf(err);
      refused = messageOf(err);
    } finally {
      saving = false;
    }
  }

  async function remove() {
    if (confirming === null) return;
    const number = confirming.number;
    deleting = true;
    try {
      const { applied } = await settleChange(await api.deletePhone(number));
      await load();
      if (applied) {
        toasts.push({ kind: 'success', text: t('phones.deleted', { number }) });
        confirmOpen = false;
      }
    } catch (err) {
      confirmOpen = false;
      toasts.push({ kind: 'error', text: messageOf(err) });
    } finally {
      deleting = false;
    }
  }

  const columns = $derived([
    { key: 'number', label: t('phones.number'), primary: true },
    { key: 'connected', label: t('phones.connected') },
    { key: 'label', label: t('phones.label') },
    { key: 'outbound', label: t('phones.outbound') },
    { key: 'rings', label: t('phones.rings_for') },
    { key: 'context', label: t('phones.context') },
    { key: 'direct_media', label: t('phones.direct_media') },
  ]);
</script>

<h1 class="mb-4 hidden text-2xl font-semibold tracking-tight md:block">{t('phones.title')}</h1>

{#if error !== null}
  <p class="card mb-4 border-rose-200 bg-rose-50 p-4 text-rose-900" role="alert">{error}</p>
{/if}

{#if connectionsError !== null}
  <p class="card mb-4 border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{t('phones.connections_unknown', { error: connectionsError })}</p>
{/if}

<section class="list-panel" aria-labelledby="phones-heading">
  <h2 id="phones-heading" class="sr-only">{t('phones.title')}</h2>
  <ResponsiveTable
    {columns}
    rows={phones}
    rowKey={(phone) => phone.number}
    label={t('phones.title')}
    empty={loading && phones.length === 0 ? t('app.loading') : t('phones.none')}
    tableFrom="56rem"
  >
    {#snippet cell(/** @type {any} */ phone, /** @type {{ key: string }} */ column)}
      {#if column.key === 'number'}
        <span class="tabular-nums">{phone.number}</span>
      {:else if column.key === 'connected'}
        {@const link = connections?.[phone.number]}
        {#if connections === null}
          <span class="text-slate-500">{t('phones.connected_unknown')}</span>
        {:else}
          {#each link?.calls ?? [] as call, index (index)}
            <span class="block font-medium text-sky-800 wrap-anywhere">{callText(call)}</span>
            <span class="block text-xs text-slate-500 tabular-nums">{t('phones.call_since', { time: time(call.since) })}</span>
          {/each}
          {#each link?.contacts ?? [] as contact, index (index)}
            <span class="block wrap-anywhere">
              <span class="mr-1.5 inline-block h-2 w-2 rounded-full align-middle {contact.reachable === false ? 'bg-amber-500' : 'bg-emerald-500'}" aria-hidden="true"></span>{contact.user_agent ?? t('phones.unknown_app')}
            </span>
            <span class="block text-xs text-slate-500 tabular-nums wrap-anywhere">
              {address(contact)}{contact.reachable === false ? ` · ${t('phones.not_answering')}` : contact.rtt_ms !== null ? ` · ${contact.rtt_ms} ms` : ''}
            </span>
          {:else}
            <span class="text-slate-500">{t('phones.not_connected')}</span>
          {/each}
        {/if}
      {:else if column.key === 'label'}
        {orNone(phone.label)}
      {:else if column.key === 'outbound'}
        {phone.outbound ?? t('phones.internal_only')}
      {:else if column.key === 'rings'}
        {#if phone.rings_for?.length > 0}
          <span class="inline-flex flex-wrap justify-end gap-1">
            {#each phone.rings_for as modem (modem)}
              <a class="inline-flex min-h-8 items-center rounded-full bg-slate-100 px-3 text-sm ring-1 ring-slate-300 ring-inset hover:bg-slate-200 md:min-h-0 md:px-2 md:py-0.5 md:text-xs" href="/modems/{encodeURIComponent(modem)}">{modem}</a>
            {/each}
          </span>
        {:else}
          {t('common.none')}
        {/if}
      {:else if column.key === 'context'}
        <span class="font-mono text-xs">{orNone(phone.context)}</span>
      {:else if column.key === 'direct_media'}
        {phone.direct_media ? t('common.yes') : t('common.no')}
      {/if}
    {/snippet}

    {#snippet actions(/** @type {any} */ phone)}
      <button type="button" class="btn btn-plain px-3 text-sm" onclick={() => edit(phone)}>{t('common.edit')}</button>
      <button
        type="button"
        class="btn btn-danger px-3 text-sm"
        onclick={() => {
          confirming = phone;
          confirmOpen = true;
        }}
      >
        {t('common.delete')}
      </button>
    {/snippet}
  </ResponsiveTable>
</section>

<StickyActions>
  <button type="button" class="btn btn-primary" onclick={() => edit(null)}>{t('phones.add')}</button>
</StickyActions>

<Dialog bind:open title={editing === null ? t('phones.add_title') : t('phones.edit_title', { number: editing })}>
  <form id="phone-form" class="flex flex-col gap-4" onsubmit={submit} novalidate>
    {#if refused !== null}
      <p class="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900" role="alert">{refused}</p>
    {/if}
    {#each problemsElsewhere(problems, FIELDS) as problem (problem.path + problem.message)}
      <p class="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900">{problem.path}: {problem.message}</p>
    {/each}

    <Field
      id="phone-number"
      label={t('phones.number')}
      hint={editing === null ? t('phones.number_hint') : t('phones.number_fixed')}
      problems={problemsFor(problems, 'number')}
    >
      {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
        <input
          id="phone-number"
          class="input tabular-nums {editing === null ? '' : 'bg-slate-50'}"
          bind:value={form.number}
          readonly={editing !== null}
          inputmode="numeric"
          maxlength="6"
          autocomplete="off"
          aria-describedby={field.describedBy}
        />
      {/snippet}
    </Field>

    <Field id="phone-secret" label={t('phones.secret')} hint={t('phones.secret_hint')} problems={problemsFor(problems, 'secret')}>
      {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
        <div class="flex gap-2">
          <input
            id="phone-secret"
            class="input font-mono"
            type={showSecret ? 'text' : 'password'}
            bind:value={form.secret}
            autocomplete="off"
            spellcheck="false"
            aria-describedby={field.describedBy}
          />
          <button type="button" class="btn btn-plain shrink-0" aria-pressed={showSecret} onclick={() => (showSecret = !showSecret)}>
            {showSecret ? t('common.hide') : t('common.show')}
          </button>
        </div>
      {/snippet}
    </Field>

    <Field id="phone-label" label={t('phones.label')} problems={problemsFor(problems, 'label')}>
      {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
        <input id="phone-label" class="input" bind:value={form.label} maxlength="64" aria-describedby={field.describedBy} />
      {/snippet}
    </Field>

    <Field id="phone-outbound" label={t('phones.outbound')} hint={t('phones.outbound_hint')} problems={problemsFor(problems, 'outbound')}>
      {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
        <select id="phone-outbound" class="input" bind:value={form.outbound} aria-describedby={field.describedBy}>
          <option value="">{t('phones.internal_only')}</option>
          {#each modems as modem (modem.id)}
            <option value={modem.id}>{modem.id}</option>
          {/each}
        </select>
      {/snippet}
    </Field>

    <fieldset>
      <legend class="mb-1 block font-medium">{t('phones.rings_for')}</legend>
      <p class="mb-1 text-sm text-slate-500">{t('phones.rings_for_hint')}</p>
      {#if modems.length === 0}
        <p class="text-sm text-slate-500">{t('phones.rings_for_no_modems')}</p>
      {:else}
        <ul class="flex flex-col">
          {#each modems as modem (modem.id)}
            <li>
              <label class="flex min-h-11 items-center gap-3">
                <input
                  type="checkbox"
                  class="h-5 w-5"
                  checked={form.rings_for.includes(modem.id)}
                  onchange={(event) => {
                    form.rings_for = event.currentTarget.checked
                      ? [...form.rings_for, modem.id]
                      : form.rings_for.filter((/** @type {string} */ id) => id !== modem.id);
                  }}
                />
                <span class="min-w-0 truncate">{modem.id}</span>
              </label>
              {#if modem.incoming_context}
                <!-- the generated ring group is only dialed while incoming_context is null -->
                <p class="mb-1 ml-8 text-sm text-amber-900">{t('phones.rings_for_own_context', { context: modem.incoming_context })}</p>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#each problemsFor(problems, 'rings_for') as problem (problem.message)}
        <p class="mt-1 text-sm text-rose-800">{problem.message}</p>
      {/each}
    </fieldset>

    <Field id="phone-context" label={t('phones.context')} hint={t('phones.context_hint')} problems={problemsFor(problems, 'context')}>
      {#snippet children(/** @type {{ describedBy: string | undefined }} */ field)}
        <input id="phone-context" class="input font-mono" bind:value={form.context} autocomplete="off" spellcheck="false" aria-describedby={field.describedBy} />
      {/snippet}
    </Field>

    <label class="flex min-h-11 items-center gap-3">
      <input type="checkbox" class="h-5 w-5" bind:checked={form.direct_media} />
      <span>{t('phones.direct_media')}</span>
    </label>
    <p class="-mt-2 text-sm text-slate-500">{t('phones.direct_media_hint')}</p>
  </form>

  {#snippet footer()}
    <div class="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
      <button type="button" class="btn btn-plain sm:order-1" disabled={saving} onclick={() => (open = false)}>{t('common.cancel')}</button>
      <button type="submit" form="phone-form" class="btn btn-primary sm:order-2" disabled={saving}>
        {saving ? t('common.saving') : t('common.save')}
      </button>
    </div>
  {/snippet}
</Dialog>

<Confirm
  bind:open={confirmOpen}
  title={t('phones.delete_title', { number: confirming?.number ?? '' })}
  text={t('phones.delete_text')}
  confirmLabel={t('common.delete')}
  danger
  busy={deleting}
  onconfirm={remove}
/>

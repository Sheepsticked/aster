<!-- An editable list of short strings (e.g. Telegram chat ids). Rejects pattern mismatches and duplicates locally;
     the controller still validates. Each chip is a remove button labelled with its value. -->
<script>
  import { t } from '../i18n/index.js';

  /**
   * @type {{ id: string, items: string[], pattern?: RegExp, placeholder?: string, inputmode?: 'numeric' | 'tel' | 'text',
   *   addLabel?: string, describedBy?: string, disabled?: boolean, onchange: (items: string[]) => void }}
   */
  const { id, items, pattern, placeholder, inputmode = 'text', addLabel, describedBy, disabled = false, onchange } = $props();

  let draft = $state('');
  /** @type {string | null} */
  let problem = $state(null);

  function add() {
    const value = draft.trim();
    if (value === '') return;
    if (pattern && !pattern.test(value)) {
      problem = t('list.invalid');
      return;
    }
    if (items.includes(value)) {
      problem = t('list.duplicate');
      return;
    }
    problem = null;
    draft = '';
    onchange([...items, value]);
  }

  /** @param {string} value */
  function remove(value) {
    problem = null;
    onchange(items.filter((item) => item !== value));
  }
</script>

<div>
  {#if items.length > 0}
    <ul class="mb-2 flex flex-wrap gap-2">
      {#each items as item (item)}
        <li>
          <span class="inline-flex items-center gap-1 rounded-full bg-slate-100 py-1 pr-1 pl-3 text-sm ring-1 ring-slate-300 ring-inset">
            <span class="tabular-nums">{item}</span>
            <button
              type="button"
              class="btn btn-ghost h-8 min-h-8 w-8 rounded-full px-0 text-lg leading-none"
              aria-label={t('list.remove', { item })}
              {disabled}
              onclick={() => remove(item)}
            >
              ×
            </button>
          </span>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="flex gap-2">
    <input
      {id}
      class="input"
      type="text"
      {inputmode}
      {placeholder}
      {disabled}
      bind:value={draft}
      aria-describedby={[problem ? `${id}-list-problem` : null, describedBy ?? null].filter((part) => part !== null).join(' ') || undefined}
      onkeydown={(event) => {
        // Enter adds the chip instead of submitting the surrounding form.
        if (event.key !== 'Enter') return;
        event.preventDefault();
        add();
      }}
    />
    <button type="button" class="btn btn-primary shrink-0" {disabled} onclick={add}>{addLabel ?? t('list.add')}</button>
  </div>

  {#if problem !== null}
    <p id="{id}-list-problem" class="mt-1 text-sm text-rose-800" role="alert">{problem}</p>
  {/if}
</div>

<!-- A touch-friendly confirmation dialog (instead of window.confirm); Esc or Cancel never confirms.
     The confirm button is blue, solid red only for deletes (`danger` or tone="danger"). -->
<script>
  import { t } from '../i18n/index.js';
  import Dialog from './Dialog.svelte';

  /**
   * @type {{ open?: boolean, title: string, text?: string, confirmLabel?: string, cancelLabel?: string, danger?: boolean,
   *   tone?: 'primary' | 'danger', busy?: boolean, children?: import('svelte').Snippet, onconfirm: () => void,
   *   oncancel?: () => void }}
   */
  let { open = $bindable(false), title, text, confirmLabel, cancelLabel, danger = false, tone, busy = false, children, onconfirm, oncancel } = $props();
  const style = $derived((tone ?? (danger ? 'danger' : 'primary')) === 'danger' ? 'btn-danger-solid' : 'btn-primary');
</script>

<Dialog bind:open {title} onclose={() => oncancel?.()}>
  {#if text}<p class="text-slate-700">{text}</p>{/if}
  {@render children?.()}

  {#snippet footer()}
    <div class="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
      <button type="button" class="btn btn-plain sm:order-1" disabled={busy} onclick={() => (open = false)}>
        {cancelLabel ?? t('common.cancel')}
      </button>
      <button
        type="button"
        class="btn sm:order-2 {style}"
        disabled={busy}
        onclick={() => onconfirm()}
      >
        {busy ? t('common.working') : (confirmLabel ?? t('common.confirm'))}
      </button>
    </div>
  {/snippet}
</Dialog>

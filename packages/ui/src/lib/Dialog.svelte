<!-- Modal built on native <dialog>.showModal() (focus trap, Esc); full-screen below `sm`, backdrop click closes.
     `panelClass`/`dialogClass` restyle it (e.g. the nav drawer); `animateClose` waits for `data-closing` animations. -->
<script>
  import { tick, untrack } from 'svelte';
  import { t } from '../i18n/index.js';

  /** The longest a closing animation may hold the dialog open. */
  const CLOSE_LIMIT_MS = 400;

  /**
   * @type {{ open?: boolean, title: string, labelHidden?: boolean, panelClass?: string, dialogClass?: string, animateClose?: boolean,
   *   closeLabel?: string, children?: import('svelte').Snippet, footer?: import('svelte').Snippet, onclose?: () => void }}
   */
  let {
    open = $bindable(false),
    title,
    labelHidden = false,
    panelClass = 'm-0 h-dvh w-full max-w-none sm:m-auto sm:h-auto sm:max-h-[85dvh] sm:w-full sm:max-w-lg sm:rounded-2xl',
    dialogClass = '',
    animateClose = false,
    closeLabel,
    children,
    footer,
    onclose,
  } = $props();

  /** @type {HTMLDialogElement | null} */
  let el = $state(null);
  let closing = $state(false);
  /** Counts the closes; one that is no longer the latest (the dialog was opened again meanwhile) does not close it. */
  let closes = 0;

  $effect(() => {
    if (el === null) return;
    if (open && !el.open) el.showModal();
    else if (open && untrack(() => closing)) {
      closes += 1;
      closing = false;
    } else if (!open && el.open) void dismiss();
  });

  /** Closes the dialog, after its closing animation when it has one. */
  async function dismiss() {
    if (el === null || !el.open || closing) return;
    if (!animateClose) {
      el.close();
      return;
    }
    const close = ++closes;
    closing = true;
    await tick();
    const running = el.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined));
    await Promise.race([Promise.all(running), new Promise((resolve) => setTimeout(resolve, CLOSE_LIMIT_MS))]);
    if (close !== closes) return;
    el.close();
    closing = false;
  }

  /** A click that lands on the dialog element and not on the panel inside it is a click on the backdrop. */
  function click(/** @type {MouseEvent} */ event) {
    if (event.target === el) void dismiss();
  }
</script>

<dialog
  bind:this={el}
  onclose={() => {
    open = false;
    onclose?.();
  }}
  oncancel={(event) => {
    // Esc: the same animated close as the other ways out.
    if (!animateClose) return;
    event.preventDefault();
    void dismiss();
  }}
  onclick={click}
  aria-label={title}
  data-closing={closing || undefined}
  class="m-0 max-h-none max-w-none bg-transparent p-0 backdrop:bg-slate-900/50 open:flex open:h-full open:w-full open:items-stretch {dialogClass}"
>
  <div class="flex min-h-0 flex-col overflow-hidden bg-white shadow-xl {panelClass}" data-closing={closing || undefined}>
    <div class="flex items-start gap-3 border-b border-slate-200 px-4 py-3">
      <h2 class="min-w-0 flex-1 text-lg font-semibold {labelHidden ? 'sr-only' : ''}">{title}</h2>
      <button type="button" class="btn btn-ghost -my-1 -mr-2 w-11 px-0 text-xl leading-none" aria-label={closeLabel ?? t('common.close')} onclick={() => void dismiss()}>
        ×
      </button>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      {@render children?.()}
    </div>
    {#if footer}
      <div class="border-t border-slate-200 px-4 py-3 pb-safe">
        {@render footer()}
      </div>
    {/if}
  </div>
</dialog>

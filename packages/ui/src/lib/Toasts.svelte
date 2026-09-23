<!-- The toast stack at the bottom of the screen; below `md` it sits above a floating action bar (`--sticky-actions`).
     aria-live="polite" announces toasts without moving focus. -->
<script>
  import { t } from '../i18n/index.js';
  import { toasts } from './toasts.svelte.js';

  /** @type {Record<string, string>} */
  const TONE = {
    success: 'border-emerald-300 bg-emerald-50 text-emerald-950',
    error: 'border-rose-300 bg-rose-50 text-rose-950',
    info: 'border-slate-300 bg-white text-slate-900',
  };
</script>

<div
  class="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex flex-col items-center gap-2 px-4 pb-safe sm:items-end
    max-md:bottom-[var(--sticky-actions,0px)]"
  aria-live="polite"
  aria-atomic="false"
>
  {#each toasts.items as toast (toast.id)}
    <div class="pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-xl border p-3 shadow-lg {TONE[toast.kind] ?? TONE.info}">
      <p class="min-w-0 flex-1 text-sm break-words">{toast.text}</p>
      <button
        type="button"
        class="btn btn-ghost -my-1 -mr-1 min-h-11 w-11 shrink-0 px-0 text-lg leading-none"
        aria-label={t('toast.dismiss')}
        onclick={() => toasts.dismiss(toast.id)}
      >
        ×
      </button>
    </div>
  {/each}
</div>

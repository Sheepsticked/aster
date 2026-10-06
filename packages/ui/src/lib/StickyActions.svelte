<!-- A page's action bar, sticky at the bottom below `md`. `unsaved` is for a page with edits to save: true sticks the bar at every
     size, highlights it and says so; false keeps it in place. A button that stays at the bar's left takes `md:order-first`. -->
<script>
  import { t } from '../i18n/index.js';

  /** @type {{ children: import('svelte').Snippet, unsaved?: boolean, class?: string }} */
  const { children, unsaved, class: className = '' } = $props();

  const frame = $derived(
    unsaved === true
      ? 'sticky bottom-0 z-20 border-amber-300 bg-amber-50 shadow-[0_-2px_8px_rgb(15_23_42/0.18)] md:rounded-b-none md:border-b-0'
      : `${unsaved === false ? 'static' : 'sticky bottom-0 z-20 shadow-[0_-1px_3px_rgb(15_23_42/0.08)]'} border-slate-200 bg-white md:static md:shadow-sm`,
  );
</script>

<div class="{frame} -mx-4 mt-4 flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3 pb-safe md:mx-0 md:rounded-xl md:border {className}">
  {#if unsaved === true}
    <!-- a line of its own on a phone, the stretch between the buttons from `md` -->
    <p class="flex basis-full items-center gap-2 text-sm font-medium text-amber-900 md:basis-auto md:flex-1 md:text-base" role="status">
      <span class="h-2.5 w-2.5 shrink-0 rounded-full bg-amber-500" aria-hidden="true"></span>
      {t('common.unsaved')}
    </p>
  {/if}
  {@render children()}
</div>

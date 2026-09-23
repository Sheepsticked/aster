<!-- Shared list pager (page, per_page, total, pages): shows the visible range and Previous/Next buttons.
     Hidden when there are no rows; the buttons only appear when there is more than one page. -->
<script>
  import { t } from '../i18n/index.js';

  /** @type {{ page: number, pages: number, total: number, per_page: number, busy?: boolean, onpage: (page: number) => void }} */
  const { page, pages, total, per_page, busy = false, onpage } = $props();

  const first = $derived(total === 0 ? 0 : (page - 1) * per_page + 1);
  const last = $derived(Math.min(total, page * per_page));
</script>

{#if total > 0}
  <div class="mt-3 flex flex-wrap items-center justify-between gap-2 px-1">
    <p class="text-sm text-slate-500" aria-live="polite">{t('list.range', { first, last, total })}</p>
    {#if pages > 1}
      <div class="flex gap-2">
        <button type="button" class="btn btn-plain px-3 text-sm" disabled={busy || page <= 1} onclick={() => onpage(page - 1)}>
          {t('list.previous')}
        </button>
        <button type="button" class="btn btn-plain px-3 text-sm" disabled={busy || page >= pages} onclick={() => onpage(page + 1)}>
          {t('list.next')}
        </button>
      </div>
    {/if}
  </div>
{/if}

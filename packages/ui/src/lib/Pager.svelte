<!-- Shared list pager (page, per_page, total, pages): shows the visible range, the rows-per-page choice and Previous/Next.
     Hidden when there are no rows; the choice only appears when there are more rows than the smallest page holds, the
     buttons when there is more than one page. -->
<script>
  import { t } from '../i18n/index.js';
  import { PAGE_SIZES, perPage } from './perPage.svelte.js';

  /** @type {{ page: number, pages: number, total: number, per_page: number, busy?: boolean, onpage: (page: number) => void }} */
  const { page, pages, total, per_page, busy = false, onpage } = $props();

  /** A new page size starts again from the first page. @param {Event & { currentTarget: HTMLSelectElement }} event */
  function choose(event) {
    perPage.set(Number(event.currentTarget.value));
    onpage(1);
  }

  const first = $derived(total === 0 ? 0 : (page - 1) * per_page + 1);
  const last = $derived(Math.min(total, page * per_page));
</script>

{#if total > 0}
  <div class="mt-3 flex flex-wrap items-center justify-between gap-2 px-1">
    <p class="text-sm text-slate-500" aria-live="polite">{t('list.range', { first, last, total })}</p>
    <div class="flex flex-wrap items-center gap-2">
      {#if total > (PAGE_SIZES[0] ?? 0)}
        <label class="flex items-center gap-2 text-sm text-slate-500">
          {t('list.per_page')}
          <select class="input w-auto" value={perPage.value} disabled={busy} onchange={choose}>
            {#each PAGE_SIZES as size (size)}
              <option value={size}>{size}</option>
            {/each}
          </select>
        </label>
      {/if}
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
  </div>
{/if}

<!-- A table when its container is at least `tableFrom` wide, otherwise cards; both render the same `cell` snippet.
     `primary` is the card heading; `block` columns (long text) span the full card width under their label. -->
<script>
  import { t } from '../i18n/index.js';

  /**
   * @typedef {{ key: string, label: string, primary?: boolean, cardHidden?: boolean, block?: boolean, class?: string }} Column
   * @type {{ columns: readonly Column[], rows: readonly any[], rowKey: (row: any) => string | number, label: string,
   *   empty?: string, cell: import('svelte').Snippet<[any, Column]>, actions?: import('svelte').Snippet<[any]>,
   *   tableFrom?: '48rem' | '56rem' }}
   */
  const { columns, rows, rowKey, label, empty, cell, actions, tableFrom = '48rem' } = $props();

  // Whole class names, so Tailwind finds them in the source.
  /** @type {Record<string, { table: string, cards: string }>} */
  const FROM = {
    '48rem': { table: '@3xl:table', cards: '@3xl:hidden' },
    '56rem': { table: '@4xl:table', cards: '@4xl:hidden' },
  };
  const from = $derived(FROM[tableFrom] ?? FROM['48rem']);
</script>

{#if rows.length === 0}
  <p class="px-1 py-6 text-center text-slate-500">{empty ?? t('common.none')}</p>
{:else}
  <div class="@container">
    <table class="hidden w-full border-collapse text-left text-sm {from.table}">
      <caption class="sr-only">{label}</caption>
      <thead>
        <tr class="border-b border-slate-200 text-slate-500">
          {#each columns as column (column.key)}
            <th scope="col" class="px-3 py-2 font-medium {column.class ?? ''}">{column.label}</th>
          {/each}
          {#if actions}
            <th scope="col" class="px-3 py-2 text-right font-medium">{t('common.actions')}</th>
          {/if}
        </tr>
      </thead>
      <tbody>
        {#each rows as row (rowKey(row))}
          <tr class="border-b border-slate-100 last:border-0">
            {#each columns as column (column.key)}
              <td class="px-3 py-2 align-middle {column.class ?? ''}">{@render cell(row, column)}</td>
            {/each}
            {#if actions}
              <td class="px-3 py-2 text-right align-middle whitespace-nowrap">{@render actions(row)}</td>
            {/if}
          </tr>
        {/each}
      </tbody>
    </table>

    <!-- Card buttons sit beside the heading and wrap only when needed; without a primary column they go at the end. -->
    <ul class="flex flex-col gap-3 {from.cards}" aria-label={label}>
      {#each rows as row (rowKey(row))}
        <li class="card p-3">
          {#each columns as column (column.key)}
            {#if column.primary}
              <div class="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <p class="min-w-0 text-base font-semibold break-words">{@render cell(row, column)}</p>
                {#if actions}
                  <div class="ml-auto flex flex-wrap justify-end gap-2">{@render actions(row)}</div>
                {/if}
              </div>
            {:else if !column.cardHidden}
              {#if column.block}
                <div class="py-1 text-sm">
                  <span class="block text-slate-500">{column.label}</span>
                  <div class="mt-0.5 break-words">{@render cell(row, column)}</div>
                </div>
              {:else}
                <div class="flex flex-wrap items-baseline justify-between gap-x-3 py-0.5 text-sm">
                  <span class="text-slate-500">{column.label}</span>
                  <span class="ml-auto max-w-full min-w-0 text-right break-words">{@render cell(row, column)}</span>
                </div>
              {/if}
            {/if}
          {/each}
          {#if actions && !columns.some((column) => column.primary)}
            <div class="mt-3 flex flex-wrap justify-end gap-2">{@render actions(row)}</div>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
{/if}

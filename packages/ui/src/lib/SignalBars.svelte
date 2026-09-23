<!-- Modem signal as four bars plus dBm text; an empty meter when unknown keeps the row height stable.
     The bars are decorative; screen readers get the text. -->
<script>
  import { t } from '../i18n/index.js';
  import { bars, dbm } from './format.js';

  /** @type {{ rssi: unknown }} */
  const { rssi } = $props();

  const level = $derived(bars(rssi));
  const value = $derived(dbm(rssi));
</script>

<span class="inline-flex items-center gap-2">
  <span class="flex items-end gap-0.5" aria-hidden="true">
    {#each [1, 2, 3, 4] as bar (bar)}
      <span
        class="w-1 rounded-sm {bar <= level ? 'bg-emerald-600' : 'bg-slate-300'}"
        style="height: {2 + bar * 3}px"
      ></span>
    {/each}
  </span>
  <span class="text-sm tabular-nums">{value === null ? t('common.none') : t('modem.rssi', { dbm: value })}</span>
</span>

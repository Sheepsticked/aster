<!-- A modem's own number: the one the SIM reports, else the one entered by hand (marked as such), else "none". -->
<script>
  import { t } from '../i18n/index.js';
  import { orNone } from './format.js';

  /** @type {{ reported: string | null | undefined, entered: string | null | undefined }} */
  const { reported, entered } = $props();
</script>

{#if reported}
  {reported}
{:else if entered}
  {entered}<span class="text-slate-500">{' · '}{t('modem.number_entered')}</span>
{:else}
  {orNone(null)}
{/if}

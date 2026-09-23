<!-- Unassigned devices from a scan, shared by the Overview and Modems pages; row actions come from the page. -->
<script>
  import { t } from '../i18n/index.js';
  import ResponsiveTable from './ResponsiveTable.svelte';
  import { orNone } from './format.js';

  /** @type {{ devices: readonly any[], label: string, empty?: string, actions?: import('svelte').Snippet<[any]> }} */
  const { devices, label, empty, actions } = $props();

  const columns = $derived([
    { key: 'port', label: t('device.port'), primary: true },
    { key: 'driver', label: t('device.driver') },
    { key: 'imei', label: t('device.imei') },
    { key: 'imsi', label: t('device.imsi') },
    { key: 'tty', label: t('device.tty') },
    { key: 'vendor', label: t('device.vendor') },
  ]);
</script>

<ResponsiveTable {columns} rows={devices} rowKey={(device) => device.data_tty} {label} {empty} {actions}>
  {#snippet cell(/** @type {any} */ device, /** @type {{ key: string }} */ column)}
    {#if column.key === 'port'}
      <span class="tabular-nums">{orNone(device.usb_port)}</span>
    {:else if column.key === 'driver'}
      {orNone(device.suggested_driver)}
    {:else if column.key === 'imei'}
      <span class="tabular-nums">{orNone(device.imei)}</span>
    {:else if column.key === 'imsi'}
      <span class="tabular-nums">{orNone(device.imsi)}</span>
    {:else if column.key === 'tty'}
      <span class="font-mono text-xs">{orNone(device.data_tty)}</span>
    {:else if column.key === 'vendor'}
      <span class="font-mono text-xs">{orNone(device.vendor)}:{orNone(device.product)}</span>
    {/if}
  {/snippet}
</ResponsiveTable>

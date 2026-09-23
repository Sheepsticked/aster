<!-- Icons for modem action buttons, so same-coloured buttons are told apart by shape. Decorative; hidden below `sm`
     where half-width buttons have no room. -->
<script>
  /** @type {{ name: string }} */
  const { name } = $props();
</script>

<svg
  class="hidden h-5 w-5 shrink-0 opacity-75 sm:block"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.75"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  {#if name === 'start'}
    <path d="M8.5 5.5v13l10-6.5z" />
  {:else if name === 'stop'}
    <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />
  {:else if name === 'restart'}
    <!-- a clockwise arrow: the driver lets the modem go and takes it again -->
    <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3l2.2 1.8" />
    <path d="M19.5 4.5v4h-4" />
  {:else if name === 'reset'}
    <!-- the power sign: the modem itself reboots -->
    <path d="M12 3.5v8" />
    <path d="M6.7 6.7a7.5 7.5 0 1 0 10.6 0" />
  {:else if name === 'remap'}
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="m15 15 5 5" />
  {:else if name === 'enable' || name === 'disable'}
    <!-- the radio, which Disable turns off -->
    <circle cx="12" cy="12" r="1.5" />
    <path d="M8.5 8.5a5 5 0 0 0 0 7" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    <path d="M5.6 5.6a9 9 0 0 0 0 12.8" />
    <path d="M18.4 5.6a9 9 0 0 1 0 12.8" />
    {#if name === 'disable'}<path d="m4 4 16 16" />{/if}
  {/if}
</svg>

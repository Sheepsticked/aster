<!-- Inline navigation icons (no icon package or web font needed offline); decorative, since each has text beside it. -->
<script>
  /** @type {{ name: string, class?: string }} */
  const { name, class: className = 'h-5 w-5 shrink-0' } = $props();
</script>

<svg
  class={className}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.75"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  {#if name === 'overview'}
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
  {:else if name === 'modems'}
    <rect x="6" y="8" width="12" height="13" rx="2" />
    <path d="M12 8V4" />
    <path d="M8.5 4.5a5 5 0 0 1 7 0" />
    <path d="M9.5 17h5" />
  {:else if name === 'phones'}
    <path d="M5 4h5l1.5 4-2.5 2a12 12 0 0 0 5 5l2-2.5 4 1.5v5a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z" />
  {:else if name === 'messages'}
    <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4z" />
    <path d="M8 8h8M8 12h5" />
  {:else if name === 'calls'}
    <path d="M4 5h4l1.2 3.5-2 1.6a11 11 0 0 0 4.7 4.7l1.6-2L17 14v4a1 1 0 0 1-1 1A13 13 0 0 1 3 6a1 1 0 0 1 1-1z" />
    <path d="M15 9l5-5M20 4h-4M20 4v4" />
  {:else if name === 'config'}
    <path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
    <path d="M14 3v4h4M8.5 12h7M8.5 16h7" />
  {:else if name === 'settings'}
    <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
    <circle cx="16" cy="7" r="2.2" />
    <circle cx="8" cy="17" r="2.2" />
  {:else if name === 'activity'}
    <path d="M3 12h4l3 7 4-14 3 7h4" />
  {:else if name === 'logs'}
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <path d="M8 9h8M8 13h8M8 17h4" />
  {/if}
</svg>

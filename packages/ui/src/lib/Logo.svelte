<!-- The Aster mark, drawn inline (sized by class, no request); decorative, since the word is always beside it.
     `dark` is the variant for a dark surface; colours are fixed brand colours. -->
<script>
  /** @type {{ dark?: boolean, class?: string }} */
  const { dark = false, class: className = 'h-6 w-6 shrink-0' } = $props();
</script>

<svg
  class={className}
  viewBox="0 0 100 100"
  fill="none"
  stroke-width="13"
  stroke-linecap="round"
  aria-hidden="true"
  focusable="false"
>
  <path d="M50 50 L50 8 M50 50 L13.6 71 M50 50 L86.4 71" stroke={dark ? '#ffffff' : '#0f172a'} />
  <path d="M50 69 L50 92 M33.5 40.5 L13.6 29 M66.5 40.5 L86.4 29" stroke={dark ? '#38bdf8' : '#0ea5e9'} />
</svg>

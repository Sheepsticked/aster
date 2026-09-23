<!-- A collapsible page section (<details>): open by default from `md` up, closed below, following resizes.
     Once the user toggles it, their choice wins. -->
<script>
  /** The `md` breakpoint. */
  const DESKTOP = '(min-width: 48rem)';

  /**
   * @type {{ title: string, subtitle?: string, id?: string, open?: boolean, class?: string,
   *   children: import('svelte').Snippet, aside?: import('svelte').Snippet }}
   */
  const { title, subtitle, id, open: forced, class: className = '', children, aside } = $props();

  const query = typeof window === 'undefined' || typeof window.matchMedia !== 'function' ? null : window.matchMedia(DESKTOP);
  let wide = $state(query?.matches ?? true);
  /** Set as soon as the admin opens or closes this section: their choice outlives the next resize. */
  let chosen = $state(/** @type {boolean | null} */ (null));

  $effect(() => {
    if (query === null) return;
    const follow = () => {
      wide = query.matches;
    };
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  });

  const open = $derived(forced ?? chosen ?? wide);
</script>

<details
  {id}
  {open}
  class="card group px-4 py-3 {className}"
  ontoggle={(event) => (chosen = event.currentTarget.open)}
>
  <summary class="-mx-2 -my-1 flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-2 py-1 hover:bg-slate-50">
    <svg viewBox="0 0 24 24" class="h-5 w-5 shrink-0 text-slate-500 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
    <span class="min-w-0 flex-1">
      <span class="block text-base font-semibold">{title}</span>
      <!-- The hint is clamped to two lines while folded and shown whole when open. -->
      {#if subtitle}<span class="line-clamp-2 text-sm font-normal text-slate-500 group-open:line-clamp-none">{subtitle}</span>{/if}
    </span>
    {#if aside}
      <span class="shrink-0">{@render aside()}</span>
    {/if}
  </summary>
  <div class="mt-3">
    {@render children()}
  </div>
</details>

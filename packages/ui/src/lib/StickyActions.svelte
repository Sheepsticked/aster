<!-- A page's action bar, sticky at the bottom below `md`. `floating=false` keeps it in place (e.g. a form with nothing to save).
     While floating it publishes its height as `--sticky-actions` so toasts stay above it. -->
<script>
  /** @type {{ children: import('svelte').Snippet, floating?: boolean, class?: string }} */
  const { children, floating = true, class: className = '' } = $props();

  let height = $state(0);

  $effect(() => {
    if (!floating) return;
    const root = document.documentElement;
    root.style.setProperty('--sticky-actions', `${height}px`);
    return () => root.style.removeProperty('--sticky-actions');
  });
</script>

<div
  bind:clientHeight={height}
  class="{floating ? 'sticky bottom-0 z-20 shadow-[0_-1px_3px_rgb(15_23_42/0.08)]' : 'static'} -mx-4 mt-4 flex flex-wrap
    items-center justify-end gap-2 border-t border-slate-200 bg-white px-4 py-3 pb-safe md:static md:mx-0 md:rounded-xl
    md:border md:shadow-sm {className}"
>
  {@render children()}
</div>

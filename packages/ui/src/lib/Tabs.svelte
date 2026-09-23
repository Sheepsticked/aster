<!-- An ARIA tab strip with arrow-key navigation; the page renders the single `tabpanel` it points to.
     Below `sm` it scrolls sideways instead of wrapping. -->
<script>
  /**
   * @type {{ tabs: readonly { id: string, label: string, count?: number | null }[], current: string, panel?: string,
   *   onselect: (id: string) => void }}
   */
  const { tabs, current, panel = 'tabpanel', onselect } = $props();

  /** Arrow keys move between tabs (with the roving tabindex below). @param {KeyboardEvent} event */
  function keys(event) {
    const index = tabs.findIndex((tab) => tab.id === current);
    const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const tab = tabs[(next + tabs.length) % tabs.length];
    if (tab) onselect(tab.id);
  }
</script>

<div role="tablist" class="-mx-1 flex gap-1 overflow-x-auto px-1">
  {#each tabs as tab (tab.id)}
    <button
      type="button"
      role="tab"
      id="tab-{tab.id}"
      aria-selected={tab.id === current}
      aria-controls={panel}
      tabindex={tab.id === current ? 0 : -1}
      class="btn shrink-0 px-3 text-sm {tab.id === current ? 'bg-slate-900 text-white' : 'btn-plain'}"
      onclick={() => onselect(tab.id)}
      onkeydown={keys}
    >
      {tab.label}
      {#if typeof tab.count === 'number'}
        <span class="tabular-nums opacity-70">{tab.count}</span>
      {/if}
    </button>
  {/each}
</div>

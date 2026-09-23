<!-- One labelled form field: a real <label for>, hint and problems below, and the describedby ids for the caller's control.
     `problems` are the controller's messages for this field, shown as-is. -->
<script>
  /**
   * @type {{ id: string, label: string, hint?: string, problems?: readonly { path: string, message: string }[],
   *   class?: string, children: import('svelte').Snippet<[{ describedBy: string | undefined }]> }}
   */
  const { id, label, hint, problems = [], class: className = '', children } = $props();

  const hintId = $derived(hint ? `${id}-hint` : null);
  const problemId = $derived(problems.length > 0 ? `${id}-problem` : null);
  const describedBy = $derived([problemId, hintId].filter((part) => part !== null).join(' ') || undefined);
</script>

<div class={className}>
  <label class="mb-1 block font-medium" for={id}>{label}</label>
  {@render children({ describedBy })}
  {#if problems.length > 0}
    <ul id={problemId} class="mt-1 space-y-0.5 text-sm text-rose-800">
      {#each problems as problem (problem.path + problem.message)}
        <li>{problem.message}</li>
      {/each}
    </ul>
  {/if}
  {#if hint}
    <p id={hintId} class="mt-1 text-sm text-slate-500">{hint}</p>
  {/if}
</div>

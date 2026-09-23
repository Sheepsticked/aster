<!-- A list search box: debounced while typing, immediate on Enter. The label comes from the caller (lib/Field.svelte). -->
<script>
  /** How long the typing has to stop before the list is asked again. */
  const DEBOUNCE_MS = 300;

  /** @type {{ id: string, value: string, describedBy?: string, placeholder?: string, class?: string, onsearch: (value: string) => void }} */
  const { id, value, describedBy, placeholder, class: className = '', onsearch } = $props();

  let text = $state(value);
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;

  // Follow outside filter changes, but never while the field has focus.
  $effect(() => {
    if (value !== text && document.activeElement?.id !== id) text = value;
  });

  /** @param {string} next @param {boolean} now */
  function change(next, now) {
    text = next;
    clearTimeout(timer);
    if (now) onsearch(next);
    else timer = setTimeout(() => onsearch(next), DEBOUNCE_MS);
  }

  $effect(() => () => clearTimeout(timer));
</script>

<input
  {id}
  class="input {className}"
  type="search"
  {placeholder}
  value={text}
  aria-describedby={describedBy}
  oninput={(event) => change(event.currentTarget.value, false)}
  onchange={(event) => change(event.currentTarget.value, true)}
  onkeydown={(event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      change(event.currentTarget.value, true);
    }
  }}
/>

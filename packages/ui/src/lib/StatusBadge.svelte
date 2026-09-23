<!-- A generic status badge: ready-made text on a tone colour (modem states use StateBadge).
     The text is always shown, never colour alone; an unknown tone falls back to grey. -->
<script>
  /** @type {{ text: string, tone?: 'ok' | 'info' | 'warn' | 'bad' | 'neutral', title?: string, class?: string }} */
  const { text, tone = 'neutral', title, class: className = '' } = $props();

  /** @type {Record<string, string>} */
  const TONE = {
    ok: 'bg-emerald-100 text-emerald-900 ring-emerald-300',
    info: 'bg-sky-100 text-sky-900 ring-sky-300',
    warn: 'bg-amber-100 text-amber-900 ring-amber-300',
    bad: 'bg-rose-100 text-rose-900 ring-rose-300',
    neutral: 'bg-slate-200 text-slate-800 ring-slate-300',
  };
</script>

<span {title} class="inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-sm font-medium ring-1 ring-inset {TONE[tone] ?? TONE.neutral} {className}">
  {text}
</span>

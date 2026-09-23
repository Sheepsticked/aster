<!-- A modem state badge: colours the state the controller sends. Unknown states are shown as "unknown", not the raw word. -->
<script>
  import { t } from '../i18n/index.js';

  /** @type {{ state: string, class?: string }} */
  const { state, class: className = '' } = $props();

  /** @type {Record<string, string>} */
  const TONE = {
    ready: 'bg-emerald-100 text-emerald-900 ring-emerald-300',
    busy: 'bg-sky-100 text-sky-900 ring-sky-300',
    connecting: 'bg-amber-100 text-amber-900 ring-amber-300',
    'no-network': 'bg-amber-100 text-amber-900 ring-amber-300',
    unmapped: 'bg-amber-100 text-amber-900 ring-amber-300',
    stopped: 'bg-slate-200 text-slate-800 ring-slate-300',
    disabled: 'bg-slate-200 text-slate-800 ring-slate-300',
    unverified: 'bg-slate-200 text-slate-800 ring-slate-300',
    absent: 'bg-rose-100 text-rose-900 ring-rose-300',
    flapping: 'bg-rose-100 text-rose-900 ring-rose-300',
    'duplicate-imei': 'bg-rose-100 text-rose-900 ring-rose-300',
  };

  const known = $derived(typeof state === 'string' && state in TONE);
</script>

<span
  class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-sm font-medium ring-1 ring-inset
    {known ? TONE[state] : 'bg-slate-200 text-slate-800 ring-slate-300'} {className}"
>
  <span class="h-2 w-2 rounded-full bg-current opacity-70" aria-hidden="true"></span>
  {known ? t(`state.${state}`) : t('state.unknown')}
</span>

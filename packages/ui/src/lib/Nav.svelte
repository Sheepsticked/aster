<!-- Section navigation, shared by the desktop sidebar and the phone drawer. Plain links (router.js intercepts clicks);
     the current one has aria-current="page", which also drives its styling. -->
<script>
  import { t } from '../i18n/index.js';
  import { NAV } from '../router.js';
  import NavIcon from './NavIcon.svelte';

  /** @type {{ path: string, onnavigate?: () => void }} */
  const { path, onnavigate } = $props();
</script>

<nav aria-label={t('nav.sections')} class="p-2">
  <ul class="flex flex-col gap-0.5">
    {#each NAV as route (route.path)}
      {@const current = route.path === path}
      <li>
        <a
          href={route.path}
          aria-current={current ? 'page' : undefined}
          onclick={() => onnavigate?.()}
          class="flex min-h-11 items-center gap-3 rounded-lg px-3 text-base transition-colors
            {current ? 'bg-accent text-on-fill' : 'text-slate-700 hover:bg-slate-200/80'}"
        >
          <NavIcon name={route.icon ?? ''} />
          <span class="truncate">{t(`nav.${route.name}`)}</span>
        </a>
      </li>
    {/each}
  </ul>
</nav>

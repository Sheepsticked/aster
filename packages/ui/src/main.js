// Entry point: installs the in-browser mock in a mock build, then mounts the app.
// VITE_MOCK is replaced at build time, so production bundles drop the mock entirely.
import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { language } from './i18n/index.js';
// Applies the stored theme before the first paint.
import './lib/theme.svelte.js';

if (import.meta.env.VITE_MOCK === '1') {
  const { installMock } = await import('./mock/index.js');
  installMock();
}

document.documentElement.lang = language();

const target = document.getElementById('app');
if (!target) throw new Error('index.html has no #app element to mount into');
mount(App, { target });

// Translation: `t(key, params)` looks up the current language, then English, then returns the key; `{name}` is filled from params.
// Controller error messages are shown untranslated, as sent.
import en from './en.json';
import ru from './ru.json';
import { DEFAULT, LANGUAGES, lang } from '../lib/lang.svelte.js';

/** @type {Record<string, Record<string, string>>} */
const CATALOGS = { ru, en };

/**
 * @param {string} key                                flat key, e.g. `nav.overview`
 * @param {Record<string, string | number>} [params]  values for `{name}` placeholders
 */
export function t(key, params) {
  const text = CATALOGS[lang.current]?.[key] ?? CATALOGS.en[key] ?? key;
  if (params === undefined) return text;
  return text.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole));
}

/** The language in use; reading it in a component makes that component follow a switch. */
export const language = () => lang.current;

/**
 * Switches this browser's language (the appliance's setting is written by the Settings page).
 * @param {string} next
 */
export const setLanguage = (next) => lang.set(next);

export { DEFAULT, LANGUAGES };

// Shared formatting. Times arrive as epoch ms and are shown in the browser's time zone.
import { language, t } from '../i18n/index.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The locale for Intl; `ru` and `en` are the two catalogs, and `en-GB` is the one with a 24-hour clock. */
const locale = () => (language() === 'ru' ? 'ru-RU' : 'en-GB');

/** @param {unknown} at  epoch ms */
export function time(at) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return t('common.none');
  return new Date(at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** @param {unknown} at  epoch ms */
export function dateTime(at) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return t('common.none');
  return new Date(at).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/**
 * How long ago something was observed, in coarse steps.
 * @param {unknown} at  epoch ms
 */
export function ago(at) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return t('common.none');
  const ms = Date.now() - at;
  if (ms < MINUTE) return t('time.just_now');
  if (ms < HOUR) return t('time.minutes_ago', { n: Math.floor(ms / MINUTE) });
  if (ms < DAY) return t('time.hours_ago', { n: Math.floor(ms / HOUR) });
  return t('time.days_ago', { n: Math.floor(ms / DAY) });
}

/** @param {unknown} seconds  an uptime from /api/health */
export function uptime(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return t('common.none');
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} ${t('time.d')} ${hours} ${t('time.h')}`;
  if (hours > 0) return `${hours} ${t('time.h')} ${minutes} ${t('time.m')}`;
  return `${minutes} ${t('time.m')}`;
}

/**
 * AT+CSQ value (0–31, null if unknown) to dBm: -113 dBm at 0, 2 dBm per step (3GPP 27.007 §8.5).
 * @param {unknown} rssi
 */
export function dbm(rssi) {
  if (typeof rssi !== 'number' || !Number.isFinite(rssi)) return null;
  return -113 + 2 * Math.max(0, Math.min(31, Math.round(rssi)));
}

/**
 * 0–4 bars for the same value, so a card can show signal strength without a number.
 * @param {unknown} rssi
 */
export function bars(rssi) {
  if (typeof rssi !== 'number' || !Number.isFinite(rssi)) return 0;
  if (rssi >= 20) return 4;
  if (rssi >= 15) return 3;
  if (rssi >= 10) return 2;
  if (rssi >= 5) return 1;
  return 0;
}

/** @param {unknown} value */
export const orNone = (value) => (value === null || value === undefined || value === '' ? t('common.none') : String(value));

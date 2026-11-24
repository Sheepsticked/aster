// @ts-check
// Sender routes: extra (or, with `only`, the sole) Telegram chats for the SMS and missed calls of chosen senders on one modem (registry modems[].sender_routes).

/** @typedef {import('../config/registry.js').SenderRoute} SenderRoute */

/** A number without its spaces, dashes, brackets and one leading plus. */
const digitsOf = (/** @type {string} */ value) => value.replace(/[\s\-()]/g, '').replace(/^\+/, '');

/**
 * Whether `sender` is the one `rule` names. A rule written as a number (digits only once the usual separators are gone)
 * matches the digits exactly; any other rule is a name, matched ignoring case and surrounding spaces.
 * @param {string} rule
 * @param {string} sender
 */
function matches(rule, sender) {
  const number = digitsOf(rule);
  if (/^[0-9]+$/.test(number)) return digitsOf(sender) === number;
  return sender.trim().toLowerCase() === rule.trim().toLowerCase();
}

/**
 * The chats of every rule that names `sender`, after `normal` unless one of those rules is `only`; each chat once.
 * @param {readonly SenderRoute[]} routes
 * @param {string | null | undefined} sender  an SMS sender or a caller; empty or missing matches nothing
 * @param {readonly string[]} normal  the chats the event goes to anyway
 * @returns {string[]}
 */
export function withSenderRoutes(routes, sender, normal) {
  const found = sender ? routes.filter((route) => matches(route.sender, sender)) : [];
  const chats = new Set(found.some((route) => route.only) ? [] : normal);
  for (const route of found) for (const chat of route.recipients) chats.add(chat);
  return [...chats];
}

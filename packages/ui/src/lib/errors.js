// Error helpers for failed API calls: the controller's message and its problem list (untranslated).
// Problems come either as a 400 `problems` list or inside a 409 operation result; `problemsOf` reads both.
import { ApiError } from '../api.js';

/** @param {unknown} err @returns {string} */
export const messageOf = (err) => (err instanceof Error ? err.message : String(err));

/**
 * The `{path, message}` list behind a refusal, in the order the controller listed it.
 * @param {unknown} err
 * @returns {{ path: string, message: string }[]}
 */
export function problemsOf(err) {
  if (!(err instanceof ApiError)) return [];
  if (err.problems !== null) return err.problems;
  const inResult = err.body?.result?.problems;
  return Array.isArray(inResult) ? inResult : [];
}

/**
 * The problems that belong to one field of one entry — `modems[1].incoming_context` is the `incoming_context` of the modem
 * being edited, and a path that names another entry is not this field's business.
 * @param {{ path: string, message: string }[]} problems
 * @param {string} field
 */
export const problemsFor = (problems, field) => problems.filter((problem) => problem.path.endsWith(`.${field}`) || problem.path === field);

/**
 * The rest: everything that is not one of `fields`, which is what a form shows above itself rather than beside a control.
 * @param {{ path: string, message: string }[]} problems
 * @param {readonly string[]} fields
 */
export const problemsElsewhere = (problems, fields) =>
  problems.filter((problem) => !fields.some((field) => problem.path.endsWith(`.${field}`) || problem.path === field));

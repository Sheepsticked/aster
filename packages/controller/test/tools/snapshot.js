// @ts-check
// Test helper: compares a migration tool's output with the committed copy under test/tools/snapshots/, so a change is
// reviewed in the diff. ASTER_UPDATE_SNAPSHOTS=1 rewrites them.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

const DIR = new URL('./snapshots/', import.meta.url);

/**
 * @param {string} name  a file under test/tools/snapshots
 * @param {string} actual
 */
export function snapshot(name, actual) {
  const file = new URL(name, DIR);
  if (process.env.ASTER_UPDATE_SNAPSHOTS === '1') {
    writeFileSync(file, actual);
    return;
  }
  let expected;
  try {
    expected = readFileSync(file, 'utf8');
  } catch {
    assert.fail(`snapshots/${name} is not committed — run the tests once with ASTER_UPDATE_SNAPSHOTS=1 and review what it wrote`);
  }
  assert.equal(actual, expected, `snapshots/${name} is not what the tool prints any more (ASTER_UPDATE_SNAPSHOTS=1 rewrites it)`);
}

/** The repository root, so a test can run a tool the way an operator does. */
export const ROOT = new URL('../../../../', import.meta.url).pathname;

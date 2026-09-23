// @ts-check
// Flow 5 (the rollback): a configuration file that passes the lint but breaks at reload. A dialplan
// line with a priority that is not a number is syntactically a key line, so the controller's lint lets it through;
// `dialplan reload` then logs a WARNING from pbx_config.c, which the apply reads as a problem — the previous version
// must come back and be reloaded, the operation must end `failed` with that account, and the file on disk must be the
// one that was there before. A good change is then applied and taken back with Restore, so the file ends as it began.
import { assert } from './lib.js';

export const name = '05 broken extensions.conf: refused at reload, the previous version restored; a good one applied and restored';

const FILE = '/api/config/files/extensions.conf';

/** @param {import('./lib.js').Ctx} ctx */
export async function run({ api, log }) {
  const { content, hash, status } = await api.read(FILE);
  assert.equal(typeof content, 'string');
  assert.match(content, /\[smoke\]/, 'the e2e stack runs the test-config dialplan');
  log(`extensions.conf ${hash.slice(0, 12)}… (${status})`);

  // Broken at reload, not at lint.
  const broken = `${content.replace(/\n*$/, '\n')}\n[e2e-broken]\nexten => s,abc,NoOp(e2e)\n`;
  const refused = await api.put(FILE, { content: broken, base_hash: hash });
  assert.equal(refused.status, 409, `expected the apply to be refused, got ${refused.status} ${JSON.stringify(refused.data)}`);
  const op = refused.data.operation;
  assert.equal(op.kind, 'config-apply');
  assert.equal(op.status, 'failed');
  log(`operation ${op.id}: ${op.error}`);
  assert.match(op.error, /extensions\.conf was not applied: Asterisk logged \d+ problem line/);
  assert.match(op.error, /the previous version is back$/, 'the restore itself reloaded cleanly');
  assert.equal(op.result.restored, true);
  assert.equal(op.result.hash, hash, 'the hash on disk is the previous version\'s again');
  assert.ok(Array.isArray(op.result.log) && op.result.log.length > 0, 'the log lines Asterisk wrote are in the result');
  for (const line of op.result.log) log(`  asterisk: ${line}`);
  assert.ok(op.result.log.some((/** @type {string} */ line) => /pbx_config\.c/.test(line)), 'the problem came from the dialplan loader');

  const after = await api.read(FILE);
  assert.equal(after.content, content, 'the file on disk is the previous version');
  assert.equal(after.hash, hash);

  // A good change applies with one dialplan reload, and Restore brings the previous version back.
  const good = `${content.replace(/\n*$/, '\n')}\n; e2e: applied through the API and restored again\n`;
  const applied = await api.put(FILE, { content: good, base_hash: hash });
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.equal(applied.data.operation.status, 'done');
  assert.deepEqual(applied.data.operation.result.actions, ['Command: dialplan reload']);
  assert.equal(applied.data.operation.result.previous_hash, hash);
  const goodHash = applied.data.operation.result.hash;
  log(`applied ${goodHash.slice(0, 12)}… with ${JSON.stringify(applied.data.operation.result.actions)}`);

  const listed = (await api.read('/api/config/files')).files.find((/** @type {any} */ f) => f.name === 'extensions.conf');
  assert.equal(listed.status, 'applied');
  assert.equal(listed.restorable, true);

  const restored = await api.post('/api/config/files/extensions.conf/restore', { base_hash: goodHash });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.equal(restored.data.operation.status, 'done');
  assert.equal(restored.data.operation.result.hash, hash);
  const final = await api.read(FILE);
  assert.equal(final.content, content, 'back to the original text');
  log('restored the original');
}

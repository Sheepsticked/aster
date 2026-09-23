// @ts-check
// Aster — write the generated half of config/asterisk from the registry, without reloading anything.
//
// The five files under config/asterisk/aster.d are derived from config/aster.yaml, and every hand-owned file
// includes its own: extensions.conf includes globals.conf and modems.conf, pjsip.conf includes phones.conf, the two
// driver files their device lists. Asterisk does not tolerate a missing include — it rejects the **whole** file, so a
// pjsip.conf whose include is not there leaves the appliance with no transport and no endpoints at all — which is why
// a fresh install writes them before anything starts: install.sh runs this once, after the starter templates and the
// registry are in place and before the containers come up.
//
// It is not an apply: nothing is reloaded and nothing is verified, because at this point there is no Asterisk to talk
// to. Changing a modem or a phone later goes through the registry-apply operation as always, which regenerates
// the same files, reloads exactly what changed and checks the result. Running this again writes only what differs, so
// it is safe at any time — the apply would produce the same bytes.
//
// Usage: node bin/generate.js [--force] [--quiet]
//   --force   write every file even when its content already matches (a repair for a file with a broken mode)
//   --quiet   print nothing but errors
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { readFile, writeAtomic } from '../src/config/atomic.js';
import { generateAll } from '../src/config/generators.js';
import { load as loadRegistry, RegistryError, validate } from '../src/config/registry.js';
import { loadEnv } from '../src/env.js';

/** @param {string} message @returns {never} */
function fail(message) {
  process.stderr.write(`generate.js: ${message}\n`);
  process.exit(2);
}

async function main() {
  const { values } = parseArgs({ options: { force: { type: 'boolean', default: false }, quiet: { type: 'boolean', default: false } } });
  const env = loadEnv();
  const say = (/** @type {string} */ line) => {
    if (!values.quiet) process.stdout.write(`${line}\n`);
  };

  /** An appliance that has not been configured yet has no registry file: the empty registry is what it means. */
  let registry;
  try {
    registry = existsSync(env.paths.registry)
      ? loadRegistry(env.paths.registry).registry
      : validate({ version: 1, modems: [], phones: [] });
  } catch (err) {
    if (err instanceof RegistryError) {
      fail(`${env.paths.registry} is invalid, so the generated files cannot be written:\n  ${err.errors.map((problem) => `${problem.path}: ${problem.message}`).join('\n  ')}`);
    }
    throw err;
  }

  const generated = generateAll(registry);
  let written = 0;
  for (const [name, text] of Object.entries(generated)) {
    const path = join(env.paths.asteriskConfig, name);
    const current = readFile(path);
    if (!values.force && current !== null && current.text === text) {
      say(`unchanged ${name}`);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeAtomic(path, text);
    written += 1;
    say(`${current === null ? 'wrote' : 'rewrote'} ${name}`);
  }
  say(`generate.js: ${written} of ${Object.keys(generated).length} file(s) written into ${env.paths.asteriskConfig}/aster.d`);
}

await main();

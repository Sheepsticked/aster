// @ts-check
// Aster — set the admin password: a scrypt hash (src/http/auth.js) into ASTER_ADMIN_PASSWORD_HASH of config/secrets.env, and every
// session ended, so a password change logs out every browser. The password comes from ASTER_ADMIN_PASSWORD, else from stdin
// when it is not a terminal (install.sh --non-interactive pipes it), else from two prompts with the echo turned off. The file is
// rewritten atomically, keeping its mode and its other lines; nothing but the hash is ever written, and the password itself is
// never printed or logged.
// Usage: node bin/passwd.js [--hash]   (--hash: print the hash for a password read from stdin/ASTER_ADMIN_PASSWORD, write nothing)
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { createSecretsStore, loadEnv } from '../src/env.js';
import { checkPassword, HASH_KEY, hashPassword } from '../src/http/auth.js';
import { open } from '../src/store/db.js';

/** @param {string} message @param {number} [code] @returns {never} */
function fail(message, code = 2) {
  process.stderr.write(`passwd.js: ${message}\n`);
  process.exit(code);
}

/**
 * Reads a line without echoing it.
 * @param {string} prompt
 * @returns {Promise<string>}
 */
function ask(prompt) {
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stderr.write(chunk, encoding);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    const cleanup = () => {
      rl.removeListener('close', onClose);
      rl.removeListener('SIGINT', onInterrupt);
      rl.close();
      process.stderr.write('\n');
    };
    /** @param {number} code */
    const cancel = (code) => {
      cleanup();
      fail('cancelled; nothing was written', code);
    };
    const onClose = () => cancel(2);
    const onInterrupt = () => cancel(130);
    rl.once('close', onClose);
    rl.once('SIGINT', onInterrupt);
    // Let readline refresh and write the prompt before suppressing all echo and cursor movement.
    rl.question(prompt, (answer) => {
      cleanup();
      resolve(answer);
    });
    muted = true;
  });
}

/** Everything on stdin, used when it is a pipe or a file. @returns {Promise<string>} */
async function readStdin() {
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/** @returns {Promise<string>} */
async function readPassword() {
  const fromEnv = process.env.ASTER_ADMIN_PASSWORD;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  if (!process.stdin.isTTY) {
    const text = await readStdin();
    if (text === '') fail('no password on stdin (set ASTER_ADMIN_PASSWORD or pipe one in)');
    return text.split('\n')[0]?.replace(/\r$/, '') ?? '';
  }
  const password = await ask('New admin password: ');
  const again = await ask('Repeat the password: ');
  if (password !== again) fail('the two passwords are not the same; nothing was written');
  return password;
}

async function main() {
  const { values } = parseArgs({ options: { hash: { type: 'boolean', default: false } } });
  const password = await readPassword();
  const problem = checkPassword(password);
  if (problem) fail(`${problem}; nothing was written`);
  const hash = await hashPassword(password);
  if (values.hash) {
    process.stdout.write(`${hash}\n`);
    return;
  }

  const env = loadEnv();
  createSecretsStore(env.paths.secrets, env.secrets).set({ [HASH_KEY]: hash });
  let cleared = 0;
  if (existsSync(env.paths.db)) {
    const db = open(env.paths.db);
    try {
      cleared = Number(db.prepare('DELETE FROM sessions').run().changes);
    } catch (err) {
      process.stderr.write(`passwd.js: the password was written, but the sessions could not be cleared: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    } finally {
      db.close();
    }
  }
  process.stdout.write(`the admin password is set in ${env.paths.secrets}; ${cleared} session(s) ended\n`);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));

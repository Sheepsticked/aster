// @ts-check
// Tests for src/env.js: the secrets.env grammar, the paths derived from ASTER_HOME, the HTTP target and UI directory, and the
// secrets store that rewrites the file in place.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import { createSecretsStore, DEFAULT_HOME, DEFAULT_TELEGRAM_API, loadEnv, parseSecrets, updateSecretsText } from '../src/env.js';

describe('parseSecrets', () => {
  test('KEY=value lines; comments, blank lines, CRLF and a BOM are ignored; unquoted values are trimmed', () => {
    const text = '\uFEFF# Aster secrets\r\nASTER_AMI_SECRET=abc123\r\n\r\n   # indented comment\n  ASTER_SESSION_KEY=  k3y  \nEMPTY=\n';
    assert.deepEqual({ ...parseSecrets(text) }, { ASTER_AMI_SECRET: 'abc123', ASTER_SESSION_KEY: 'k3y', EMPTY: '' });
  });

  test('values are literal: =, $, #, backticks and $(…) are kept and nothing is expanded', () => {
    const text = [
      'B64=YWJjZA==',
      'ASTER_ADMIN_PASSWORD_HASH=$scrypt$ln=15,r=8,p=1$c2FsdA$aGFzaA',
      'TELEGRAM_BOT_TOKEN=123456:AA-bb_cc # not a comment',
      'SHELL=`id` $(id) ${HOME}',
    ].join('\n');
    assert.deepEqual({ ...parseSecrets(text) }, {
      B64: 'YWJjZA==',
      ASTER_ADMIN_PASSWORD_HASH: '$scrypt$ln=15,r=8,p=1$c2FsdA$aGFzaA',
      TELEGRAM_BOT_TOKEN: '123456:AA-bb_cc # not a comment',
      SHELL: '`id` $(id) ${HOME}',
    });
  });

  test('quotes are removed and their content is kept verbatim', () => {
    const text = "SINGLE='  a b  '\nDOUBLE=\"x\\ny\"\nINNER=\"a\"b\"\nMIXED='it\"s'\n";
    assert.deepEqual({ ...parseSecrets(text) }, { SINGLE: '  a b  ', DOUBLE: 'x\\ny', INNER: 'a"b', MIXED: 'it"s' });
  });

  test('__proto__ is an ordinary key', () => {
    const secrets = parseSecrets('__proto__=x\n');
    assert.equal(secrets.__proto__, 'x');
    assert.equal(Object.getPrototypeOf(secrets), null);
  });

  test('errors name the file and the line but never the value', () => {
    /** @type {Array<[string, RegExp]>} */
    const cases = [
      ['NO_EQUALS_SIGN', /^x\.env:1: expected KEY=value$/],
      ['1BAD=secret-value', /^x\.env:1: invalid key/],
      ['export KEY=secret-value', /^x\.env:1: invalid key/],
      ['KEY ="secret-value"', /^x\.env:1: invalid key/],
      ['A=1\nKEY="secret-value', /^x\.env:2: KEY: unterminated quote$/],
      ["A=1\nKEY='", /^x\.env:2: KEY: unterminated quote$/],
      ['KEY=other\n\nKEY=secret-value', /^x\.env:3: KEY is already set on line 1$/],
    ];
    for (const [text, expected] of cases) {
      assert.throws(
        () => parseSecrets(text, 'x.env'),
        (err) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, expected);
          assert.doesNotMatch(err.message, /secret-value/);
          return true;
        },
        text,
      );
    }
  });
});

describe('loadEnv', () => {
  const root = mkdtempSync(join(tmpdir(), 'aster-env-'));
  after(() => rmSync(root, { recursive: true, force: true }));

  test('derives every path from ASTER_HOME, reads the secrets and freezes the result', () => {
    const home = join(root, 'home');
    mkdirSync(join(home, 'config'), { recursive: true });
    writeFileSync(join(home, 'config', 'secrets.env'), 'ASTER_AMI_SECRET=s3cret\nTELEGRAM_BOT_TOKEN=\n', { mode: 0o600 });
    const env = loadEnv({ ASTER_HOME: home });
    assert.equal(env.home, home);
    assert.deepEqual({ ...env.paths }, {
      config: join(home, 'config'),
      registry: join(home, 'config', 'aster.yaml'),
      secrets: join(home, 'config', 'secrets.env'),
      asteriskConfig: join(home, 'config', 'asterisk'),
      state: join(home, 'state'),
      db: join(home, 'state', 'aster.db'),
      prev: join(home, 'state', 'prev'),
      spool: join(home, 'spool'),
      logs: join(home, 'logs'),
    });
    assert.deepEqual({ ...env.secrets }, { ASTER_AMI_SECRET: 's3cret', TELEGRAM_BOT_TOKEN: '' });
    assert.ok(Object.isFrozen(env) && Object.isFrozen(env.paths) && Object.isFrozen(env.secrets));
    assert.throws(() => {
      /** @type {Record<string, string>} */ (env.secrets).ASTER_AMI_SECRET = 'changed';
    }, TypeError);
  });

  test('ASTER_TELEGRAM_API: the Bot API base, default api.telegram.org; only an http(s) URL without credentials, query or fragment', () => {
    const home = join(root, 'telegram-api');
    mkdirSync(join(home, 'config'), { recursive: true });
    writeFileSync(join(home, 'config', 'secrets.env'), '');
    assert.equal(DEFAULT_TELEGRAM_API, 'https://api.telegram.org');
    assert.equal(loadEnv({ ASTER_HOME: home }).telegramApi, 'https://api.telegram.org');
    assert.equal(loadEnv({ ASTER_HOME: home, ASTER_TELEGRAM_API: '' }).telegramApi, 'https://api.telegram.org');
    assert.equal(loadEnv({ ASTER_HOME: home, ASTER_TELEGRAM_API: 'http://127.0.0.1:18081' }).telegramApi, 'http://127.0.0.1:18081');
    assert.equal(loadEnv({ ASTER_HOME: home, ASTER_TELEGRAM_API: 'https://proxy.lan/telegram//' }).telegramApi, 'https://proxy.lan/telegram');
    for (const bad of ['api.telegram.org', 'ftp://api.telegram.org', 'https://user:pw@api.telegram.org', 'https://api.telegram.org/?x=1', 'https://api.telegram.org/#a']) {
      assert.throws(() => loadEnv({ ASTER_HOME: home, ASTER_TELEGRAM_API: bad }), { message: /^ASTER_TELEGRAM_API must be an http or https URL/ }, bad);
    }
  });

  test('secrets come from the file, not from process.env', () => {
    const home = join(root, 'file-only');
    mkdirSync(join(home, 'config'), { recursive: true });
    writeFileSync(join(home, 'config', 'secrets.env'), 'ASTER_AMI_SECRET=from-file\n');
    const env = loadEnv({ ASTER_HOME: home, ASTER_AMI_SECRET: 'from-environment', ASTER_SESSION_KEY: 'x' });
    assert.deepEqual({ ...env.secrets }, { ASTER_AMI_SECRET: 'from-file' });
  });

  test('a relative ASTER_HOME is resolved against the working directory', () => {
    assert.equal(DEFAULT_HOME, '/srv/aster');
    const home = join(root, 'relative');
    mkdirSync(join(home, 'config'), { recursive: true });
    writeFileSync(join(home, 'config', 'secrets.env'), '');
    const cwd = process.cwd();
    process.chdir(root);
    try {
      assert.equal(loadEnv({ ASTER_HOME: 'relative' }).home, home);
    } finally {
      process.chdir(cwd);
    }
  });

  test(
    'without ASTER_HOME the default /srv/aster is used',
    { skip: existsSync('/srv/aster/config/secrets.env') ? 'a real /srv/aster exists on this machine' : false },
    () => {
      for (const environ of [{}, { ASTER_HOME: '' }]) {
        assert.throws(() => loadEnv(environ), { message: /^secrets file not found: \/srv\/aster\/config\/secrets\.env / });
      }
    },
  );

  test('a missing secrets file is an explicit error naming the path', () => {
    const home = join(root, 'no-secrets');
    mkdirSync(join(home, 'config'), { recursive: true });
    const expected = `secrets file not found: ${join(home, 'config', 'secrets.env')} (install.sh creates it; ASTER_HOME=${home})`;
    assert.throws(() => loadEnv({ ASTER_HOME: home }), { message: expected });
  });

  test('a malformed secrets file names the file and line', () => {
    const home = join(root, 'malformed');
    mkdirSync(join(home, 'config'), { recursive: true });
    writeFileSync(join(home, 'config', 'secrets.env'), 'OK=1\nbroken line\n');
    assert.throws(() => loadEnv({ ASTER_HOME: home }), { message: `${join(home, 'config', 'secrets.env')}:2: expected KEY=value` });
  });

  // An installed appliance keeps the port its .env names.
  test('ASTER_HTTP_HOST/PORT: the LAN and port 80 by default, 0 asks for a free one; ASTER_UI_DIR is null while it does not exist', () => {
    const home = join(root, 'http');
    mkdirSync(join(home, 'config'), { recursive: true });
    writeFileSync(join(home, 'config', 'secrets.env'), '');
    assert.deepEqual({ ...loadEnv({ ASTER_HOME: home }).http }, { host: '0.0.0.0', port: 80 });
    assert.deepEqual({ ...loadEnv({ ASTER_HOME: home, ASTER_HTTP_HOST: '127.0.0.1', ASTER_HTTP_PORT: '9090' }).http }, { host: '127.0.0.1', port: 9090 });
    assert.equal(loadEnv({ ASTER_HOME: home, ASTER_HTTP_PORT: '0' }).http.port, 0);
    assert.equal(loadEnv({ ASTER_HOME: home, ASTER_HTTP_PORT: '' }).http.port, 80);
    for (const port of ['-1', '65536', 'eighty', '80.5']) {
      assert.throws(() => loadEnv({ ASTER_HOME: home, ASTER_HTTP_PORT: port }), { message: /^ASTER_HTTP_PORT must be a port number/ }, port);
    }
    assert.equal(loadEnv({ ASTER_HOME: home, ASTER_UI_DIR: join(home, 'nothing') }).uiDir, join(home, 'nothing'), 'the path is not checked here');
    assert.equal(loadEnv({ ASTER_HOME: home, ASTER_UI_DIR: 'ui' }).uiDir, resolve('ui'));
    assert.equal(loadEnv({ ASTER_HOME: home }).uiDir, join(fileURLToPath(new URL('../..', import.meta.url)), 'ui', 'dist'),
      'the default is packages/ui/dist beside the controller; the build puts it there and the server answers 503 until it holds an index.html');
  });

  test('ASTER_AMI_MOCK is off unless it is exactly 1 (it disconnects the controller from Asterisk)', () => {
    const home = join(root, 'ami-mock');
    mkdirSync(join(home, 'config'), { recursive: true });
    writeFileSync(join(home, 'config', 'secrets.env'), '');
    assert.equal(loadEnv({ ASTER_HOME: home }).amiMock, false);
    assert.equal(loadEnv({ ASTER_HOME: home, ASTER_AMI_MOCK: '1' }).amiMock, true);
    // Anything else is off: a variable left behind as `0` or `false` must not take a real appliance off Asterisk.
    for (const value of ['', '0', 'false', 'true', 'yes', 'on', '01']) {
      assert.equal(loadEnv({ ASTER_HOME: home, ASTER_AMI_MOCK: value }).amiMock, false, value);
    }
  });
});

describe('updateSecretsText and the secrets store', () => {
  const root = mkdtempSync(join(tmpdir(), 'aster-secrets-'));
  after(() => rmSync(root, { recursive: true, force: true }));

  test('a key is rewritten in place, a new one appended, a null one removed; comments and the other lines stay', () => {
    const text = '# Aster secrets\nASTER_AMI_SECRET=abc\n\n# the bot\nTELEGRAM_BOT_TOKEN=old\n';
    assert.equal(updateSecretsText(text, { TELEGRAM_BOT_TOKEN: 'new' }), '# Aster secrets\nASTER_AMI_SECRET=abc\n\n# the bot\nTELEGRAM_BOT_TOKEN=new\n');
    assert.equal(updateSecretsText(text, { TELEGRAM_BOT_TOKEN: null }), '# Aster secrets\nASTER_AMI_SECRET=abc\n\n# the bot\n');
    assert.equal(updateSecretsText(text, { ASTER_ADMIN_PASSWORD_HASH: '$scrypt$ln=15,r=8,p=1$c2FsdA$aGFzaA' }),
      `${text}ASTER_ADMIN_PASSWORD_HASH=$scrypt$ln=15,r=8,p=1$c2FsdA$aGFzaA\n`);
    assert.equal(updateSecretsText('', { A: '1' }), 'A=1\n');
    assert.equal(updateSecretsText('A=1', { B: '2' }), 'A=1\nB=2\n', 'a file without a final newline gets one');
    assert.equal(updateSecretsText(text, { NOTHERE: null }), text);
    // A value that would not be read back the same way is quoted, and one that cannot be written at all is refused.
    assert.deepEqual({ ...parseSecrets(updateSecretsText('', { A: '  spaced  ', B: "it's", C: '"quoted"' })) },
      { A: '  spaced  ', B: "it's", C: '"quoted"' });
    assert.throws(() => updateSecretsText('', { A: 'two\nlines' }), { message: /must not contain line breaks/ });
    assert.throws(() => updateSecretsText('', { '2BAD': 'x' }), { message: /^invalid key/ });
  });

  test('the store writes the file atomically, keeps its mode and hands out the new secrets', () => {
    const path = join(root, 'secrets.env');
    writeFileSync(path, '# head\nASTER_AMI_SECRET=abc\n', { mode: 0o600 });
    const store = createSecretsStore(path);
    assert.deepEqual({ ...store.get() }, { ASTER_AMI_SECRET: 'abc' });
    const next = store.set({ TELEGRAM_BOT_TOKEN: '123:abc' });
    assert.deepEqual({ ...next }, { ASTER_AMI_SECRET: 'abc', TELEGRAM_BOT_TOKEN: '123:abc' });
    assert.equal(store.get(), next, 'every holder of the store sees it');
    assert.equal(readFileSync(path, 'utf8'), '# head\nASTER_AMI_SECRET=abc\nTELEGRAM_BOT_TOKEN=123:abc\n');
    assert.equal(statSync(path).mode & 0o777, 0o600, 'a secrets file stays unreadable to others');
    store.set({ TELEGRAM_BOT_TOKEN: null });
    assert.equal(store.get().TELEGRAM_BOT_TOKEN, undefined);
    assert.ok(Object.isFrozen(store.get()));
    assert.equal(store.path, path);
  });
});

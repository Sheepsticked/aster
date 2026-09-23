// @ts-check
// Aster controller — structured logger: one JSON object per line on stdout (`ts`, `level`, `msg`, then the fields); no dependency.
// Usage: const log = createLogger(); log.info('migrations applied', { from: 0, to: 1 }); log.child({ module: 'store' }).warn('…')

/** @typedef {'debug' | 'info' | 'warn' | 'error'} Level */
/** @typedef {Record<string, unknown>} Fields */
/**
 * @typedef {object} Logger
 * @property {(msg: string, fields?: Fields) => void} debug
 * @property {(msg: string, fields?: Fields) => void} info
 * @property {(msg: string, fields?: Fields) => void} warn
 * @property {(msg: string, fields?: Fields) => void} error
 * @property {(fields: Fields) => Logger} child  a logger that adds `fields` to every line
 */
/** @typedef {{ write(text: string): unknown }} Sink */

/** @type {Record<Level, number>} */
const RANK = { debug: 10, info: 20, warn: 30, error: 40 };
/** Keys every line starts with; a field of the same name is written as `field_<name>`. */
const RESERVED = new Set(['ts', 'level', 'msg']);

/**
 * JSON.stringify replacer: an Error becomes {name, message, its own properties (code, errno, path, errcode…), stack, cause};
 * a bigint becomes its decimal string.
 * @param {string} _key
 * @param {unknown} value
 * @returns {unknown}
 */
function replacer(_key, value) {
  if (value instanceof Error) {
    /** @type {Record<string, unknown>} */
    const out = { name: value.name, message: value.message };
    for (const [k, v] of Object.entries(value)) out[k] = v;
    if (value.stack !== undefined) out.stack = value.stack;
    if (value.cause !== undefined) out.cause = value.cause;
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/**
 * @param {Fields} base
 * @param {Level} threshold
 * @param {Sink} sink
 * @returns {Logger}
 */
function make(base, threshold, sink) {
  /**
   * @param {Level} level
   * @returns {(msg: string, fields?: Fields) => void}
   */
  const emitter = (level) => (msg, fields) => {
    if (RANK[level] < RANK[threshold]) return;
    /** @type {Record<string, unknown>} */
    const line = { ts: new Date().toISOString(), level, msg };
    for (const source of [base, fields ?? {}]) {
      for (const [k, v] of Object.entries(source)) line[RESERVED.has(k) ? `field_${k}` : k] = v;
    }
    let text;
    try {
      text = JSON.stringify(line, replacer);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      text = JSON.stringify({ ts: line.ts, level, msg, log_error: `unserializable fields: ${reason}` });
    }
    sink.write(`${text}\n`);
  };
  return {
    debug: emitter('debug'),
    info: emitter('info'),
    warn: emitter('warn'),
    error: emitter('error'),
    child: (fields) => make({ ...base, ...fields }, threshold, sink),
  };
}

/**
 * @param {{ level?: Level, fields?: Fields, stream?: Sink }} [options]
 *   level: lowest level written (default info); fields: added to every line; stream: default process.stdout
 * @returns {Logger}
 */
export function createLogger({ level = 'info', fields = {}, stream = process.stdout } = {}) {
  if (!Object.hasOwn(RANK, level)) throw new Error(`unknown log level: ${level}`);
  return make({ ...fields }, level, stream);
}

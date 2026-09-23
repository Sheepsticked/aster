// @ts-check
// Aster — runs the end-to-end flows against the stack test/e2e/run.sh brought up: one admin session, one AMI
// session, the five flows in order, and a line per flow with what it took. A flow that throws fails the run; the rest
// still run, because a second failure is information too. ASTER_E2E_ONLY=01,04 runs a subset by prefix.
// Usage: node test/e2e/flows/run.js   (with the ASTER_E2E_* variables run.sh exports)
import { connectAmi, env, makeApi, makeTelegram, waitFor } from './lib.js';
import * as missedCall from './01-missed-call.js';
import * as smsReports from './02-sms-reports.js';
import * as inboundSms from './03-inbound-sms.js';
import * as modemToggle from './04-modem-toggle.js';
import * as brokenConfig from './05-broken-config.js';

const FLOWS = [missedCall, smsReports, inboundSms, modemToggle, brokenConfig];

async function main() {
  const e = env();
  const only = (process.env.ASTER_E2E_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const api = makeApi(e);
  const tg = makeTelegram(e);
  await api.login();
  await waitFor('the AMI to be up', async () => (await api.read('/api/health')).ami?.state === 'up', { timeoutMs: 60_000 });
  const ami = await connectAmi(e);
  /** @type {Array<{ name: string, ok: boolean, ms: number, error?: string }>} */
  const results = [];
  try {
    for (const flow of FLOWS) {
      if (only.length > 0 && !only.some((prefix) => flow.name.startsWith(prefix))) continue;
      const started = Date.now();
      const log = (/** @type {string} */ line) => console.log(`  ${line}`);
      console.log(`▶ ${flow.name}`);
      try {
        await flow.run({ env: e, api, ami, tg, log });
        results.push({ name: flow.name, ok: true, ms: Date.now() - started });
        console.log(`✔ ${flow.name} (${Date.now() - started} ms)`);
      } catch (err) {
        const error = err instanceof Error ? (err.stack ?? err.message) : String(err);
        results.push({ name: flow.name, ok: false, ms: Date.now() - started, error });
        console.log(`✖ ${flow.name} (${Date.now() - started} ms)\n${error}`);
      }
    }
  } finally {
    await ami.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nflows: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(2);
});

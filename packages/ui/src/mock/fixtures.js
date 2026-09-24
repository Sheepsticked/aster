// Mock fixtures in the controller's own response shapes: a working modem, a flapping SIM-less modem (unverified forwarding,
// refused AT), one unassigned device and no AMI, so the pages have failure states to show.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The session-only part of the health answer (`summary`): modems and pending work. */
const summary = () => ({
  modems: [
    { id: 'gsm1', enabled: true, state: 'ready', rssi: 21, provider: 'MTS BY' },
    { id: 'gsm2', enabled: true, state: 'flapping', rssi: null, provider: null },
  ],
  sms: { waiting: 1, failed: 1 },
  notifications: { waiting: 3, failed: 0 },
  operations: { running: 0, waiting: 0 },
});

/** @param {{ summary?: boolean }} [options]  summary: false is the answer an unauthenticated caller gets */
export const health = ({ summary: withSummary = true } = {}) => ({
  ...(withSummary ? { summary: summary() } : {}),
  status: 'degraded',
  reasons: ['AMI is not configured (ASTER_AMI_SECRET is not set), so nothing can be changed in Asterisk'],
  // Just the version, as the controller extracts it from `core show version`.
  versions: { controller: '0.0.0', node: 'v24.21.0', asterisk: '20.15.2' },
  ami: { configured: false, state: null, connected: false, since: null },
  fully_booted: false,
  modules: { checked: false, missing: [], error: null },
  spool_backlog: 0,
  quarantine: 0,
  disk_free_mb: 24_836,
  database: { ok: true, schema_version: 2, error: null },
  uptime_s: 5231,
  checked_at: Date.now(),
});

export const settings = () => ({
  ui_language: 'ru', // the layout tests use the longer Russian labels
  timezone: 'Europe/Istanbul',
  retention_days: { operations: 30, notifications: 45, messages: 180, calls: 365 },
  default_recipients: ['123456789'],
  alerts: true,
  telegram_token_set: true,
  password_set: true,
  registry: { present: true, hash: 'b4d6f1a2c3e4d5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0' },
});

/** @param {Partial<Record<string, unknown>>} fields */
const modem = (fields) => ({
  id: 'gsm1',
  driver: 'quectel',
  imei: '867435040012345',
  enabled: true,
  uac: true,
  usb_port: '1-1',
  group: 1,
  ring: ['101'],
  ring_timeout: 25,
  incoming_context: 'from-gsm1',
  recipients: null,
  ports: null,
  state: 'ready',
  driver_state: 'Free',
  gsm_registration: 'Registered, home network',
  rssi: 21,
  provider: 'MTS BY',
  number: '+1234567890',
  data_tty: '/dev/ttyUSB2',
  observed_at: Date.now() - 2 * MINUTE,
  forwarding: null,
  detail: null,
  ...fields,
});

export const modems = () => [
  modem({}),
  modem({
    id: 'gsm2',
    driver: 'dongle',
    imei: '356938031234560',
    uac: false,
    usb_port: '1-2',
    group: 2,
    ring: ['101', '102'],
    incoming_context: 'from-gsm2',
    state: 'flapping',
    driver_state: 'Not connected',
    gsm_registration: null,
    rssi: null,
    provider: null,
    number: null,
    data_tty: '/dev/ttyUSB6',
    observed_at: Date.now() - 20_000,
  }),
];

/** The phones: two that only ring, one that dials out through a modem. */
export const phones = () => [
  { number: '101', label: 'Приёмная', secret: 'sip-101-secret', outbound: 'gsm1', context: null, direct_media: false, rings_for: ['gsm1', 'gsm2'] },
  { number: '102', label: 'Склад', secret: 'sip-102-secret', outbound: null, context: null, direct_media: false, rings_for: ['gsm2'] },
];

/** Who is connected (`GET /api/connections`): 101 is a desk phone in a call, 102 is not registered. */
export const connections = () => [
  {
    number: '101',
    contacts: [{ address: '192.0.2.21', port: 5060, user_agent: 'Yealink SIP-T31P 124.86.0.40', expires_at: Date.now() + 3_000_000, reachable: null, rtt_ms: null }],
    calls: [{ state: 'talking', number: '+375290000001', name: null, since: Date.now() - 180_000 }],
  },
];

/** The device the drivers found and no modem owns: the row the Overview offers to assign. */
export const unassigned = () => [
  {
    found_by: ['quectel'],
    data_tty: '/dev/ttyUSB8',
    audio_tty: '/dev/ttyUSB7',
    imei: '867435040099999',
    imsi: '001011234567890',
    usb_port: '1-3',
    vendor: '2c7c',
    product: '0125',
    suggested_driver: 'quectel',
    registered: null,
  },
];

export const scan = () => ({ at: Date.now() - 9 * MINUTE, trigger: 'admin', devices: 3, errors: [] });

/**
 * Inbox and outbox as `GET /api/messages` returns them (newest first); outbox rows cover delivered, failed (free retry)
 * and uncertain (retry needs confirmation).
 */
export const messages = () => [
  { direction: 'in', id: 31, modem_id: 'gsm1', number: '+1234567890', text: 'Баланс 12.34 EUR', status: null,
    at: Date.now() - 3 * MINUTE, updated_at: Date.now() - 3 * MINUTE, attempt_no: null, last_error: null, scts: Date.now() - 3 * MINUTE },
  { direction: 'out', id: 12, modem_id: 'gsm1', number: '+375291112233', text: 'Заявка принята', status: 'delivered',
    at: Date.now() - 20 * MINUTE, updated_at: Date.now() - 19 * MINUTE, attempt_no: 1, last_error: null, scts: null },
  { direction: 'out', id: 11, modem_id: 'gsm2', number: '+375299998877', text: 'Склад закрыт до понедельника, приезжайте во вторник после обеда, пропуск на проходной.\nЕсли нужно раньше — позвоните кладовщику, он будет на месте с девяти утра до шести вечера, обед с часу до двух. Номер тот же, что и в прошлый раз.', status: 'uncertain',
    at: Date.now() - 40 * MINUTE, updated_at: Date.now() - 38 * MINUTE, attempt_no: 2,
    last_error: 'the controller restarted while the SMS was being submitted; whether the driver received it is unknown', scts: null },
  { direction: 'out', id: 10, modem_id: 'gsm1', number: '+375291110000', text: 'Тест', status: 'failed',
    at: Date.now() - 2 * HOUR, updated_at: Date.now() - 2 * HOUR, attempt_no: 1, last_error: '[gsm1] Device disconnected', scts: null },
  { direction: 'in', id: 30, modem_id: 'gsm2', number: 'no-reply.notifications@example-service.com', text: 'Перезвоните пожалуйста', status: null,
    at: Date.now() - 3 * HOUR, updated_at: Date.now() - 3 * HOUR, attempt_no: null, last_error: null, scts: Date.now() - 3 * HOUR },
];

/** Calls as `GET /api/calls` returns them: the three outcomes the controller derives. */
export const calls = () => [
  { id: 7, modem_id: 'gsm1', uniqueid: '1789200000.7', caller: '+1234567890', did: '+375291111111', dialstatus: 'ANSWER',
    answered_sec: 96, dialed_sec: 12, disposition: 'ANSWERED', hangupcause: 16, outcome: 'answered', ended_at: Date.now() - 12 * MINUTE },
  { id: 6, modem_id: 'gsm2', uniqueid: '1789200000.6', caller: '+375447654321', did: '+375292222222', dialstatus: 'NOANSWER',
    answered_sec: 0, dialed_sec: 25, disposition: 'NO ANSWER', hangupcause: 19, outcome: 'missed', ended_at: Date.now() - 50 * MINUTE },
  { id: 5, modem_id: 'gsm1', uniqueid: '1789200000.5', caller: '', did: '+375291111111', dialstatus: 'CONGESTION',
    answered_sec: 0, dialed_sec: 0, disposition: 'FAILED', hangupcause: 34, outcome: 'failed', ended_at: Date.now() - 5 * HOUR },
];

/** Notification rows as `GET /api/notifications` returns them. */
export const notifications = () => [
  { id: 51, source_kind: 'sms', source_id: 31, chat_id: '123456789', part_no: 1, part_count: 1, text: 'SMS gsm1 ← +1234567890: Баланс 12.34 EUR',
    status: 'sent', attempts: 1, next_at: null, tg_message_id: 4412, error: null, created_at: Date.now() - 3 * MINUTE, sent_at: Date.now() - 3 * MINUTE },
  { id: 50, source_kind: 'call', source_id: 6, chat_id: '123456789', part_no: 1, part_count: 1, text: 'Пропущенный звонок gsm2 ← +375447654321',
    status: 'retry', attempts: 2, next_at: Date.now() + MINUTE, tg_message_id: null, error: 'Bad Gateway', created_at: Date.now() - 50 * MINUTE, sent_at: null },
  { id: 49, source_kind: 'alert', source_id: null, chat_id: '987654321', part_no: 1, part_count: 1, text: 'Модем gsm2 недоступен более 5 минут',
    status: 'failed', attempts: 5, next_at: null, tg_message_id: null, error: 'Forbidden: bot was blocked by the user',
    created_at: Date.now() - 6 * HOUR, sent_at: null },
];

/** Operations as the list route returns them (the params and the result are only in `GET /api/operations/:id`). */
export const operations = () => [
  { id: 44, kind: 'sms-send', modem_id: 'gsm2', status: 'uncertain', error: 'no report within the validity period; whether it was delivered is unknown',
    actor: 'admin', created_at: Date.now() - 38 * MINUTE, started_at: Date.now() - 38 * MINUTE, finished_at: Date.now() - 8 * MINUTE },
  { id: 43, kind: 'registry-apply', modem_id: null, status: 'done', error: null, actor: 'admin',
    created_at: Date.now() - 2 * HOUR, started_at: Date.now() - 2 * HOUR, finished_at: Date.now() - 2 * HOUR + 1200 },
  { id: 42, kind: 'modem-restart', modem_id: 'gsm2', status: 'failed', error: '[gsm2] Device not found', actor: 'system',
    created_at: Date.now() - 3 * HOUR, started_at: Date.now() - 3 * HOUR, finished_at: Date.now() - 3 * HOUR + 400 },
];

/** What `GET /api/operations/:id` adds to a row: the parameters it ran with and what it produced. */
export const operationDetail = (/** @type {any} */ row) => ({
  ...row,
  params: row.kind === 'sms-send' ? { outbox_id: 11, attempt_no: 2 } : row.kind === 'modem-restart' ? { when: 'gracefully' } : { base_hash: null },
  result: row.status === 'done' ? { files_written: ['aster.d/phones.conf'], actions: ['Command: module reload res_pjsip.so'], verified: { endpoints: ['101', '102'] } } : null,
});

/**
 * Config files as `GET /api/config/files` lists them (hand-owned and generated). `drift` simulates one outside write
 * between read and apply to exercise the "changed on disk" conflict; it fires once.
 */
export const configFiles = () => [
  { name: 'extensions.conf', kind: 'hand', editable: true, present: true, status: 'applied', restorable: true, restart_required: false,
    reload: ['Command: dialplan reload'], content: '[smoke]\nexten => 100,1,Answer()\n same => n,Playback(hello-world)\n same => n,Hangup()\n' },
  { name: 'pjsip.conf', kind: 'hand', editable: true, present: true, status: 'modified', restorable: false, restart_required: false,
    reload: ['Command: module reload res_pjsip.so'], content: '[transport-udp]\ntype = transport\nprotocol = udp\nbind = 0.0.0.0:5060\n#include aster.d/phones.conf\n' },
  { name: 'rtp.conf', kind: 'hand', editable: true, present: true, status: 'applied', restorable: false, restart_required: false, drift: true,
    reload: ['Command: module reload res_rtp_asterisk.so'], content: '[general]\nrtpstart = 10000\nrtpend = 10200\n' },
  { name: 'modules.conf', kind: 'hand', editable: true, present: true, status: 'applied', restorable: false, restart_required: true,
    reload: ['Command: core restart gracefully'], content: '[modules]\nautoload = yes\nnoload = chan_sip.so\n' },
  { name: 'aster.d/phones.conf', kind: 'generated', editable: false, present: true, status: 'generated', restorable: false,
    restart_required: false, reload: ['Command: module reload res_pjsip.so'],
    content: '; generated by aster — do not edit\n[101](aster-phone)\nauth = 101\naors = 101\n' },
];

/** The log tails: Asterisk's own file and the controller's ring buffer. */
export const logLines = (/** @type {'asterisk' | 'controller'} */ which) => (which === 'asterisk'
  ? [
      '[2026-09-12 12:00:01] NOTICE[41] chan_quectel.c: [gsm1] Trying to connect on /dev/ttyUSB2...',
      '[2026-09-12 12:00:03] NOTICE[41] chan_quectel.c: [gsm1] Module Quectel EC25 IMEI 867435040012345 registered',
      '[2026-09-12 12:04:11] WARNING[52] chan_dongle.c: [gsm2] Lost connection to device',
      '[2026-09-12 12:04:26] NOTICE[52] chan_dongle.c: [gsm2] Trying to connect on /dev/ttyUSB6...',
    ]
  : [
      '{"ts":"2026-09-12T12:00:01.004Z","level":"info","msg":"ready","module":"main"}',
      '{"ts":"2026-09-12T12:04:11.900Z","level":"warn","msg":"modem state changed","module":"devices","modem":"gsm2","state":"flapping"}',
      '{"ts":"2026-09-12T12:05:00.120Z","level":"info","msg":"operation finished","module":"ops","kind":"scan","status":"done"}',
    ]);

/**
 * One condition's forwarding verdict: `verified` only for a usable +CCFC answer; otherwise the outcome and driver text.
 * @param {Partial<Record<string, unknown>>} fields
 */
export const forwarding = (fields = {}) => ({
  verified: true,
  outcome: 'ok',
  enabled: false,
  number: null,
  type: null,
  class: 1,
  time: null,
  entries: [{ class: 1, status: 0, number: null, type: null }],
  lines: ['+CCFC: 0,1'],
  error: null,
  observed_at: Date.now() - MINUTE,
  ...fields,
});

// @ts-check
// Aster controller — JSON schemas of the modem routes: shapes and bounds only; config/registry.js decides validity.
// Query and path parameters are not coerced, so numbers are strings with a digit pattern.

/** The modem id: it becomes the device name, `${<ID>}` and the aster-*-<id> contexts (config/registry.js). */
export const ID = '^[a-z][a-z0-9_]{0,15}$';
const IMEI = { type: 'string', pattern: '^[0-9]{15}$' };
const USB_PORT = { type: ['string', 'null'], pattern: '^[0-9]+-[0-9]+(?:\\.[0-9]+)*$' };
const CONTEXT = { type: ['string', 'null'], maxLength: 79 };
const PHONE_NUMBER = { type: 'string', pattern: '^[0-9]{3,6}$' };
const DEVICE = { type: 'string', pattern: '^/dev(?:/[A-Za-z0-9_.:+@-]+)+$' };
/** A modem's own number in international format (config/registry.js, at/simnumber.js). */
const OWN_NUMBER = { type: 'string', pattern: '^\\+[0-9]{6,15}$' };

/** The fields a modem has in config/aster.yaml; POST requires id, driver and imei, PUT takes any subset but never the id. */
const FIELDS = {
  driver: { enum: ['quectel', 'dongle'] },
  imei: IMEI,
  phone_number: { ...OWN_NUMBER, type: ['string', 'null'] },
  enabled: { type: 'boolean' },
  uac: { type: 'boolean' },
  usb_port: USB_PORT,
  ring: { type: 'array', maxItems: 32, items: PHONE_NUMBER },
  ring_timeout: { type: 'integer', minimum: 1, maximum: 3600 },
  incoming_context: CONTEXT,
  group: { type: ['integer', 'null'], minimum: 0, maximum: 2147483647 },
  recipients: { type: ['array', 'null'], maxItems: 32, items: { type: 'string', pattern: '^-?[0-9]{1,20}$' } },
  ports: {
    type: ['object', 'null'],
    required: ['data', 'audio'],
    additionalProperties: false,
    properties: { data: DEVICE, audio: DEVICE },
  },
};

/** `:id` of every /api/modems/:id route. */
export const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: ID } } };

/** POST /api/modems — assign a scanned device or a manually entered IMEI. */
export const create = ({
  body: {
    type: 'object',
    required: ['id', 'driver', 'imei'],
    additionalProperties: false,
    properties: { id: { type: 'string', pattern: ID }, force: { type: 'boolean' }, ...FIELDS },
  },
});

/** PUT /api/modems/:id — the fields to change. The id is not among them: it names the device, so a rename is a delete and an add. */
export const update = ({
  params: idParam,
  body: {
    type: 'object',
    minProperties: 1,
    additionalProperties: false,
    properties: { force: { type: 'boolean' }, ...FIELDS },
  },
});

export const remove = ({ params: idParam, body: { type: 'object', additionalProperties: false, properties: { force: { type: 'boolean' } } } });

/** POST /api/modems/:id/{start,stop,restart,reset,remap} — `when` is the drivers' Stop/Restart timing (devices/lifecycle.js). */
export const action = ({
  params: idParam,
  body: {
    type: 'object',
    additionalProperties: false,
    properties: { when: { enum: ['now', 'gracefully', 'when convenient'] } },
  },
});

/** POST /api/modems/:id/forwarding (at/forwarding.js; the route checks which fields go with which action). */
export const forwarding = ({
  params: idParam,
  body: {
    type: 'object',
    required: ['action'],
    additionalProperties: false,
    properties: {
      action: { enum: ['set', 'enable', 'disable', 'erase', 'query'] },
      reason: { enum: ['unconditional', 'busy', 'no_reply', 'not_reachable', 'conditional', 'all'] },
      number: { type: 'string', pattern: '^\\+[0-9]{6,15}$' },
      time: { enum: [5, 10, 15, 20, 25, 30] },
    },
  },
});

/** POST /api/modems/:id/sim-number: the number to write into the SIM's own-number list. */
export const simNumber = ({
  params: idParam,
  body: { type: 'object', required: ['number'], additionalProperties: false, properties: { number: OWN_NUMBER } },
});

/** POST /api/modems/:id/at (at/client.js checks the command text and the timeout again inside the operation). */
export const at = ({
  params: idParam,
  body: {
    type: 'object',
    required: ['command'],
    additionalProperties: false,
    properties: { command: { type: 'string', minLength: 1, maxLength: 256 }, timeout: { type: 'integer', minimum: 1, maximum: 60 } },
  },
});

/** POST /api/modems/:id/ussd. */
export const ussd = ({
  params: idParam,
  body: {
    type: 'object',
    required: ['code'],
    additionalProperties: false,
    properties: { code: { type: 'string', pattern: '^[0-9*#]{1,64}$' } },
  },
});

/** POST /api/modems/:id/ussd/cancel takes no parameters. */
export const ussdCancel = ({
  params: idParam,
  body: { type: 'object', additionalProperties: false, properties: {} },
});

/** GET /api/modems — the list takes no filters; `q` and paging belong to the history routes. */
export const list = ({ querystring: { type: 'object', additionalProperties: false, properties: {} } });

/** POST /api/scan takes no parameters (the operation probes every free port of both drivers). */
export const scan = ({ body: { type: 'object', additionalProperties: false, properties: {} } });

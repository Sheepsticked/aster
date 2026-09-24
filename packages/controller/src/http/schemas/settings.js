// @ts-check
// Aster controller — JSON schema of PUT /api/settings: shapes and bounds only; config/registry.js validates values again.
import { MAX_PASSWORD } from '../auth.js';

const CHAT_ID = { type: 'string', pattern: '^-?[0-9]{1,20}$' };

/** PUT /api/settings — every field is optional, but the body must change something. */
export const update = ({
  body: {
    type: 'object',
    additionalProperties: false,
    minProperties: 1,
    properties: {
      ui_language: { enum: ['ru', 'en'] },
      timezone: { type: 'string', minLength: 1, maxLength: 64 },
      retention_days: {
        type: 'object',
        additionalProperties: false,
        minProperties: 1,
        properties: {
          operations: { type: 'integer', minimum: 1, maximum: 3650 },
          notifications: { type: 'integer', minimum: 1, maximum: 3650 },
          messages: { type: 'integer', minimum: 1, maximum: 3650 },
          calls: { type: 'integer', minimum: 1, maximum: 3650 },
        },
      },
      default_recipients: { type: 'array', maxItems: 32, items: CHAT_ID },
      alerts: { type: 'boolean' },
      // null clears the token; the format is checked against notify/telegram.js isToken before anything is written.
      telegram_token: { type: ['string', 'null'], maxLength: 256 },
      password: {
        type: 'object',
        required: ['current', 'next'],
        additionalProperties: false,
        properties: {
          current: { type: 'string', minLength: 1, maxLength: MAX_PASSWORD },
          next: { type: 'string', minLength: 1, maxLength: MAX_PASSWORD },
        },
      },
      force: { type: 'boolean' }, // apply although the registry changed on disk since it was read
    },
  },
});

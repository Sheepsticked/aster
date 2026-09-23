// @ts-check
// Aster controller — JSON schemas of the auth routes (request bodies only; a failure is a 400 naming the field).
import { MAX_PASSWORD } from '../auth.js';

/** POST /api/login */
export const login = ({
  body: {
    type: 'object',
    required: ['password'],
    additionalProperties: false,
    properties: { password: { type: 'string', minLength: 1, maxLength: MAX_PASSWORD } },
  },
});

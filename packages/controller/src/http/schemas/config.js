// @ts-check
// Aster controller — JSON schemas of the configuration file routes. File names are checked by the route
// against the known file lists, not by a pattern.
import { MAX_CONTENT_BYTES } from '../../config/apply.js';

/** PUT /api/config/files/<name> — `restart` is the acknowledgement that the file needs `core restart gracefully`. */
export const apply = ({
  body: {
    type: 'object',
    required: ['content'],
    additionalProperties: false,
    properties: {
      content: { type: 'string', maxLength: MAX_CONTENT_BYTES },
      base_hash: { type: ['string', 'null'], pattern: '^[0-9a-f]{64}$' },
      force: { type: 'boolean' },
      restart: { type: 'boolean' },
    },
  },
});

/** POST /api/config/files/<name>/restore — brings state/prev/<name> back. */
export const restore = ({
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      base_hash: { type: ['string', 'null'], pattern: '^[0-9a-f]{64}$' },
      restart: { type: 'boolean' },
    },
  },
});

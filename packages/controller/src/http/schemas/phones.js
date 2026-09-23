// @ts-check
// Aster controller — JSON schemas of the phone routes: shapes and bounds only; the registry checks the rest.
const NUMBER = '^[0-9]{3,6}$';

const FIELDS = {
  label: { type: ['string', 'null'], maxLength: 64 },
  // Printable ASCII without spaces and without ';' (it would end the value in pjsip.conf); registry.js checks it again.
  secret: { type: 'string', pattern: '^[\\x21-\\x3a\\x3c-\\x7e]{1,128}$' },
  outbound: { type: ['string', 'null'], pattern: '^[a-z][a-z0-9_]{0,15}$' },
  context: { type: ['string', 'null'], maxLength: 79 },
  direct_media: { type: 'boolean' },
  // Not a field of the phone entry: the modem ids whose ring lists should hold this phone (routes/phones.js writes them there).
  rings_for: { type: 'array', maxItems: 64, uniqueItems: true, items: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,15}$' } },
};

/** `:number` of every /api/phones/:number route. */
export const numberParam = { type: 'object', required: ['number'], properties: { number: { type: 'string', pattern: NUMBER } } };

export const create = ({
  body: {
    type: 'object',
    required: ['number', 'secret'],
    additionalProperties: false,
    properties: { number: { type: 'string', pattern: NUMBER }, force: { type: 'boolean' }, ...FIELDS },
  },
});

/** PUT /api/phones/:number — the number itself is the endpoint name, so changing it is a delete and an add. */
export const update = ({
  params: numberParam,
  body: { type: 'object', minProperties: 1, additionalProperties: false, properties: { force: { type: 'boolean' }, ...FIELDS } },
});

export const remove = ({
  params: numberParam,
  body: { type: 'object', additionalProperties: false, properties: { force: { type: 'boolean' } } },
});

export const one = ({ params: numberParam });

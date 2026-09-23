// Estimates how many SMS parts a text needs (the driver picks the actual encoding).
// GSM 03.38: 160/153 septets (extension chars cost 2); otherwise UCS-2: 70/67 UTF-16 units.
const BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const EXTENDED = '^{}\\[~]|€';

const LIMITS = Object.freeze({
  gsm: { single: 160, part: 153 },
  ucs2: { single: 70, part: 67 },
});

/**
 * @param {string} text
 * @returns {{ encoding: 'gsm' | 'ucs2', units: number, parts: number, limit: number, left: number }}
 *   `units` is what the text costs in that encoding, `limit` how many fit in the messages it takes, and `left` how many are
 *   free before it grows by one more part.
 */
export function segments(text) {
  let units = 0;
  let gsm = true;
  for (const character of text) {
    if (BASIC.includes(character)) {
      units += 1;
    } else if (EXTENDED.includes(character)) {
      units += 2;
    } else {
      gsm = false;
      break;
    }
  }
  // UCS-2 counts UTF-16 units, so a character outside the basic plane (an emoji) is two of them.
  if (!gsm) units = [...text].reduce((total, character) => total + ((character.codePointAt(0) ?? 0) > 0xffff ? 2 : 1), 0);
  const encoding = gsm ? 'gsm' : 'ucs2';
  const { single, part } = LIMITS[encoding];
  const parts = units === 0 ? 1 : units <= single ? 1 : Math.ceil(units / part);
  const limit = parts === 1 ? single : parts * part;
  return { encoding, units, parts, limit, left: limit - units };
}

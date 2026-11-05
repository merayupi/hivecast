/**
 * Exact decimal helpers.
 *
 * Monetary amounts are carried as `bigint` yoctoNEAR everywhere (see
 * accounting.ts). This module only handles exact comparison and integer scaling
 * of source decimal strings (prices, precipitation) so up/down ties and the
 * 1.0 mm threshold are never decided by floating-point rounding.
 */

/** Parse an optional sign and absolute part of a decimal string. */
function parseSign(s: string): { neg: boolean; abs: string } {
  const t = s.trim();
  if (t.startsWith('-')) return { neg: true, abs: t.slice(1) };
  if (t.startsWith('+')) return { neg: false, abs: t.slice(1) };
  return { neg: false, abs: t };
}

/** Compare the absolute values of two non-negative decimal strings. */
function compareAbsDecimal(a: string, b: string): number {
  const [ai, af = ''] = a.split('.');
  const [bi, bf = ''] = b.split('.');
  const aiN = (ai ?? '').replace(/^0+/, '') || '0';
  const biN = (bi ?? '').replace(/^0+/, '') || '0';
  if (aiN.length !== biN.length) return aiN.length > biN.length ? 1 : -1;
  if (aiN !== biN) return aiN > biN ? 1 : -1;
  const maxF = Math.max(af.length, bf.length);
  const afp = af.padEnd(maxF, '0');
  const bfp = bf.padEnd(maxF, '0');
  if (afp === bfp) return 0;
  return afp > bfp ? 1 : -1;
}

/**
 * Exact comparison of two decimal strings. Returns -1, 0, or 1.
 * Handles signs and leading/trailing zeros. Throws on malformed input.
 */
export function compareDecimalStrings(a: string, b: string): number {
  const sa = parseSign(a);
  const sb = parseSign(b);
  if (sa.neg !== sb.neg) return sa.neg ? -1 : 1;
  const c = compareAbsDecimal(sa.abs, sb.abs);
  return sa.neg ? -c : c;
}

/** `a > b` for decimal strings. */
export function gtDec(a: string, b: string): boolean {
  return compareDecimalStrings(a, b) > 0;
}

/** `a >= b` for decimal strings. */
export function gteDec(a: string, b: string): boolean {
  return compareDecimalStrings(a, b) >= 0;
}

/**
 * Convert a decimal string to an integer scaled by `scale` fractional digits.
 * Extra digits are truncated, missing digits are padded with zeros. Used to
 * compare price means without floating point.
 */
export function scaleDecimal(s: string, scale: number): bigint {
  const { neg, abs } = parseSign(s);
  const [intPart = '0', fracPart = ''] = abs.split('.');
  if (!/^\d+$/.test(intPart) || (fracPart !== '' && !/^\d+$/.test(fracPart))) {
    throw new Error(`Invalid decimal string: ${JSON.stringify(s)}`);
  }
  const factor = 10n ** BigInt(scale);
  const intVal = BigInt(intPart) * factor;
  const fracPad = fracPart.padEnd(scale, '0').slice(0, scale);
  const fracVal = fracPad === '' ? 0n : BigInt(fracPad);
  const v = intVal + fracVal;
  return neg ? -v : v;
}

/** Format a `bigint` scaled by `scale` fractional digits back into a decimal string. */
export function formatScaled(value: bigint, scale: number): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const factor = 10n ** BigInt(scale);
  const intPart = abs / factor;
  let fracPart = (abs % factor).toString().padStart(scale, '0');
  fracPart = fracPart.replace(/0+$/, '');
  const body = fracPart === '' ? intPart.toString() : `${intPart}.${fracPart}`;
  return neg ? `-${body}` : body;
}

const decimalNumberPattern = /^\p{Decimal_Number}$/u;
const decimalValueCache = new Map<number, number>();

/**
 * Unicode guarantees that Decimal_Number characters are arranged as ordered
 * zero-to-nine sets. Derive the value from the complete contiguous run so new
 * scripts supported by the runtime do not require a language or script table.
 */
function unicodeDecimalValue(character: string): number | null {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined || !decimalNumberPattern.test(character)) return null;
  const cached = decimalValueCache.get(codePoint);
  if (cached !== undefined) return cached;

  let runStart = codePoint;
  while (runStart > 0 && codePoint - runStart <= 255) {
    const previous = String.fromCodePoint(runStart - 1);
    if (!decimalNumberPattern.test(previous)) break;
    runStart -= 1;
  }
  if (codePoint - runStart > 255) return null;
  const value = (codePoint - runStart) % 10;
  decimalValueCache.set(codePoint, value);
  return value;
}

/** NFKC-normalize text and map every runtime-supported Unicode decimal digit. */
export function normalizeUnicodeDecimalDigits(value: string): string | null {
  let normalized = "";
  for (const character of value.normalize("NFKC")) {
    if (!decimalNumberPattern.test(character)) {
      normalized += character;
      continue;
    }
    const digit = unicodeDecimalValue(character);
    if (digit === null) return null;
    normalized += String(digit);
  }
  return normalized;
}

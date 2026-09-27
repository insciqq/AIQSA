export function takeUtf16SafePrefix(value: string, maxCodeUnits: number): string {
  const end = Math.min(value.length, Math.max(0, Math.floor(maxCodeUnits) || 0));
  if (end >= value.length) return value;

  const finalCodeUnit = value.charCodeAt(end - 1);
  const safeEnd = finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff
    ? end - 1
    : end;

  return value.slice(0, safeEnd);
}

/**
 * PostgreSQL `jsonb` rejects NUL and an unpaired UTF-16 surrogate anywhere in
 * a document, so provider text bound for a durable JSON row drops NUL and
 * replaces an unpaired surrogate with U+FFFD. With the `u` flag a valid pair
 * is one code point and never matches the surrogate range.
 */
export function storableUtf16Text(value: string): string {
  return value.replace(/\u0000/gu, "").replace(/[\uD800-\uDFFF]/gu, "�");
}

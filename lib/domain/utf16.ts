export function takeUtf16SafePrefix(value: string, maxCodeUnits: number): string {
  const end = Math.min(value.length, Math.max(0, Math.floor(maxCodeUnits) || 0));
  if (end >= value.length) return value;

  const finalCodeUnit = value.charCodeAt(end - 1);
  const safeEnd = finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff
    ? end - 1
    : end;

  return value.slice(0, safeEnd);
}

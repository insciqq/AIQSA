const RETRY_AFTER_MAX_CHARS = 128;

export function parseRetryAfterMs(
  value: string | null,
  nowMs: number = Date.now()
): number | null {
  if (
    !value ||
    value.length > RETRY_AFTER_MAX_CHARS ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) return null;
  const normalized = value.trim();
  if (/^\d{1,9}$/u.test(normalized)) {
    const delayMs = Number(normalized) * 1_000;
    return Number.isSafeInteger(delayMs) && delayMs > 0 ? delayMs : null;
  }
  const retryAt = Date.parse(normalized);
  if (!Number.isFinite(retryAt) || !Number.isFinite(nowMs)) return null;
  const delayMs = Math.ceil(retryAt - nowMs);
  return Number.isSafeInteger(delayMs) && delayMs > 0 ? delayMs : null;
}

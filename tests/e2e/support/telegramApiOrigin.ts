/**
 * The loopback origin of the fake Telegram Bot API for browser specs: the
 * Playwright web server reads it as `AIQSA_TELEGRAM_API_ORIGIN` (honoured only
 * in test mode) and a spec starts its fake on this port.
 */
export const TELEGRAM_E2E_API_ORIGIN = process.env.AIQSA_TELEGRAM_API_ORIGIN?.trim() || "http://127.0.0.1:39417";

export function telegramE2eApiPort(): number {
  const port = Number(new URL(TELEGRAM_E2E_API_ORIGIN).port);
  if (!Number.isSafeInteger(port) || port <= 0) throw new Error("AIQSA_TELEGRAM_API_ORIGIN needs an explicit loopback port");
  return port;
}

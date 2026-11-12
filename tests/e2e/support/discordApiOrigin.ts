/**
 * The loopback ports of the fake Discord for browser specs, distinct from the
 * fake Telegram Bot API's. The Playwright web server reads
 * `AIQSA_DISCORD_API_ORIGIN` (REST, CDN and the gateway's HTTP upgrade share
 * one port) and `AIQSA_DISCORD_GATEWAY_URL`, honoured only in test mode, and
 * a spec starts its fake with `discordE2ePorts()`. The resume server the
 * fake names in READY listens on its own port.
 */
export const DISCORD_E2E_API_ORIGIN = process.env.AIQSA_DISCORD_API_ORIGIN?.trim() || "http://127.0.0.1:39427";

function explicitPort(value: string, name: string): number {
  const port = Number(new URL(value).port);
  if (!Number.isSafeInteger(port) || port <= 0) throw new Error(`${name} needs an explicit loopback port`);
  return port;
}

/** The gateway is the REST origin's own port: the fake upgrades WebSockets on its main server. */
export const DISCORD_E2E_GATEWAY_URL = `ws://127.0.0.1:${explicitPort(DISCORD_E2E_API_ORIGIN, "AIQSA_DISCORD_API_ORIGIN")}`;

export function discordE2ePorts(): Readonly<{ port: number; resumePort: number }> {
  const port = explicitPort(DISCORD_E2E_API_ORIGIN, "AIQSA_DISCORD_API_ORIGIN");
  const resumePort = Number(process.env.AIQSA_DISCORD_E2E_RESUME_PORT?.trim() || port + 1);
  if (!Number.isSafeInteger(resumePort) || resumePort <= 0 || resumePort === port) {
    throw new Error("AIQSA_DISCORD_E2E_RESUME_PORT needs a free loopback port other than the API origin's");
  }
  return { port, resumePort };
}

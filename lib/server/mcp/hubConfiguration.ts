export const MCP_HUB_REQUEST_DEADLINE_MS = 90_000;
export const MCP_HUB_MAX_CONCURRENT_REQUESTS = 32;
export const MCP_HUB_MAX_CONCURRENT_REQUESTS_PER_PRINCIPAL = 4;
// Includes text and structured representations, JSON escaping and the envelope.
export const MCP_HUB_DISCOVERY_RESPONSE_MAX_BYTES = 512 * 1_024;

export function isMcpHubEnabled(environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const value = environment.AIQSA_MCP_HUB_ENABLED?.trim();
  return value === undefined || value === "1";
}

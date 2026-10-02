/**
 * Marks every request personal MCP sends. AIQSA refuses any inbound request
 * carrying it before routing, so a personal connection never reaches the app
 * itself, whichever host address it used. Dependency-free: the request entry
 * (`proxy.ts`) imports it.
 */
export const PERSONAL_MCP_EGRESS_HEADER = "x-aiqsa-egress";
export const PERSONAL_MCP_EGRESS_VALUE = "personal-mcp";

/** Headers the personal MCP transport sets last on every hop. */
export const PERSONAL_MCP_EGRESS_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  [PERSONAL_MCP_EGRESS_HEADER]: PERSONAL_MCP_EGRESS_VALUE
});

/** The app's refusal of its own egress: no body, the marker echoed. */
export const PERSONAL_MCP_EGRESS_REFUSAL_STATUS = 421;

export function isPersonalMcpEgressRequest(headers: Pick<Headers, "has">): boolean {
  return headers.has(PERSONAL_MCP_EGRESS_HEADER);
}

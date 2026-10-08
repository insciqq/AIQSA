/**
 * Client-safe contract of MCP write approval (operator decision 2026-10-08).
 * An interactive run never dispatches an MCP tool that may change data
 * without its initiator's consent: the call is refused undispatched and the
 * answer shows an approval card (`ThreadArtifactSummary.mcpApprovals`). Allow
 * once and Always allow start a continuation turn; Deny starts nothing.
 */

export const MCP_APPROVAL_DECISIONS = ["allow_once", "allow_server", "deny"] as const;
export type McpApprovalDecision = (typeof MCP_APPROVAL_DECISIONS)[number];

/** Cards one answer shows at most. */
export const MCP_APPROVAL_CARDS_LIMIT = 16;

/** Where the refused call came from: the model's tool loop, Workspace guest code, or Agent. */
export type McpApprovalSource = "agent" | "code" | "model";

/** A pending card or its decision. */
export type McpApprovalState = "allowed_once" | "allowed_server" | "denied" | "pending";

/**
 * One refused call as its run initiator's card shows it. Display names are
 * bounded catalog snapshots. `canDecide` is set only for the run's initiator
 * (other Project members see the card read-only); `details` names the
 * refused tool-loop call whose redacted request the initiator may expand.
 */
export type McpApprovalCard = Readonly<{
  approvalId: string;
  canDecide?: true;
  details?: Readonly<{ ordinal: number; roundIndex: number }>;
  serverName: string;
  source: McpApprovalSource;
  state: McpApprovalState;
  toolName: string;
}>;

/** The kind of the server-written user turn that continues after an approval. */
export const MCP_APPROVAL_CONTINUATION_KIND = "mcp_approval_continuation";
export type MessageSystemTurnKind = typeof MCP_APPROVAL_CONTINUATION_KIND;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const display = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= 160 && !value.includes("\0");
const ordinal = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const SOURCES: readonly unknown[] = ["agent", "code", "model"];
const STATES: readonly unknown[] = ["allowed_once", "allowed_server", "denied", "pending"];

export function decodeMcpApprovalCard(value: unknown): McpApprovalCard | null {
  if (!record(value) || !only(value, ["approvalId", "canDecide", "details", "serverName", "source", "state", "toolName"]) ||
    !id(value.approvalId) || !display(value.serverName) || !display(value.toolName) ||
    !SOURCES.includes(value.source) || !STATES.includes(value.state) ||
    (value.canDecide !== undefined && value.canDecide !== true)) return null;
  let details: McpApprovalCard["details"];
  if (value.details !== undefined) {
    if (value.source !== "model" || !record(value.details) || !only(value.details, ["ordinal", "roundIndex"]) ||
      !ordinal(value.details.ordinal) || !ordinal(value.details.roundIndex) || value.details.roundIndex < 1) return null;
    details = { ordinal: value.details.ordinal, roundIndex: value.details.roundIndex };
  }
  return {
    approvalId: value.approvalId,
    ...(value.canDecide === true ? { canDecide: true as const } : {}),
    ...(details ? { details } : {}),
    serverName: value.serverName,
    source: value.source as McpApprovalSource,
    state: value.state as McpApprovalState,
    toolName: value.toolName
  };
}

/**
 * An answer's cards: decoded, one per approval, bounded. A later payload of
 * the same approval replaces an earlier one, so a saved card with its current
 * state wins over the live card it follows.
 */
export function foldMcpApprovalCards(payloads: readonly unknown[]): McpApprovalCard[] {
  const cards = new Map<string, McpApprovalCard>();
  for (const payload of payloads) {
    const card = decodeMcpApprovalCard(payload);
    if (!card || !cards.has(card.approvalId) && cards.size >= MCP_APPROVAL_CARDS_LIMIT) continue;
    cards.set(card.approvalId, card);
  }
  return [...cards.values()];
}

export function isMcpApprovalDecision(value: unknown): value is McpApprovalDecision {
  return (MCP_APPROVAL_DECISIONS as readonly unknown[]).includes(value);
}

/** What the decision route returns: the card as it is now. */
export function decodeMcpApprovalDecisionResponse(value: unknown): McpApprovalCard | null {
  return record(value) && only(value, ["approval"]) ? decodeMcpApprovalCard(value.approval) : null;
}

/** The server-written user turn after an approval: the model's next instruction. */
export function mcpApprovalContinuationText(input: Readonly<{ serverName: string; toolName: string }>): string {
  return `The user approved \`${input.toolName}\` on \`${input.serverName}\`. Continue the task.`;
}

/** The approved tool's name for the turn's compact chip, or null for other text. */
export function mcpApprovalContinuationTool(text: string): string | null {
  return /^The user approved `([^`\n]{1,160})` on `[^`\n]{1,160}`\. Continue the task\.$/u.exec(text.trim())?.[1] ?? null;
}

/** Settings: a server the user always allows, with its Revoke action. */
export type McpToolConsentWire = Readonly<{ createdAt: string; serverId: string; serverName: string }>;

export function decodeMcpToolConsents(value: unknown): McpToolConsentWire[] | null {
  if (!record(value) || !only(value, ["consents"]) || !Array.isArray(value.consents) || value.consents.length > 256) return null;
  const consents: McpToolConsentWire[] = [];
  for (const entry of value.consents) {
    if (!record(entry) || !only(entry, ["createdAt", "serverId", "serverName"]) || !id(entry.serverId) ||
      typeof entry.serverName !== "string" || !entry.serverName.trim() || entry.serverName.length > 512 ||
      typeof entry.createdAt !== "string" || Number.isNaN(Date.parse(entry.createdAt))) return null;
    consents.push({ createdAt: entry.createdAt, serverId: entry.serverId, serverName: entry.serverName });
  }
  return consents;
}

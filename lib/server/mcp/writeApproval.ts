import { decodeAcceptedMcpGuardPlan } from "../providerRuntime/mcpGuardPlan";
import { boundedMcpGuardMessages, MCP_GUARD_LIMITS, type McpGuardVerdict } from "./guardPrompt";
import type { McpGuardAdmission } from "./guard";
import { hashCanonicalMcpValue } from "./definitions";

/**
 * MCP write approval (operator decision 2026-10-29). Interactive writes use
 * the admitted guard when assigned, including standing consents; only an ask
 * needs the initiator. Without a guard the earlier consent policy is unchanged.
 * Scheduled tasks have standing authority and Hub clients prompt themselves: neither carries the admission marker.
 *
 * The marker is frozen at admission with the initiator's "Always allow"
 * consents for the run's servers, so recovery decides exactly as the live run
 * did and a revocation applies to runs admitted after it.
 */
export type McpApprovalAdmission = Readonly<{
  consentedServerIds: readonly string[];
  approvedBy?: string;
  guard?: McpGuardAdmission;
  version: 1;
}>;

/** Only a boolean `true` counts: inventories keep annotations as declared. */
export type McpToolAnnotations = Readonly<{
  destructiveHint?: unknown;
  readOnlyHint?: unknown;
}>;

export const MCP_APPROVAL_REQUIRED = "mcp_approval_required";
/** The model-facing result of a gated tool-loop call. */
export const MCP_APPROVAL_REQUIRED_MESSAGE =
  "Nothing was sent. The user must approve this call in the card below. Stop and say briefly what you wanted to do; do not retry until approved.";
/** Guest code and Agent refusal code and message. */
export const MCP_APPROVAL_REFUSAL = "approval_required";
export const MCP_APPROVAL_REFUSAL_MESSAGE = "This MCP tool needs the user's approval in the chat. Nothing was sent.";
/** An Allow once is consumable this long after the decision. */
export const MCP_APPROVAL_TTL_MS = 15 * 60_000;
/** Card display names are bounded snapshots of catalog metadata. */
export const MCP_APPROVAL_DISPLAY_LENGTH = 160;

/**
 * A tool that may change data: every tool except one its server annotates
 * read-only without also marking it destructive. Annotations are trusted as
 * declared; a server that lies about them is malicious, which an approval
 * prompt would not defend against either.
 */
export function mcpToolMayChangeData(annotations: McpToolAnnotations | undefined): boolean {
  return !(annotations?.readOnlyHint === true && annotations.destructiveHint !== true);
}

/**
 * Whether a call needs its run initiator's approval before dispatch: the run
 * was admitted interactive, the tool may change data and either a guard was
 * admitted or the initiator gave its server no standing consent.
 */
export function mcpCallNeedsApproval(input: Readonly<{
  admission: McpApprovalAdmission | undefined;
  annotations: McpToolAnnotations | undefined;
  serverId: string;
}>): boolean {
  return input.admission !== undefined && mcpToolMayChangeData(input.annotations) &&
    (input.admission.guard !== undefined || !input.admission.consentedServerIds.includes(input.serverId));
}

/** The frozen marker in the shape admission writes it. */
export function isMcpApprovalAdmission(value: unknown): value is McpApprovalAdmission {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every(key => ["consentedServerIds", "approvedBy", "guard", "version"].includes(key)) &&
    (record.approvedBy === undefined || typeof record.approvedBy === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(record.approvedBy)) &&
    (record.guard === undefined || isMcpGuardAdmission(record.guard)) && record.version === 1 &&
    Array.isArray(record.consentedServerIds) && record.consentedServerIds.length <= 256 &&
    record.consentedServerIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128) &&
    new Set(record.consentedServerIds).size === record.consentedServerIds.length;
}

export function mcpApprovalAdmission(consentedServerIds: readonly string[], guard?: McpGuardAdmission, approvedBy?: string): McpApprovalAdmission {
  return { consentedServerIds: [...new Set(consentedServerIds)].sort(), ...(guard ? { guard } : {}), ...(approvedBy ? { approvedBy } : {}), version: 1 };
}

/** What an approval matches: the exact server, tool, definition and arguments. */
export type McpApprovalCallKey = Readonly<{
  argumentsDigest: string;
  definitionHash: string;
  serverId: string;
  /** The namespaced tool name the run calls. */
  toolName: string;
}>;

/** A gated call: its key and the card's bounded display names. */
export type McpApprovalRequest = McpApprovalCallKey & Readonly<{
  guard?: McpGuardVerdict;
  serverName: string;
  toolTitle: string;
}>;

/** The canonical-arguments digest every source compares. */
export function mcpApprovalArgumentsDigest(args: unknown): string {
  return hashCanonicalMcpValue(args ?? {});
}

export function boundedMcpApprovalDisplay(value: string | undefined, fallback: string): string {
  const text = (value ?? "").trim() || fallback;
  return Array.from(text).slice(0, MCP_APPROVAL_DISPLAY_LENGTH).join("");
}

/** The request of one call of a tool whose route the run's authority resolved. */
export function mcpApprovalRequest(input: Readonly<{
  arguments: unknown;
  definitionHash: string;
  originalName: string;
  serverId: string;
  serverName: string;
  title?: string;
  toolName: string;
}>): McpApprovalRequest {
  return {
    argumentsDigest: mcpApprovalArgumentsDigest(input.arguments),
    definitionHash: input.definitionHash,
    serverId: input.serverId,
    serverName: boundedMcpApprovalDisplay(input.serverName, "MCP server"),
    toolName: input.toolName,
    toolTitle: boundedMcpApprovalDisplay(input.title, input.originalName)
  };
}

export function isMcpApprovalRequest(value: unknown): value is McpApprovalRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return /^[0-9a-f]{64}$/u.test(String(record.argumentsDigest)) && /^[0-9a-f]{64}$/u.test(String(record.definitionHash)) &&
    typeof record.serverId === "string" && record.serverId.length > 0 && record.serverId.length <= 128 &&
    typeof record.toolName === "string" && record.toolName.length > 0 && record.toolName.length <= 256 &&
    typeof record.serverName === "string" && record.serverName.length > 0 &&
    Array.from(record.serverName).length <= MCP_APPROVAL_DISPLAY_LENGTH &&
    typeof record.toolTitle === "string" && record.toolTitle.length > 0 &&
    Array.from(record.toolTitle).length <= MCP_APPROVAL_DISPLAY_LENGTH;
}

function isMcpGuardAdmission(value: unknown): value is McpGuardAdmission {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const id = (entry: unknown): entry is string => typeof entry === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(entry);
  if (row.approvedBy !== undefined && !id(row.approvedBy) || decodeAcceptedMcpGuardPlan(row.plan) === null) return false;
  if (row.version === 2) {
    if (Object.keys(row).some(key => !["version", "plan", "messages", "currentMessageId", "unavailable", "approvedBy"].includes(key)) ||
      row.unavailable !== undefined && row.unavailable !== true || row.currentMessageId !== undefined && !id(row.currentMessageId) ||
      !Array.isArray(row.messages) || row.messages.length > MCP_GUARD_LIMITS.messages) return false;
    const seen = new Set<string>();
    for (const ref of row.messages) {
      if (!ref || typeof ref !== "object" || Array.isArray(ref) || !id(ref.id) ||
        (ref.kind !== "message" && ref.kind !== "followup") ||
        Object.keys(ref).sort().join(",") !== (ref.kind === "message" ? "id,kind" : "answerId,id,kind") ||
        ref.kind === "followup" && !id(ref.answerId) || seen.has(`${ref.kind}:${ref.id}`)) return false;
      seen.add(`${ref.kind}:${ref.id}`);
    }
    return row.currentMessageId === undefined || seen.has(`message:${row.currentMessageId}`);
  }
  return Object.keys(row).every(key => ["plan", "userMessages", "approvedBy"].includes(key)) &&
    (row.userMessages === null || Array.isArray(row.userMessages) && boundedMcpGuardMessages(row.userMessages) !== null);
}

import {
  decodeMcpApprovalDecisionResponse,
  decodeMcpToolConsents,
  type McpApprovalCard,
  type McpApprovalDecision,
  type McpToolConsentWire
} from "@/lib/contracts/mcpApprovals";

/** A failed approval request: the server's stable code when it sent one, and the card it returned. */
export class McpApprovalApiError extends Error {
  constructor(readonly code: string | null, readonly status: number, readonly card: McpApprovalCard | null = null) {
    super(code ?? `mcp_approval_http_${status}`);
    this.name = "McpApprovalApiError";
  }
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(path, { ...init, cache: "no-store", credentials: "same-origin" });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
    const code = typeof record?.error === "string" ? record.error : null;
    const card = record && "approval" in record ? decodeMcpApprovalDecisionResponse({ approval: record.approval }) : null;
    throw new McpApprovalApiError(code, response.status, card);
  }
  return body;
}

/** The run initiator's decision on one card; the same nonce replays it. */
export async function decideMcpApproval(input: Readonly<{
  approvalId: string;
  decision: McpApprovalDecision;
  nonce: string;
  runId: string;
}>): Promise<McpApprovalCard> {
  const body = await request(`/api/model-runs/${encodeURIComponent(input.runId)}/mcp-approvals/${encodeURIComponent(input.approvalId)}`, {
    body: JSON.stringify({ decision: input.decision, nonce: input.nonce }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  const card = decodeMcpApprovalDecisionResponse(body);
  if (!card) throw new McpApprovalApiError(null, 200);
  return card;
}

export async function listMcpToolConsents(signal?: AbortSignal): Promise<McpToolConsentWire[]> {
  const consents = decodeMcpToolConsents(await request("/api/me/mcp-consents", { signal }));
  if (!consents) throw new McpApprovalApiError(null, 200);
  return consents;
}

export async function revokeMcpToolConsent(serverId: string): Promise<void> {
  await request(`/api/me/mcp-consents/${encodeURIComponent(serverId)}`, { method: "DELETE" });
}

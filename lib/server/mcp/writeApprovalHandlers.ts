import type { PrismaClient } from "@prisma/client";
import { isMcpApprovalDecision, type McpApprovalDecision } from "@/lib/contracts/mcpApprovals";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import {
  decideMcpApproval,
  listMcpToolConsents,
  revokeMcpToolConsent,
  type McpApprovalDecisionOutcome
} from "./writeApprovalRepository";

type Params<T> = Promise<T> | T;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const NONCE = /^[A-Za-z0-9_-]{8,128}$/u;
const headers = { "cache-control": "private, no-store", vary: "Cookie" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });

function failed(error: unknown, code: string): Response {
  logEvent("service_operation", { subsystem: "configuration", stage: "write", outcome: "failed", code,
    prisma_code: databaseFailureCode(error) });
  return json({ error: "mcp_approval_unavailable" }, 503);
}

function decisionBody(value: unknown): Readonly<{ decision: McpApprovalDecision; nonce: string }> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(",") === "decision,nonce" && isMcpApprovalDecision(record.decision) &&
    typeof record.nonce === "string" && NONCE.test(record.nonce)
    ? { decision: record.decision, nonce: record.nonce } : null;
}

/**
 * Routes of MCP write approval: the run initiator's decision on a card, and
 * the user's "Always allow" consents in MCP settings. Other users' and
 * missing cards look alike.
 */
export function createMcpApprovalHandlers(deps: Readonly<{
  decide?: (input: Parameters<typeof decideMcpApproval>[1]) => Promise<McpApprovalDecisionOutcome>;
  prisma: () => PrismaClient;
  resolveAuth: RequestAuthResolver;
}>) {
  const decide = deps.decide ?? ((input) => decideMcpApproval(deps.prisma(), input));
  return {
    /** `POST /api/model-runs/[runId]/mcp-approvals/[callId]`: `callId` is the card's approval id. */
    async POST_DECISION(request: Request, context: { params: Params<{ callId: string; runId: string }> }): Promise<Response> {
      const session = await deps.resolveAuth(request);
      if (!session) return json({ error: "unauthorized" }, 401);
      if (session.user.status !== "active") return json({ error: "forbidden" }, 403);
      const { callId, runId } = await context.params;
      if (!ID.test(callId) || !ID.test(runId)) return json({ error: "mcp_approval_not_found" }, 404);
      const body = await readJsonBodyOrNull(request, "json");
      const tooLarge = requestBodyErrorResponse(body);
      if (tooLarge) return tooLarge;
      const input = decisionBody(body);
      if (!input) return json({ error: "mcp_approval_request_invalid" }, 400);
      let outcome: McpApprovalDecisionOutcome;
      try {
        outcome = await decide({ approvalId: callId, decision: input.decision, nonce: input.nonce, runId, userId: session.userId });
      } catch (error) {
        return failed(error, "mcp_approval_decision_failed");
      }
      switch (outcome.kind) {
        case "decided": return json({ approval: outcome.card });
        case "conflict": return json({ approval: outcome.card, error: "mcp_approval_already_decided" }, 409);
        case "run_active": return json({ error: "mcp_approval_run_active" }, 409);
        case "not_found": return json({ error: "mcp_approval_not_found" }, 404);
      }
    },

    /** `GET /api/me/mcp-consents`: the servers the user always allows. */
    async GET_CONSENTS(request: Request): Promise<Response> {
      const session = await deps.resolveAuth(request);
      if (!session) return json({ error: "unauthorized" }, 401);
      try {
        return json({ consents: await listMcpToolConsents(deps.prisma(), session.userId) });
      } catch (error) {
        return failed(error, "mcp_consent_list_failed");
      }
    },

    /** `DELETE /api/me/mcp-consents/[serverId]`: Revoke; runs admitted afterwards ask again. */
    async DELETE_CONSENT(request: Request, context: { params: Params<{ serverId: string }> }): Promise<Response> {
      const session = await deps.resolveAuth(request);
      if (!session) return json({ error: "unauthorized" }, 401);
      if (session.user.status !== "active") return json({ error: "forbidden" }, 403);
      const { serverId } = await context.params;
      if (!ID.test(serverId)) return json({ error: "mcp_consent_not_found" }, 404);
      try {
        return await revokeMcpToolConsent(deps.prisma(), { serverId, userId: session.userId })
          ? json({ revoked: true })
          : json({ error: "mcp_consent_not_found" }, 404);
      } catch (error) {
        return failed(error, "mcp_consent_revoke_failed");
      }
    }
  };
}

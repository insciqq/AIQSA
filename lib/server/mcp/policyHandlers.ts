import {
  isMcpPolicyVersion,
  type McpPolicyErrorCode,
  type McpPolicyResponseWire,
  type McpPolicyWire
} from "@/lib/contracts/mcpPolicy";
import type { RequestAuthResolver } from "@/lib/server/auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "@/lib/server/http/requestBody";
import { reportSubsystemFailure } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import type { McpPolicyRepository } from "./policyRepository";

const NO_STORE = { "cache-control": "private, no-store" } as const;

function errorJson(error: McpPolicyErrorCode, status: number): Response {
  return Response.json({ error }, { headers: NO_STORE, status });
}

function policyJson(policy: McpPolicyWire): Response {
  return Response.json({ policy } satisfies McpPolicyResponseWire, { headers: NO_STORE });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requireAdmin(request: Request, resolveAuth: RequestAuthResolver) {
  const session = await resolveAuth(request);
  if (!session) return errorJson("unauthorized", 401);
  if (session.user.status !== "active" || session.user.role !== "admin") return errorJson("forbidden", 403);
  return session;
}

function unavailable(error: unknown, stage: "read" | "write"): Response {
  reportSubsystemFailure({
    action: "retry",
    code: "mcp_policy_unavailable",
    prisma_code: databaseFailureCode(error),
    scope_id: "mcp_policy",
    stage,
    subsystem: "mcp"
  });
  return errorJson("mcp_policy_unavailable", 503);
}

/**
 * Administrator MCP policy (`/api/admin/mcp/policy`). PATCH replaces the
 * whole policy at the version it read; a concurrent change is stale, never
 * merged. `onUpdated` applies a committed change to running personal
 * connections (cache invalidation and runtime resync).
 */
export function createMcpPolicyHandlers(input: Readonly<{
  onUpdated?(policy: McpPolicyWire): void;
  repository: McpPolicyRepository;
  resolveAuth: RequestAuthResolver;
}>) {
  return {
    async GET(request: Request): Promise<Response> {
      const auth = await requireAdmin(request, input.resolveAuth);
      if (auth instanceof Response) return auth;
      try {
        return policyJson(await input.repository.read());
      } catch (error) {
        return unavailable(error, "read");
      }
    },
    async PATCH(request: Request): Promise<Response> {
      const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json" && !contentType?.endsWith("+json")) return errorJson("json_required", 415);
      const auth = await requireAdmin(request, input.resolveAuth);
      if (auth instanceof Response) return auth;
      const body = await readJsonBodyOrNull(request, "json");
      const bodyError = requestBodyErrorResponse(body);
      if (bodyError) return bodyError;
      if (!isRecord(body) || Object.keys(body).some((key) => key !== "personalLocalNetworkEnabled" && key !== "version") ||
        typeof body.personalLocalNetworkEnabled !== "boolean" || !isMcpPolicyVersion(body.version)) {
        return errorJson("mcp_policy_input_invalid", 400);
      }
      let result: Awaited<ReturnType<McpPolicyRepository["update"]>>;
      try {
        result = await input.repository.update({
          expectedVersion: body.version,
          personalLocalNetworkEnabled: body.personalLocalNetworkEnabled
        });
      } catch (error) {
        return unavailable(error, "write");
      }
      if (result.kind === "stale") return errorJson("mcp_policy_stale", 409);
      try {
        input.onUpdated?.(result.policy);
      } catch {
        // The committed policy is authoritative; caches expire and reconciliation repeats.
      }
      return policyJson(result.policy);
    }
  };
}

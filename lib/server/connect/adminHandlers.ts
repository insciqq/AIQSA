import {
  CONNECT_ADMIN_POLICY_CONFLICT_ERROR,
  connectAdminPolicyUpdateRequestSchema,
  type ConnectAdminPolicy,
  type ConnectAdminPolicyResponse
} from "@/lib/contracts/connect";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import { logConnect } from "./observability";
import type { ConnectPolicyRepository } from "./policyRepository";

const NO_STORE = { "cache-control": "private, no-store" } as const;

function errorJson(error: string, status: number): Response {
  return Response.json({ error }, { headers: NO_STORE, status });
}

function policyJson(policy: ConnectAdminPolicy): Response {
  return Response.json({ connect: { enabled: policy.enabled, version: policy.version } } satisfies ConnectAdminPolicyResponse, {
    headers: NO_STORE
  });
}

async function requireAdmin(request: Request, resolveAuth: RequestAuthResolver) {
  const session = await resolveAuth(request);
  if (!session) return errorJson("unauthorized", 401);
  if (session.user.status !== "active" || session.user.role !== "admin") return errorJson("forbidden", 403);
  return session;
}

function unavailable(error: unknown, stage: "read" | "write"): Response {
  logConnect({ action: "retry", code: "connect_policy_unavailable", error, outcome: "failed", stage });
  return errorJson("connect_policy_unavailable", 503);
}

/**
 * Administrator switch for AIQSA Connect (`/api/admin/connect`). PATCH sets
 * the switch at the version the administrator read; a concurrent change is
 * stale, never merged. `onUpdated` applies a committed change to this
 * process: the policy cache, and every open stream when it turned off.
 */
export function createConnectAdminPolicyHandlers(input: Readonly<{
  onUpdated(policy: ConnectAdminPolicy): void;
  repository: ConnectPolicyRepository;
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
      if (bodyError) {
        bodyError.headers.set("cache-control", NO_STORE["cache-control"]);
        return bodyError;
      }
      const parsed = connectAdminPolicyUpdateRequestSchema.safeParse(body);
      if (!parsed.success) return errorJson("connect_policy_input_invalid", 400);
      let result: Awaited<ReturnType<ConnectPolicyRepository["update"]>>;
      try {
        result = await input.repository.update({ ...parsed.data, userId: auth.userId });
      } catch (error) {
        return unavailable(error, "write");
      }
      if (result.kind === "stale") {
        logConnect({ code: "connect_policy_version_conflict", outcome: "stale", stage: "write" });
        return errorJson(CONNECT_ADMIN_POLICY_CONFLICT_ERROR, 409);
      }
      logConnect({ code: "connect_policy_updated", outcome: "completed", stage: "write" });
      try {
        input.onUpdated(result.policy);
      } catch {
        // The committed policy is authoritative; the cache expires and streams recheck it.
      }
      return policyJson(result.policy);
    }
  };
}

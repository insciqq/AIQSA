import type { RequestAuthResolver } from "../../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../../http/requestBody";
import {
  MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS,
  MCP_RUN_PLAN_LIMITS
} from "../../../contracts/mcp";
import {
  AdminModelPolicyServiceError,
  type createAdminModelPolicyService
} from "./modelPolicyService";

type Service = ReturnType<typeof createAdminModelPolicyService>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requireAdmin(request: Request, resolveAuth: RequestAuthResolver) {
  const session = await resolveAuth(request);
  if (!session) return { error: Response.json({ error: "unauthorized" }, { status: 401 }), session: null };
  if (session.user.status !== "active" || session.user.role !== "admin") {
    return { error: Response.json({ error: "forbidden" }, { status: 403 }), session: null };
  }
  return { error: null, session };
}

function contentTypeIsJson(request: Request): boolean {
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "application/json" || type.endsWith("+json");
}

function failure(error: unknown): Response {
  if (error instanceof AdminModelPolicyServiceError) {
    return Response.json({ error: error.code }, {
      status: error.code === "model_policy_stale" ? 409 : 400
    });
  }
  console.error("model_policy_admin_action_failed");
  return Response.json({ error: "model_policy_admin_action_failed" }, { status: 500 });
}

export function createAdminModelPolicyHandlers(input: Readonly<{
  resolveAuth: RequestAuthResolver;
  service: Service;
}>) {
  return {
    async GET(request: Request): Promise<Response> {
      const auth = await requireAdmin(request, input.resolveAuth);
      if (auth.error) return auth.error;
      try {
        return Response.json({ modelPolicy: await input.service.list() });
      } catch (error) {
        return failure(error);
      }
    },

    async PATCH(request: Request): Promise<Response> {
      if (!contentTypeIsJson(request)) {
        return Response.json({ error: "json_required" }, { status: 415 });
      }
      const auth = await requireAdmin(request, input.resolveAuth);
      if (auth.error || !auth.session) return auth.error!;
      const value = await readJsonBodyOrNull(request, "json");
      const bodyError = requestBodyErrorResponse(value);
      if (bodyError) return bodyError;
      const limitKeys = [
        "maxToolCalls", "maxToolRounds", "maxMcpToolsPerDiscovery", "mcpAutoDiscoveryTimeoutSeconds"
      ] as const;
      const allowed = ["expectedVersion", "providerModelId", "reasoningEffort", ...limitKeys];
      const textOrNull = (entry: unknown, limit: number) => entry === null ||
        typeof entry === "string" && entry.trim() === entry && entry.length > 0 &&
        entry.length <= limit && !/[\u0000-\u001f\u007f]/u.test(entry);
      const hasModel = record(value) &&
        (Object.hasOwn(value, "providerModelId") || Object.hasOwn(value, "reasoningEffort"));
      const presentLimits = record(value) ? limitKeys.filter((key) => Object.hasOwn(value, key)) : [];
      if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key)) ||
        !Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion) < 1 ||
        !hasModel && presentLimits.length === 0 ||
        hasModel && (!Object.hasOwn(value, "providerModelId") || !Object.hasOwn(value, "reasoningEffort") ||
          !textOrNull(value.providerModelId, 256) || !textOrNull(value.reasoningEffort, 32) ||
          value.providerModelId === null && value.reasoningEffort !== null) ||
        presentLimits.length > 0 && (presentLimits.length !== limitKeys.length ||
          !Number.isSafeInteger(value.mcpAutoDiscoveryTimeoutSeconds) ||
          Number(value.mcpAutoDiscoveryTimeoutSeconds) < MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS.minSeconds ||
          Number(value.mcpAutoDiscoveryTimeoutSeconds) > MCP_AUTO_DISCOVERY_TIMEOUT_LIMITS.maxSeconds ||
          !Number.isSafeInteger(value.maxMcpToolsPerDiscovery) ||
          Number(value.maxMcpToolsPerDiscovery) < 1 ||
          Number(value.maxMcpToolsPerDiscovery) > MCP_RUN_PLAN_LIMITS.maxTools ||
          !Number.isSafeInteger(value.maxToolCalls) || Number(value.maxToolCalls) < 1 ||
          !Number.isSafeInteger(value.maxToolRounds) || Number(value.maxToolRounds) < 1)) {
        return Response.json({ error: "model_policy_update_invalid" }, { status: 400 });
      }
      try {
        await input.service.update({
          expectedVersion: Number(value.expectedVersion),
          ...(hasModel ? {
            providerModelId: value.providerModelId as string | null,
            reasoningEffort: value.reasoningEffort as string | null
          } : {}),
          ...(presentLimits.length > 0 ? {
            maxMcpToolsPerDiscovery: Number(value.maxMcpToolsPerDiscovery),
            maxToolCalls: Number(value.maxToolCalls),
            maxToolRounds: Number(value.maxToolRounds),
            mcpAutoDiscoveryTimeoutSeconds: Number(value.mcpAutoDiscoveryTimeoutSeconds)
          } : {}),
          userId: auth.session.userId
        });
        return Response.json({ modelPolicy: await input.service.list() });
      } catch (error) {
        return failure(error);
      }
    }
  };
}

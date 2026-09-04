import type { RequestAuthResolver } from "@/lib/server/auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "@/lib/server/http/requestBody";
import type { createWorkspacePolicyService } from "./policyService";
import { WorkspacePolicyServiceError } from "./policyService";

type Service = ReturnType<typeof createWorkspacePolicyService>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requireAdmin(request: Request, resolveAuth: RequestAuthResolver) {
  const session = await resolveAuth(request);
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (session.user.status !== "active" || session.user.role !== "admin") {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  return session;
}

function failure(error: unknown): Response {
  if (error instanceof WorkspacePolicyServiceError) {
    return Response.json({ error: error.code }, { status: 409 });
  }
  console.error("workspace_policy_action_failed");
  return Response.json({ error: "workspace_policy_action_failed" }, { status: 500 });
}

export function createWorkspacePolicyHandlers(input: Readonly<{
  resolveAuth: RequestAuthResolver;
  service: Service;
}>) {
  return {
    async GET(request: Request): Promise<Response> {
      const auth = await requireAdmin(request, input.resolveAuth);
      if (auth instanceof Response) return auth;
      try {
        return Response.json({ workspace: await input.service.read() });
      } catch (error) {
        return failure(error);
      }
    },
    async PATCH(request: Request): Promise<Response> {
      const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
        return Response.json({ error: "json_required" }, { status: 415 });
      }
      const auth = await requireAdmin(request, input.resolveAuth);
      if (auth instanceof Response) return auth;
      const value = await readJsonBodyOrNull(request, "json");
      const bodyError = requestBodyErrorResponse(value);
      if (bodyError) return bodyError;
      const keys = isRecord(value) ? Object.keys(value) : [];
      if (
        !isRecord(value) ||
        keys.some((key) => !["enabled", "expectedVersion", "internetEnabled"].includes(key)) ||
        !Number.isSafeInteger(value.expectedVersion) ||
        Number(value.expectedVersion) < 1 ||
        (value.enabled === undefined && value.internetEnabled === undefined) ||
        (value.enabled !== undefined && typeof value.enabled !== "boolean") ||
        (value.internetEnabled !== undefined && typeof value.internetEnabled !== "boolean")
      ) {
        return Response.json({ error: "workspace_policy_input_invalid" }, { status: 400 });
      }
      try {
        return Response.json({
          workspace: await input.service.update({
            ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
            expectedVersion: Number(value.expectedVersion),
            ...(typeof value.internetEnabled === "boolean"
              ? { internetEnabled: value.internetEnabled }
              : {}),
            userId: auth.userId
          })
        });
      } catch (error) {
        return failure(error);
      }
    }
  };
}

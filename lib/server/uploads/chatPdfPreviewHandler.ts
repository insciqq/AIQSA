import type { PrismaClient } from "@prisma/client";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import { resolveProjectAccess } from "../projects/access";
import { loadProviderAdmissionPlan } from "../providerRuntime/admission";
import { createChatPdfRouteResolver } from "./chatPdfAdmission";

export function createChatPdfPreviewHandler(deps: Readonly<{ prisma: PrismaClient; resolveAuth: RequestAuthResolver }>) {
  return async (request: Request): Promise<Response> => {
    const auth = await deps.resolveAuth(request);
    if (!auth) return Response.json({ error: "unauthorized" }, { status: 401 });
    const raw = await readJsonBodyOrNull(request);
    const bodyError = requestBodyErrorResponse(raw);
    if (bodyError) return bodyError;
    const body = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const { providerConnectionId, providerModelId, projectId = null } = body ?? {};
    const identifier = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 128;
    if (!identifier(providerConnectionId) || !identifier(providerModelId) || projectId !== null && !identifier(projectId)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    try {
      const route = await deps.prisma.$transaction(async (tx) => {
        if (projectId) {
          const access = await resolveProjectAccess(tx, { projectId: String(projectId), userId: auth.userId,
            minimumRole: "CONTRIBUTOR", requireActive: true });
          const binding = access && await tx.projectModelBinding.findUnique({ where: {
            projectId_providerModelId: { projectId: String(projectId), providerModelId: String(providerModelId) }
          }, select: { providerModelId: true } });
          if (!binding) return null;
        }
        const plan = await loadProviderAdmissionPlan(tx, {
          providerConnectionId: String(providerConnectionId), providerModelId: String(providerModelId),
          ...(projectId ? { executionScope: "project" as const } : {}),
          searchPlan: { mode: "all_selected", optionIds: [] }, userId: auth.userId
        });
        return (await createChatPdfRouteResolver(tx).resolve(plan.answer)).route;
      });
      return route ? Response.json({ route, version: 1 }, { headers: { "Cache-Control": "no-store" } })
        : Response.json({ error: "model_not_available" }, { status: 404 });
    } catch {
      return Response.json({ error: "model_not_available" }, { status: 409 });
    }
  };
}

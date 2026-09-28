import {
  decodeAssistantDeleteRequest,
  type AssistantDeletionConsequencesResponse
} from "../../contracts/assistantDeletion";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import type { PrismaAssistantDeletionRepository } from "./deletionRepository";

export type AssistantDeletionHandlerDeps = {
  repository: Pick<PrismaAssistantDeletionRepository, "delete" | "loadConsequences">;
  resolveAuth: RequestAuthResolver;
};

type AssistantRouteContext = {
  params: Promise<{ assistantId: string }> | { assistantId: string };
};

function errorJson(code: string, status: number): Response {
  return Response.json({ error: code }, { status });
}

/** Owner only. Administrators and every other caller receive the same neutral
 * 404 as for a missing Assistant. */
export function createAssistantDeletionConsequencesHandler(deps: AssistantDeletionHandlerDeps) {
  return async function GET(request: Request, context: AssistantRouteContext): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return errorJson("unauthorized", 401);
    const { assistantId } = await context.params;
    const consequences = await deps.repository.loadConsequences(session.userId, assistantId ?? "");
    if (!consequences) return errorJson("assistant_not_available", 404);
    return Response.json({ consequences } satisfies AssistantDeletionConsequencesResponse);
  };
}

export function createDeleteAssistantHandler(deps: AssistantDeletionHandlerDeps) {
  return async function DELETE(request: Request, context: AssistantRouteContext): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return errorJson("unauthorized", 401);
    const body = await readJsonBodyOrNull(request, "json");
    const bodyError = requestBodyErrorResponse(body);
    if (bodyError) return bodyError;
    const decoded = decodeAssistantDeleteRequest(body);
    if (!decoded) return errorJson("assistant_draft_invalid", 400);
    const { assistantId } = await context.params;
    const result = await deps.repository.delete(session.userId, assistantId ?? "", decoded.expectedVersion);
    if (result.kind === "not_found") return errorJson("assistant_not_available", 404);
    if (result.kind === "version_conflict") return errorJson("assistant_version_conflict", 409);
    return new Response(null, { status: 204 });
  };
}

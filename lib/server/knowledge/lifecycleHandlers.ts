import {
  decodeKnowledgeBaseLifecycle,
  decodeKnowledgeSourceLifecycle,
  type KnowledgeDeletionResponse,
  type KnowledgeLifecycleInput
} from "../../contracts/knowledge";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import type {
  KnowledgeLifecycleWriteResult,
  KnowledgePermanentDeletionResult,
  PrismaKnowledgeLifecycleRepository
} from "./lifecycleRepository";

type Target = "base" | "source";
type Action = "delete" | "restore" | "trash";

export type KnowledgeLifecycleHandlerDeps = Readonly<{
  kickDeletionWorker?: () => void;
  repository: Pick<
    PrismaKnowledgeLifecycleRepository,
    | "permanentlyDeleteBase"
    | "permanentlyDeleteSource"
    | "restoreBase"
    | "restoreSource"
    | "trashBase"
    | "trashSource"
  >;
  resolveAuth: RequestAuthResolver;
}>;

type LifecycleContext = {
  params:
    | Promise<{ baseId?: string; sourceId?: string }>
    | { baseId?: string; sourceId?: string };
};

function errorJson(code: string, status: number): Response {
  return Response.json({ error: code }, { status });
}

function boundedId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u0020\u007f]/u.test(value)
    ? value
    : null;
}

function writeError(target: Target, result: KnowledgeLifecycleWriteResult): Response {
  if (result.kind === "not_found") {
    return errorJson(`knowledge_${target}_not_available`, 404);
  }
  if (result.kind === "version_conflict") {
    return errorJson(`knowledge_${target}_version_conflict`, 409);
  }
  return errorJson(`knowledge_${target}_lifecycle_conflict`, 409);
}

function deletionError(target: Target, result: KnowledgePermanentDeletionResult): Response {
  if (result.kind === "not_found") {
    return errorJson(`knowledge_${target}_not_available`, 404);
  }
  if (result.kind === "version_conflict") {
    return errorJson(`knowledge_${target}_version_conflict`, 409);
  }
  return errorJson(`knowledge_${target}_must_be_trashed`, 409);
}

async function input(
  request: Request,
  target: Target
): Promise<KnowledgeLifecycleInput | Response> {
  const body = await readJsonBodyOrNull(request, "json");
  const bodyError = requestBodyErrorResponse(body);
  if (bodyError) return bodyError;
  const decoded = target === "base"
    ? decodeKnowledgeBaseLifecycle(body)
    : decodeKnowledgeSourceLifecycle(body);
  return decoded.ok ? decoded.value : errorJson(decoded.code, 400);
}

export function createKnowledgeLifecycleHandler(
  deps: KnowledgeLifecycleHandlerDeps,
  target: Target,
  action: Action
) {
  return async function POST(request: Request, context: LifecycleContext): Promise<Response> {
    const auth = await deps.resolveAuth(request);
    if (!auth) return errorJson("unauthorized", 401);
    const params = await context.params;
    const id = boundedId(target === "base" ? params.baseId : params.sourceId);
    if (!id) return errorJson(`knowledge_${target}_not_available`, 404);
    const decoded = await input(request, target);
    if (decoded instanceof Response) return decoded;

    if (action === "delete") {
      const result = target === "base"
        ? await deps.repository.permanentlyDeleteBase(auth.userId, id, decoded.expectedVersion)
        : await deps.repository.permanentlyDeleteSource(auth.userId, id, decoded.expectedVersion);
      if (result.kind !== "pending") return deletionError(target, result);
      deps.kickDeletionWorker?.();
      return Response.json(
        { status: "pending" } satisfies KnowledgeDeletionResponse,
        { status: 202 }
      );
    }

    const result = target === "base"
      ? action === "trash"
        ? await deps.repository.trashBase(auth.userId, id, decoded.expectedVersion)
        : await deps.repository.restoreBase(auth.userId, id, decoded.expectedVersion)
      : action === "trash"
        ? await deps.repository.trashSource(auth.userId, id, decoded.expectedVersion)
        : await deps.repository.restoreSource(auth.userId, id, decoded.expectedVersion);
    return result.kind === "ok" ? new Response(null, { status: 204 }) : writeError(target, result);
  };
}

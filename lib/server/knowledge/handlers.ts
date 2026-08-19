import {
  decodeKnowledgeBaseCreate,
  decodeKnowledgeBasePublication,
  decodeKnowledgeBaseUpdate,
  type KnowledgeBaseDetail,
  type KnowledgeBaseDetailResponse,
  type KnowledgeBaseListResponse,
  type KnowledgeBasePublication,
  type KnowledgeBasePublicationResponse,
  type KnowledgeBaseSummary
} from "../../contracts/knowledge";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import {
  getKnowledgeExtractionConfig,
  type KnowledgeExtractionConfig
} from "./knowledgeExtractionConfig";
import type {
  KnowledgeBaseAccessEntry,
  KnowledgeBaseDetailData,
  KnowledgeBasePublicationRow,
  PrismaKnowledgeRepository
} from "./prismaRepository";

export type KnowledgeHandlerDeps = Readonly<{
  getExtractionConfig?: () => Pick<KnowledgeExtractionConfig, "maxFileBytes">;
  repository: Pick<
    PrismaKnowledgeRepository,
    | "canCreate"
    | "create"
    | "getDetail"
    | "listForUser"
    | "listPublishableGroups"
    | "publish"
    | "revokePublication"
    | "update"
  >;
  resolveAuth: RequestAuthResolver;
}>;

type AuthenticatedViewer = Readonly<{
  isAdmin: boolean;
  userId: string;
}>;

function errorJson(code: string, status: number): Response {
  return Response.json({ error: code }, { status });
}

async function readJson(request: Request): Promise<readonly [unknown, Response | null]> {
  const value = await readJsonBodyOrNull(request, "json");
  return [value, requestBodyErrorResponse(value)];
}

async function authenticate(
  deps: KnowledgeHandlerDeps,
  request: Request
): Promise<AuthenticatedViewer | Response> {
  const session = await deps.resolveAuth(request);
  return session
    ? { isAdmin: session.user.role === "admin", userId: session.userId }
    : errorJson("unauthorized", 401);
}

async function routeParam(
  context: { params: Promise<Record<string, string>> | Record<string, string> },
  key: string
): Promise<string> {
  const params = await context.params;
  return params[key] ?? "";
}

function publicationFromRow(row: KnowledgeBasePublicationRow): KnowledgeBasePublication {
  return {
    groupId: row.groupId,
    groupName: row.groupName,
    id: row.id,
    scope: row.scope,
    updatedAt: row.updatedAt.toISOString()
  };
}

function summaryFromEntry(
  entry: KnowledgeBaseAccessEntry
): KnowledgeBaseSummary {
  return {
    archived: entry.archived,
    deletionPending: entry.deletionPending,
    description: entry.description,
    sourceCount: entry.sourceCount,
    id: entry.id,
    name: entry.name,
    owned: entry.owned,
    ownerDisplayName: entry.ownerDisplayName,
    purgeScheduledAt: entry.purgeScheduledAt?.toISOString() ?? null,
    readiness: {
      attentionSources: entry.readiness.attentionSources,
      processingSources: entry.readiness.processingSources,
      readySources: entry.readiness.readySources,
      state: entry.readiness.state,
      supportReference: entry.readiness.supportReference,
      totalSources: entry.readiness.totalSources
    },
    scope: entry.owned
      ? { kind: "owner" }
      : entry.memberGroupNames.length > 0
        ? { groupNames: entry.memberGroupNames, kind: "group" }
        : { kind: "installation" },
    trashed: entry.trashed,
    trashedAt: entry.trashedAt?.toISOString() ?? null,
    updatedAt: entry.updatedAt.toISOString(),
    version: entry.version
  };
}

function detailFromEntry(
  entry: KnowledgeBaseDetailData
): KnowledgeBaseDetail {
  return {
    ...summaryFromEntry(entry),
    publications: entry.publications?.map(publicationFromRow) ?? null
  };
}

export function createListKnowledgeBasesHandler(deps: KnowledgeHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const viewer = await authenticate(deps, request);
    if (viewer instanceof Response) return viewer;
    const [entries, canCreate, publishableGroups] = await Promise.all([
      deps.repository.listForUser(viewer.userId),
      deps.repository.canCreate(viewer.userId),
      deps.repository.listPublishableGroups(viewer.userId)
    ]);
    return Response.json({
      knowledgeBases: entries.map(summaryFromEntry),
      publishableGroups: publishableGroups.map(({ id, name }) => ({ id, name })),
      viewer: {
        canCreate,
        canPublishInstallation: viewer.isAdmin,
        maxUploadBytes: (deps.getExtractionConfig?.() ?? getKnowledgeExtractionConfig()).maxFileBytes
      }
    } satisfies KnowledgeBaseListResponse);
  };
}

export function createCreateKnowledgeBaseHandler(deps: KnowledgeHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const viewer = await authenticate(deps, request);
    if (viewer instanceof Response) return viewer;
    const [body, bodyError] = await readJson(request);
    if (bodyError) return bodyError;
    const decoded = decodeKnowledgeBaseCreate(body);
    if (!decoded.ok) return errorJson(decoded.code, 400);
    const created = await deps.repository.create(viewer.userId, decoded.value);
    if (created.kind === "profile_unavailable") {
      return errorJson("knowledge_temporarily_unavailable", 503);
    }
    const detail = await deps.repository.getDetail(viewer.userId, created.id);
    if (!detail) return errorJson("knowledge_base_not_available", 404);
    return Response.json(
      { knowledgeBase: detailFromEntry(detail) } satisfies KnowledgeBaseDetailResponse,
      { status: 201 }
    );
  };
}

export function createGetKnowledgeBaseHandler(deps: KnowledgeHandlerDeps) {
  return async function GET(
    request: Request,
    context: { params: Promise<{ baseId: string }> | { baseId: string } }
  ): Promise<Response> {
    const viewer = await authenticate(deps, request);
    if (viewer instanceof Response) return viewer;
    const baseId = await routeParam(context, "baseId");
    const detail = await deps.repository.getDetail(viewer.userId, baseId);
    if (!detail) return errorJson("knowledge_base_not_available", 404);
    return Response.json({
      knowledgeBase: detailFromEntry(detail)
    } satisfies KnowledgeBaseDetailResponse);
  };
}

export function createUpdateKnowledgeBaseHandler(deps: KnowledgeHandlerDeps) {
  return async function PATCH(
    request: Request,
    context: { params: Promise<{ baseId: string }> | { baseId: string } }
  ): Promise<Response> {
    const viewer = await authenticate(deps, request);
    if (viewer instanceof Response) return viewer;
    const baseId = await routeParam(context, "baseId");
    const [body, bodyError] = await readJson(request);
    if (bodyError) return bodyError;
    const decoded = decodeKnowledgeBaseUpdate(body);
    if (!decoded.ok) return errorJson(decoded.code, 400);
    const updated = await deps.repository.update(viewer.userId, baseId, decoded.value);
    if (updated.kind === "not_found") return errorJson("knowledge_base_not_available", 404);
    if (updated.kind === "version_conflict") {
      return errorJson("knowledge_base_version_conflict", 409);
    }
    const detail = await deps.repository.getDetail(viewer.userId, baseId);
    if (!detail) return errorJson("knowledge_base_not_available", 404);
    return Response.json({
      knowledgeBase: detailFromEntry(detail)
    } satisfies KnowledgeBaseDetailResponse);
  };
}

export function createPublishKnowledgeBaseHandler(deps: KnowledgeHandlerDeps) {
  return async function POST(
    request: Request,
    context: { params: Promise<{ baseId: string }> | { baseId: string } }
  ): Promise<Response> {
    const viewer = await authenticate(deps, request);
    if (viewer instanceof Response) return viewer;
    const baseId = await routeParam(context, "baseId");
    const [body, bodyError] = await readJson(request);
    if (bodyError) return bodyError;
    const decoded = decodeKnowledgeBasePublication(body);
    if (!decoded.ok) return errorJson(decoded.code, 400);
    const result = await deps.repository.publish({
      actorIsAdmin: viewer.isAdmin,
      groupId: decoded.value.groupId,
      knowledgeBaseId: baseId,
      scope: decoded.value.scope,
      userId: viewer.userId
    });
    if (result.kind === "not_found") return errorJson("knowledge_base_not_available", 404);
    if (result.kind === "forbidden") {
      return errorJson("knowledge_publication_forbidden", 403);
    }
    if (result.kind === "archived") return errorJson("knowledge_base_archived", 409);
    return Response.json(
      { publication: publicationFromRow(result.publication) } satisfies KnowledgeBasePublicationResponse,
      { status: 201 }
    );
  };
}

export function createRevokeKnowledgeBasePublicationHandler(deps: KnowledgeHandlerDeps) {
  return async function DELETE(
    request: Request,
    context: {
      params:
        | Promise<{ baseId: string; publicationId: string }>
        | { baseId: string; publicationId: string };
    }
  ): Promise<Response> {
    const viewer = await authenticate(deps, request);
    if (viewer instanceof Response) return viewer;
    const params = await context.params;
    const result = await deps.repository.revokePublication({
      actorIsAdmin: viewer.isAdmin,
      knowledgeBaseId: params.baseId ?? "",
      publicationId: params.publicationId ?? "",
      userId: viewer.userId
    });
    return result.kind === "ok"
      ? new Response(null, { status: 204 })
      : errorJson("knowledge_base_not_available", 404);
  };
}

import {
  decodeKnowledgeBaseCreate,
  decodeKnowledgeBasePublication,
  decodeKnowledgeBaseUpdate,
  type KnowledgeBaseDetail,
  type KnowledgeBaseDetailResponse,
  type KnowledgeBaseListResponse,
  type KnowledgeBasePublication,
  type KnowledgeBasePublicationResponse,
  type KnowledgeBaseSummary,
  type KnowledgeEmbeddingDeployment
} from "../../contracts/knowledge";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import type {
  KnowledgeBaseAccessEntry,
  KnowledgeBaseDetailData,
  KnowledgeBasePublicationRow,
  PrismaKnowledgeRepository
} from "./prismaRepository";

export type KnowledgeHandlerDeps = Readonly<{
  repository: Pick<
    PrismaKnowledgeRepository,
    | "create"
    | "getDetail"
    | "listEmbeddingDeployments"
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
  entry: KnowledgeBaseAccessEntry,
  deployments: ReadonlyMap<string, KnowledgeEmbeddingDeployment>
): KnowledgeBaseSummary {
  const visibleDeployment = deployments.get(entry.activeGeneration.embeddingDeployment.id) ?? null;
  const embeddingDeployment = entry.owned
    ? visibleDeployment ?? {
        ...entry.activeGeneration.embeddingDeployment,
        indexSupported: true
      }
    : visibleDeployment;
  return {
    activeGeneration: {
      chunkingProfileVersion: entry.activeGeneration.chunkingProfileVersion,
      embeddingDeployment,
      embeddingDeploymentId: entry.owned || visibleDeployment
        ? entry.activeGeneration.embeddingDeployment.id
        : null,
      id: entry.activeGeneration.id,
      indexedContentRevision: entry.activeGeneration.indexedContentRevision,
      targetDimension: entry.activeGeneration.embeddingDeployment.targetDimension,
      vectorSpaceFingerprint: entry.activeGeneration.vectorSpaceFingerprint
    },
    archived: entry.archived,
    contentRevision: entry.contentRevision,
    description: entry.description,
    id: entry.id,
    name: entry.name,
    owned: entry.owned,
    ownerDisplayName: entry.ownerDisplayName,
    published: entry.published,
    scope: entry.owned
      ? { kind: "owner" }
      : entry.memberGroupNames.length > 0
        ? { groupNames: entry.memberGroupNames, kind: "group" }
        : { kind: "installation" },
    updatedAt: entry.updatedAt.toISOString(),
    version: entry.version
  };
}

function detailFromEntry(
  entry: KnowledgeBaseDetailData,
  deployments: ReadonlyMap<string, KnowledgeEmbeddingDeployment>
): KnowledgeBaseDetail {
  return {
    ...summaryFromEntry(entry, deployments),
    documentCount: entry.documentCount,
    publications: entry.publications?.map(publicationFromRow) ?? null
  };
}

async function deploymentMap(
  deps: KnowledgeHandlerDeps,
  userId: string
): Promise<ReadonlyMap<string, KnowledgeEmbeddingDeployment>> {
  const deployments = await deps.repository.listEmbeddingDeployments(userId);
  return new Map(deployments.map((deployment) => [deployment.id, deployment]));
}

export function createListKnowledgeBasesHandler(deps: KnowledgeHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const viewer = await authenticate(deps, request);
    if (viewer instanceof Response) return viewer;
    const [entries, deployments, publishableGroups] = await Promise.all([
      deps.repository.listForUser(viewer.userId),
      deps.repository.listEmbeddingDeployments(viewer.userId),
      deps.repository.listPublishableGroups(viewer.userId)
    ]);
    const byId = new Map(deployments.map((deployment) => [deployment.id, deployment]));
    return Response.json({
      embeddingDeployments: deployments,
      knowledgeBases: entries.map((entry) => summaryFromEntry(entry, byId)),
      publishableGroups,
      viewer: { canPublishInstallation: viewer.isAdmin }
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
    if (created.kind === "embedding_not_available") {
      return errorJson("knowledge_embedding_not_available", 400);
    }
    if (created.kind === "embedding_dimension_not_supported") {
      return errorJson("knowledge_embedding_dimension_not_supported", 400);
    }
    const [detail, deployments] = await Promise.all([
      deps.repository.getDetail(viewer.userId, created.id),
      deploymentMap(deps, viewer.userId)
    ]);
    if (!detail) return errorJson("knowledge_base_not_available", 404);
    return Response.json(
      { knowledgeBase: detailFromEntry(detail, deployments) } satisfies KnowledgeBaseDetailResponse,
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
    const [detail, deployments] = await Promise.all([
      deps.repository.getDetail(viewer.userId, baseId),
      deploymentMap(deps, viewer.userId)
    ]);
    if (!detail) return errorJson("knowledge_base_not_available", 404);
    return Response.json({
      knowledgeBase: detailFromEntry(detail, deployments)
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
    const [detail, deployments] = await Promise.all([
      deps.repository.getDetail(viewer.userId, baseId),
      deploymentMap(deps, viewer.userId)
    ]);
    if (!detail) return errorJson("knowledge_base_not_available", 404);
    return Response.json({
      knowledgeBase: detailFromEntry(detail, deployments)
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

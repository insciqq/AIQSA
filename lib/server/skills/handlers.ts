import {
  decodeSkillDraft,
  type SkillDetail,
  type SkillListResponse,
  type SkillMutationResponse,
  type SkillSummary
} from "../../contracts/skills";
import type { RequestAuthResolver } from "../auth/requestAuth";
import {
  readJsonBodyOrNull,
  requestBodyErrorResponse
} from "../http/requestBody";
import type {
  PrismaSkillRepository,
  SkillDetailEntry,
  SkillListEntry
} from "./prismaRepository";

export type SkillHandlerDeps = {
  repository: PrismaSkillRepository;
  resolveAuth: RequestAuthResolver;
};

const DEFAULT_LIST_LIMIT = 30;
const MAX_LIST_LIMIT = 50;
const MAX_SEARCH_LENGTH = 200;
const MAX_CURSOR_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorJson(code: string, status: number): Response {
  return Response.json({ error: code }, { status });
}

async function body(request: Request): Promise<[Record<string, unknown> | null, Response | null]> {
  const value = await readJsonBodyOrNull(request, "json");
  return [isRecord(value) ? value : null, requestBodyErrorResponse(value)];
}

function summary(entry: SkillListEntry): SkillSummary {
  return {
    archived: entry.archived,
    description: entry.description,
    id: entry.id,
    instructionCharacterCount: entry.instructionCharacterCount,
    name: entry.name,
    owned: entry.owned,
    ownerDisplayName: entry.ownerDisplayName,
    scope: entry.owned
      ? { kind: "owner" }
      : entry.memberWorkspaceNames.length > 0
        ? { kind: "workspace", workspaceNames: entry.memberWorkspaceNames }
        : { kind: "installation" },
    updatedAt: entry.updatedAt.toISOString(),
    version: entry.version
  };
}

function detail(entry: SkillDetailEntry, actorIsAdmin: boolean): SkillDetail {
  return {
    ...summary(entry),
    assistantUsageCount: entry.assistantUsageCount,
    audiences: entry.audiences.map((audience) => audience.kind === "installation"
      ? { id: audience.id, kind: "everyone", name: "Everyone" }
      : audience.kind === "project"
        ? { id: audience.id, kind: "project", name: "Project publication" }
        : {
            id: audience.id,
            kind: "workspace",
            name: audience.name,
            workspaceId: audience.workspaceId
          }),
    canDelete: entry.owned,
    canEdit: entry.owned && !entry.archived,
    canPublish: entry.owned && !entry.archived,
    canUnshare: entry.owned || actorIsAdmin,
    instructions: entry.revision.instructions,
    owner: { displayName: entry.ownerDisplayName },
    workspaceUsageCount: entry.workspaceUsageCount
  };
}

function encodeCursor(cursor: { id: string; updatedAt: Date }): string {
  return Buffer.from(JSON.stringify({
    id: cursor.id,
    updatedAt: cursor.updatedAt.toISOString()
  }), "utf8").toString("base64url");
}

function decodeCursor(value: string): { id: string; updatedAt: Date } | null {
  if (!value || value.length > MAX_CURSOR_LENGTH) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!isRecord(decoded) || Object.keys(decoded).some((key) =>
      key !== "id" && key !== "updatedAt") ||
      typeof decoded.id !== "string" || !decoded.id || decoded.id.length > 64 ||
      typeof decoded.updatedAt !== "string") return null;
    const updatedAt = new Date(decoded.updatedAt);
    if (!Number.isFinite(updatedAt.getTime()) || updatedAt.toISOString() !== decoded.updatedAt) {
      return null;
    }
    return { id: decoded.id, updatedAt };
  } catch {
    return null;
  }
}

function listQuery(request: Request): Readonly<{
  cursor?: { id: string; updatedAt: Date };
  limit: number;
  query?: string;
}> | null {
  const parameters = new URL(request.url).searchParams;
  const allowed = new Set(["cursor", "limit", "q"]);
  if ([...parameters.keys()].some((key) => !allowed.has(key)) ||
    [...allowed].some((key) => parameters.getAll(key).length > 1)) return null;
  const rawLimit = parameters.get("limit");
  const limit = rawLimit === null ? DEFAULT_LIST_LIMIT : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT ||
    (rawLimit !== null && !/^[1-9][0-9]*$/u.test(rawLimit))) return null;
  const rawQuery = parameters.get("q");
  const query = rawQuery?.trim() ?? "";
  if (query.length > MAX_SEARCH_LENGTH) return null;
  const rawCursor = parameters.get("cursor");
  const cursor = rawCursor === null ? undefined : decodeCursor(rawCursor);
  if (rawCursor !== null && !cursor) return null;
  return {
    ...(cursor ? { cursor } : {}),
    limit,
    ...(query ? { query } : {})
  };
}

async function mutationResponse(
  deps: SkillHandlerDeps,
  userId: string,
  actorIsAdmin: boolean,
  skillId: string,
  status = 200
): Promise<Response> {
  const entry = await deps.repository.getForUser(userId, skillId);
  return entry
    ? Response.json({ skill: detail(entry, actorIsAdmin) } satisfies SkillMutationResponse, { status })
    : errorJson("skill_not_available", 404);
}

async function routeParam(
  context: { params: Promise<Record<string, string>> | Record<string, string> },
  key: string
): Promise<string> {
  return (await context.params)[key] ?? "";
}

export function createListSkillsHandler(deps: SkillHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return errorJson("unauthorized", 401);
    const query = listQuery(request);
    if (!query) return errorJson("skill_list_invalid", 400);
    const [page, publishableWorkspaces] = await Promise.all([
      deps.repository.listForUser(session.userId, query),
      deps.repository.listPublishableWorkspaces(session.userId)
    ]);
    return Response.json({
      nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
      publishableWorkspaces,
      skills: page.entries.map(summary),
      viewer: { canPublishInstallation: session.user.role === "admin" }
    } satisfies SkillListResponse);
  };
}

export function createGetSkillHandler(deps: SkillHandlerDeps) {
  return async function GET(
    request: Request,
    context: { params: Promise<{ skillId: string }> | { skillId: string } }
  ): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return errorJson("unauthorized", 401);
    const entry = await deps.repository.getForUser(
      session.userId,
      await routeParam(context, "skillId")
    );
    return entry
      ? Response.json({ skill: detail(entry, session.user.role === "admin") })
      : errorJson("skill_not_available", 404);
  };
}

export function createCreateSkillHandler(deps: SkillHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return errorJson("unauthorized", 401);
    const [value, bodyError] = await body(request);
    if (bodyError) return bodyError;
    const decoded = decodeSkillDraft(value);
    if (!decoded.ok) return errorJson(decoded.code, 400);
    const skillId = await deps.repository.create(session.userId, decoded.draft);
    return mutationResponse(
      deps,
      session.userId,
      session.user.role === "admin",
      skillId,
      201
    );
  };
}

export function createUpdateSkillHandler(deps: SkillHandlerDeps) {
  return async function PATCH(
    request: Request,
    context: { params: Promise<{ skillId: string }> | { skillId: string } }
  ): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return errorJson("unauthorized", 401);
    const skillId = await routeParam(context, "skillId");
    const [value, bodyError] = await body(request);
    if (bodyError) return bodyError;
    if (!value || !Number.isSafeInteger(value.expectedVersion) ||
      Number(value.expectedVersion) < 1) {
      return errorJson("skill_draft_invalid", 400);
    }
    const hasRevision = Object.prototype.hasOwnProperty.call(value, "revision");
    const hasArchived = Object.prototype.hasOwnProperty.call(value, "archived");
    const allowedKeys = new Set(hasRevision
      ? ["expectedVersion", "revision"]
      : ["archived", "expectedVersion"]);
    if (hasRevision === hasArchived || Object.keys(value).some((key) => !allowedKeys.has(key))) {
      return errorJson("skill_draft_invalid", 400);
    }
    const result = hasRevision
      ? (() => {
          const decoded = decodeSkillDraft(value.revision);
          return decoded.ok
            ? deps.repository.revise(
                session.userId,
                skillId,
                Number(value.expectedVersion),
                decoded.draft
              )
            : null;
        })()
      : typeof value.archived === "boolean"
        ? deps.repository.setArchived(
            session.userId,
            skillId,
            Number(value.expectedVersion),
            value.archived
          )
        : null;
    if (!result) return errorJson("skill_draft_invalid", 400);
    const settled = await result;
    if (settled.kind === "not_found") return errorJson("skill_not_available", 404);
    if (settled.kind === "version_conflict") return errorJson("skill_version_conflict", 409);
    if (settled.kind === "archived") return errorJson("skill_archived", 409);
    return mutationResponse(
      deps,
      session.userId,
      session.user.role === "admin",
      skillId
    );
  };
}

export function createDeleteSkillHandler(deps: SkillHandlerDeps) {
  return async function DELETE(
    request: Request,
    context: { params: Promise<{ skillId: string }> | { skillId: string } }
  ): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return errorJson("unauthorized", 401);
    const result = await deps.repository.delete(
      session.userId,
      await routeParam(context, "skillId")
    );
    return result === "ok"
      ? new Response(null, { status: 204 })
      : errorJson("skill_not_available", 404);
  };
}

export function createPublishSkillHandler(deps: SkillHandlerDeps) {
  return async function POST(
    request: Request,
    context: { params: Promise<{ skillId: string }> | { skillId: string } }
  ): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return errorJson("unauthorized", 401);
    const skillId = await routeParam(context, "skillId");
    const [value, bodyError] = await body(request);
    if (bodyError) return bodyError;
    const scope = value?.scope;
    const workspaceId = value?.workspaceId;
    if ((scope !== "workspace" && scope !== "installation") ||
      (scope === "workspace" && (typeof workspaceId !== "string" || !workspaceId.trim())) ||
      (scope === "installation" && workspaceId !== undefined) ||
      !value || Object.keys(value).some((key) => key !== "scope" && key !== "workspaceId")) {
      return errorJson("skill_publication_invalid", 400);
    }
    const result = await deps.repository.publish({
      actorIsAdmin: session.user.role === "admin",
      groupId: scope === "workspace" ? String(workspaceId).trim() : null,
      scope: scope === "workspace" ? "group" : "installation",
      skillId,
      userId: session.userId
    });
    if (result.kind !== "ok") {
      if (result.kind === "not_found") return errorJson("skill_not_available", 404);
      if (result.kind === "forbidden") return errorJson("forbidden", 403);
      return errorJson("skill_publication_invalid", 400);
    }
    return Response.json({ publication: { id: result.id } });
  };
}

export function createRevokeSkillPublicationHandler(deps: SkillHandlerDeps) {
  return async function DELETE(
    request: Request,
    context: {
      params:
        | Promise<{ publicationId: string; skillId: string }>
        | { publicationId: string; skillId: string };
    }
  ): Promise<Response> {
    const session = await deps.resolveAuth(request);
    if (!session) return errorJson("unauthorized", 401);
    const params = await context.params;
    const result = await deps.repository.revokePublication({
      actorIsAdmin: session.user.role === "admin",
      publicationId: params.publicationId,
      skillId: params.skillId,
      userId: session.userId
    });
    if (result === "dependency_conflict") {
      return errorJson("skill_publication_in_use", 409);
    }
    return result === "ok"
      ? new Response(null, { status: 204 })
      : errorJson("skill_not_available", 404);
  };
}

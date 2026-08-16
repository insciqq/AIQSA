import {
  decodeSkillDraft,
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
  SkillAccessEntry
} from "./prismaRepository";

export type SkillHandlerDeps = {
  repository: PrismaSkillRepository;
  resolveAuth: RequestAuthResolver;
};

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

function summary(entry: SkillAccessEntry): SkillSummary {
  return {
    archived: entry.archived,
    description: entry.revision.description,
    id: entry.id,
    instructions: entry.revision.instructions,
    name: entry.revision.name,
    owned: entry.owned,
    ownerDisplayName: entry.ownerDisplayName,
    scope: entry.owned
      ? { kind: "owner" }
      : entry.memberGroupNames.length > 0
        ? { groupNames: entry.memberGroupNames, kind: "group" }
        : { kind: "installation" },
    version: entry.version
  };
}

async function mutationResponse(
  deps: SkillHandlerDeps,
  userId: string,
  skillId: string,
  status = 200
): Promise<Response> {
  const entry = (await deps.repository.listForUser(userId)).find((skill) => skill.id === skillId);
  return entry
    ? Response.json({ skill: summary(entry) } satisfies SkillMutationResponse, { status })
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
    const [entries, publishableGroups] = await Promise.all([
      deps.repository.listForUser(session.userId),
      deps.repository.listPublishableGroups(session.userId)
    ]);
    return Response.json({
      publishableGroups,
      skills: entries.map(summary),
      viewer: { canPublishInstallation: session.user.role === "admin" }
    } satisfies SkillListResponse);
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
    return mutationResponse(deps, session.userId, skillId, 201);
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
    return mutationResponse(deps, session.userId, skillId);
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
    const groupId = value?.groupId;
    if ((scope !== "group" && scope !== "installation") ||
      (scope === "group" && (typeof groupId !== "string" || !groupId.trim())) ||
      (scope === "installation" && groupId !== undefined) ||
      !value || Object.keys(value).some((key) => key !== "scope" && key !== "groupId")) {
      return errorJson("skill_publication_invalid", 400);
    }
    const result = await deps.repository.publish({
      actorIsAdmin: session.user.role === "admin",
      groupId: scope === "group" ? String(groupId).trim() : null,
      scope,
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
    return result === "ok" ? new Response(null, { status: 204 }) : errorJson("skill_not_available", 404);
  };
}

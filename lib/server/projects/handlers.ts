import {
  PROJECT_ACTIVITY_PAGE_SIZE,
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_INSTRUCTIONS_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  decodeProjectDefaults,
  decodeProjectPolicy,
  type ProjectResponseWire,
  type ProjectsResponseWire
} from "../../contracts/projects";
import { isProjectRole } from "../../domain/projects";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import type { ProjectRepository, ProjectRepositoryResult } from "./prismaRepository";

export type ProjectHandlerDeps = Readonly<{
  repository: ProjectRepository;
  resolveAuth: RequestAuthResolver;
}>;

type RouteContext<Keys extends string> = {
  params: Promise<Record<Keys, string>> | Record<Keys, string>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function jsonBody(request: Request): Promise<readonly [Record<string, unknown> | null, Response | null]> {
  const value = await readJsonBodyOrNull(request, "json");
  return [isRecord(value) ? value : null, requestBodyErrorResponse(value)];
}

function error(code: string, status: number, message?: string): Response {
  return Response.json({ error: code, ...(message ? { message } : {}) }, { status });
}

function mutationResponse<T>(result: ProjectRepositoryResult<T>, success: (value: T) => Response): Response {
  if (result.kind === "not_found") return error("project_not_found", 404);
  if (result.kind === "conflict") return error(result.reason, 409);
  return success(result.value);
}

function hasOnly(body: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(body).every((key) => set.has(key));
}

function nonEmptyText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

function optionalText(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" && value.length <= maxLength ? value.trim() : null;
}

function optionalRevision(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function queryRevision(request: Request, name: string): number | null {
  const raw = new URL(request.url).searchParams.get(name);
  if (raw === null || !/^\d+$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function authenticated(deps: ProjectHandlerDeps, request: Request) {
  const session = await deps.resolveAuth(request);
  return session ?? error("unauthorized", 401);
}

export function createListProjectsHandler(deps: ProjectHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const session = await authenticated(deps, request);
    if (session instanceof Response) return session;
    const projects = await deps.repository.list(session.userId);
    if (!projects) return error("unauthorized", 401);
    return Response.json({ projects } satisfies ProjectsResponseWire);
  };
}

export function createCreateProjectHandler(deps: ProjectHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const session = await authenticated(deps, request);
    if (session instanceof Response) return session;
    const [body, bodyError] = await jsonBody(request);
    if (bodyError) return bodyError;
    if (!body || !hasOnly(body, ["description", "name"])) {
      return error("project_input_invalid", 400);
    }
    const name = nonEmptyText(body.name, PROJECT_NAME_MAX_LENGTH);
    const description = optionalText(body.description, PROJECT_DESCRIPTION_MAX_LENGTH) ?? "";
    if (!name || description === null) return error("project_input_invalid", 400);
    return mutationResponse(
      await deps.repository.create({
        actorDisplayName: session.user.displayName,
        description,
        name,
        userId: session.userId
      }),
      (project) => Response.json({ project } satisfies ProjectResponseWire, { status: 201 })
    );
  };
}

export function createGetProjectHandler(deps: ProjectHandlerDeps) {
  return async function GET(request: Request, context: RouteContext<"projectId">): Promise<Response> {
    const session = await authenticated(deps, request);
    if (session instanceof Response) return session;
    const { projectId } = await context.params;
    const project = await deps.repository.getDetail(session.userId, projectId);
    return project
      ? Response.json({ project } satisfies ProjectResponseWire)
      : error("project_not_found", 404);
  };
}

export function createUpdateProjectHandler(deps: ProjectHandlerDeps) {
  return async function PATCH(request: Request, context: RouteContext<"projectId">): Promise<Response> {
    const session = await authenticated(deps, request);
    if (session instanceof Response) return session;
    const [body, bodyError] = await jsonBody(request);
    if (bodyError) return bodyError;
    const allowed = [
      "defaults", "description", "expectedAccessRevision", "expectedInstructionsRevision",
      "expectedMemoryRevision", "expectedPolicyRevision",
      "instructions", "memoryEnabled", "name", "policy", "publicSharingEnabled", "status"
    ];
    if (!body || Object.keys(body).length === 0 || !hasOnly(body, allowed)) {
      return error("project_input_invalid", 400);
    }
    const name = body.name === undefined
      ? undefined
      : nonEmptyText(body.name, PROJECT_NAME_MAX_LENGTH);
    const description = optionalText(body.description, PROJECT_DESCRIPTION_MAX_LENGTH);
    const instructions = optionalText(body.instructions, PROJECT_INSTRUCTIONS_MAX_LENGTH);
    const expectedAccessRevision = optionalRevision(body.expectedAccessRevision);
    const expectedInstructionsRevision = optionalRevision(body.expectedInstructionsRevision);
    const expectedMemoryRevision = optionalRevision(body.expectedMemoryRevision);
    const expectedPolicyRevision = optionalRevision(body.expectedPolicyRevision);
    const defaults = body.defaults === undefined ? undefined : decodeProjectDefaults(body.defaults);
    const policy = body.policy === undefined ? undefined : decodeProjectPolicy(body.policy);
    const status = body.status === undefined
      ? undefined
      : body.status === "ACTIVE" || body.status === "ARCHIVED" ? body.status : null;
    const memoryEnabled = body.memoryEnabled === undefined
      ? undefined
      : typeof body.memoryEnabled === "boolean" ? body.memoryEnabled : null;
    const publicSharingEnabled = body.publicSharingEnabled === undefined
      ? undefined
      : typeof body.publicSharingEnabled === "boolean" ? body.publicSharingEnabled : null;
    if (
      name === null || description === null || instructions === null ||
      expectedAccessRevision === null || expectedInstructionsRevision === null ||
      expectedMemoryRevision === null || expectedPolicyRevision === null ||
      defaults?.ok === false || policy?.ok === false || status === null ||
      memoryEnabled === null || publicSharingEnabled === null ||
      (body.instructions !== undefined && expectedInstructionsRevision === undefined) ||
      (body.memoryEnabled !== undefined && expectedMemoryRevision === undefined) ||
      ((body.defaults !== undefined || body.policy !== undefined || body.publicSharingEnabled !== undefined) &&
        expectedPolicyRevision === undefined) ||
      (body.status !== undefined && expectedAccessRevision === undefined)
    ) return error("project_input_invalid", 400);
    const { projectId } = await context.params;
    return mutationResponse(
      await deps.repository.update({
        actorDisplayName: session.user.displayName,
        defaults: defaults?.ok ? defaults.defaults : undefined,
        description,
        expectedAccessRevision,
        expectedInstructionsRevision,
        expectedMemoryRevision,
        expectedPolicyRevision,
        instructions,
        memoryEnabled,
        name,
        policy: policy?.ok ? policy.policy : undefined,
        projectId,
        publicSharingEnabled,
        status: status ?? undefined,
        userId: session.userId
      }),
      (project) => Response.json({ project } satisfies ProjectResponseWire)
    );
  };
}

export function createDeleteProjectHandler(deps: ProjectHandlerDeps) {
  return async function DELETE(request: Request, context: RouteContext<"projectId">): Promise<Response> {
    const session = await authenticated(deps, request);
    if (session instanceof Response) return session;
    const { projectId } = await context.params;
    return mutationResponse(
      await deps.repository.delete({
        actorDisplayName: session.user.displayName,
        projectId,
        userId: session.userId
      }),
      ({ id }) => Response.json({ deleted: true, projectId: id }, { status: 202 })
    );
  };
}

export function createListProjectGrantsHandler(deps: ProjectHandlerDeps) {
  return async function GET(request: Request, context: RouteContext<"projectId">): Promise<Response> {
    const session = await authenticated(deps, request);
    if (session instanceof Response) return session;
    const { projectId } = await context.params;
    const grants = await deps.repository.listGrants(session.userId, projectId);
    return grants ? Response.json({ grants }) : error("project_not_found", 404);
  };
}

export function createAddProjectGrantHandler(deps: ProjectHandlerDeps) {
  return async function POST(request: Request, context: RouteContext<"projectId">): Promise<Response> {
    const session = await authenticated(deps, request);
    if (session instanceof Response) return session;
    const [body, bodyError] = await jsonBody(request);
    if (bodyError) return bodyError;
    if (!body || !hasOnly(body, ["expectedAccessRevision", "groupId", "role", "userId"]) || !isProjectRole(body.role)) {
      return error("project_grant_input_invalid", 400);
    }
    const expectedAccessRevision = optionalRevision(body.expectedAccessRevision);
    const groupId = nonEmptyText(body.groupId, 128);
    const targetUserId = nonEmptyText(body.userId, 128);
    if (expectedAccessRevision === null || expectedAccessRevision === undefined ||
      (groupId === null) === (targetUserId === null)) return error("project_grant_input_invalid", 400);
    const { projectId } = await context.params;
    return mutationResponse(
      await deps.repository.addGrant({
        actorDisplayName: session.user.displayName,
        expectedAccessRevision,
        groupId: groupId ?? undefined,
        projectId,
        role: body.role,
        targetUserId: targetUserId ?? undefined,
        userId: session.userId
      }),
      (grant) => Response.json({ grant }, { status: 201 })
    );
  };
}

export function createUpdateProjectGrantHandler(deps: ProjectHandlerDeps) {
  return async function PATCH(
    request: Request,
    context: RouteContext<"grantId" | "projectId">
  ): Promise<Response> {
    const session = await authenticated(deps, request);
    if (session instanceof Response) return session;
    const [body, bodyError] = await jsonBody(request);
    if (bodyError) return bodyError;
    if (!body || !hasOnly(body, ["expectedAccessRevision", "role"]) || !isProjectRole(body.role)) {
      return error("project_grant_input_invalid", 400);
    }
    const expectedAccessRevision = optionalRevision(body.expectedAccessRevision);
    if (expectedAccessRevision === null || expectedAccessRevision === undefined) {
      return error("project_grant_input_invalid", 400);
    }
    const { grantId, projectId } = await context.params;
    return mutationResponse(
      await deps.repository.updateGrant({
        actorDisplayName: session.user.displayName,
        expectedAccessRevision,
        grantId,
        projectId,
        role: body.role,
        userId: session.userId
      }),
      (grant) => Response.json({ grant })
    );
  };
}

export function createDeleteProjectGrantHandler(deps: ProjectHandlerDeps) {
  return async function DELETE(
    request: Request,
    context: RouteContext<"grantId" | "projectId">
  ): Promise<Response> {
    const session = await authenticated(deps, request);
    if (session instanceof Response) return session;
    const expectedAccessRevision = queryRevision(request, "expectedAccessRevision");
    if (expectedAccessRevision === null) return error("project_grant_input_invalid", 400);
    const { grantId, projectId } = await context.params;
    return mutationResponse(
      await deps.repository.removeGrant({
        actorDisplayName: session.user.displayName,
        expectedAccessRevision,
        grantId,
        projectId,
        userId: session.userId
      }),
      () => new Response(null, { status: 204 })
    );
  };
}

export function createListProjectResourcesHandler(deps: ProjectHandlerDeps) {
  return async function GET(request: Request, context: RouteContext<"projectId">): Promise<Response> {
    const session = await authenticated(deps, request);
    if (session instanceof Response) return session;
    const { projectId } = await context.params;
    const resources = await deps.repository.listResources(session.userId, projectId);
    return resources ? Response.json({ resources }) : error("project_not_found", 404);
  };
}

export function createAddProjectResourceHandler(deps: ProjectHandlerDeps) {
  return async function POST(request: Request, context: RouteContext<"projectId">): Promise<Response> {
    const session = await authenticated(deps, request);
    if (session instanceof Response) return session;
    const [body, bodyError] = await jsonBody(request);
    if (bodyError) return bodyError;
    if (!body || !hasOnly(body, ["expectedPolicyRevision", "resourceId", "revisionId", "type"])) {
      return error("project_resource_input_invalid", 400);
    }
    const expectedPolicyRevision = optionalRevision(body.expectedPolicyRevision);
    const type = body.type;
    const resourceId = nonEmptyText(body.resourceId, 128);
    const revisionId = body.revisionId === undefined ? undefined : nonEmptyText(body.revisionId, 128);
    if (
      expectedPolicyRevision === null || expectedPolicyRevision === undefined ||
      !resourceId || revisionId === null ||
      !["assistant", "knowledge", "mcp", "model", "search"].includes(String(type))
    ) return error("project_resource_input_invalid", 400);
    const { projectId } = await context.params;
    return mutationResponse(
      await deps.repository.addResource({
        actorDisplayName: session.user.displayName,
        expectedPolicyRevision,
        projectId,
        resourceId,
        revisionId,
        type: type as "assistant" | "knowledge" | "mcp" | "model" | "search",
        userId: session.userId
      }),
      (resources) => Response.json({ resources }, { status: 201 })
    );
  };
}

export function createDeleteProjectResourceHandler(deps: ProjectHandlerDeps) {
  return async function DELETE(
    request: Request,
    context: RouteContext<"bindingId" | "projectId">
  ): Promise<Response> {
    const session = await authenticated(deps, request);
    if (session instanceof Response) return session;
    const expectedPolicyRevision = queryRevision(request, "expectedPolicyRevision");
    if (expectedPolicyRevision === null) return error("project_resource_input_invalid", 400);
    const { bindingId, projectId } = await context.params;
    return mutationResponse(
      await deps.repository.removeResource({
        actorDisplayName: session.user.displayName,
        bindingId,
        expectedPolicyRevision,
        projectId,
        userId: session.userId
      }),
      () => new Response(null, { status: 204 })
    );
  };
}

export function createProjectActivityHandler(deps: ProjectHandlerDeps) {
  return async function GET(request: Request, context: RouteContext<"projectId">): Promise<Response> {
    const session = await authenticated(deps, request);
    if (session instanceof Response) return session;
    const { projectId } = await context.params;
    const before = new URL(request.url).searchParams.get("before")?.trim() || undefined;
    const activity = await deps.repository.activity({
      before,
      limit: PROJECT_ACTIVITY_PAGE_SIZE,
      projectId,
      userId: session.userId
    });
    return activity ? Response.json(activity) : error("project_not_found", 404);
  };
}

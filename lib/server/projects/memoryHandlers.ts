import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import type { ProjectRepositoryResult } from "./prismaRepository";
import type { ReturnTypeOfProjectMemoryRepository } from "./memoryRepository";

const TEXT_MAX = 4_000;

export type ProjectMemoryHandlerDeps = Readonly<{
  repository: ReturnTypeOfProjectMemoryRepository;
  resolveAuth: RequestAuthResolver;
}>;

type RouteContext<Keys extends string> = {
  params: Promise<Record<Keys, string>> | Record<Keys, string>;
};

function error(code: string, status: number): Response {
  return Response.json({ error: code }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function auth(deps: ProjectMemoryHandlerDeps, request: Request) {
  const session = await deps.resolveAuth(request);
  return session ?? error("unauthorized", 401);
}

async function body(request: Request): Promise<readonly [Record<string, unknown> | null, Response | null]> {
  const value = await readJsonBodyOrNull(request, "json");
  return [isRecord(value) ? value : null, requestBodyErrorResponse(value)];
}

function result<T>(value: ProjectRepositoryResult<T>, success: (value: T) => Response): Response {
  if (value.kind === "not_found") return error("project_not_found", 404);
  if (value.kind === "conflict") return error(value.reason, 409);
  return success(value.value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.trim().length <= TEXT_MAX
    ? value.trim()
    : null;
}

function sourceId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value as null | undefined;
  return typeof value === "string" && value.trim().length <= 128 && value.trim()
    ? value.trim()
    : null;
}

function validity(value: unknown): { ok: true; value: Date | null | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string" || value.length > 64) return { ok: false };
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? { ok: false } : { ok: true, value: parsed };
}

export function createProjectMemoryListHandler(deps: ProjectMemoryHandlerDeps) {
  return async function GET(request: Request, context: RouteContext<"projectId">): Promise<Response> {
    const session = await auth(deps, request);
    if (session instanceof Response) return session;
    const { projectId } = await context.params;
    const memory = await deps.repository.list(session.userId, projectId);
    return memory ? Response.json(memory) : error("project_not_found", 404);
  };
}

export function createProjectMemoryProposalHandler(deps: ProjectMemoryHandlerDeps) {
  return async function POST(request: Request, context: RouteContext<"projectId">): Promise<Response> {
    const session = await auth(deps, request);
    if (session instanceof Response) return session;
    const [input, inputError] = await body(request);
    if (inputError) return inputError;
    if (!input || Object.keys(input).some((key) => !["sourceMessageId", "text"].includes(key))) {
      return error("project_memory_input_invalid", 400);
    }
    const value = text(input.text);
    const sourceMessageId = sourceId(input.sourceMessageId);
    if (!value || !sourceMessageId) return error("project_memory_input_invalid", 400);
    const { projectId } = await context.params;
    return result(
      await deps.repository.propose({
        actorDisplayName: session.user.displayName,
        projectId,
        sourceMessageId,
        text: value,
        userId: session.userId
      }),
      (proposal) => Response.json({ proposal }, { status: 201 })
    );
  };
}

export function createProjectMemoryFactHandler(deps: ProjectMemoryHandlerDeps) {
  return async function POST(request: Request, context: RouteContext<"projectId">): Promise<Response> {
    const session = await auth(deps, request);
    if (session instanceof Response) return session;
    const [input, inputError] = await body(request);
    if (inputError) return inputError;
    if (!input || Object.keys(input).some((key) => !["sourceMessageId", "text", "validUntil"].includes(key))) {
      return error("project_memory_input_invalid", 400);
    }
    const value = text(input.text);
    const sourceMessageId = sourceId(input.sourceMessageId);
    const validUntil = validity(input.validUntil);
    if (!value || sourceMessageId === null || !validUntil.ok) return error("project_memory_input_invalid", 400);
    const { projectId } = await context.params;
    return result(
      await deps.repository.createFact({
        actorDisplayName: session.user.displayName,
        projectId,
        sourceMessageId,
        text: value,
        validUntil: validUntil.value,
        userId: session.userId
      }),
      (fact) => Response.json({ fact }, { status: 201 })
    );
  };
}

export function createProjectMemoryReviewHandler(deps: ProjectMemoryHandlerDeps, approve: boolean) {
  return async function POST(
    request: Request,
    context: RouteContext<"projectId" | "proposalId">
  ): Promise<Response> {
    const session = await auth(deps, request);
    if (session instanceof Response) return session;
    const { projectId, proposalId } = await context.params;
    return result(
      await deps.repository.reviewProposal({
        actorDisplayName: session.user.displayName,
        approve,
        projectId,
        proposalId,
        userId: session.userId
      }),
      (proposal) => Response.json({ proposal })
    );
  };
}

export function createProjectMemoryFactUpdateHandler(deps: ProjectMemoryHandlerDeps) {
  return async function PATCH(
    request: Request,
    context: RouteContext<"factId" | "projectId">
  ): Promise<Response> {
    const session = await auth(deps, request);
    if (session instanceof Response) return session;
    const [input, inputError] = await body(request);
    if (inputError) return inputError;
    if (!input || Object.keys(input).some((key) => !["sourceMessageId", "text", "validUntil"].includes(key))) {
      return error("project_memory_input_invalid", 400);
    }
    const value = text(input.text);
    const sourceMessageId = sourceId(input.sourceMessageId);
    const validUntil = validity(input.validUntil);
    if (!value || sourceMessageId === null || !validUntil.ok) return error("project_memory_input_invalid", 400);
    const { factId, projectId } = await context.params;
    return result(
      await deps.repository.editFact({
        actorDisplayName: session.user.displayName,
        factId,
        projectId,
        sourceMessageId,
        text: value,
        validUntil: validUntil.value,
        userId: session.userId
      }),
      (fact) => Response.json({ fact })
    );
  };
}

export function createProjectMemoryFactDeleteHandler(deps: ProjectMemoryHandlerDeps) {
  return async function DELETE(
    request: Request,
    context: RouteContext<"factId" | "projectId">
  ): Promise<Response> {
    const session = await auth(deps, request);
    if (session instanceof Response) return session;
    const { factId, projectId } = await context.params;
    return result(
      await deps.repository.forgetFact({
        actorDisplayName: session.user.displayName,
        factId,
        projectId,
        userId: session.userId
      }),
      () => new Response(null, { status: 204 })
    );
  };
}

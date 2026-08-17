import {
  PROJECT_DESCRIPTION_MAX_LENGTH,
  type ProjectWorkspaceResponseWire
} from "../../contracts/projects";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import type { RequestAuthResolver } from "../auth/requestAuth";
import type { ProjectRepositoryResult } from "./prismaRepository";
import type { ReturnTypeOfProjectContentRepository } from "./contentRepository";

export type ProjectContentHandlerDeps = Readonly<{
  repository: ReturnTypeOfProjectContentRepository;
  resolveAuth: RequestAuthResolver;
}>;

type RouteContext<Keys extends string> = {
  params: Promise<Record<Keys, string>> | Record<Keys, string>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function error(code: string, status: number): Response {
  return Response.json({ error: code }, { status });
}

async function body(request: Request): Promise<readonly [Record<string, unknown> | null, Response | null]> {
  const value = await readJsonBodyOrNull(request, "json");
  return [isRecord(value) ? value : null, requestBodyErrorResponse(value)];
}

async function auth(deps: ProjectContentHandlerDeps, request: Request) {
  const session = await deps.resolveAuth(request);
  return session ?? error("unauthorized", 401);
}

function result<T>(value: ProjectRepositoryResult<T>, success: (value: T) => Response): Response {
  if (value.kind === "not_found") return error("project_not_found", 404);
  if (value.kind === "conflict") return error(value.reason, 409);
  return success(value.value);
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() && value.trim().length <= max
    ? value.trim()
    : null;
}

export function createProjectWorkspaceHandler(deps: ProjectContentHandlerDeps) {
  return async function GET(request: Request, context: RouteContext<"projectId">): Promise<Response> {
    const session = await auth(deps, request);
    if (session instanceof Response) return session;
    const { projectId } = await context.params;
    const workspace = await deps.repository.listWorkspace(session.userId, projectId);
    return workspace
      ? Response.json(workspace satisfies ProjectWorkspaceResponseWire)
      : error("project_not_found", 404);
  };
}

export function createProjectChatHandler(deps: ProjectContentHandlerDeps) {
  return async function POST(request: Request, context: RouteContext<"projectId">): Promise<Response> {
    const session = await auth(deps, request);
    if (session instanceof Response) return session;
    const [input, inputError] = await body(request);
    if (inputError) return inputError;
    if (!input || Object.keys(input).some((key) => !["folderId", "title"].includes(key))) {
      return error("project_chat_input_invalid", 400);
    }
    const folderId = input.folderId === undefined || input.folderId === null
      ? input.folderId ?? undefined
      : text(input.folderId, 128);
    const title = input.title === undefined || input.title === null
      ? input.title
      : text(input.title, 80);
    if (folderId === null || title === null) return error("project_chat_input_invalid", 400);
    const { projectId } = await context.params;
    return result(
      await deps.repository.createChat({
        actorDisplayName: session.user.displayName,
        folderId,
        projectId,
        title,
        userId: session.userId
      }),
      (chat) => Response.json({ chat }, { status: 201 })
    );
  };
}

export function createProjectFolderHandler(deps: ProjectContentHandlerDeps) {
  return async function POST(request: Request, context: RouteContext<"projectId">): Promise<Response> {
    const session = await auth(deps, request);
    if (session instanceof Response) return session;
    const [input, inputError] = await body(request);
    if (inputError) return inputError;
    if (!input || Object.keys(input).some((key) => !["name", "parentId"].includes(key))) {
      return error("project_folder_input_invalid", 400);
    }
    const name = text(input.name, 60);
    const parentId = input.parentId === undefined || input.parentId === null
      ? input.parentId ?? undefined
      : text(input.parentId, 128);
    if (!name || parentId === null) return error("project_folder_input_invalid", 400);
    const { projectId } = await context.params;
    return result(
      await deps.repository.createFolder({
        actorDisplayName: session.user.displayName,
        name,
        parentId,
        projectId,
        userId: session.userId
      }),
      (folder) => Response.json({ folder }, { status: 201 })
    );
  };
}

export function createProjectFolderUpdateHandler(deps: ProjectContentHandlerDeps) {
  return async function PATCH(
    request: Request,
    context: RouteContext<"folderId" | "projectId">
  ): Promise<Response> {
    const session = await auth(deps, request);
    if (session instanceof Response) return session;
    const [input, inputError] = await body(request);
    if (inputError) return inputError;
    if (!input || Object.keys(input).length === 0 || Object.keys(input).some((key) => !["name", "parentId"].includes(key))) {
      return error("project_folder_input_invalid", 400);
    }
    const name = input.name === undefined ? undefined : text(input.name, 60);
    const parentId = input.parentId === undefined || input.parentId === null
      ? input.parentId
      : text(input.parentId, 128);
    if (
      name === null ||
      (input.parentId !== undefined && input.parentId !== null && parentId === null)
    ) return error("project_folder_input_invalid", 400);
    const { folderId, projectId } = await context.params;
    return result(
      await deps.repository.updateFolder({
        actorDisplayName: session.user.displayName,
        folderId,
        name,
        parentId,
        projectId,
        userId: session.userId
      }),
      (folder) => Response.json({ folder })
    );
  };
}

export function createProjectFolderDeleteHandler(deps: ProjectContentHandlerDeps) {
  return async function DELETE(
    request: Request,
    context: RouteContext<"folderId" | "projectId">
  ): Promise<Response> {
    const session = await auth(deps, request);
    if (session instanceof Response) return session;
    const { folderId, projectId } = await context.params;
    return result(
      await deps.repository.deleteFolder({
        actorDisplayName: session.user.displayName,
        folderId,
        projectId,
        userId: session.userId
      }),
      () => new Response(null, { status: 204 })
    );
  };
}

export function createProjectChatArchiveHandler(deps: ProjectContentHandlerDeps, archived: boolean) {
  return async function POST(
    request: Request,
    context: RouteContext<"chatId" | "projectId">
  ): Promise<Response> {
    const session = await auth(deps, request);
    if (session instanceof Response) return session;
    const { chatId, projectId } = await context.params;
    return result(
      await deps.repository.setChatArchived({
        actorDisplayName: session.user.displayName,
        archived,
        chatId,
        projectId,
        userId: session.userId
      }),
      (chat) => Response.json({ chat })
    );
  };
}

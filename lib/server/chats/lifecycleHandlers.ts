import {
  ARCHIVED_CHAT_CURSOR_MAX_LENGTH,
  decodeChatLifecycleRequest,
  type ArchivedChatDetailResponseWire,
  type ArchivedChatSummaryWire,
  type ArchivedChatsResponseWire,
  type ChatLifecycleResponseWire,
  type ChatSourceResolutionResponseWire,
  type RetainedChatMemoryMode
} from "../../contracts/chats";
import {
  type MemoryChatModePatch,
  type MemoryChatModeResponse
} from "../../contracts/memory";
import {
  decodeMemoryConsumerChatModePatch,
  type MemoryConsumerChatModeResponse
} from "../../contracts/memoryClient";
import type { RequestAuthResolver } from "../auth/requestAuth";
import {
  readJsonBodyOrNull,
  requestBodyErrorResponse
} from "../http/requestBody";
import { ActiveRunConflictError } from "../runs/runRepositoryContract";
import {
  serializeChatDetail,
  serializeChatSummary,
  serializeMessagesPage,
  type ChatDetailRecord,
  type ChatMessagesPageResult,
  type ChatSummaryRecord
} from "./handlers";

const PRIVATE_CACHE_CONTROL = "private, no-store, max-age=0";

export type ArchivedChatSummaryRecord = ChatSummaryRecord & Readonly<{
  archived: true;
  memoryMode: RetainedChatMemoryMode;
  sourceRevision: number;
}>;

export type ArchivedChatDetailRecord = ChatDetailRecord & Readonly<{
  archived: true;
  memoryMode: RetainedChatMemoryMode;
  sourceRevision: number;
}>;

export type ChatLifecycleStateRecord = Readonly<{
  archived: boolean;
  id: string;
  memoryMode: RetainedChatMemoryMode;
  sourceRevision: number;
  updatedAt: Date | string;
}>;

export type ChatMemoryStateRecord = Readonly<{
  archived: boolean;
  chatId: string;
  mode: "NORMAL" | "EXCLUDED" | "TEMPORARY";
  sourceRevision: number;
  temporaryRetentionDeadline: Date | string | null;
  temporaryRetentionPolicyVersion: "temporary-24h-v1" | null;
  updatedAt: Date | string;
}>;

export type ChatSourceResolutionRecord = Readonly<{
  chatId: string;
  location: "ACTIVE_CHAT" | "ARCHIVED_PREVIEW";
  memoryMode: RetainedChatMemoryMode;
  sourceRevision: number;
  updatedAt: Date | string;
}>;

export type ArchivedChatsPageResult =
  | Readonly<{ kind: "cursor_invalid" }>
  | Readonly<{
      chats: readonly ArchivedChatSummaryRecord[];
      kind: "ok";
      nextCursor: string | null;
    }>;

export type ChatLifecycleMutationResult =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "stale" }>
  | Readonly<{ chat: ChatLifecycleStateRecord; kind: "ok" }>;

export type ChatMemoryModeMutationResult =
  | Readonly<{
      kind:
        | "contract_invalid"
        | "memory_stale"
        | "not_found"
        | "resume_blocked"
        | "source_stale"
        | "temporary";
    }>
  | Readonly<{ kind: "ok"; response: MemoryChatModeResponse }>;

type ChatMemoryModeMutationInput = Readonly<{
  expectedChatRevision?: number;
  expectedMemoryRevision?: number;
  mode: MemoryChatModePatch["mode"];
  resumeDisclosureCopyVersion?: MemoryChatModePatch["resumeDisclosureCopyVersion"];
}>;

export type ChatLifecycleRepository = Readonly<{
  getArchivedChat(input: { chatId: string; userId: string }): Promise<ArchivedChatDetailRecord | null>;
  getChatMemoryState(input: { chatId: string; userId: string }): Promise<ChatMemoryStateRecord | null>;
  getArchivedMessagesPage(input: {
    before: string;
    chatId: string;
    userId: string;
  }): Promise<ChatMessagesPageResult>;
  listArchivedChats(input: { cursor: string | null; userId: string }): Promise<ArchivedChatsPageResult>;
  resolveChatSource(input: {
    chatId: string;
    userId: string;
  }): Promise<ChatSourceResolutionRecord | null>;
  setArchived(input: {
    archived: boolean;
    chatId: string;
    expectedChatRevision: number;
    userId: string;
  }): Promise<ChatLifecycleMutationResult>;
  setMemoryMode(input: ChatMemoryModeMutationInput & {
    chatId: string;
    userId: string;
  }): Promise<ChatMemoryModeMutationResult>;
}>;

export type ChatLifecycleHandlerDeps = Readonly<{
  repository: ChatLifecycleRepository;
  resolveAuth: RequestAuthResolver;
}>;

type ChatRouteContext = Readonly<{
  params: Promise<{ chatId: string }> | { chatId: string };
}>;

function withPrivateHeaders(response: Response): Response {
  response.headers.set("cache-control", PRIVATE_CACHE_CONTROL);
  response.headers.set("vary", "Cookie");
  return response;
}

function json(body: unknown, status = 200): Response {
  return withPrivateHeaders(Response.json(body, { status }));
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function routeId(value: string | undefined): string | null {
  return value && value.length <= 256 && !/[\u0000-\u0020\u007f]/u.test(value)
    ? value
    : null;
}

function noSearchParams(request: Request): boolean {
  return [...new URL(request.url).searchParams].length === 0;
}

function isJsonContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function jsonBody(request: Request): Promise<unknown | Response> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return json({ error: "chat_lifecycle_invalid" }, 400);
  }
  const value = await readJsonBodyOrNull(request, "json");
  const error = requestBodyErrorResponse(value);
  return error ? withPrivateHeaders(error) : value;
}

async function memoryJsonBody(request: Request): Promise<unknown | Response> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return json({ error: "memory_contract_invalid" }, 400);
  }
  const value = await readJsonBodyOrNull(request, "json");
  const error = requestBodyErrorResponse(value);
  return error ? withPrivateHeaders(error) : value;
}

function isActiveRunConflictError(error: unknown): boolean {
  return error instanceof ActiveRunConflictError ||
    (error instanceof Error && error.name === "ActiveRunConflictError");
}

function serializeLifecycleState(chat: ChatLifecycleStateRecord): ChatLifecycleResponseWire {
  return {
    chat: {
      archived: chat.archived,
      id: chat.id,
      memoryMode: chat.memoryMode,
      sourceRevision: chat.sourceRevision,
      updatedAt: iso(chat.updatedAt)
    }
  };
}

function serializeMemoryState(chat: ChatMemoryStateRecord): MemoryConsumerChatModeResponse {
  return {
    allowedActions: chat.mode === "NORMAL"
      ? ["EXCLUDE"]
      : chat.mode === "EXCLUDED"
        ? ["RESUME"]
        : [],
    archived: chat.archived,
    mode: chat.mode,
    temporaryRetentionDeadline: chat.temporaryRetentionDeadline === null
      ? null
      : iso(chat.temporaryRetentionDeadline)
  };
}

function serializeArchivedSummary(chat: ArchivedChatSummaryRecord): ArchivedChatSummaryWire {
  return {
    ...serializeChatSummary(chat),
    archived: true,
    memoryMode: chat.memoryMode,
    sourceRevision: chat.sourceRevision
  };
}

function serializeArchivedDetail(chat: ArchivedChatDetailRecord): ArchivedChatDetailResponseWire {
  return {
    chat: {
      ...serializeChatDetail(chat),
      archived: true,
      memoryMode: chat.memoryMode,
      sourceRevision: chat.sourceRevision
    }
  };
}

async function authenticated(
  request: Request,
  deps: ChatLifecycleHandlerDeps
): Promise<Readonly<{ ok: false; response: Response } | { ok: true; userId: string }>> {
  const session = await deps.resolveAuth(request);
  return session
    ? { ok: true, userId: session.userId }
    : { ok: false, response: json({ error: "unauthorized" }, 401) };
}

export function createListArchivedChatsHandler(deps: ChatLifecycleHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const resolved = await authenticated(request, deps);
    if (!resolved.ok) return resolved.response;
    const search = new URL(request.url).searchParams;
    const cursorValues = search.getAll("cursor");
    if ([...search.keys()].some((key) => key !== "cursor") || cursorValues.length > 1) {
      return json({ error: "archived_chat_cursor_invalid" }, 400);
    }
    const cursor = cursorValues.length === 0 ? null : cursorValues[0]?.trim() ?? "";
    if (
      cursor !== null &&
      (!cursor || cursor.length > ARCHIVED_CHAT_CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(cursor))
    ) {
      return json({ error: "archived_chat_cursor_invalid" }, 400);
    }
    const page = await deps.repository.listArchivedChats({ cursor, userId: resolved.userId });
    if (page.kind === "cursor_invalid") {
      return json({ error: "archived_chat_cursor_invalid" }, 400);
    }
    const response: ArchivedChatsResponseWire = {
      chats: page.chats.map(serializeArchivedSummary),
      nextCursor: page.nextCursor
    };
    return json(response);
  };
}

export function createGetArchivedChatHandler(deps: ChatLifecycleHandlerDeps) {
  return async function GET(request: Request, context: ChatRouteContext): Promise<Response> {
    const resolved = await authenticated(request, deps);
    if (!resolved.ok) return resolved.response;
    if (!noSearchParams(request)) return json({ error: "chat_lifecycle_invalid" }, 400);
    const chatId = routeId((await context.params).chatId);
    if (!chatId) return json({ error: "chat_lifecycle_invalid" }, 400);
    const chat = await deps.repository.getArchivedChat({ chatId, userId: resolved.userId });
    return chat
      ? json(serializeArchivedDetail(chat))
      : json({ error: "chat_not_found" }, 404);
  };
}

export function createGetArchivedChatMessagesPageHandler(deps: ChatLifecycleHandlerDeps) {
  return async function GET(request: Request, context: ChatRouteContext): Promise<Response> {
    const resolved = await authenticated(request, deps);
    if (!resolved.ok) return resolved.response;
    const search = new URL(request.url).searchParams;
    const beforeValues = search.getAll("before");
    const before = beforeValues.length === 1 ? beforeValues[0]?.trim() ?? "" : "";
    if ([...search.keys()].some((key) => key !== "before") || !before) {
      return json({ error: "chat_page_cursor_invalid" }, 400);
    }
    const chatId = routeId((await context.params).chatId);
    if (!chatId) return json({ error: "chat_page_cursor_invalid" }, 400);
    const page = await deps.repository.getArchivedMessagesPage({
      before,
      chatId,
      userId: resolved.userId
    });
    if (page.kind === "not_found") return json({ error: "chat_not_found" }, 404);
    if (page.kind === "cursor_invalid") {
      return json({ error: "chat_page_cursor_invalid" }, 400);
    }
    if (page.kind === "stale") return json({ error: "chat_page_stale" }, 409);
    return json(serializeMessagesPage(page.page));
  };
}

function createSetArchivedHandler(deps: ChatLifecycleHandlerDeps, archived: boolean) {
  return async function POST(request: Request, context: ChatRouteContext): Promise<Response> {
    const resolved = await authenticated(request, deps);
    if (!resolved.ok) return resolved.response;
    if (!noSearchParams(request)) return json({ error: "chat_lifecycle_invalid" }, 400);
    const chatId = routeId((await context.params).chatId);
    if (!chatId) return json({ error: "chat_lifecycle_invalid" }, 400);
    const body = await jsonBody(request);
    if (body instanceof Response) return body;
    const decoded = decodeChatLifecycleRequest(body);
    if (!decoded) return json({ error: "chat_lifecycle_invalid" }, 400);
    try {
      const result = await deps.repository.setArchived({
        archived,
        chatId,
        expectedChatRevision: decoded.expectedChatRevision,
        userId: resolved.userId
      });
      if (result.kind === "not_found") return json({ error: "chat_not_found" }, 404);
      if (result.kind === "stale") return json({ error: "chat_revision_stale" }, 409);
      return json(serializeLifecycleState(result.chat));
    } catch (error) {
      if (isActiveRunConflictError(error)) {
        return json({ error: "active_run_in_progress" }, 409);
      }
      throw error;
    }
  };
}

export function createArchiveChatExplicitHandler(deps: ChatLifecycleHandlerDeps) {
  return createSetArchivedHandler(deps, true);
}

export function createRestoreChatHandler(deps: ChatLifecycleHandlerDeps) {
  return createSetArchivedHandler(deps, false);
}

export function createResolveChatSourceHandler(deps: ChatLifecycleHandlerDeps) {
  return async function GET(request: Request, context: ChatRouteContext): Promise<Response> {
    const resolved = await authenticated(request, deps);
    if (!resolved.ok) return resolved.response;
    if (!noSearchParams(request)) return json({ error: "chat_lifecycle_invalid" }, 400);
    const chatId = routeId((await context.params).chatId);
    if (!chatId) return json({ error: "chat_lifecycle_invalid" }, 400);
    const source = await deps.repository.resolveChatSource({ chatId, userId: resolved.userId });
    if (!source) return json({ error: "chat_not_found" }, 404);
    const response: ChatSourceResolutionResponseWire = {
      source: {
        ...source,
        updatedAt: iso(source.updatedAt)
      }
    };
    return json(response);
  };
}

export function createPatchChatMemoryModeHandler(deps: ChatLifecycleHandlerDeps) {
  return async function PATCH(request: Request, context: ChatRouteContext): Promise<Response> {
    const resolved = await authenticated(request, deps);
    if (!resolved.ok) return resolved.response;
    if (!noSearchParams(request)) return json({ error: "memory_contract_invalid" }, 400);
    const chatId = routeId((await context.params).chatId);
    if (!chatId) return json({ error: "memory_contract_invalid" }, 400);
    const body = await memoryJsonBody(request);
    if (body instanceof Response) return body;
    const decoded = decodeMemoryConsumerChatModePatch(body);
    if (!decoded.ok) return json({ error: decoded.code }, 400);
    const result = await deps.repository.setMemoryMode({
      ...decoded.value,
      chatId,
      userId: resolved.userId
    });
    switch (result.kind) {
      case "ok":
        {
          const updated = await deps.repository.getChatMemoryState({
            chatId,
            userId: resolved.userId
          });
          return updated
            ? json(serializeMemoryState(updated))
            : json({ error: "memory_not_found" }, 404);
        }
      case "not_found":
        return json({ error: "memory_not_found" }, 404);
      case "contract_invalid":
        return json({ error: "memory_contract_invalid" }, 400);
      case "temporary":
        return json({ error: "memory_temporary_chat_forbidden" }, 409);
      case "memory_stale":
        return json({ error: "memory_changed" }, 409);
      case "source_stale":
        return json({ error: "memory_changed" }, 409);
      case "resume_blocked":
        return json({ error: "memory_action_failed" }, 503);
    }
  };
}

export function createGetChatMemoryModeHandler(deps: ChatLifecycleHandlerDeps) {
  return async function GET(request: Request, context: ChatRouteContext): Promise<Response> {
    const resolved = await authenticated(request, deps);
    if (!resolved.ok) return resolved.response;
    if (!noSearchParams(request)) return json({ error: "memory_contract_invalid" }, 400);
    const chatId = routeId((await context.params).chatId);
    if (!chatId) return json({ error: "memory_contract_invalid" }, 400);
    const chat = await deps.repository.getChatMemoryState({ chatId, userId: resolved.userId });
    return chat
      ? json(serializeMemoryState(chat))
      : json({ error: "memory_not_found" }, 404);
  };
}

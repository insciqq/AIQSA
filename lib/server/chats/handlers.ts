import type { RequestAuthResolver } from "../auth/requestAuth";
import {
  readJsonBodyOrNull,
  requestBodyErrorResponse
} from "../http/requestBody";
import { ActiveRunConflictError } from "../runs/runRepositoryContract";
import type {
  ChatDetailResponseWire,
  ChatDetailWire,
  ChatRouteErrorResponse,
  ChatMessageWire,
  ChatUsageStats,
  ChatSummaryResponseWire,
  CreateChatRequestWire,
  ThreadArtifactSummary,
  ThreadAssistantIdentity,
  ThreadRunUsage,
  UpdateChatRequestWire,
  WorkspaceChatSummaryWire,
  WorkspaceChatsResponseWire
} from "../../contracts/chats";

export type {
  ChatUsageStats,
  ThreadArtifactSummary,
  ThreadCitation,
  ThreadSearchActivity
} from "../../contracts/chats";

export type ChatMessageRecord = {
  artifactSummary?: ThreadArtifactSummary | null;
  assistantIdentity?: ThreadAssistantIdentity | null;
  content: unknown;
  createdAt: Date | string;
  errorMessage?: string | null;
  id: string;
  modelId: string | null;
  modelRunId?: string | null;
  parentMessageId: string | null;
  provider: string | null;
  role: string;
  runUsage?: ThreadRunUsage | null;
  status: string;
};

export type ChatSummaryRecord = {
  activeLeafMessageId: string | null;
  createdAt: Date | string;
  defaultModelId: string | null;
  defaultProvider: string | null;
  folderId: string | null;
  id: string;
  messageCount: number;
  pinned: boolean;
  title: string;
  updatedAt: Date | string;
};

export type ChatDetailRecord = ChatSummaryRecord & {
  messages: ChatMessageRecord[];
  usageStats: ChatUsageStats | null;
};

export type FolderRecord = {
  id: string;
  name: string;
  parentId: string | null;
  projectMemory: string;
  sortOrder: number;
};

export type ChatWorkspace = {
  chats: ChatSummaryRecord[];
  folders: FolderRecord[];
};

export type ChatContentMatchRecord = {
  chatId: string;
  snippet?: string | null;
};

export type ChatRepository = {
  createChat(input: { folderId?: string | null; title?: string | null; userId: string }): Promise<ChatSummaryRecord | null>;
  createFolder(input: { name: string; parentId?: string | null; userId: string }): Promise<FolderRecord | null>;
  deleteFolder(input: { folderId: string; userId: string }): Promise<boolean>;
  archiveChat(input: { chatId: string; userId: string }): Promise<boolean>;
  getChat(input: { chatId: string; userId: string }): Promise<ChatDetailRecord | null>;
  listWorkspace(userId: string): Promise<ChatWorkspace | null>;
  searchChatContent(input: { limit: number; query: string; userId: string }): Promise<ChatContentMatchRecord[]>;
  updateFolder(input: {
    folderId: string;
    name?: string | null;
    parentId?: string | null;
    projectMemory?: string;
    userId: string;
  }): Promise<FolderRecord | null>;
  updateChat(input: {
    activeLeafMessageId?: string | null;
    chatId: string;
    folderId?: string | null;
    pinned?: boolean;
    title?: string | null;
    userId: string;
  }): Promise<ChatSummaryRecord | null>;
};

export type ChatHandlerDeps = {
  reconcileRuns?: (input: { chatId: string; userId: string }) => Promise<void>;
  repository: ChatRepository;
  resolveAuth: RequestAuthResolver;
};

type UntrustedWire<Wire extends object> = Partial<Record<keyof Wire, unknown>>;

async function readJson<Wire extends object = Record<string, unknown>>(
  request: Request
): Promise<readonly [UntrustedWire<Wire> | null, Response | null]> {
  const value = await readJsonBodyOrNull(request, "json");
  return [
    typeof value === "object" && value !== null
      ? (value as UntrustedWire<Wire>)
      : null,
    requestBodyErrorResponse(value)
  ];
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function folderValue(body: { folderId?: unknown } | null): string | null | undefined {
  if (!body || !("folderId" in body)) {
    return undefined;
  }

  return typeof body.folderId === "string" && body.folderId.trim() ? body.folderId.trim() : null;
}

function activeLeafValue(body: { activeLeafMessageId?: unknown } | null): string | null | undefined {
  if (!body || !("activeLeafMessageId" in body)) {
    return undefined;
  }

  return typeof body.activeLeafMessageId === "string" && body.activeLeafMessageId.trim()
    ? body.activeLeafMessageId.trim()
    : null;
}

function pinnedValue(body: { pinned?: unknown } | null): boolean | undefined {
  if (!body || !("pinned" in body)) {
    return undefined;
  }

  return typeof body.pinned === "boolean" ? body.pinned : undefined;
}

function parentFolderValue(body: Record<string, unknown> | null): string | null | undefined {
  if (!body || !("parentId" in body)) {
    return undefined;
  }

  return typeof body.parentId === "string" && body.parentId.trim() ? body.parentId.trim() : null;
}

function optionalTextValue(body: Record<string, unknown> | null, key: string): string | undefined {
  if (!body || !(key in body)) {
    return undefined;
  }

  return typeof body[key] === "string" ? body[key].trim() : "";
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function serializeMessage(message: ChatMessageRecord): ChatMessageWire {
  return {
    artifactSummary: message.artifactSummary ?? null,
    assistantIdentity: message.assistantIdentity ?? null,
    content: message.content,
    createdAt: iso(message.createdAt),
    errorMessage: message.errorMessage ?? null,
    id: message.id,
    modelId: message.modelId,
    modelRunId: message.modelRunId ?? null,
    parentMessageId: message.parentMessageId,
    provider: message.provider,
    role: message.role,
    runUsage: message.runUsage ?? null,
    status: message.status
  };
}

function serializeChatSummary(chat: ChatSummaryRecord): WorkspaceChatSummaryWire {
  return {
    activeLeafMessageId: chat.activeLeafMessageId,
    createdAt: iso(chat.createdAt),
    defaultModelId: chat.defaultModelId,
    defaultProvider: chat.defaultProvider,
    folderId: chat.folderId,
    id: chat.id,
    messageCount: chat.messageCount,
    pinned: chat.pinned,
    title: chat.title,
    updatedAt: iso(chat.updatedAt)
  };
}

function serializeChatDetail(chat: ChatDetailRecord): ChatDetailWire {
  return {
    ...serializeChatSummary(chat),
    messages: chat.messages.map(serializeMessage),
    usageStats: chat.usageStats
  };
}

function serializeChatContentMatch(match: ChatContentMatchRecord) {
  return {
    chatId: match.chatId,
    snippet: match.snippet ?? null
  };
}

function chatRouteErrorJson(data: ChatRouteErrorResponse, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function isActiveRunConflictError(error: unknown): boolean {
  return error instanceof ActiveRunConflictError || (error instanceof Error && error.name === "ActiveRunConflictError");
}

function activeRunConflictJson(): Response {
  return chatRouteErrorJson({ error: "active_run_in_progress" }, { status: 409 });
}

function chatSummaryJson(data: ChatSummaryResponseWire, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function chatDetailJson(data: ChatDetailResponseWire, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function workspaceJson(data: WorkspaceChatsResponseWire, init?: ResponseInit): Response {
  return Response.json(data, init);
}

async function auth(request: Request, deps: ChatHandlerDeps) {
  const session = await deps.resolveAuth(request);
  if (!session) {
    return {
      response: chatRouteErrorJson({ error: "unauthorized" }, { status: 401 }),
      session: null
    };
  }

  return {
    response: null,
    session
  };
}

export function createListChatsHandler(deps: ChatHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const result = await auth(request, deps);
    if (!result.session) {
      return result.response;
    }

    const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
    const workspace = await deps.repository.listWorkspace(result.session.userId);
    if (!workspace) {
      return chatRouteErrorJson({ error: "workspace_not_found" }, { status: 404 });
    }
    const contentMatches = query
      ? await deps.repository.searchChatContent({
          limit: 50,
          query,
          userId: result.session.userId
        })
      : [];

    return workspaceJson({
      chats: workspace.chats.map(serializeChatSummary),
      contentMatches: contentMatches.map(serializeChatContentMatch),
      folders: workspace.folders
    });
  };
}

export function createGetChatHandler(deps: ChatHandlerDeps) {
  return async function GET(
    request: Request,
    context: { params: Promise<{ chatId: string }> | { chatId: string } }
  ): Promise<Response> {
    const result = await auth(request, deps);
    if (!result.session) {
      return result.response;
    }

    const params = await context.params;
    await deps.reconcileRuns?.({
      chatId: params.chatId,
      userId: result.session.userId
    });
    const chat = await deps.repository.getChat({
      chatId: params.chatId,
      userId: result.session.userId
    });

    if (!chat) {
      return chatRouteErrorJson({ error: "chat_not_found" }, { status: 404 });
    }

    return chatDetailJson({ chat: serializeChatDetail(chat) });
  };
}

export function createCreateChatHandler(deps: ChatHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const result = await auth(request, deps);
    if (!result.session) {
      return result.response;
    }

    const [body, bodyError] = await readJson<CreateChatRequestWire>(request);
    if (bodyError) {
      return bodyError;
    }
    const chat = await deps.repository.createChat({
      folderId: body && "folderId" in body ? folderValue(body) : null,
      title: textValue(body?.title),
      userId: result.session.userId
    });

    if (!chat) {
      return chatRouteErrorJson({ error: "chat_not_created" }, { status: 400 });
    }

    return chatSummaryJson({ chat: serializeChatSummary(chat) }, { status: 201 });
  };
}

export function createUpdateChatHandler(deps: ChatHandlerDeps) {
  return async function PATCH(
    request: Request,
    context: { params: Promise<{ chatId: string }> | { chatId: string } }
  ): Promise<Response> {
    const result = await auth(request, deps);
    if (!result.session) {
      return result.response;
    }

    const params = await context.params;
    const [body, bodyError] = await readJson<UpdateChatRequestWire>(request);
    if (bodyError) {
      return bodyError;
    }
    let chat: ChatSummaryRecord | null;
    try {
      chat = await deps.repository.updateChat({
        activeLeafMessageId: activeLeafValue(body),
        chatId: params.chatId,
        folderId: folderValue(body),
        pinned: pinnedValue(body),
        title: textValue(body?.title),
        userId: result.session.userId
      });
    } catch (error) {
      if (isActiveRunConflictError(error)) {
        return activeRunConflictJson();
      }
      throw error;
    }

    if (!chat) {
      return chatRouteErrorJson({ error: "chat_not_found" }, { status: 404 });
    }

    return chatSummaryJson({ chat: serializeChatSummary(chat) });
  };
}

export function createArchiveChatHandler(deps: ChatHandlerDeps) {
  return async function DELETE(
    request: Request,
    context: { params: Promise<{ chatId: string }> | { chatId: string } }
  ): Promise<Response> {
    const result = await auth(request, deps);
    if (!result.session) {
      return result.response;
    }

    const params = await context.params;
    let archived: boolean;
    try {
      archived = await deps.repository.archiveChat({
        chatId: params.chatId,
        userId: result.session.userId
      });
    } catch (error) {
      if (isActiveRunConflictError(error)) {
        return activeRunConflictJson();
      }
      throw error;
    }

    if (!archived) {
      return chatRouteErrorJson({ error: "chat_not_found" }, { status: 404 });
    }

    return Response.json({
      chat: {
        archived: true,
        id: params.chatId
      }
    });
  };
}

export function createCreateFolderHandler(deps: ChatHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const result = await auth(request, deps);
    if (!result.session) {
      return result.response;
    }

    const [body, bodyError] = await readJson(request);
    if (bodyError) {
      return bodyError;
    }
    const name = textValue(body?.name);
    if (!name) {
      return Response.json({ error: "folder_name_required" }, { status: 400 });
    }

    const folder = await deps.repository.createFolder({
      name,
      parentId: parentFolderValue(body),
      userId: result.session.userId
    });

    if (!folder) {
      return Response.json({ error: "folder_not_created" }, { status: 400 });
    }

    return Response.json({ folder }, { status: 201 });
  };
}

export function createDeleteFolderHandler(deps: ChatHandlerDeps) {
  return async function DELETE(
    request: Request,
    context: { params: Promise<{ folderId: string }> | { folderId: string } }
  ): Promise<Response> {
    const result = await auth(request, deps);
    if (!result.session) {
      return result.response;
    }

    const params = await context.params;
    const deleted = await deps.repository.deleteFolder({
      folderId: params.folderId,
      userId: result.session.userId
    });

    if (!deleted) {
      return Response.json({ error: "folder_not_found" }, { status: 404 });
    }

    return Response.json({
      folder: {
        deleted: true,
        id: params.folderId
      }
    });
  };
}

export function createUpdateFolderHandler(deps: ChatHandlerDeps) {
  return async function PATCH(
    request: Request,
    context: { params: Promise<{ folderId: string }> | { folderId: string } }
  ): Promise<Response> {
    const result = await auth(request, deps);
    if (!result.session) {
      return result.response;
    }

    const params = await context.params;
    const [body, bodyError] = await readJson(request);
    if (bodyError) {
      return bodyError;
    }
    const name = optionalTextValue(body, "name");
    const projectMemory = optionalTextValue(body, "projectMemory");
    const parentId = parentFolderValue(body);
    if (name === undefined && projectMemory === undefined && parentId === undefined) {
      return Response.json({ error: "folder_update_required" }, { status: 400 });
    }
    if (name !== undefined && !name) {
      return Response.json({ error: "folder_name_required" }, { status: 400 });
    }

    const folder = await deps.repository.updateFolder({
      folderId: params.folderId,
      name,
      parentId,
      projectMemory,
      userId: result.session.userId
    });

    if (!folder) {
      return Response.json({ error: "folder_not_found_or_duplicate" }, { status: 404 });
    }

    return Response.json({ folder });
  };
}

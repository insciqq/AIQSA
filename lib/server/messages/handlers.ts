import { textMessageContent } from "../../domain/content";
import type {
  ChatSummaryResponseWire,
  WorkspaceChatSummaryWire
} from "../../contracts/chats";
import type { RequestAuthResolver } from "../auth/requestAuth";
import {
  readJsonBodyOrNull,
  requestBodyErrorResponse
} from "../http/requestBody";

export type BranchMessageRecord = {
  chatId: string;
  content: unknown;
  createdAt?: Date | string;
  errorMessage?: string | null;
  id: string;
  modelId: string | null;
  parentMessageId: string | null;
  provider: string | null;
  role: string;
  status: string;
};

export type BranchChatRecord = {
  activeLeafMessageId: string | null;
  createdAt: Date | string;
  defaultModelId: string | null;
  defaultPromptPresetId: string | null;
  defaultProvider: string | null;
  folderId: string | null;
  id: string;
  messageCount: number;
  pinned: boolean;
  title: string;
  updatedAt: Date | string;
};

export class ActiveMessageMutationConflictError extends Error {
  run: { id: string | null; status: string } | null;

  constructor(run: { id: string | null; status: string } | null = null) {
    super("active_run_in_progress");
    this.name = "ActiveMessageMutationConflictError";
    this.run = run;
  }
}

export type MessageBranchRepository = {
  createChatBranchFromMessage(input: {
    sourceMessageId: string;
    userId: string;
  }): Promise<BranchChatRecord | null>;
  createEditedMessageBranch(input: {
    content: { blocks: unknown[] };
    originalMessageId: string;
    userId: string;
  }): Promise<BranchMessageRecord | null>;
  deleteMessageSubtree(input: {
    messageId: string;
    userId: string;
  }): Promise<{
    activeLeafMessageId: string | null;
    chatId: string;
    deletedMessageIds: string[];
  } | null>;
};

export type MessageBranchHandlerDeps = {
  repository: MessageBranchRepository;
  resolveAuth: RequestAuthResolver;
};

async function readJson(
  request: Request
): Promise<readonly [Record<string, unknown> | null, Response | null]> {
  const value = await readJsonBodyOrNull(request, "json");
  return [
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null,
    requestBodyErrorResponse(value)
  ];
}

function normalizeContent(body: Record<string, unknown> | null): { blocks: unknown[] } {
  if (typeof body?.content === "object" && body.content && "blocks" in body.content) {
    const blocks = (body.content as { blocks?: unknown }).blocks;
    if (Array.isArray(blocks)) {
      return { blocks };
    }
  }

  if (typeof body?.text === "string") {
    return textMessageContent(body.text);
  }

  return { blocks: [] };
}

function serializeMessage(message: BranchMessageRecord) {
  return {
    chatId: message.chatId,
    content: message.content,
    createdAt: message.createdAt instanceof Date ? message.createdAt.toISOString() : message.createdAt,
    errorMessage: message.errorMessage ?? null,
    id: message.id,
    modelId: message.modelId,
    parentMessageId: message.parentMessageId,
    provider: message.provider,
    role: message.role,
    status: message.status
  };
}

function serializeChatSummary(chat: BranchChatRecord): WorkspaceChatSummaryWire {
  return {
    activeLeafMessageId: chat.activeLeafMessageId,
    createdAt: chat.createdAt instanceof Date ? chat.createdAt.toISOString() : chat.createdAt,
    defaultModelId: chat.defaultModelId,
    defaultPromptPresetId: chat.defaultPromptPresetId,
    defaultProvider: chat.defaultProvider,
    folderId: chat.folderId,
    id: chat.id,
    messageCount: chat.messageCount,
    pinned: chat.pinned,
    title: chat.title,
    updatedAt: chat.updatedAt instanceof Date ? chat.updatedAt.toISOString() : chat.updatedAt
  };
}

function isActiveMessageMutationConflictError(error: unknown): error is ActiveMessageMutationConflictError {
  return (
    error instanceof ActiveMessageMutationConflictError ||
    (error instanceof Error && error.name === "ActiveMessageMutationConflictError")
  );
}

function activeMutationConflictResponse(error: ActiveMessageMutationConflictError): Response {
  return Response.json(
    {
      error: "active_run_in_progress",
      ...(error.run
        ? {
            run: {
              id: error.run.id,
              status: error.run.status
            }
          }
        : {})
    },
    { status: 409 }
  );
}

async function getSession(request: Request, deps: MessageBranchHandlerDeps) {
  const session = await deps.resolveAuth(request);
  if (!session) {
    return {
      response: Response.json({ error: "unauthorized" }, { status: 401 }),
      session: null
    };
  }

  return {
    response: null,
    session
  };
}

export function createEditMessageBranchHandler(deps: MessageBranchHandlerDeps) {
  return async function PATCH(
    request: Request,
    context: { params: Promise<{ messageId: string }> | { messageId: string } }
  ): Promise<Response> {
    const auth = await getSession(request, deps);
    if (!auth.session) {
      return auth.response;
    }

    const [body, bodyError] = await readJson(request);
    if (bodyError) {
      return bodyError;
    }
    const content = normalizeContent(body);
    if (content.blocks.length === 0) {
      return Response.json({ error: "content_required" }, { status: 400 });
    }

    const params = await context.params;
    let message: BranchMessageRecord | null;
    try {
      message = await deps.repository.createEditedMessageBranch({
        content,
        originalMessageId: params.messageId,
        userId: auth.session.userId
      });
    } catch (error) {
      if (isActiveMessageMutationConflictError(error)) {
        return activeMutationConflictResponse(error);
      }

      throw error;
    }

    if (!message) {
      return Response.json({ error: "message_not_found_or_not_editable" }, { status: 404 });
    }

    return Response.json({
      message: serializeMessage(message)
    });
  };
}

export function createBranchChatFromMessageHandler(deps: MessageBranchHandlerDeps) {
  return async function POST(
    request: Request,
    context: { params: Promise<{ messageId: string }> | { messageId: string } }
  ): Promise<Response> {
    const auth = await getSession(request, deps);
    if (!auth.session) {
      return auth.response;
    }

    const params = await context.params;
    let chat: BranchChatRecord | null;
    try {
      chat = await deps.repository.createChatBranchFromMessage({
        sourceMessageId: params.messageId,
        userId: auth.session.userId
      });
    } catch (error) {
      if (isActiveMessageMutationConflictError(error)) {
        return activeMutationConflictResponse(error);
      }

      throw error;
    }

    if (!chat) {
      return Response.json({ error: "message_not_found_or_not_branchable" }, { status: 404 });
    }

    return Response.json(
      {
        chat: serializeChatSummary(chat)
      } satisfies ChatSummaryResponseWire,
      { status: 201 }
    );
  };
}

export function createDeleteMessageHandler(deps: MessageBranchHandlerDeps) {
  return async function DELETE(
    request: Request,
    context: { params: Promise<{ messageId: string }> | { messageId: string } }
  ): Promise<Response> {
    const auth = await getSession(request, deps);
    if (!auth.session) {
      return auth.response;
    }

    const params = await context.params;
    let deleted: {
      activeLeafMessageId: string | null;
      chatId: string;
      deletedMessageIds: string[];
    } | null;
    try {
      deleted = await deps.repository.deleteMessageSubtree({
        messageId: params.messageId,
        userId: auth.session.userId
      });
    } catch (error) {
      if (isActiveMessageMutationConflictError(error)) {
        return activeMutationConflictResponse(error);
      }

      throw error;
    }

    if (!deleted) {
      return Response.json({ error: "message_not_found" }, { status: 404 });
    }

    return Response.json({
      message: {
        activeLeafMessageId: deleted.activeLeafMessageId,
        chatId: deleted.chatId,
        deleted: true,
        deletedMessageIds: deleted.deletedMessageIds,
        id: params.messageId
      }
    });
  };
}

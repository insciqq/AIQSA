import { shellFetch } from "@/components/app-shell/shellApi";
import {
  decodeArchivedChatDetailResponse,
  decodeArchivedChatsResponse,
  decodeChatLifecycleResponse,
  decodeChatMemoryStateResponse,
  decodeChatMessagesPageResponse,
  decodeChatSourceResolutionResponse,
  type ArchivedChatDetailResponseWire,
  type ArchivedChatsResponseWire,
  type ChatLifecycleResponseWire,
  type ChatMemoryStateResponseWire,
  type ChatMessagesPageWire,
  type ChatSourceResolutionResponseWire
} from "@/lib/contracts/chats";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  decodeMemoryChatModeResponse,
  type MemoryChatModeResponse,
  type MemorySettingsResponse
} from "@/lib/contracts/memory";

export class ChatLifecycleApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = "ChatLifecycleApiError";
    this.code = code;
    this.status = status;
  }
}

async function body(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorCode(value: unknown): string {
  return value && typeof value === "object" && !Array.isArray(value) &&
    typeof (value as { error?: unknown }).error === "string"
    ? (value as { error: string }).error
    : "chat_lifecycle_failed";
}

async function request<T>(
  path: string,
  init: RequestInit,
  decode: (value: unknown) => T | null
): Promise<T> {
  const response = await shellFetch(path, {
    cache: "no-store",
    credentials: "same-origin",
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers
    }
  });
  const value = await body(response);
  if (!response.ok) throw new ChatLifecycleApiError(errorCode(value), response.status);
  const decoded = decode(value);
  if (!decoded) throw new ChatLifecycleApiError("chat_lifecycle_response_invalid", 502);
  return decoded;
}

export function listArchivedChats(
  cursor: string | null = null,
  signal?: AbortSignal
): Promise<ArchivedChatsResponseWire> {
  const query = new URLSearchParams();
  if (cursor) query.set("cursor", cursor);
  const suffix = query.size ? `?${query.toString()}` : "";
  return request(`/api/chats/archived${suffix}`, { method: "GET", signal }, decodeArchivedChatsResponse);
}

export function loadArchivedChat(
  chatId: string,
  signal?: AbortSignal
): Promise<ArchivedChatDetailResponseWire> {
  return request(
    `/api/chats/${encodeURIComponent(chatId)}/archive`,
    { method: "GET", signal },
    decodeArchivedChatDetailResponse
  );
}

export function loadArchivedMessages(
  chatId: string,
  before: string,
  signal?: AbortSignal
): Promise<ChatMessagesPageWire> {
  const query = new URLSearchParams({ before });
  return request(
    `/api/chats/${encodeURIComponent(chatId)}/archive/messages?${query.toString()}`,
    { method: "GET", signal },
    decodeChatMessagesPageResponse
  );
}

export function resolveChatSource(
  chatId: string,
  signal?: AbortSignal
): Promise<ChatSourceResolutionResponseWire> {
  return request(
    `/api/chats/${encodeURIComponent(chatId)}/source`,
    { method: "GET", signal },
    decodeChatSourceResolutionResponse
  );
}

export function loadChatMemoryState(
  chatId: string,
  signal?: AbortSignal
): Promise<ChatMemoryStateResponseWire> {
  return request(
    `/api/me/chats/${encodeURIComponent(chatId)}/memory-mode`,
    { method: "GET", signal },
    decodeChatMemoryStateResponse
  );
}

function lifecycleMutation(
  chatId: string,
  operation: "archive" | "restore",
  expectedChatRevision: number
): Promise<ChatLifecycleResponseWire> {
  return request(
    `/api/chats/${encodeURIComponent(chatId)}/${operation}`,
    { body: JSON.stringify({ expectedChatRevision }), method: "POST" },
    decodeChatLifecycleResponse
  );
}

export function archiveChat(chatId: string, expectedChatRevision: number) {
  return lifecycleMutation(chatId, "archive", expectedChatRevision);
}

export function restoreChat(chatId: string, expectedChatRevision: number) {
  return lifecycleMutation(chatId, "restore", expectedChatRevision);
}

export function patchChatMemoryMode(input: Readonly<{
  chatId: string;
  expectedChatRevision: number;
  mode: "NORMAL" | "EXCLUDED";
  settings: MemorySettingsResponse;
}>): Promise<MemoryChatModeResponse> {
  return request(
    `/api/me/chats/${encodeURIComponent(input.chatId)}/memory-mode`,
    {
      body: JSON.stringify({
        expectedChatRevision: input.expectedChatRevision,
        expectedMemoryRevision: input.settings.settings.memoryRevision,
        mode: input.mode,
        ...(input.mode === "NORMAL"
          ? { resumeDisclosureCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION }
          : {})
      }),
      method: "PATCH"
    },
    (value) => {
      const decoded = decodeMemoryChatModeResponse(value);
      return decoded.ok ? decoded.value : null;
    }
  );
}

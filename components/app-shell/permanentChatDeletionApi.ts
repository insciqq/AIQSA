import { loadArchivedChat, loadChatMemoryState } from "@/components/app-shell/chatLifecycleApi";
import { shellFetch } from "@/components/app-shell/shellApi";
import {
  decodeChatDetailResponse,
  decodeChatPermanentDeleteAdmissionResponse,
  decodeChatPermanentDeleteAuthorizationResponse,
  decodeChatPermanentDeleteStatusResponse,
  type ChatPermanentDeleteAdmissionResponseWire,
  type ChatPermanentDeleteAuthorizationRequestWire,
  type ChatPermanentDeleteAuthorizationResponseWire,
  type ChatPermanentDeleteRequestWire,
  type ChatPermanentDeleteStatusResponseWire
} from "@/lib/contracts/chats";

export class PermanentChatDeletionApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.name = "PermanentChatDeletionApiError";
    this.status = status;
  }
}

export type PermanentChatDeletionSnapshot = Readonly<{
  chatId: string;
  expectedActiveLeafMessageId: string | null;
  expectedChatRevision: number;
  location: "ARCHIVED" | "WORKSPACE";
  title: string;
}>;

async function responseBody(response: Response): Promise<unknown> {
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
    : "chat_permanent_delete_failed";
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
  const value = await responseBody(response);
  if (!response.ok) {
    throw new PermanentChatDeletionApiError(errorCode(value), response.status);
  }
  const decoded = decode(value);
  if (!decoded) {
    throw new PermanentChatDeletionApiError(
      "chat_permanent_delete_response_invalid",
      502
    );
  }
  return decoded;
}

export async function loadPermanentChatDeletionSnapshot(
  chatId: string,
  signal?: AbortSignal
): Promise<PermanentChatDeletionSnapshot> {
  const lifecycle = await loadChatMemoryState(chatId, signal);
  if (lifecycle.chat.mode === "TEMPORARY") {
    throw new PermanentChatDeletionApiError(
      "chat_permanent_delete_temporary_forbidden",
      409
    );
  }
  if (lifecycle.chat.archived) {
    const archived = await loadArchivedChat(chatId, signal);
    return {
      chatId,
      expectedActiveLeafMessageId: archived.chat.activeLeafMessageId,
      expectedChatRevision: lifecycle.chat.sourceRevision,
      location: "ARCHIVED",
      title: archived.chat.title
    };
  }
  const detail = await request(
    `/api/chats/${encodeURIComponent(chatId)}`,
    { method: "GET", signal },
    decodeChatDetailResponse
  );
  return {
    chatId,
    expectedActiveLeafMessageId: detail.activeLeafMessageId,
    expectedChatRevision: lifecycle.chat.sourceRevision,
    location: "WORKSPACE",
    title: detail.title
  };
}

export function authorizePermanentChatDeletion(
  chatId: string,
  input: ChatPermanentDeleteAuthorizationRequestWire,
  signal?: AbortSignal
): Promise<ChatPermanentDeleteAuthorizationResponseWire> {
  return request(
    `/api/chats/${encodeURIComponent(chatId)}/delete-permanently/authorization`,
    { body: JSON.stringify(input), method: "POST", signal },
    decodeChatPermanentDeleteAuthorizationResponse
  );
}

export function admitPermanentChatDeletion(
  chatId: string,
  input: ChatPermanentDeleteRequestWire,
  signal?: AbortSignal
): Promise<ChatPermanentDeleteAdmissionResponseWire> {
  return request(
    `/api/chats/${encodeURIComponent(chatId)}/delete-permanently`,
    { body: JSON.stringify(input), method: "POST", signal },
    decodeChatPermanentDeleteAdmissionResponse
  );
}

export function loadPermanentChatDeletionStatus(
  chatId: string,
  deletionId: string,
  signal?: AbortSignal
): Promise<ChatPermanentDeleteStatusResponseWire> {
  const query = new URLSearchParams({ deletionId });
  return request(
    `/api/chats/${encodeURIComponent(chatId)}/delete-permanently/status?${query.toString()}`,
    { method: "GET", signal },
    decodeChatPermanentDeleteStatusResponse
  );
}

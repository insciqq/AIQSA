import { shellFetch } from "@/components/app-shell/shellApi";
import {
  SUBAGENT_API_PATHS,
  SUBAGENT_NOT_FOUND,
  decodeSubagentChatThreads,
  decodeSubagentStopAllResponse,
  decodeSubagentStopResponse,
  decodeSubagentSummaryResponse,
  decodeSubagentThreadView,
  type SubagentChatThreads,
  type SubagentStopAllResponse,
  type SubagentStopResponse,
  type SubagentSummaryResponse,
  type SubagentThreadView
} from "@/lib/contracts/subagentViews";

/** A refused or unreadable sub-agent request; `code` is the route's stable code or a client one. */
export class SubagentApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = "SubagentApiError";
    this.code = code;
    this.status = status;
  }

  /** Missing, another user's, pending deletion or off the active branch: all one answer. */
  get notFound(): boolean {
    return this.code === SUBAGENT_NOT_FOUND.error || this.status === SUBAGENT_NOT_FOUND.status;
  }
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorCode(value: unknown): string {
  return value && typeof value === "object" && !Array.isArray(value) &&
    typeof (value as { error?: unknown }).error === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test((value as { error: string }).error)
    ? (value as { error: string }).error
    : "subagent_request_failed";
}

async function request<T>(path: string, init: RequestInit, decode: (value: unknown) => T | null): Promise<T> {
  const response = await shellFetch(path, {
    cache: "no-store",
    credentials: "same-origin",
    ...init,
    headers: { accept: "application/json", ...init.headers }
  });
  const value = await readBody(response);
  if (!response.ok) throw new SubagentApiError(errorCode(value), response.status);
  const decoded = decode(value);
  // A malformed response fails visibly; it never becomes guessed state.
  if (!decoded) throw new SubagentApiError("subagent_response_invalid", 502);
  return decoded;
}

export function loadSubagentSummary(chatIds: readonly string[], signal?: AbortSignal): Promise<SubagentSummaryResponse> {
  const requested = new Set(chatIds);
  return request(SUBAGENT_API_PATHS.summary(chatIds), { method: "GET", signal }, (value) => {
    const decoded = decodeSubagentSummaryResponse(value);
    return decoded && decoded.chats.every((chat) => requested.has(chat.chatId)) ? decoded : null;
  });
}

export function loadChatSubagents(chatId: string, signal?: AbortSignal): Promise<SubagentChatThreads> {
  return request(SUBAGENT_API_PATHS.chatThreads(chatId), { method: "GET", signal }, (value) => {
    const decoded = decodeSubagentChatThreads(value);
    return decoded?.chatId === chatId ? decoded : null;
  });
}

export function loadSubagentThread(chatId: string, threadId: string, signal?: AbortSignal): Promise<SubagentThreadView> {
  return request(SUBAGENT_API_PATHS.thread(chatId, threadId), { method: "GET", signal }, (value) => {
    const decoded = decodeSubagentThreadView(value);
    return decoded?.chatId === chatId && decoded.thread.id === threadId ? decoded : null;
  });
}

export function stopSubagentThread(chatId: string, threadId: string): Promise<SubagentStopResponse> {
  return request(SUBAGENT_API_PATHS.stopThread(chatId, threadId), { method: "POST" }, (value) => {
    const decoded = decodeSubagentStopResponse(value);
    return decoded?.thread.id === threadId ? decoded : null;
  });
}

export function stopAllChatSubagents(chatId: string): Promise<SubagentStopAllResponse> {
  return request(SUBAGENT_API_PATHS.stopAll(chatId), { method: "POST" }, decodeSubagentStopAllResponse);
}

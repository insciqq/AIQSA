import { shellFetch } from "@/components/app-shell/shellApi";
import {
  decodeMemoryConsumerPermanentChatDeleteResponse,
  type MemoryConsumerPermanentChatDeleteInput,
  type MemoryConsumerPermanentChatDeleteResponse
} from "@/lib/contracts/memoryClient";

export class PermanentChatDeletionApiError extends Error {
  readonly reason: PermanentChatDeletionFailureReason;
  readonly status: number;

  constructor(reason: PermanentChatDeletionFailureReason, status: number) {
    super(reason);
    this.reason = reason;
    this.name = "PermanentChatDeletionApiError";
    this.status = status;
  }
}

export type PermanentChatDeletionFailureReason =
  | "BUSY"
  | "CHANGED"
  | "FAILED"
  | "UNAVAILABLE";

export type PermanentChatDeletionSnapshot = Readonly<{
  chatId: string;
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

function failureReason(value: unknown): PermanentChatDeletionFailureReason {
  const code = value && typeof value === "object" && !Array.isArray(value) &&
    typeof (value as { error?: unknown }).error === "string"
    ? (value as { error: string }).error
    : null;
  switch (code) {
    case "BUSY": return "BUSY";
    case "CHANGED": return "CHANGED";
    case "UNAVAILABLE": return "UNAVAILABLE";
    default:
      return "FAILED";
  }
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
    throw new PermanentChatDeletionApiError(failureReason(value), response.status);
  }
  const decoded = decode(value);
  if (!decoded) {
    throw new PermanentChatDeletionApiError(
      "FAILED",
      502
    );
  }
  return decoded;
}

export function admitPermanentChatDeletion(
  chatId: string,
  input: MemoryConsumerPermanentChatDeleteInput,
  signal?: AbortSignal
): Promise<MemoryConsumerPermanentChatDeleteResponse> {
  return request(
    `/api/chats/${encodeURIComponent(chatId)}/delete-permanently`,
    { body: JSON.stringify(input), method: "POST", signal },
    (value) => {
      const decoded = decodeMemoryConsumerPermanentChatDeleteResponse(value);
      return decoded.ok ? decoded.value : null;
    }
  );
}

export function loadPermanentChatDeletionStatus(
  chatId: string,
  signal?: AbortSignal
): Promise<MemoryConsumerPermanentChatDeleteResponse> {
  return request(
    `/api/chats/${encodeURIComponent(chatId)}/delete-permanently/status`,
    { method: "GET", signal },
    (value) => {
      const decoded = decodeMemoryConsumerPermanentChatDeleteResponse(value);
      return decoded.ok ? decoded.value : null;
    }
  );
}

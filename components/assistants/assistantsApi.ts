import { shellFetch } from "@/components/app-shell/shellApi";
import {
  decodeAssistantDetailResponse,
  decodeAssistantListResponse,
  decodeAssistantRevisionResponse,
  decodeAssistantRevisionsResponse,
  type AssistantDetail,
  type AssistantDraft,
  type AssistantListResponse,
  type AssistantRevisionContent,
  type AssistantRevisionHistoryEntry
} from "@/lib/contracts/assistants";

export type AssistantApiResult<T> =
  | { data: T; ok: true }
  | { code: string; message: string; ok: false };

async function errorResult(response: Response): Promise<{ code: string; message: string; ok: false }> {
  let code = "assistant_request_failed";
  let message = "The assistant request could not be completed.";
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const record = body as Record<string, unknown>;
      if (typeof record.error === "string" && record.error) {
        code = record.error;
      }
      if (typeof record.message === "string" && record.message) {
        message = record.message;
      }
    }
  } catch {
    // The stable fallback code above covers unreadable bodies.
  }
  return { code, message, ok: false };
}

function decodeFailure<T>(): AssistantApiResult<T> {
  return {
    code: "assistant_response_invalid",
    message: "The assistant response could not be read. Refresh and try again.",
    ok: false
  };
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
  decode: (value: unknown) => T | null
): Promise<AssistantApiResult<T>> {
  let response: Response;
  try {
    response = await shellFetch(url, init);
  } catch {
    return {
      code: "network_unavailable",
      message: "The assistant request could not reach the server.",
      ok: false
    };
  }
  if (!response.ok) {
    return errorResult(response);
  }
  if (response.status === 204) {
    return { data: undefined as T, ok: true };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return decodeFailure<T>();
  }
  const decoded = decode(payload);
  return decoded === null ? decodeFailure<T>() : { data: decoded, ok: true };
}

const jsonHeaders = { "content-type": "application/json" } as const;

export function fetchAssistantList(): Promise<AssistantApiResult<AssistantListResponse>> {
  return requestJson("/api/me/assistants", { method: "GET" }, decodeAssistantListResponse);
}

export function fetchAssistantDetail(
  assistantId: string
): Promise<AssistantApiResult<AssistantDetail>> {
  return requestJson(
    `/api/me/assistants/${encodeURIComponent(assistantId)}`,
    { method: "GET" },
    (value) => decodeAssistantDetailResponse(value)?.assistant ?? null
  );
}

export function createAssistant(
  draft: AssistantDraft
): Promise<AssistantApiResult<AssistantDetail>> {
  return requestJson(
    "/api/me/assistants",
    { body: JSON.stringify(draft), headers: jsonHeaders, method: "POST" },
    (value) => decodeAssistantDetailResponse(value)?.assistant ?? null
  );
}

export function reviseAssistant(
  assistantId: string,
  expectedVersion: number,
  draft: AssistantDraft
): Promise<AssistantApiResult<AssistantDetail>> {
  return requestJson(
    `/api/me/assistants/${encodeURIComponent(assistantId)}`,
    {
      body: JSON.stringify({ expectedVersion, revision: draft }),
      headers: jsonHeaders,
      method: "PATCH"
    },
    (value) => decodeAssistantDetailResponse(value)?.assistant ?? null
  );
}

export function setAssistantArchived(
  assistantId: string,
  expectedVersion: number,
  archived: boolean
): Promise<AssistantApiResult<AssistantDetail>> {
  return requestJson(
    `/api/me/assistants/${encodeURIComponent(assistantId)}`,
    {
      body: JSON.stringify({ archived, expectedVersion }),
      headers: jsonHeaders,
      method: "PATCH"
    },
    (value) => decodeAssistantDetailResponse(value)?.assistant ?? null
  );
}

export function duplicateAssistant(
  assistantId: string
): Promise<AssistantApiResult<AssistantDetail>> {
  return requestJson(
    `/api/me/assistants/${encodeURIComponent(assistantId)}/duplicate`,
    { method: "POST" },
    (value) => decodeAssistantDetailResponse(value)?.assistant ?? null
  );
}

export function fetchAssistantRevisions(
  assistantId: string
): Promise<AssistantApiResult<AssistantRevisionHistoryEntry[]>> {
  return requestJson(
    `/api/me/assistants/${encodeURIComponent(assistantId)}/revisions`,
    { method: "GET" },
    (value) => decodeAssistantRevisionsResponse(value)?.revisions ?? null
  );
}

export function fetchAssistantRevision(
  assistantId: string,
  revisionNumber: number
): Promise<AssistantApiResult<AssistantRevisionContent>> {
  return requestJson(
    `/api/me/assistants/${encodeURIComponent(assistantId)}/revisions/${revisionNumber}`,
    { method: "GET" },
    (value) => decodeAssistantRevisionResponse(value)?.revision ?? null
  );
}

export function publishAssistant(
  assistantId: string,
  input: { groupId?: string; revisionNumber?: number; scope: "group" | "installation" }
): Promise<AssistantApiResult<undefined>> {
  return requestJson(
    `/api/me/assistants/${encodeURIComponent(assistantId)}/publications`,
    { body: JSON.stringify(input), headers: jsonHeaders, method: "POST" },
    () => undefined as undefined
  );
}

export function revokeAssistantPublication(
  assistantId: string,
  publicationId: string
): Promise<AssistantApiResult<undefined>> {
  return requestJson(
    `/api/me/assistants/${encodeURIComponent(assistantId)}/publications/${encodeURIComponent(publicationId)}`,
    { method: "DELETE" },
    () => undefined as undefined
  );
}

export function setAssistantPinned(
  assistantId: string,
  pinned: boolean
): Promise<AssistantApiResult<undefined>> {
  return requestJson(
    `/api/me/assistants/${encodeURIComponent(assistantId)}/pin`,
    { method: pinned ? "PUT" : "DELETE" },
    () => undefined as undefined
  );
}

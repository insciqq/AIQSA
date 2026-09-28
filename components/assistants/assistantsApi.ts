import { shellFetch } from "@/components/app-shell/shellApi";
import {
  ASSISTANT_RUN_CONTROL_FIELDS,
  decodeAssistantDetailResponse,
  decodeAssistantDuplicateResponse,
  decodeAssistantListResponse,
  decodeAssistantRowKey,
  type AssistantDetail,
  type AssistantDraft,
  type AssistantDuplicateResponse,
  type AssistantListResponse,
  type AssistantRowKey,
  type AssistantRunControlField
} from "@/lib/contracts/assistants";
import {
  decodeAssistantDeletionConsequencesResponse,
  type AssistantDeletionConsequences
} from "@/lib/contracts/assistantDeletion";
import {
  ASSISTANT_FEATURED_LIMIT,
  decodeAssistantListingStatusResponse,
  type AssistantListingStatus
} from "@/lib/contracts/assistantListing";
import type { AdminAssistantFeaturedResponse } from "@/lib/contracts/adminAssistants";

export type AssistantApiResult<T> =
  | { data: T; ok: true }
  | {
      code: string;
      field?: AssistantRunControlField;
      limit?: number;
      message: string;
      ok: false;
      /** The setup row a draft error belongs to. */
      row?: AssistantRowKey;
      /** Names of the Skills that block an audience (`assistant_skill_audience_mismatch`). */
      skills?: string[];
      status?: number;
    };

const MAX_BLOCKING_SKILL_NAMES = 64;

async function errorResult(
  response: Response
): Promise<Extract<AssistantApiResult<never>, { ok: false }>> {
  let code = "assistant_request_failed";
  let field: AssistantRunControlField | undefined;
  let limit: number | undefined;
  let row: AssistantRowKey | undefined;
  let skills: string[] | undefined;
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
      if (
        typeof record.field === "string" &&
        ASSISTANT_RUN_CONTROL_FIELDS.includes(record.field as AssistantRunControlField)
      ) {
        field = record.field as AssistantRunControlField;
      }
      if (field && typeof record.limit === "number" && Number.isFinite(record.limit)) {
        limit = record.limit;
      }
      row = decodeAssistantRowKey(record.row) ?? undefined;
      if (Array.isArray(record.skills)) {
        skills = record.skills
          .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
          .slice(0, MAX_BLOCKING_SKILL_NAMES);
      }
    }
  } catch {
    // The stable fallback code above covers unreadable bodies.
  }
  return {
    code,
    ...(field ? { field } : {}),
    ...(limit !== undefined ? { limit } : {}),
    message,
    ok: false,
    ...(row ? { row } : {}),
    ...(skills?.length ? { skills } : {}),
    status: response.status
  };
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

function assistantPath(assistantId: string, suffix = ""): string {
  return `/api/me/assistants/${encodeURIComponent(assistantId)}${suffix}`;
}

const detailOf = (value: unknown) => decodeAssistantDetailResponse(value)?.assistant ?? null;

export function fetchAssistantList(): Promise<AssistantApiResult<AssistantListResponse>> {
  return requestJson("/api/me/assistants", { method: "GET" }, decodeAssistantListResponse);
}

export function fetchAssistantDetail(
  assistantId: string
): Promise<AssistantApiResult<AssistantDetail>> {
  return requestJson(assistantPath(assistantId), { method: "GET" }, detailOf);
}

export function createAssistant(
  draft: AssistantDraft
): Promise<AssistantApiResult<AssistantDetail>> {
  return requestJson(
    "/api/me/assistants",
    { body: JSON.stringify(draft), headers: jsonHeaders, method: "POST" },
    detailOf
  );
}

export function updateAssistant(
  assistantId: string,
  expectedVersion: number,
  draft: AssistantDraft
): Promise<AssistantApiResult<AssistantDetail>> {
  return requestJson(
    assistantPath(assistantId),
    {
      body: JSON.stringify({ expectedVersion, content: draft }),
      headers: jsonHeaders,
      method: "PATCH"
    },
    detailOf
  );
}

export function setAssistantArchived(
  assistantId: string,
  expectedVersion: number,
  archived: boolean
): Promise<AssistantApiResult<AssistantDetail>> {
  return requestJson(
    assistantPath(assistantId),
    {
      body: JSON.stringify({ archived, expectedVersion }),
      headers: jsonHeaders,
      method: "PATCH"
    },
    detailOf
  );
}

/** The copy plus the rows downgraded because the copier cannot use their resources. */
export function duplicateAssistant(
  assistantId: string
): Promise<AssistantApiResult<AssistantDuplicateResponse>> {
  return requestJson(
    assistantPath(assistantId, "/duplicate"),
    { method: "POST" },
    decodeAssistantDuplicateResponse
  );
}

export function fetchAssistantDeletionConsequences(
  assistantId: string
): Promise<AssistantApiResult<AssistantDeletionConsequences>> {
  return requestJson(
    assistantPath(assistantId, "/consequences"),
    { method: "GET" },
    (value) => decodeAssistantDeletionConsequencesResponse(value)?.consequences ?? null
  );
}

/** Send the `version` of the consequences the owner confirmed. */
export function deleteAssistant(
  assistantId: string,
  expectedVersion: number
): Promise<AssistantApiResult<undefined>> {
  return requestJson(
    assistantPath(assistantId),
    { body: JSON.stringify({ expectedVersion }), headers: jsonHeaders, method: "DELETE" },
    () => undefined as undefined
  );
}

export function publishAssistant(
  assistantId: string,
  input: { groupId?: string; scope: "group" | "installation" }
): Promise<AssistantApiResult<undefined>> {
  return requestJson(
    assistantPath(assistantId, "/publications"),
    { body: JSON.stringify(input), headers: jsonHeaders, method: "POST" },
    () => undefined as undefined
  );
}

export function revokeAssistantPublication(
  assistantId: string,
  publicationId: string
): Promise<AssistantApiResult<undefined>> {
  return requestJson(
    assistantPath(assistantId, `/publications/${encodeURIComponent(publicationId)}`),
    { method: "DELETE" },
    () => undefined as undefined
  );
}

export function setAssistantPinned(
  assistantId: string,
  pinned: boolean
): Promise<AssistantApiResult<undefined>> {
  return requestJson(
    assistantPath(assistantId, "/pin"),
    { method: pinned ? "PUT" : "DELETE" },
    () => undefined as undefined
  );
}

const listingOf = (value: unknown) => decodeAssistantListingStatusResponse(value)?.listing ?? null;

/** Asks an administrator to list this exact definition version for everyone. */
export function requestAssistantListing(
  assistantId: string,
  expectedVersion: number
): Promise<AssistantApiResult<AssistantListingStatus>> {
  return requestJson(
    assistantPath(assistantId, "/listing-requests"),
    { body: JSON.stringify({ expectedVersion }), headers: jsonHeaders, method: "POST" },
    listingOf
  );
}

export function withdrawAssistantListingRequest(
  assistantId: string,
  requestId: string
): Promise<AssistantApiResult<AssistantListingStatus>> {
  return requestJson(
    assistantPath(assistantId, `/listing-requests/${encodeURIComponent(requestId)}`),
    { method: "DELETE" },
    listingOf
  );
}

function decodeFeaturedOrder(value: unknown): AdminAssistantFeaturedResponse["featured"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const featured = (value as Record<string, unknown>).featured;
  if (!Array.isArray(featured)) return null;
  const entries: AdminAssistantFeaturedResponse["featured"] = [];
  for (const entry of featured) {
    if (!entry || typeof entry !== "object") return null;
    const { assistantId, featuredOrder } = entry as Record<string, unknown>;
    if (
      typeof assistantId !== "string" || !assistantId ||
      !Number.isSafeInteger(featuredOrder) || Number(featuredOrder) < 0 ||
      Number(featuredOrder) >= ASSISTANT_FEATURED_LIMIT
    ) {
      return null;
    }
    entries.push({ assistantId, featuredOrder: Number(featuredOrder) });
  }
  return entries;
}

/**
 * Administrators only: the Studio Sharing sheet's Featured control. The app
 * shell may not depend on the Control Center client, so Studio keeps this
 * small call of its own. Null removes the Assistant from Featured.
 */
export function setAssistantFeaturedOrder(
  assistantId: string,
  order: number | null
): Promise<AssistantApiResult<AdminAssistantFeaturedResponse["featured"]>> {
  return requestJson(
    `/api/admin/assistants/${encodeURIComponent(assistantId)}/featured`,
    { body: JSON.stringify({ order }), headers: jsonHeaders, method: "POST" },
    decodeFeaturedOrder
  );
}

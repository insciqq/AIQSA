import { shellFetch } from "@/components/app-shell/shellApi";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  decodeMemoryDeletionStatus,
  decodeMemoryErrorResponse,
  decodeMemoryEvidenceResponse,
  decodeMemoryListResponse,
  decodeMemoryMutationAuthorizationResponse,
  decodeMemoryMutationResponse,
  decodeMemorySettingsResponse,
  type MemoryBulkDeleteInput,
  type MemoryConsentInput,
  type MemoryCreateInput,
  type MemoryDeletionStatus,
  type MemoryEvidenceResponse,
  type MemoryForgetInput,
  type MemoryListResponse,
  type MemoryFactState,
  type MemoryScopeSelection,
  type MemoryMutationAuthorizationInput,
  type MemoryMutationAuthorizationResponse,
  type MemoryMutationResponse,
  type MemorySettingsPatch,
  type MemorySettingsResponse,
  type MemoryUpdateInput
} from "@/lib/contracts/memory";

export class MemoryApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = "MemoryApiError";
    this.code = code;
    this.status = status;
  }
}

type MemoryMutationAuthorizationIntent =
  MemoryMutationAuthorizationInput extends infer T
    ? T extends MemoryMutationAuthorizationInput
      ? Omit<T, "confirmationCopyVersion" | "requestNonce">
      : never
    : never;

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorCode(value: unknown): string {
  const decoded = decodeMemoryErrorResponse(value);
  if (decoded) return decoded.error;
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "error" in value &&
    (value as { error?: unknown }).error === "unauthorized"
  ) {
    return "unauthorized";
  }
  return "memory_action_failed";
}

async function memoryRequest<T>(
  path: string,
  init: RequestInit,
  decode: (value: unknown) => Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>
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
  const body = await responseJson(response);
  if (!response.ok) throw new MemoryApiError(errorCode(body), response.status);
  const decoded = decode(body);
  if (!decoded.ok) throw new MemoryApiError("memory_response_invalid", 502);
  return decoded.value;
}

function nonce(): string {
  if (!globalThis.crypto?.getRandomValues) {
    throw new MemoryApiError("memory_client_crypto_unavailable", 500);
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function memoryStatementHash(statement: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new MemoryApiError("memory_client_crypto_unavailable", 500);
  }
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(statement)
  );
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0")
  ).join("");
}

export async function loadMemorySettings(signal?: AbortSignal): Promise<MemorySettingsResponse> {
  return memoryRequest(
    "/api/me/memory/settings",
    { method: "GET", signal },
    decodeMemorySettingsResponse
  );
}

export async function patchMemorySettings(
  body: MemorySettingsPatch
): Promise<MemorySettingsResponse> {
  return memoryRequest(
    "/api/me/memory/settings",
    { body: JSON.stringify(body), method: "PATCH" },
    decodeMemorySettingsResponse
  );
}

export async function acceptMemoryDestinations(
  body: MemoryConsentInput
): Promise<MemorySettingsResponse> {
  return memoryRequest(
    "/api/me/memory/settings",
    { body: JSON.stringify(body), method: "PATCH" },
    decodeMemorySettingsResponse
  );
}

export async function listMemories(
  cursor: string | null = null,
  filters: Readonly<{
    scope?: MemoryScopeSelection;
    state?: MemoryFactState;
  }> = {},
  signal?: AbortSignal
): Promise<MemoryListResponse> {
  const query = new URLSearchParams({ pageSize: "20", state: filters.state ?? "ACTIVE" });
  if (filters.scope) {
    query.set("scope", filters.scope.type);
    if (filters.scope.type !== "GLOBAL_USER") query.set("targetId", filters.scope.targetId);
  }
  if (cursor) query.set("cursor", cursor);
  return memoryRequest(
    `/api/me/memories?${query.toString()}`,
    { method: "GET", signal },
    decodeMemoryListResponse
  );
}

export async function searchMemories(
  query: string,
  cursor: string | null = null,
  filters: Readonly<{
    scope?: MemoryScopeSelection;
    state?: MemoryFactState;
  }> = {},
  signal?: AbortSignal
): Promise<MemoryListResponse> {
  return memoryRequest(
    "/api/me/memories/search",
    {
      body: JSON.stringify({
        ...(cursor ? { cursor } : {}),
        pageSize: 20,
        query,
        ...(filters.scope ? { scope: filters.scope } : {}),
        state: filters.state ?? "ACTIVE"
      }),
      method: "POST",
      signal
    },
    decodeMemoryListResponse
  );
}

export async function loadMemory(
  memoryId: string,
  signal?: AbortSignal
): Promise<MemoryMutationResponse> {
  return memoryRequest(
    `/api/me/memories/${encodeURIComponent(memoryId)}`,
    { method: "GET", signal },
    decodeMemoryMutationResponse
  );
}

export async function loadMemoryEvidence(
  memoryId: string,
  cursor: string | null = null,
  signal?: AbortSignal
): Promise<MemoryEvidenceResponse> {
  const query = new URLSearchParams();
  if (cursor) query.set("cursor", cursor);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return memoryRequest(
    `/api/me/memories/${encodeURIComponent(memoryId)}/evidence${suffix}`,
    { method: "GET", signal },
    decodeMemoryEvidenceResponse
  );
}

export async function authorizeMemoryMutation(
  body: MemoryMutationAuthorizationIntent
): Promise<MemoryMutationAuthorizationResponse> {
  return memoryRequest(
    "/api/me/memory/mutation-authorizations",
    {
      body: JSON.stringify({
        ...body,
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        requestNonce: nonce()
      }),
      method: "POST"
    },
    decodeMemoryMutationAuthorizationResponse
  );
}

export async function createMemory(
  body: MemoryCreateInput
): Promise<MemoryMutationResponse> {
  return memoryRequest(
    "/api/me/memories",
    { body: JSON.stringify(body), method: "POST" },
    decodeMemoryMutationResponse
  );
}

export async function updateMemory(
  memoryId: string,
  body: MemoryUpdateInput
): Promise<MemoryMutationResponse> {
  return memoryRequest(
    `/api/me/memories/${encodeURIComponent(memoryId)}`,
    { body: JSON.stringify(body), method: "PATCH" },
    decodeMemoryMutationResponse
  );
}

export async function forgetMemory(
  memoryId: string,
  body: MemoryForgetInput
): Promise<MemoryMutationResponse> {
  return memoryRequest(
    `/api/me/memories/${encodeURIComponent(memoryId)}/forget`,
    { body: JSON.stringify(body), method: "POST" },
    decodeMemoryMutationResponse
  );
}

export async function startExplicitMemoryDeletion(
  body: MemoryBulkDeleteInput
): Promise<MemoryDeletionStatus> {
  return memoryRequest(
    "/api/me/memory/bulk-delete",
    { body: JSON.stringify(body), method: "POST" },
    decodeMemoryDeletionStatus
  );
}

export async function loadMemoryDeletionStatus(
  deletionId: string,
  signal?: AbortSignal
): Promise<MemoryDeletionStatus> {
  return memoryRequest(
    `/api/me/memory/deletions/${encodeURIComponent(deletionId)}`,
    { method: "GET", signal },
    decodeMemoryDeletionStatus
  );
}

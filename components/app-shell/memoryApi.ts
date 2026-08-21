import { shellFetch } from "@/components/app-shell/shellApi";
import {
  decodeMemorySourceActionResponse,
  isSafeMemorySourceActionHref,
  type MemoryClientDecodeResult,
  type MemorySourceActionInput,
  type MemorySourceActionResponse
} from "@/lib/contracts/memoryClient";
import {
  MEMORY_CONSUMER_CONFIRMATION_COPY_VERSION,
  MEMORY_CONSUMER_STATEMENT_MAX_LENGTH,
  decodeMemoryConsumerErrorResponse,
  decodeMemoryConsumerForgetResponse,
  decodeMemoryConsumerListResponse,
  decodeMemoryConsumerMutationResponse,
  decodeMemoryConsumerResetResponse,
  decodeMemoryConsumerSettingsResponse,
  type MemoryConsumerForgetResponse,
  type MemoryConsumerListInput,
  type MemoryConsumerListResponse,
  type MemoryConsumerMutationResponse,
  type MemoryConsumerResetResponse,
  type MemoryConsumerSearchInput,
  type MemoryConsumerSettingsPatch,
  type MemoryConsumerSettingsResponse,
  type MemoryConsumerStatementMutation
} from "@/lib/contracts/memoryConsumer";

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

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function consumerFailure(value: unknown): string {
  const decoded = decodeMemoryConsumerErrorResponse(value);
  if (decoded) return decoded.error;
  if (value && typeof value === "object" && !Array.isArray(value) && "error" in value) {
    const error = (value as { error?: unknown }).error;
    if (error === "unauthorized") return "unauthorized";
    if (error === "memory_not_found") return "memory_not_found";
    if (error === "memory_secret_rejected") return "memory_secret_rejected";
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
  if (!response.ok) throw new MemoryApiError(consumerFailure(body), response.status);
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

export function memoryRequestId(): string {
  return nonce();
}

function decodeSourceActionResponse(
  value: unknown,
  action: MemorySourceActionInput["action"]
): MemoryClientDecodeResult<MemorySourceActionResponse> {
  const decoded = decodeMemorySourceActionResponse(value);
  if (!decoded.ok) return decoded;
  if (action === "OPEN_SOURCE") {
    return decoded.value.status === "READY" && isSafeMemorySourceActionHref(decoded.value.href)
      ? decoded
      : { code: "memory_contract_invalid", ok: false };
  }
  return decoded.value.status === "COMMITTED"
    ? decoded
    : { code: "memory_contract_invalid", ok: false };
}

export async function submitMemorySourceAction(
  action: MemorySourceActionInput["action"],
  memoryRef: string,
  statement?: string
): Promise<MemorySourceActionResponse> {
  const trimmedRef = memoryRef.trim();
  if (!trimmedRef || trimmedRef.length > 2_048) {
    throw new MemoryApiError("memory_not_found", 400);
  }
  if (action === "CORRECT") {
    const trimmedStatement = statement?.trim() ?? "";
    if (!trimmedStatement ||
      trimmedStatement.length > MEMORY_CONSUMER_STATEMENT_MAX_LENGTH) {
      throw new MemoryApiError("memory_contract_invalid", 400);
    }
    return memoryRequest(
      "/api/me/memory/source-actions",
      {
        body: JSON.stringify({
          action,
          memoryRef: trimmedRef,
          requestNonce: memoryRequestId(),
          statement: trimmedStatement
        }),
        method: "POST"
      },
      (value) => decodeSourceActionResponse(value, action)
    );
  }
  return memoryRequest(
    "/api/me/memory/source-actions",
    {
      body: JSON.stringify({
        action,
        memoryRef: trimmedRef,
        requestNonce: memoryRequestId()
      }),
      method: "POST"
    },
    (value) => decodeSourceActionResponse(value, action)
  );
}

export const applyMemorySourceAction = submitMemorySourceAction;

export function loadMemorySettings(
  signal?: AbortSignal
): Promise<MemoryConsumerSettingsResponse> {
  return memoryRequest(
    "/api/me/memory/settings",
    { method: "GET", signal },
    decodeMemoryConsumerSettingsResponse
  );
}

export function patchMemorySettings(
  body: MemoryConsumerSettingsPatch
): Promise<MemoryConsumerSettingsResponse> {
  return memoryRequest(
    "/api/me/memory/settings",
    { body: JSON.stringify(body), method: "PATCH" },
    decodeMemoryConsumerSettingsResponse
  );
}

export function listMemories(
  cursor: string | null = null,
  signal?: AbortSignal,
  filters: Pick<MemoryConsumerListInput, "category" | "provenance"> = {}
): Promise<MemoryConsumerListResponse> {
  const query = new URLSearchParams({ pageSize: "20" });
  if (filters.category) query.set("category", filters.category);
  if (cursor) query.set("cursor", cursor);
  if (filters.provenance) query.set("provenance", filters.provenance);
  return memoryRequest(
    `/api/me/memories?${query.toString()}`,
    { method: "GET", signal },
    decodeMemoryConsumerListResponse
  );
}

export function searchMemories(
  query: string,
  cursor: string | null = null,
  signal?: AbortSignal,
  filters: Pick<MemoryConsumerSearchInput, "category" | "provenance"> = {}
): Promise<MemoryConsumerListResponse> {
  return memoryRequest(
    "/api/me/memories/search",
    {
      body: JSON.stringify({
        ...(filters.category ? { category: filters.category } : {}),
        ...(cursor ? { cursor } : {}),
        pageSize: 20,
        ...(filters.provenance ? { provenance: filters.provenance } : {}),
        query
      }),
      method: "POST",
      signal
    },
    decodeMemoryConsumerListResponse
  );
}

export function createMemory(
  statement: string
): Promise<MemoryConsumerMutationResponse> {
  const body: MemoryConsumerStatementMutation = {
    requestId: memoryRequestId(),
    statement
  };
  return memoryRequest(
    "/api/me/memories",
    { body: JSON.stringify(body), method: "POST" },
    decodeMemoryConsumerMutationResponse
  );
}

export function updateMemory(
  memoryRef: string,
  statement: string
): Promise<MemoryConsumerMutationResponse> {
  const body: MemoryConsumerStatementMutation = {
    requestId: memoryRequestId(),
    statement
  };
  return memoryRequest(
    `/api/me/memories/${encodeURIComponent(memoryRef)}`,
    { body: JSON.stringify(body), method: "PATCH" },
    decodeMemoryConsumerMutationResponse
  );
}

export function forgetMemory(
  memoryRef: string
): Promise<MemoryConsumerForgetResponse> {
  return memoryRequest(
    `/api/me/memories/${encodeURIComponent(memoryRef)}/forget`,
    {
      body: JSON.stringify({ requestId: memoryRequestId() }),
      method: "POST"
    },
    decodeMemoryConsumerForgetResponse
  );
}

export function resetPersonalMemory(): Promise<MemoryConsumerResetResponse> {
  return memoryRequest(
    "/api/me/memory/reset",
    {
      body: JSON.stringify({
        confirmationCopyVersion: MEMORY_CONSUMER_CONFIRMATION_COPY_VERSION,
        requestId: memoryRequestId()
      }),
      method: "POST"
    },
    decodeMemoryConsumerResetResponse
  );
}

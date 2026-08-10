import { shellFetch } from "@/components/app-shell/shellApi";
import {
  decodeMemoryErrorResponse,
  decodeMemoryHistorySearchInput,
  decodeMemoryHistorySearchResponse,
  type MemoryHistorySearchInput,
  type MemoryHistorySearchResponse
} from "@/lib/contracts/memory";

export class MemoryHistorySearchApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = "MemoryHistorySearchApiError";
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

function stableErrorCode(value: unknown): string {
  const decoded = decodeMemoryErrorResponse(value);
  if (decoded) return decoded.error;
  if (
    value && typeof value === "object" && !Array.isArray(value) &&
    (value as { error?: unknown }).error === "unauthorized"
  ) return "unauthorized";
  return "memory_action_failed";
}

export async function searchMemoryHistory(
  input: MemoryHistorySearchInput,
  signal?: AbortSignal
): Promise<MemoryHistorySearchResponse> {
  const request = decodeMemoryHistorySearchInput(input);
  if (!request.ok) {
    throw new MemoryHistorySearchApiError("memory_contract_invalid", 400);
  }
  const response = await shellFetch("/api/me/memory/history/search", {
    body: JSON.stringify(request.value),
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    },
    method: "POST",
    signal
  });
  const body = await responseJson(response);
  if (!response.ok) {
    throw new MemoryHistorySearchApiError(stableErrorCode(body), response.status);
  }
  const decoded = decodeMemoryHistorySearchResponse(body);
  if (!decoded.ok) {
    throw new MemoryHistorySearchApiError("memory_response_invalid", 502);
  }
  return decoded.value;
}

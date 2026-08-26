import { shellFetch } from "@/components/app-shell/shellApi";
import {
  decodeKnowledgeBaseDetailResponse,
  decodeKnowledgeBaseListResponse,
  decodeKnowledgeBasePublicationResponse,
  decodeKnowledgeDeletionResponse,
  decodeKnowledgeSourceDetailResponse,
  decodeKnowledgeSourceListResponse,
  type KnowledgeBaseCreateInput,
  type KnowledgeBaseDetail,
  type KnowledgeBaseListResponse,
  type KnowledgeBasePublication,
  type KnowledgeBasePublicationInput,
  type KnowledgeBaseUpdateInput,
  KNOWLEDGE_SOURCE_PAGE_SIZE,
  type KnowledgeSourceDetail,
  type KnowledgeSourceFilter,
  type KnowledgeSourceListResponse,
  type KnowledgeSourceMoveInput,
  type KnowledgeSourceUpdateInput
} from "@/lib/contracts/knowledge";
import {
  decodeKnowledgeUploadBatchListResponse,
  decodeKnowledgeUploadBatchResponse,
  type KnowledgeUploadBatch,
  type KnowledgeUploadBatchCreateInput,
  type KnowledgeUploadBatchListResponse
} from "@/lib/contracts/knowledgeUploads";

export type KnowledgeApiResult<T> =
  | { data: T; ok: true }
  | { code: string; message: string; ok: false };

async function errorResult(response: Response): Promise<KnowledgeApiResult<never>> {
  let code = "knowledge_request_failed";
  let message = "The Knowledge request could not be completed.";
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const record = body as Record<string, unknown>;
      if (typeof record.error === "string" && record.error) code = record.error;
      if (typeof record.message === "string" && record.message) message = record.message;
    }
  } catch {
    // The stable fallback above covers unreadable bodies.
  }
  return { code, message, ok: false };
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
  decode: (value: unknown) => T | null
): Promise<KnowledgeApiResult<T>> {
  let response: Response;
  try {
    response = await shellFetch(url, init);
  } catch {
    return {
      code: "network_unavailable",
      message: "The Knowledge request could not reach the server.",
      ok: false
    };
  }
  if (!response.ok) return errorResult(response);
  if (response.status === 204) return { data: undefined as T, ok: true };
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      code: "knowledge_response_invalid",
      message: "The Knowledge response could not be read. Refresh and try again.",
      ok: false
    };
  }
  const decoded = decode(payload);
  return decoded === null
    ? {
        code: "knowledge_response_invalid",
        message: "The Knowledge response could not be read. Refresh and try again.",
        ok: false
      }
    : { data: decoded, ok: true };
}

const jsonHeaders = { "content-type": "application/json" } as const;

function basePath(baseId: string): string {
  return `/api/me/knowledge-bases/${encodeURIComponent(baseId)}`;
}

function sourcePath(sourceId: string): string {
  return `/api/me/knowledge-sources/${encodeURIComponent(sourceId)}`;
}

function uploadBatchPath(baseId: string, batchId?: string): string {
  const collection = `${basePath(baseId)}/upload-batches`;
  return batchId ? `${collection}/${encodeURIComponent(batchId)}` : collection;
}

function uploadItemPath(baseId: string, batchId: string, itemId: string): string {
  return [
    "/api/me/knowledge-uploads",
    encodeURIComponent(baseId),
    encodeURIComponent(batchId),
    encodeURIComponent(itemId)
  ].join("/");
}

function lifecycleRequest(
  path: string,
  action: "delete-permanently" | "restore" | "trash",
  expectedVersion: number
): Promise<KnowledgeApiResult<undefined>> {
  return requestJson(
    `${path}/${action}`,
    {
      body: JSON.stringify({ expectedVersion }),
      headers: jsonHeaders,
      method: "POST"
    },
    action === "delete-permanently"
      ? (value) => decodeKnowledgeDeletionResponse(value) ? undefined : null
      : () => undefined
  );
}

export function fetchKnowledgeBaseList(): Promise<KnowledgeApiResult<KnowledgeBaseListResponse>> {
  return requestJson(
    "/api/me/knowledge-bases",
    { method: "GET" },
    decodeKnowledgeBaseListResponse
  );
}

export function fetchKnowledgeBaseDetail(
  baseId: string
): Promise<KnowledgeApiResult<KnowledgeBaseDetail>> {
  return requestJson(basePath(baseId), { method: "GET" }, (value) =>
    decodeKnowledgeBaseDetailResponse(value)?.knowledgeBase ?? null
  );
}

export function createKnowledgeBase(
  input: KnowledgeBaseCreateInput
): Promise<KnowledgeApiResult<KnowledgeBaseDetail>> {
  return requestJson(
    "/api/me/knowledge-bases",
    { body: JSON.stringify(input), headers: jsonHeaders, method: "POST" },
    (value) => decodeKnowledgeBaseDetailResponse(value)?.knowledgeBase ?? null
  );
}

export function updateKnowledgeBase(
  baseId: string,
  input: KnowledgeBaseUpdateInput
): Promise<KnowledgeApiResult<KnowledgeBaseDetail>> {
  return requestJson(
    basePath(baseId),
    { body: JSON.stringify(input), headers: jsonHeaders, method: "PATCH" },
    (value) => decodeKnowledgeBaseDetailResponse(value)?.knowledgeBase ?? null
  );
}

export function trashKnowledgeBase(
  baseId: string,
  expectedVersion: number
): Promise<KnowledgeApiResult<undefined>> {
  return lifecycleRequest(basePath(baseId), "trash", expectedVersion);
}

export function restoreKnowledgeBase(
  baseId: string,
  expectedVersion: number
): Promise<KnowledgeApiResult<undefined>> {
  return lifecycleRequest(basePath(baseId), "restore", expectedVersion);
}

export function permanentlyDeleteKnowledgeBase(
  baseId: string,
  expectedVersion: number
): Promise<KnowledgeApiResult<undefined>> {
  return lifecycleRequest(basePath(baseId), "delete-permanently", expectedVersion);
}

export function fetchKnowledgeUploadBatches(
  baseId: string
): Promise<KnowledgeApiResult<KnowledgeUploadBatchListResponse>> {
  return requestJson(
    uploadBatchPath(baseId),
    { method: "GET" },
    decodeKnowledgeUploadBatchListResponse
  );
}

export function createKnowledgeUploadBatch(
  baseId: string,
  input: KnowledgeUploadBatchCreateInput
): Promise<KnowledgeApiResult<KnowledgeUploadBatch>> {
  return requestJson(
    uploadBatchPath(baseId),
    { body: JSON.stringify(input), headers: jsonHeaders, method: "POST" },
    (value) => decodeKnowledgeUploadBatchResponse(value)?.batch ?? null
  );
}

function mutateKnowledgeUploadItem(
  baseId: string,
  batchId: string,
  itemId: string,
  attemptNumber: number,
  action: "retry" | "settle" | "start"
): Promise<KnowledgeApiResult<KnowledgeUploadBatch>> {
  return requestJson(
    `${uploadItemPath(baseId, batchId, itemId)}/${action}`,
    { body: JSON.stringify({ attemptNumber }), headers: jsonHeaders, method: "POST" },
    (value) => decodeKnowledgeUploadBatchResponse(value)?.batch ?? null
  );
}

export function startKnowledgeUploadItem(
  baseId: string,
  batchId: string,
  itemId: string,
  attemptNumber: number
): Promise<KnowledgeApiResult<KnowledgeUploadBatch>> {
  return mutateKnowledgeUploadItem(baseId, batchId, itemId, attemptNumber, "start");
}

export function settleKnowledgeUploadItem(
  baseId: string,
  batchId: string,
  itemId: string,
  attemptNumber: number
): Promise<KnowledgeApiResult<KnowledgeUploadBatch>> {
  return mutateKnowledgeUploadItem(baseId, batchId, itemId, attemptNumber, "settle");
}

export function retryKnowledgeUploadItem(
  baseId: string,
  batchId: string,
  itemId: string,
  attemptNumber: number
): Promise<KnowledgeApiResult<KnowledgeUploadBatch>> {
  return mutateKnowledgeUploadItem(baseId, batchId, itemId, attemptNumber, "retry");
}

export function checkpointKnowledgeUploadPart(
  baseId: string,
  batchId: string,
  itemId: string,
  partNumber: number,
  input: Readonly<{ attemptNumber: number; byteSize: number; etag: string }>
): Promise<KnowledgeApiResult<KnowledgeUploadBatch>> {
  return requestJson(
    `${uploadItemPath(baseId, batchId, itemId)}/parts/${partNumber}`,
    { body: JSON.stringify(input), headers: jsonHeaders, method: "POST" },
    (value) => decodeKnowledgeUploadBatchResponse(value)?.batch ?? null
  );
}

export function cancelKnowledgeUploadItem(
  baseId: string,
  batchId: string,
  itemId: string,
  attemptNumber: number
): Promise<KnowledgeApiResult<KnowledgeUploadBatch>> {
  return requestJson(
    uploadItemPath(baseId, batchId, itemId),
    {
      body: JSON.stringify({ attemptNumber }),
      headers: jsonHeaders,
      method: "DELETE"
    },
    (value) => decodeKnowledgeUploadBatchResponse(value)?.batch ?? null
  );
}

type BinaryUploadResult =
  | Readonly<{ etag: string | null; ok: true; response: unknown }>
  | Readonly<{ code: string; message: string; ok: false }>;

function uploadBinary(
  url: string,
  body: Blob,
  input: Readonly<{
    onProgress?(uploadedBytes: number): void;
    signal: AbortSignal;
  }>
): Promise<BinaryUploadResult> {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    let settled = false;
    const finish = (result: BinaryUploadResult) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = () => request.abort();
    request.open("PUT", url);
    request.timeout = 15 * 60 * 1_000;
    request.upload.addEventListener("progress", (event) => {
      input.onProgress?.(Math.min(body.size, event.loaded));
    });
    request.addEventListener("abort", () => finish({
      code: "knowledge_upload_cancelled",
      message: "The upload was cancelled.",
      ok: false
    }));
    request.addEventListener("error", () => finish({
      code: "network_unavailable",
      message: "The Knowledge upload could not reach storage.",
      ok: false
    }));
    request.addEventListener("timeout", () => finish({
      code: "network_unavailable",
      message: "The Knowledge upload timed out.",
      ok: false
    }));
    request.addEventListener("load", () => {
      if (request.status < 200 || request.status >= 300) {
        let code = "knowledge_request_failed";
        let message = "The Knowledge upload could not be completed.";
        try {
          const payload = JSON.parse(request.responseText) as unknown;
          if (payload && typeof payload === "object" && !Array.isArray(payload)) {
            const record = payload as Record<string, unknown>;
            if (typeof record.error === "string" && record.error) code = record.error;
            if (typeof record.message === "string" && record.message) message = record.message;
          }
        } catch {
          // Cross-origin object storage commonly returns an empty or non-JSON error body.
        }
        finish({ code, message, ok: false });
        return;
      }
      let response: unknown = null;
      if (request.responseText) {
        try {
          response = JSON.parse(request.responseText) as unknown;
        } catch {
          response = null;
        }
      }
      input.onProgress?.(body.size);
      finish({
        etag: request.getResponseHeader("etag"),
        ok: true,
        response
      });
    });
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) {
      finish({
        code: "knowledge_upload_cancelled",
        message: "The upload was cancelled.",
        ok: false
      });
      return;
    }
    request.send(body);
  });
}

export async function uploadKnowledgeProxyContent(
  uploadUrl: string,
  file: File,
  input: Readonly<{ onProgress?(uploadedBytes: number): void; signal: AbortSignal }>
): Promise<KnowledgeApiResult<KnowledgeUploadBatch>> {
  const result = await uploadBinary(uploadUrl, file, input);
  if (!result.ok) return result;
  const decoded = decodeKnowledgeUploadBatchResponse(result.response);
  return decoded
    ? { data: decoded.batch, ok: true }
    : {
        code: "knowledge_response_invalid",
        message: "The Knowledge upload response could not be read.",
        ok: false
      };
}

export async function uploadKnowledgeMultipartPart(
  uploadUrl: string,
  body: Blob,
  input: Readonly<{ onProgress?(uploadedBytes: number): void; signal: AbortSignal }>
): Promise<KnowledgeApiResult<string>> {
  const result = await uploadBinary(uploadUrl, body, input);
  if (!result.ok) return result;
  const etag = result.etag?.trim();
  return etag
    ? { data: etag, ok: true }
    : {
        code: "knowledge_upload_etag_unavailable",
        message: "Object storage did not expose the upload checkpoint.",
        ok: false
      };
}

export function publishKnowledgeBase(
  baseId: string,
  input: KnowledgeBasePublicationInput
): Promise<KnowledgeApiResult<KnowledgeBasePublication>> {
  return requestJson(
    `${basePath(baseId)}/publications`,
    { body: JSON.stringify(input), headers: jsonHeaders, method: "POST" },
    (value) => decodeKnowledgeBasePublicationResponse(value)?.publication ?? null
  );
}

export function revokeKnowledgeBasePublication(
  baseId: string,
  publicationId: string
): Promise<KnowledgeApiResult<undefined>> {
  return requestJson(
    `${basePath(baseId)}/publications/${encodeURIComponent(publicationId)}`,
    { method: "DELETE" },
    () => undefined as undefined
  );
}

export function fetchKnowledgeSources(input: Readonly<{
  baseId?: string;
  filter?: KnowledgeSourceFilter;
  page?: number;
  pageSize?: number;
  query?: string;
}> = {}): Promise<KnowledgeApiResult<KnowledgeSourceListResponse>> {
  const search = new URLSearchParams({
    filter: input.filter ?? "all",
    page: String(input.page ?? 1),
    pageSize: String(input.pageSize ?? KNOWLEDGE_SOURCE_PAGE_SIZE)
  });
  const query = input.query?.trim() ?? "";
  if (input.baseId) search.set("baseId", input.baseId);
  if (query) search.set("q", query);
  return requestJson(
    `/api/me/knowledge-sources?${search.toString()}`,
    { method: "GET" },
    decodeKnowledgeSourceListResponse
  );
}

export function fetchKnowledgeSourceDetail(
  sourceId: string
): Promise<KnowledgeApiResult<KnowledgeSourceDetail>> {
  return requestJson(sourcePath(sourceId), { method: "GET" }, (value) =>
    decodeKnowledgeSourceDetailResponse(value)?.source ?? null
  );
}

export function updateKnowledgeSource(
  sourceId: string,
  input: KnowledgeSourceUpdateInput
): Promise<KnowledgeApiResult<KnowledgeSourceDetail>> {
  return requestJson(
    sourcePath(sourceId),
    { body: JSON.stringify(input), headers: jsonHeaders, method: "PATCH" },
    (value) => decodeKnowledgeSourceDetailResponse(value)?.source ?? null
  );
}

export function replaceKnowledgeSource(
  sourceId: string,
  file: File
): Promise<KnowledgeApiResult<KnowledgeSourceDetail>> {
  const form = new FormData();
  form.append("file", file);
  return requestJson(
    `${sourcePath(sourceId)}/versions`,
    { body: form, method: "POST" },
    (value) => decodeKnowledgeSourceDetailResponse(value)?.source ?? null
  );
}

export function reprocessKnowledgeSource(
  sourceId: string
): Promise<KnowledgeApiResult<KnowledgeSourceDetail>> {
  return requestJson(
    `${sourcePath(sourceId)}/reprocess`,
    { method: "POST" },
    (value) => decodeKnowledgeSourceDetailResponse(value)?.source ?? null
  );
}

export function trashKnowledgeSource(
  sourceId: string,
  expectedVersion: number
): Promise<KnowledgeApiResult<undefined>> {
  return lifecycleRequest(sourcePath(sourceId), "trash", expectedVersion);
}

export function restoreKnowledgeSource(
  sourceId: string,
  expectedVersion: number
): Promise<KnowledgeApiResult<undefined>> {
  return lifecycleRequest(sourcePath(sourceId), "restore", expectedVersion);
}

export function permanentlyDeleteKnowledgeSource(
  sourceId: string,
  expectedVersion: number
): Promise<KnowledgeApiResult<undefined>> {
  return lifecycleRequest(sourcePath(sourceId), "delete-permanently", expectedVersion);
}

export function addKnowledgeSourceMemberships(
  sourceId: string,
  baseIds: readonly string[]
): Promise<KnowledgeApiResult<KnowledgeSourceDetail>> {
  return requestJson(
    `${sourcePath(sourceId)}/memberships`,
    { body: JSON.stringify({ baseIds }), headers: jsonHeaders, method: "POST" },
    (value) => decodeKnowledgeSourceDetailResponse(value)?.source ?? null
  );
}

export function removeKnowledgeSourceMembership(
  sourceId: string,
  baseId: string
): Promise<KnowledgeApiResult<KnowledgeSourceDetail>> {
  return requestJson(
    `${sourcePath(sourceId)}/memberships/${encodeURIComponent(baseId)}`,
    { method: "DELETE" },
    (value) => decodeKnowledgeSourceDetailResponse(value)?.source ?? null
  );
}

export function moveKnowledgeSource(
  sourceId: string,
  input: KnowledgeSourceMoveInput
): Promise<KnowledgeApiResult<KnowledgeSourceDetail>> {
  return requestJson(
    `${sourcePath(sourceId)}/move`,
    { body: JSON.stringify(input), headers: jsonHeaders, method: "POST" },
    (value) => decodeKnowledgeSourceDetailResponse(value)?.source ?? null
  );
}

import { shellFetch } from "@/components/app-shell/shellApi";
import {
  decodeKnowledgeBaseDetailResponse,
  decodeKnowledgeBaseListResponse,
  decodeKnowledgeBasePublicationResponse,
  decodeKnowledgeDocumentMutationResponse,
  decodeKnowledgeIngestionStatusResponse,
  decodeKnowledgeReindexResponse,
  type KnowledgeBaseCreateInput,
  type KnowledgeBaseDetail,
  type KnowledgeBaseListResponse,
  type KnowledgeBasePublication,
  type KnowledgeBasePublicationInput,
  type KnowledgeBaseUpdateInput,
  type KnowledgeDocumentStatus,
  KNOWLEDGE_DOCUMENT_PAGE_SIZE,
  type KnowledgeIngestionStatusResponse,
  type KnowledgeReindexProgress
} from "@/lib/contracts/knowledge";

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

function documentPath(baseId: string, documentId: string): string {
  return `${basePath(baseId)}/documents/${encodeURIComponent(documentId)}`;
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

export function fetchKnowledgeDocuments(
  baseId: string,
  input: Readonly<{ page?: number; pageSize?: number; query?: string }> = {}
): Promise<KnowledgeApiResult<KnowledgeIngestionStatusResponse>> {
  const search = new URLSearchParams({
    page: String(input.page ?? 1),
    pageSize: String(input.pageSize ?? KNOWLEDGE_DOCUMENT_PAGE_SIZE)
  });
  const query = input.query?.trim() ?? "";
  if (query) search.set("q", query);
  return requestJson(
    `${basePath(baseId)}/documents?${search.toString()}`,
    { method: "GET" },
    decodeKnowledgeIngestionStatusResponse
  );
}

function uploadDocument(
  baseId: string,
  file: File,
  documentId?: string
): Promise<KnowledgeApiResult<KnowledgeDocumentStatus>> {
  const form = new FormData();
  form.append("file", file);
  const path = documentId
    ? `${documentPath(baseId, documentId)}/versions`
    : `${basePath(baseId)}/documents`;
  return requestJson(path, { body: form, method: "POST" }, (value) =>
    decodeKnowledgeDocumentMutationResponse(value)?.document ?? null
  );
}

export function uploadKnowledgeDocument(
  baseId: string,
  file: File
): Promise<KnowledgeApiResult<KnowledgeDocumentStatus>> {
  return uploadDocument(baseId, file);
}

export function replaceKnowledgeDocument(
  baseId: string,
  documentId: string,
  file: File
): Promise<KnowledgeApiResult<KnowledgeDocumentStatus>> {
  return uploadDocument(baseId, file, documentId);
}

export function archiveKnowledgeDocument(
  baseId: string,
  documentId: string
): Promise<KnowledgeApiResult<undefined>> {
  return requestJson(
    documentPath(baseId, documentId),
    { method: "DELETE" },
    () => undefined as undefined
  );
}

export function retryKnowledgeDocumentVersion(
  baseId: string,
  documentId: string,
  versionId: string
): Promise<KnowledgeApiResult<KnowledgeDocumentStatus>> {
  return requestJson(
    `${documentPath(baseId, documentId)}/versions/${encodeURIComponent(versionId)}/retry`,
    { method: "POST" },
    (value) => decodeKnowledgeDocumentMutationResponse(value)?.document ?? null
  );
}

export function startKnowledgeReindex(
  baseId: string,
  embeddingDeploymentId: string
): Promise<KnowledgeApiResult<KnowledgeReindexProgress>> {
  return requestJson(
    `${basePath(baseId)}/reindex`,
    {
      body: JSON.stringify({ embeddingDeploymentId }),
      headers: jsonHeaders,
      method: "POST"
    },
    (value) => decodeKnowledgeReindexResponse(value)?.reindex ?? null
  );
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

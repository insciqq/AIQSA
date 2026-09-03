import { createHash, randomUUID } from "node:crypto";
import {
  decodeKnowledgeSourceDuplicate,
  decodeKnowledgeSourceMembership,
  decodeKnowledgeSourceMove,
  decodeKnowledgeSourceUpdate,
  KNOWLEDGE_SOURCE_PAGE_SIZE,
  KNOWLEDGE_SOURCE_PAGE_SIZE_MAX,
  KNOWLEDGE_SOURCE_SEARCH_MAX_LENGTH,
  type KnowledgeSourceBaseMembership,
  type KnowledgeSourceDetail,
  type KnowledgeSourceDetailResponse,
  type KnowledgeSourceDuplicateResponse,
  type KnowledgeSourceFilter,
  type KnowledgeSourceListResponse,
  type KnowledgeSourceReadiness,
  type KnowledgeSourceSummary,
  type KnowledgeSourceVersionSummary
} from "../../contracts/knowledge";
import type { RequestAuthResolver } from "../auth/requestAuth";
import {
  readBoundedFormData,
  readJsonBodyOrNull,
  requestBodyErrorResponse,
  RequestBodyTooLargeError
} from "../http/requestBody";
import { getRequestBodyConfig, type RequestBodyConfig } from "../http/requestBodyConfig";
import { resolveUploadPermitGate, type UploadPermitGate } from "../http/uploadPermitGate";
import { resolveDocumentParserRoute } from "../parsing";
import type { StorageAdapter } from "../uploads/storage";
import { validateUpload } from "../uploads/validation";
import {
  getKnowledgeExtractionConfig,
  type KnowledgeExtractionConfig
} from "./knowledgeExtractionConfig";
import type { PrismaKnowledgeSourceLibraryRepository } from "./sourceLibraryRepository";

export type KnowledgeSourceLibraryHandlerDeps = Readonly<{
  kickProcessing?: () => void;
  repository: Pick<
    PrismaKnowledgeSourceLibraryRepository,
    | "addMemberships"
    | "findOwnedDuplicate"
    | "getDetail"
    | "listForUser"
    | "moveMembership"
    | "removeMembership"
    | "update"
  >;
  resolveAuth: RequestAuthResolver;
}>;

export type KnowledgeSourceVersionHandlerDeps = Readonly<{
  deletionOutbox: Readonly<{
    complete(jobId: string): Promise<void>;
    stage(storageKey: string): Promise<{ id: string }>;
  }>;
  getBodyConfig?: (
    uploadMaxBytes: number
  ) => Pick<RequestBodyConfig, "uploadMaxConcurrency" | "uploadMultipartMaxBytes">;
  getConfig?: () => KnowledgeExtractionConfig;
  kickProcessing?: () => void;
  repository: Pick<
    PrismaKnowledgeSourceLibraryRepository,
    "createVersion" | "getDetail" | "reprocess"
  >;
  resolveAuth: RequestAuthResolver;
  storage: Pick<StorageAdapter, "deleteObject" | "putObject">;
  uploadPermitGate?: UploadPermitGate;
}>;

type SourceContext = {
  params: Promise<{ sourceId: string }> | { sourceId: string };
};

type MembershipContext = {
  params:
    | Promise<{ baseId: string; sourceId: string }>
    | { baseId: string; sourceId: string };
};

function errorJson(code: string, status: number, headers?: HeadersInit): Response {
  return Response.json({ error: code }, { headers, status });
}

function boundedId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u0020\u007f]/u.test(value)
    ? value
    : null;
}

function positiveInteger(value: string | null, fallback: number, maximum: number): number | null {
  if (value === null) return fallback;
  if (!/^[1-9]\d{0,8}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}

function listInput(request: Request): Readonly<{
  baseId?: string;
  filter: KnowledgeSourceFilter;
  page: number;
  pageSize: number;
  query: string;
}> | null {
  const search = new URL(request.url).searchParams;
  const allowed = new Set(["baseId", "filter", "page", "pageSize", "q"]);
  if ([...search.keys()].some((key) => !allowed.has(key)) ||
    [...allowed].some((key) => search.getAll(key).length > 1)) {
    return null;
  }
  const rawBaseId = search.get("baseId");
  const baseId = rawBaseId === null ? undefined : boundedId(rawBaseId);
  const query = (search.get("q") ?? "").trim();
  const filter = search.get("filter") ?? "all";
  const page = positiveInteger(search.get("page"), 1, 1_000_000);
  const pageSize = positiveInteger(
    search.get("pageSize"),
    KNOWLEDGE_SOURCE_PAGE_SIZE,
    KNOWLEDGE_SOURCE_PAGE_SIZE_MAX
  );
  if ((rawBaseId !== null && !baseId) ||
    (filter !== "all" && filter !== "shared" && filter !== "trash" && filter !== "yours") ||
    page === null || pageSize === null || query.length > KNOWLEDGE_SOURCE_SEARCH_MAX_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(query)) return null;
  return { ...(baseId ? { baseId } : {}), filter, page, pageSize, query };
}

async function authenticatedUserId(
  deps: Readonly<{ resolveAuth: RequestAuthResolver }>,
  request: Request
): Promise<Response | string> {
  const auth = await deps.resolveAuth(request);
  return auth?.userId ?? errorJson("unauthorized", 401);
}

async function readJson(request: Request): Promise<readonly [unknown, Response | null]> {
  const value = await readJsonBodyOrNull(request, "json");
  return [value, requestBodyErrorResponse(value)];
}

function safeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/gu, "_").slice(0, 180) || "source";
}

function checksum(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function kick(deps: Readonly<{ kickProcessing?: () => void }>): void {
  try {
    deps.kickProcessing?.();
  } catch {
    // The durable queue and periodic reconciliation remain authoritative.
  }
}

async function cleanupStoredObject(
  deps: KnowledgeSourceVersionHandlerDeps,
  storageKey: string
): Promise<void> {
  let job: { id: string } | null = null;
  try {
    job = await deps.deletionOutbox.stage(storageKey);
  } catch {
    // Direct cleanup remains useful if outbox persistence is temporarily unavailable.
  }
  try {
    await deps.storage.deleteObject(storageKey);
    if (job) await deps.deletionOutbox.complete(job.id);
  } catch {
    // A staged job remains retryable; preserve the stable request result.
  }
}

async function sourceId(context: SourceContext | MembershipContext): Promise<string | null> {
  return boundedId((await context.params).sourceId);
}

function readinessResponse(readiness: KnowledgeSourceReadiness): KnowledgeSourceReadiness {
  return {
    state: readiness.state,
    supportReference: readiness.supportReference,
    warningCodes: [...readiness.warningCodes]
  };
}

function versionResponse(version: KnowledgeSourceVersionSummary): KnowledgeSourceVersionSummary {
  return {
    byteSize: version.byteSize,
    createdAt: version.createdAt,
    fileName: version.fileName,
    isCurrent: version.isCurrent,
    isPending: version.isPending,
    pageCount: version.pageCount,
    readiness: readinessResponse(version.readiness),
    versionNumber: version.versionNumber
  };
}

function membershipResponse(
  membership: KnowledgeSourceBaseMembership
): KnowledgeSourceBaseMembership {
  return {
    archived: membership.archived,
    id: membership.id,
    name: membership.name
  };
}

function summaryResponse(source: KnowledgeSourceSummary): KnowledgeSourceSummary {
  return {
    canReprocess: source.canReprocess,
    currentVersion: source.currentVersion ? versionResponse(source.currentVersion) : null,
    deletionPending: source.deletionPending,
    description: source.description,
    id: source.id,
    membershipCount: source.membershipCount,
    name: source.name,
    owned: source.owned,
    ownerDisplayName: source.ownerDisplayName,
    purgeScheduledAt: source.purgeScheduledAt,
    readiness: readinessResponse(source.readiness),
    replacement: {
      state: source.replacement.state,
      supportReference: source.replacement.supportReference
    },
    tags: [...source.tags],
    trashed: source.trashed,
    trashedAt: source.trashedAt,
    updatedAt: source.updatedAt,
    version: source.version
  };
}

function detailResponseBody(source: KnowledgeSourceDetail): KnowledgeSourceDetail {
  return {
    ...summaryResponse(source),
    eligibleBases: source.eligibleBases.map(membershipResponse),
    memberships: source.memberships.map(membershipResponse),
    versions: source.versions.map(versionResponse)
  };
}

async function detailResponse(
  deps: Readonly<{
    repository: Pick<PrismaKnowledgeSourceLibraryRepository, "getDetail">;
  }>,
  userId: string,
  id: string,
  status = 200
): Promise<Response> {
  const source = await deps.repository.getDetail(userId, id);
  return source
    ? Response.json({ source: detailResponseBody(source) } satisfies KnowledgeSourceDetailResponse, {
        headers: { "cache-control": "no-store" },
        status
      })
    : errorJson("knowledge_source_not_available", 404);
}

export function createListKnowledgeSourcesHandler(deps: KnowledgeSourceLibraryHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const userId = await authenticatedUserId(deps, request);
    if (userId instanceof Response) return userId;
    const input = listInput(request);
    if (!input) return errorJson("knowledge_source_query_invalid", 400);
    const response = await deps.repository.listForUser({ ...input, userId });
    return Response.json({
      pagination: {
        page: response.pagination.page,
        pageSize: response.pagination.pageSize,
        query: response.pagination.query,
        totalItems: response.pagination.totalItems,
        totalPages: response.pagination.totalPages
      },
      sources: response.sources.map(summaryResponse)
    } satisfies KnowledgeSourceListResponse, { headers: { "cache-control": "no-store" } });
  };
}

export function createGetKnowledgeSourceHandler(deps: KnowledgeSourceLibraryHandlerDeps) {
  return async function GET(request: Request, context: SourceContext): Promise<Response> {
    const userId = await authenticatedUserId(deps, request);
    if (userId instanceof Response) return userId;
    const id = await sourceId(context);
    return id ? detailResponse(deps, userId, id) : errorJson("knowledge_source_not_available", 404);
  };
}

export function createUpdateKnowledgeSourceHandler(deps: KnowledgeSourceLibraryHandlerDeps) {
  return async function PATCH(request: Request, context: SourceContext): Promise<Response> {
    const userId = await authenticatedUserId(deps, request);
    if (userId instanceof Response) return userId;
    const id = await sourceId(context);
    if (!id) return errorJson("knowledge_source_not_available", 404);
    const [body, bodyError] = await readJson(request);
    if (bodyError) return bodyError;
    const decoded = decodeKnowledgeSourceUpdate(body);
    if (!decoded.ok) return errorJson(decoded.code, 400);
    const result = await deps.repository.update(userId, id, decoded.value);
    if (result.kind === "not_found") return errorJson("knowledge_source_not_available", 404);
    if (result.kind === "version_conflict") {
      return errorJson("knowledge_source_version_conflict", 409);
    }
    return detailResponse(deps, userId, id);
  };
}

export function createAddKnowledgeSourceMembershipsHandler(
  deps: KnowledgeSourceLibraryHandlerDeps
) {
  return async function POST(request: Request, context: SourceContext): Promise<Response> {
    const userId = await authenticatedUserId(deps, request);
    if (userId instanceof Response) return userId;
    const id = await sourceId(context);
    if (!id) return errorJson("knowledge_source_not_available", 404);
    const [body, bodyError] = await readJson(request);
    if (bodyError) return bodyError;
    const decoded = decodeKnowledgeSourceMembership(body);
    if (!decoded.ok) return errorJson(decoded.code, 400);
    const result = await deps.repository.addMemberships(userId, id, decoded.value.baseIds);
    if (result.kind === "ok") kick(deps);
    return result.kind === "ok"
      ? detailResponse(deps, userId, id)
      : errorJson("knowledge_source_not_available", 404);
  };
}

export function createRemoveKnowledgeSourceMembershipHandler(
  deps: KnowledgeSourceLibraryHandlerDeps
) {
  return async function DELETE(request: Request, context: MembershipContext): Promise<Response> {
    const userId = await authenticatedUserId(deps, request);
    if (userId instanceof Response) return userId;
    const params = await context.params;
    const id = boundedId(params.sourceId);
    const baseId = boundedId(params.baseId);
    if (!id || !baseId) return errorJson("knowledge_source_not_available", 404);
    const result = await deps.repository.removeMembership(userId, id, baseId);
    return result.kind === "ok"
      ? detailResponse(deps, userId, id)
      : errorJson("knowledge_source_not_available", 404);
  };
}

export function createMoveKnowledgeSourceHandler(deps: KnowledgeSourceLibraryHandlerDeps) {
  return async function POST(request: Request, context: SourceContext): Promise<Response> {
    const userId = await authenticatedUserId(deps, request);
    if (userId instanceof Response) return userId;
    const id = await sourceId(context);
    if (!id) return errorJson("knowledge_source_not_available", 404);
    const [body, bodyError] = await readJson(request);
    if (bodyError) return bodyError;
    const decoded = decodeKnowledgeSourceMove(body);
    if (!decoded.ok) return errorJson(decoded.code, 400);
    const result = await deps.repository.moveMembership(
      userId,
      id,
      decoded.value.fromBaseId,
      decoded.value.toBaseId
    );
    if (result.kind === "ok") kick(deps);
    return result.kind === "ok"
      ? detailResponse(deps, userId, id)
      : errorJson("knowledge_source_not_available", 404);
  };
}

export function createFindKnowledgeSourceDuplicateHandler(
  deps: KnowledgeSourceLibraryHandlerDeps
) {
  return async function POST(request: Request): Promise<Response> {
    const userId = await authenticatedUserId(deps, request);
    if (userId instanceof Response) return userId;
    const [body, bodyError] = await readJson(request);
    if (bodyError) return bodyError;
    const decoded = decodeKnowledgeSourceDuplicate(body);
    if (!decoded.ok) return errorJson(decoded.code, 400);
    const source = await deps.repository.findOwnedDuplicate(userId, decoded.value);
    return Response.json({
      source: source ? summaryResponse(source) : null
    } satisfies KnowledgeSourceDuplicateResponse, {
      headers: { "cache-control": "no-store" }
    });
  };
}

export function createReplaceKnowledgeSourceHandler(
  deps: KnowledgeSourceVersionHandlerDeps
) {
  return async function POST(request: Request, context: SourceContext): Promise<Response> {
    const userId = await authenticatedUserId(deps, request);
    if (userId instanceof Response) return userId;
    const id = await sourceId(context);
    if (!id) return errorJson("knowledge_source_not_available", 404);

    const config = deps.getConfig?.() ?? getKnowledgeExtractionConfig();
    const bodyConfig = deps.getBodyConfig?.(config.maxFileBytes) ??
      getRequestBodyConfig(process.env, config.maxFileBytes);
    const gate = deps.uploadPermitGate ?? resolveUploadPermitGate(bodyConfig.uploadMaxConcurrency);
    const release = gate.tryAcquire();
    if (!release) return errorJson("upload_busy", 429, { "retry-after": "1" });

    try {
      let form: FormData;
      try {
        form = await readBoundedFormData(request, bodyConfig.uploadMultipartMaxBytes);
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          return errorJson("knowledge_file_limit_exceeded", 413);
        }
        if (request.signal.aborted) throw error;
        return errorJson("file_required", 400);
      }
      const file = form.get("file");
      if (!(file instanceof File)) return errorJson("file_required", 400);
      if (file.name.length > 512 || Buffer.byteLength(file.name, "utf8") > 1_024) {
        return errorJson("unsupported_type", 400);
      }
      const initial = validateUpload({
        byteSize: file.size,
        fileName: file.name,
        maxBytes: config.maxFileBytes,
        mimeType: file.type,
        scope: "knowledge"
      });
      if (!initial.ok) {
        return errorJson(
          initial.code === "file_too_large" ? "knowledge_file_limit_exceeded" : initial.code,
          initial.code === "file_too_large" ? 413 : 400
        );
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      const validation = validateUpload({
        byteSize: buffer.byteLength,
        bytes: buffer,
        fileName: file.name,
        maxBytes: config.maxFileBytes,
        mimeType: file.type,
        scope: "knowledge"
      });
      if (!validation.ok ||
        !resolveDocumentParserRoute(file.name, validation.ok ? validation.mimeType : file.type)) {
        return errorJson(
          !validation.ok && validation.code === "file_too_large"
            ? "knowledge_file_limit_exceeded"
            : "unsupported_type",
          !validation.ok && validation.code === "file_too_large" ? 413 : 400
        );
      }

      const digest = checksum(buffer);
      const sourceVersionId = randomUUID();
      const originalStorageKey = [
        "knowledge-sources",
        encodeURIComponent(userId),
        encodeURIComponent(id),
        encodeURIComponent(sourceVersionId),
        `${randomUUID()}-${digest.slice(0, 16)}-${safeFileName(file.name)}`
      ].join("/");
      try {
        await deps.storage.putObject({
          body: buffer,
          contentType: validation.mimeType,
          storageKey: originalStorageKey
        });
      } catch {
        return errorJson("knowledge_storage_unavailable", 503);
      }

      let created: Awaited<ReturnType<typeof deps.repository.createVersion>>;
      try {
        created = await deps.repository.createVersion({
          byteSize: buffer.byteLength,
          checksum: digest,
          fileName: file.name,
          mimeType: validation.mimeType,
          now: new Date(),
          originalStorageKey,
          sourceId: id,
          sourceVersionId,
          userId
        });
      } catch (error) {
        await cleanupStoredObject(deps, originalStorageKey);
        throw error;
      }
      if (created.kind !== "ok") {
        await cleanupStoredObject(deps, originalStorageKey);
        if (created.kind === "active_ingest") {
          return errorJson("knowledge_source_ingest_in_progress", 409);
        }
        if (created.kind === "profile_unavailable") {
          return errorJson("knowledge_source_profile_unavailable", 409);
        }
        return errorJson("knowledge_source_not_available", 404);
      }
      kick(deps);
      return detailResponse(deps, userId, id, 202);
    } finally {
      release();
    }
  };
}

export function createReprocessKnowledgeSourceHandler(
  deps: KnowledgeSourceVersionHandlerDeps
) {
  return async function POST(request: Request, context: SourceContext): Promise<Response> {
    const userId = await authenticatedUserId(deps, request);
    if (userId instanceof Response) return userId;
    const id = await sourceId(context);
    if (!id) return errorJson("knowledge_source_not_available", 404);
    const result = await deps.repository.reprocess(userId, id, new Date());
    if (result.kind === "not_found") return errorJson("knowledge_source_not_available", 404);
    if (result.kind === "active_ingest") {
      return errorJson("knowledge_source_ingest_in_progress", 409);
    }
    if (result.kind === "profile_unavailable") {
      return errorJson("knowledge_source_profile_unavailable", 409);
    }
    if (result.kind === "not_retryable") {
      return errorJson("knowledge_source_reprocess_not_available", 409);
    }
    kick(deps);
    return detailResponse(deps, userId, id, 202);
  };
}

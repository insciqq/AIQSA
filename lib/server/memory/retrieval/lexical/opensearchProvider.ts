import { Prisma, type PrismaClient } from "@prisma/client";
import { MEMORY_LEXICAL_ANALYSIS_PROFILE } from "../../persistence/lexical";
import {
  OpenSearchTransportError
} from "../../../search/opensearch/coreTransport";
import {
  createMemoryOpenSearchClient,
  type MemoryOpenSearchClient
} from "../../../search/opensearch/memoryClient";
import {
  MEMORY_OPENSEARCH_ANALYSIS_PROFILE,
  MEMORY_OPENSEARCH_BACKEND_KIND,
  MEMORY_OPENSEARCH_MAPPING_VERSION,
  MEMORY_OPENSEARCH_NORMALIZATION_VERSION,
  MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION,
  memoryOpenSearchConfigurationFromEnv,
  memoryOpenSearchProjectionFingerprint
} from "../../../search/opensearch/memoryContract";
import {
  MEMORY_READ_BUDGET_MS,
  MemoryReadBudgetError,
  withMemoryReadBudget
} from "../readBudget";
import {
  assertMemoryLexicalSearchRequest,
  assertMemoryLexicalSearchResult,
  memoryLexicalProjectionReadinessScope,
  type MemoryLexicalCandidateProvider,
  type MemoryLexicalFailureCode,
  type MemoryLexicalMatchMode,
  type MemoryLexicalProviderEvidence,
  type MemoryLexicalSearchRequest,
  type MemoryLexicalSearchResult
} from "./contract";
import type { PostgresUnicodeMemoryLexicalLane } from
  "./postgresUnicodeProvider";

type ProjectionReadinessRow = Readonly<{
  analysisProfile: string;
  backendKind: string;
  enqueuedThroughSequence: bigint;
  expectedContentFingerprint: string | null;
  expectedDocumentCount: number | null;
  generationIndexedThroughMemoryRevision: number;
  generationState: string;
  generationTargetMemoryRevision: number;
  lastSuccessfulRefreshAt: Date | null;
  mappingVersion: string;
  noOutstandingEvents: boolean;
  normalizationVersion: string;
  projectedThroughRevision: number;
  projectionFingerprint: string | null;
  readyAt: Date | null;
  retrievalPipelineVersion: string;
  status: string;
  targetMemoryRevision: number;
  visibleContentFingerprint: string | null;
  visibleDocumentCount: number | null;
  visibleThroughSequence: bigint;
}>;

export type MemoryOpenSearchProjectionReadiness = Readonly<{
  caughtUp: boolean;
  eventLag: number | null;
  revisionLag: number | null;
  visibleAgeMs: number | null;
}>;

type ProjectionReadinessScopeEntry = Readonly<{
  activeGenerationId: string;
  client: PrismaClient;
  configurationFingerprint: string;
  memoryRevisionSnapshot: number;
  readiness: Promise<MemoryOpenSearchProjectionReadiness>;
  userId: string;
}>;

const projectionReadinessByScope = new WeakMap<
  object,
  ProjectionReadinessScopeEntry
>();

function boundedLag(value: bigint): number {
  if (value <= 0n) return 0;
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(value > maximum ? maximum : value);
}

async function queryMemoryOpenSearchProjectionReadiness(
  client: PrismaClient,
  request: MemoryLexicalSearchRequest,
  env: NodeJS.ProcessEnv = process.env
): Promise<MemoryOpenSearchProjectionReadiness> {
  assertMemoryLexicalSearchRequest(request);
  const remainingMs = Math.min(
    MEMORY_READ_BUDGET_MS.PROJECTION_READINESS,
    request.deadlineAtMs - Date.now()
  );
  if (!Number.isSafeInteger(remainingMs) || remainingMs < 1) {
    throw new MemoryReadBudgetError("memory_read_statement_timeout");
  }
  const [row] = await withMemoryReadBudget(
    client,
    remainingMs,
    (tx) => tx.$queryRaw<ProjectionReadinessRow[]>(Prisma.sql`
      /* aiqsa_memory_retrieval_lane:OPENSEARCH_PROJECTION_READINESS */
      SELECT
        state."analysisProfile",
        state."backendKind",
        state."enqueuedThroughSequence",
        state."expectedContentFingerprint",
        state."expectedDocumentCount",
        generation."indexedThroughMemoryRevision" AS
          "generationIndexedThroughMemoryRevision",
        generation."state"::text AS "generationState",
        generation."targetMemoryRevision" AS "generationTargetMemoryRevision",
        state."lastSuccessfulRefreshAt",
        state."mappingVersion",
        NOT EXISTS (
          SELECT 1
          FROM "MemoryLexicalProjectionEvent" AS event
          WHERE event."userId" = state."userId"
            AND event."sequence" <= state."enqueuedThroughSequence"
            AND event."state" <>
              'SUCCEEDED'::"MemoryLexicalProjectionEventState"
        ) AS "noOutstandingEvents",
        state."normalizationVersion",
        state."projectedThroughRevision",
        state."projectionFingerprint",
        state."readyAt",
        state."retrievalPipelineVersion",
        state."status"::text AS "status",
        state."targetMemoryRevision",
        state."visibleContentFingerprint",
        state."visibleDocumentCount",
        state."visibleThroughSequence"
      FROM "MemoryLexicalProjectionState" AS state
      INNER JOIN "MemoryIndexGeneration" AS generation
        ON generation."userId" = state."userId"
        AND generation."id" = state."indexGenerationId"
      WHERE state."userId" = ${request.userId}
        AND state."indexGenerationId" = ${request.activeGenerationId}
      LIMIT 1
    `)
  );
  if (!row) return Object.freeze({
    caughtUp: false,
    eventLag: null,
    revisionLag: null,
    visibleAgeMs: null
  });
  const configuration = memoryOpenSearchConfigurationFromEnv(env);
  const contractFingerprint = memoryOpenSearchProjectionFingerprint(configuration);
  const eventLag = boundedLag(
    row.enqueuedThroughSequence - row.visibleThroughSequence
  );
  const revisionLag = Math.max(
    0,
    request.memoryRevisionSnapshot - row.projectedThroughRevision
  );
  const visibleAgeMs = row.lastSuccessfulRefreshAt
    ? Math.min(
        Number.MAX_SAFE_INTEGER,
        Math.max(0, Date.now() - row.lastSuccessfulRefreshAt.getTime())
      )
    : null;
  const caughtUp = row.status === "READY" && row.generationState === "ACTIVE" &&
    row.backendKind === MEMORY_OPENSEARCH_BACKEND_KIND &&
    row.mappingVersion === MEMORY_OPENSEARCH_MAPPING_VERSION &&
    row.normalizationVersion === MEMORY_OPENSEARCH_NORMALIZATION_VERSION &&
    row.analysisProfile === MEMORY_OPENSEARCH_ANALYSIS_PROFILE &&
    row.retrievalPipelineVersion ===
      MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION &&
    row.projectionFingerprint === contractFingerprint &&
    row.targetMemoryRevision === request.memoryRevisionSnapshot &&
    row.projectedThroughRevision === request.memoryRevisionSnapshot &&
    row.generationTargetMemoryRevision <= request.memoryRevisionSnapshot &&
    row.generationIndexedThroughMemoryRevision >= request.memoryRevisionSnapshot &&
    row.enqueuedThroughSequence === row.visibleThroughSequence &&
    row.expectedDocumentCount !== null &&
    row.expectedDocumentCount === row.visibleDocumentCount &&
    row.expectedContentFingerprint !== null &&
    row.expectedContentFingerprint === row.visibleContentFingerprint &&
    row.lastSuccessfulRefreshAt !== null && row.readyAt !== null &&
    row.noOutstandingEvents;
  return Object.freeze({ caughtUp, eventLag, revisionLag, visibleAgeMs });
}

/** Coalesces the PostgreSQL readiness fence across every lexical lane issued
 * from one frozen retrieval snapshot. The weak, symbol-keyed scope cannot be
 * serialized or reused by another request, so no readiness result crosses an
 * authority snapshot or becomes a process-wide TTL cache. */
export function readMemoryOpenSearchProjectionReadiness(
  client: PrismaClient,
  request: MemoryLexicalSearchRequest,
  env: NodeJS.ProcessEnv = process.env
): Promise<MemoryOpenSearchProjectionReadiness> {
  assertMemoryLexicalSearchRequest(request);
  const scope = request[memoryLexicalProjectionReadinessScope];
  if (!scope) return queryMemoryOpenSearchProjectionReadiness(client, request, env);
  const configurationFingerprint = memoryOpenSearchProjectionFingerprint(
    memoryOpenSearchConfigurationFromEnv(env)
  );
  const current = projectionReadinessByScope.get(scope);
  if (current) {
    if (current.client !== client || current.userId !== request.userId ||
      current.activeGenerationId !== request.activeGenerationId ||
      current.memoryRevisionSnapshot !== request.memoryRevisionSnapshot ||
      current.configurationFingerprint !== configurationFingerprint) {
      throw new Error("memory_lexical_search_request_invalid");
    }
    return current.readiness;
  }
  const readiness = queryMemoryOpenSearchProjectionReadiness(client, request, env);
  projectionReadinessByScope.set(scope, Object.freeze({
    activeGenerationId: request.activeGenerationId,
    client,
    configurationFingerprint,
    memoryRevisionSnapshot: request.memoryRevisionSnapshot,
    readiness,
    userId: request.userId
  }));
  return readiness;
}

function expectedFamily(
  lane: PostgresUnicodeMemoryLexicalLane
): MemoryLexicalSearchRequest["itemFamily"] {
  return lane.startsWith("FACT_") ? "FACT" : "HISTORY";
}

function openSearchFailureCode(error: unknown): Readonly<{
  code: MemoryLexicalFailureCode;
  timedOut: boolean;
}> {
  if (error instanceof MemoryReadBudgetError) {
    return Object.freeze({ code: error.code, timedOut: true });
  }
  if (error instanceof OpenSearchTransportError) {
    const mapped = `memory_${error.code}`;
    const accepted = new Set<MemoryLexicalFailureCode>([
      "memory_opensearch_authentication_failed",
      "memory_opensearch_connection_failed",
      "memory_opensearch_index_incompatible",
      "memory_opensearch_index_missing",
      "memory_opensearch_rate_limited",
      "memory_opensearch_response_invalid",
      "memory_opensearch_response_too_large",
      "memory_opensearch_scope_too_large",
      "memory_opensearch_timeout",
      "memory_opensearch_unavailable"
    ]);
    if (accepted.has(mapped as MemoryLexicalFailureCode)) {
      return Object.freeze({
        code: mapped as MemoryLexicalFailureCode,
        timedOut: error.timedOut || error.code === "opensearch_timeout"
      });
    }
  }
  return Object.freeze({
    code: "memory_lexical_lane_unavailable",
    timedOut: false
  });
}

function singleMatchMode(
  candidates: MemoryLexicalSearchResult["candidates"]
): MemoryLexicalMatchMode | null {
  const modes = new Set(candidates.map(({ matchMode }) => matchMode));
  return modes.size === 1 ? [...modes][0]! : null;
}

export class OpenSearchMemoryLexicalCandidateProvider implements
MemoryLexicalCandidateProvider {
  readonly backend = "OPENSEARCH" as const;

  constructor(
    private readonly client: PrismaClient,
    readonly lane: PostgresUnicodeMemoryLexicalLane,
    private readonly searchClient: MemoryOpenSearchClient,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  async prepare(request: MemoryLexicalSearchRequest): Promise<void> {
    assertMemoryLexicalSearchRequest(request);
    if (request.analysisProfileVersion !== MEMORY_LEXICAL_ANALYSIS_PROFILE ||
      request.itemFamily !== expectedFamily(this.lane)) {
      throw new Error("memory_lexical_search_request_invalid");
    }
    await readMemoryOpenSearchProjectionReadiness(
      this.client,
      request,
      this.env
    );
  }

  async search(request: MemoryLexicalSearchRequest): Promise<MemoryLexicalSearchResult> {
    assertMemoryLexicalSearchRequest(request);
    if (request.analysisProfileVersion !== MEMORY_LEXICAL_ANALYSIS_PROFILE ||
      request.itemFamily !== expectedFamily(this.lane)) {
      throw new Error("memory_lexical_search_request_invalid");
    }
    const startedAt = Date.now();
    let readiness: MemoryOpenSearchProjectionReadiness = Object.freeze({
      caughtUp: false,
      eventLag: null,
      revisionLag: null,
      visibleAgeMs: null
    });
    let candidates: MemoryLexicalSearchResult["candidates"] = Object.freeze([]);
    let failureCode: MemoryLexicalProviderEvidence["failureCode"] = null;
    let opaqueId: string | null = null;
    let timedOut = false;
    try {
      readiness = await readMemoryOpenSearchProjectionReadiness(
        this.client,
        request,
        this.env
      );
      if (!readiness.caughtUp) {
        failureCode = "memory_lexical_projection_not_ready";
      } else {
        const searched = await this.searchClient.searchLexical({
          phase: this.lane.endsWith("_NGRAM") ? "FALLBACK" : "PRIMARY",
          request
        });
        candidates = searched.candidates;
        opaqueId = searched.opaqueId;
      }
    } catch (error) {
      const failure = openSearchFailureCode(error);
      failureCode = failure.code;
      timedOut = failure.timedOut;
    }
    const result = Object.freeze({
      candidates,
      evidence: Object.freeze({
        backend: "OPENSEARCH" as const,
        durationMs: Math.min(60_000, Math.max(0, Date.now() - startedAt)),
        failureCode,
        fallbackUsed: this.lane.endsWith("_NGRAM"),
        lane: this.lane,
        matchMode: singleMatchMode(candidates),
        opaqueId,
        projectionCaughtUp: readiness.caughtUp,
        projectionEventLag: readiness.eventLag,
        projectionRevisionLag: readiness.revisionLag,
        projectionVisibleAgeMs: readiness.visibleAgeMs,
        rawCandidateCount: candidates.length,
        requestedLimit: request.finalLimit,
        timedOut
      })
    });
    assertMemoryLexicalSearchResult(request, result, "OPENSEARCH");
    return result;
  }
}

export function createOpenSearchMemoryLexicalCandidateProvider(
  client: PrismaClient,
  lane: PostgresUnicodeMemoryLexicalLane,
  env: NodeJS.ProcessEnv = process.env,
  searchClient: MemoryOpenSearchClient = createMemoryOpenSearchClient(env)
): MemoryLexicalCandidateProvider {
  return new OpenSearchMemoryLexicalCandidateProvider(
    client,
    lane,
    searchClient,
    env
  );
}

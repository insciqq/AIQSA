import { Prisma, type PrismaClient } from "@prisma/client";
import { KNOWLEDGE_CITATION_V2_MAX } from "../../contracts/knowledge";
import {
  KNOWLEDGE_EVIDENCE_CITATION_CONTRACT,
  KNOWLEDGE_EVIDENCE_PROVENANCE_VERSION,
  knowledgeEvidenceConfidenceBucket,
  knowledgeEvidenceReceiptHash,
  type KnowledgeEvidencePackage,
  type KnowledgeEvidencePackageItem,
  type KnowledgeEvidenceRetrievalProvenance
} from "./evidencePackage";
import {
  groundKnowledgeAnswer,
  type KnowledgeGroundingResult
} from "./grounding";
import {
  decodeKnowledgeBudgetPolicy,
  isKnowledgeOperationKind
} from "./knowledgeBudget";
import {
  decodeKnowledgePlannerPlan,
  knowledgePlannerIntents,
  knowledgePlannerStrategies,
  type KnowledgePlannerIntent,
  type KnowledgePlannerStrategy
} from "./planner";
import type {
  KnowledgeCandidateSignal,
  KnowledgeRetrievalLane
} from "./retrievalRanking";
import {
  decodeStructuredAnalysisResult,
  type StructuredInputRange
} from "./structuredData";
import { decodeKnowledgeVisualAnalysisResult } from "./visualEvidence";

type EvidenceClient = PrismaClient | Prisma.TransactionClient;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function excludedResourceCount(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.reduce<number>((total, entry) => {
    if (!record(entry)) return total;
    const count = integer(entry.count);
    return total + (count ?? 0);
  }, 0);
}

/**
 * A selected Knowledge scope with no ready evidence still needs an immutable
 * receipt. Creating the empty session before final grounding makes the
 * no-answer policy deterministic instead of trusting the provider prompt.
 */
export async function ensureKnowledgeEvidenceSession(
  client: EvidenceClient,
  input: Readonly<{ runId: string; userId: string }>
): Promise<boolean> {
  const existing = await client.knowledgeRetrievalSession.findUnique({
    select: { id: true },
    where: { modelRunId: input.runId }
  });
  if (existing) return true;

  const context = await client.modelRun.findFirst({
    select: {
      knowledgeRunScope: {
        select: {
          budgetPolicy: true,
          exclusions: true,
          resolvedBaseCount: true,
          resolvedSourceCount: true,
          selection: true
        }
      },
      normalizedRequest: true
    },
    where: { id: input.runId, userId: input.userId }
  });
  const normalizedRequest = record(context?.normalizedRequest)
    ? context.normalizedRequest
    : null;
  const decodedPlanner = normalizedRequest
    ? decodeKnowledgePlannerPlan(normalizedRequest.knowledgePlanner)
    : null;
  const scope = context?.knowledgeRunScope;
  if (!scope || !decodedPlanner?.ok ||
    decodedPlanner.plan.intent === "no_knowledge_needed") return false;

  const planner = decodedPlanner.plan;
  const excludedResources = excludedResourceCount(scope.exclusions);
  const degradedFlags = new Set<string>([
    ...(planner.status === "degraded" ? ["planner_degraded"] : []),
    ...(planner.failureCode ? [planner.failureCode] : []),
    ...(excludedResources > 0 ? ["partial_readiness"] : []),
    ...(scope.resolvedBaseCount === 0 || scope.resolvedSourceCount === 0
      ? ["no_ready_evidence"]
      : [])
  ]);
  await client.knowledgeRetrievalSession.upsert({
    create: {
      citationContract: inputJson(KNOWLEDGE_EVIDENCE_CITATION_CONTRACT),
      coverageRequirements: inputJson({ ...planner.coverage, verified: false }),
      degradedFlags: [...degradedFlags].sort(),
      modelRunId: input.runId,
      originalIntent: inputJson({ intent: planner.intent, query: planner.originalQuery }),
      readinessSummary: inputJson({
        excludedResources,
        readyBases: scope.resolvedBaseCount,
        readySources: scope.resolvedSourceCount
      }),
      scopeSnapshot: inputJson({
        budgetPolicy: scope.budgetPolicy,
        exclusions: scope.exclusions,
        resolvedBaseCount: scope.resolvedBaseCount,
        resolvedSourceCount: scope.resolvedSourceCount,
        selection: scope.selection
      }),
      strategySnapshot: inputJson({
        automaticRetrieval: planner.automaticRetrieval,
        evidenceMode: planner.evidenceMode,
        failureCode: planner.failureCode ?? null,
        status: planner.status,
        strategy: planner.strategy
      }),
      version: 2
    },
    update: {},
    where: { modelRunId: input.runId }
  });
  return true;
}

function integer(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER
): number | null {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : null;
}

function string(value: unknown, maximum = 8_000): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !/\u0000/u.test(value) ? value : null;
}

function stringArray(value: unknown, maximumItems: number, maximumLength: number): string[] | null {
  return Array.isArray(value) && value.length <= maximumItems && value.every((entry) =>
    typeof entry === "string" && entry.length <= maximumLength && !/\u0000/u.test(entry))
    ? value as string[]
    : null;
}

const retrievalLanes = new Set<KnowledgeRetrievalLane>([
  "document_lexical",
  "exact",
  "metadata",
  "neighbor",
  "passage_lexical",
  "passage_semantic",
  "section_lexical"
]);

function finite(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum &&
    value <= maximum ? value : null;
}

function retrievalSignal(value: unknown): KnowledgeCandidateSignal | null {
  if (!record(value)) return null;
  const keys = ["exactKind", "lane", "rank", "rawScore", "vectorDistance", "vectorMode"];
  const rank = integer(value.rank, 1, 100);
  const rawScore = finite(value.rawScore, -1_000_000_000, 1_000_000_000);
  const vectorDistance = value.vectorDistance === null
    ? null
    : finite(value.vectorDistance, 0, 2);
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) ||
    (value.exactKind !== null && !string(value.exactKind, 128)) ||
    typeof value.lane !== "string" || !retrievalLanes.has(value.lane as KnowledgeRetrievalLane) ||
    rank === null || rawScore === null ||
    (value.vectorMode !== null && value.vectorMode !== "ann" && value.vectorMode !== "exact") ||
    (value.vectorMode === null) !== (vectorDistance === null)) return null;
  return {
    exactKind: value.exactKind as string | null,
    lane: value.lane as KnowledgeRetrievalLane,
    rank,
    rawScore,
    vectorDistance,
    vectorMode: value.vectorMode as "ann" | "exact" | null
  };
}

type EvidenceOperationLink = Readonly<{
  knowledgeRun: Readonly<{
    fusion: string;
    invocationOrdinal: number;
    operation: string;
  }>;
  knowledgeRunId: string;
  resultOrdinal: number;
  retrievalProvenance: Prisma.JsonValue;
}>;

function retrievalProvenance(
  link: EvidenceOperationLink,
  maximumOperations: number
): KnowledgeEvidenceRetrievalProvenance | null {
  const value = link.retrievalProvenance;
  if (!record(value)) return null;
  const keys = [
    "confidence",
    "confidenceBucket",
    "fusion",
    "invocationOrdinal",
    "operation",
    "postRerankRank",
    "preRerankRank",
    "rerankScore",
    "signals",
    "version"
  ];
  const confidence = value.confidence === null ? null : finite(value.confidence, 0, 1);
  const invocationOrdinal = integer(value.invocationOrdinal, 1, maximumOperations);
  const postRerankRank = integer(value.postRerankRank, 1, 1_000);
  const preRerankRank = integer(value.preRerankRank, 1, 1_000);
  const rerankScore = value.rerankScore === null ? null : finite(value.rerankScore, 0, 1);
  const resultOrdinal = integer(link.resultOrdinal, 0, 7);
  const signals = Array.isArray(value.signals) && value.signals.length <= 100
    ? value.signals.map(retrievalSignal)
    : null;
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) ||
    !string(link.knowledgeRunId, 512) || resultOrdinal === null ||
    value.version !== KNOWLEDGE_EVIDENCE_PROVENANCE_VERSION ||
    (value.fusion !== "rrf_k60" && value.fusion !== "weighted_rrf_v2") ||
    value.fusion !== link.knowledgeRun.fusion || invocationOrdinal === null ||
    invocationOrdinal !== link.knowledgeRun.invocationOrdinal ||
    !isKnowledgeOperationKind(value.operation) || value.operation !== link.knowledgeRun.operation ||
    postRerankRank === null || preRerankRank === null ||
    (value.confidence !== null && confidence === null) ||
    value.confidenceBucket !== knowledgeEvidenceConfidenceBucket(confidence) ||
    (value.rerankScore !== null && rerankScore === null) || !signals ||
    signals.some((signal) => signal === null)) return null;
  return {
    confidence,
    confidenceBucket: value.confidenceBucket as KnowledgeEvidenceRetrievalProvenance["confidenceBucket"],
    fusion: value.fusion,
    invocationOrdinal,
    operation: value.operation,
    operationId: link.knowledgeRunId,
    postRerankRank,
    preRerankRank,
    rerankScore,
    resultOrdinal,
    signals: signals as KnowledgeCandidateSignal[],
    version: KNOWLEDGE_EVIDENCE_PROVENANCE_VERSION
  };
}

function locator(value: unknown): KnowledgeEvidencePackageItem["locator"] | undefined {
  if (value === null) return null;
  if (!record(value)) return undefined;
  const page = integer(value.page, 1);
  if (page === null) return undefined;
  const ranges = value.ranges === undefined
    ? undefined
    : Array.isArray(value.ranges) && value.ranges.length > 0 && value.ranges.length <= 64
      ? value.ranges.map((candidate): StructuredInputRange | null => {
          if (!record(candidate) || typeof candidate.range !== "string" ||
            !/^[A-Z]{1,3}[1-9]\d*:[A-Z]{1,3}[1-9]\d*$/u.test(candidate.range) ||
            typeof candidate.sheet !== "string" || !candidate.sheet || candidate.sheet.length > 256 ||
            !Number.isSafeInteger(candidate.sheetIndex) || Number(candidate.sheetIndex) < 0 ||
            Number(candidate.sheetIndex) >= 64 ||
            !["filter", "group", "join", "read", "sort", "value"].includes(String(candidate.role))) {
            return null;
          }
          return {
            range: candidate.range,
            role: candidate.role as StructuredInputRange["role"],
            sheet: candidate.sheet,
            sheetIndex: Number(candidate.sheetIndex)
          };
        })
      : null;
  if (ranges === null || ranges?.some((range) => range === null)) return undefined;
  const decodedRanges = ranges as StructuredInputRange[] | undefined;
  if (value.blockCoordinates === undefined) {
    return { page, ...(decodedRanges ? { ranges: decodedRanges } : {}) };
  }
  if (!Array.isArray(value.blockCoordinates) || value.blockCoordinates.length > 256) {
    return undefined;
  }
  const coordinates = value.blockCoordinates.map((entry) => {
    if (!record(entry)) return null;
    const coordinatePage = integer(entry.page, 1);
    const values = [entry.x, entry.y, entry.width, entry.height];
    if (coordinatePage === null || values.some((candidate) =>
      typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0)) return null;
    return {
      height: Number(entry.height),
      page: coordinatePage,
      width: Number(entry.width),
      x: Number(entry.x),
      y: Number(entry.y)
    };
  });
  return coordinates.some((entry) => entry === null)
    ? undefined
    : {
        blockCoordinates: coordinates as NonNullable<typeof coordinates[number]>[],
        page,
        ...(decodedRanges ? { ranges: decodedRanges } : {})
      };
}

function contextBoundaries(
  value: unknown
): KnowledgeEvidencePackageItem["contextBoundaries"] | undefined {
  if (value === null) return null;
  if (!record(value) || typeof value.expanded !== "boolean") return undefined;
  const excerptBytes = integer(value.excerptBytes);
  const layoutKind = value.layoutKind === undefined
    ? undefined
    : value.layoutKind === "body" || value.layoutKind === "table_ambiguous" ||
      value.layoutKind === "table_row"
      ? value.layoutKind
      : null;
  const sourceTextBytes = integer(value.sourceTextBytes);
  const structuredAnalysis = value.structuredAnalysis === undefined
    ? undefined
    : decodeStructuredAnalysisResult(value.structuredAnalysis) ?? null;
  const visualAnalysis = value.visualAnalysis === undefined
    ? undefined
    : decodeKnowledgeVisualAnalysisResult(value.visualAnalysis) ?? null;
  return excerptBytes === null || layoutKind === null || sourceTextBytes === null ||
    sourceTextBytes < excerptBytes
    || structuredAnalysis === null || visualAnalysis === null ||
      structuredAnalysis !== undefined && visualAnalysis !== undefined
    ? undefined
    : {
        expanded: value.expanded,
        excerptBytes,
        ...(layoutKind !== undefined ? { layoutKind } : {}),
        sourceTextBytes,
        ...(structuredAnalysis ? { structuredAnalysis } : {}),
        ...(visualAnalysis ? { visualAnalysis } : {})
      };
}

function evidenceItem(value: Readonly<{
  baseName: string | null;
  contentHash: string | null;
  contextBoundaries: Prisma.JsonValue | null;
  documentId: string | null;
  documentVersionId: string | null;
  excerpt: string | null;
  fileName: string | null;
  handle: string;
  headingPath: string[];
  id: string;
  knowledgeBaseId: string | null;
  locator: Prisma.JsonValue | null;
  operationLinks: readonly EvidenceOperationLink[];
  ordinal: number;
  page: number | null;
  passageId: string | null;
  sectionId: string | null;
  sourceArtifactId: string | null;
  sourceId: string | null;
  sourceName: string | null;
  sourceVersionId: string | null;
  sourceVersionNumber: number | null;
  state: string;
  textTruncated: boolean | null;
}>, maximumOperations: number): KnowledgeEvidencePackageItem | null {
  if (!Number.isSafeInteger(value.ordinal) || value.ordinal < 1 ||
    value.ordinal > KNOWLEDGE_CITATION_V2_MAX || value.handle !== `K${value.ordinal}` ||
    (value.state !== "available" && value.state !== "deleted") ||
    !string(value.id, 512) || value.headingPath.length > 64 ||
    value.headingPath.some((entry) => !string(entry, 512)) ||
    value.operationLinks.length > maximumOperations) {
    return null;
  }
  const decodedLocator = locator(value.locator);
  const boundaries = contextBoundaries(value.contextBoundaries);
  const decodedProvenance = value.operationLinks.map((link) =>
    retrievalProvenance(link, maximumOperations));
  if (decodedLocator === undefined || boundaries === undefined ||
    decodedProvenance.some((entry) => entry === null)) return null;
  const provenance = (decodedProvenance as KnowledgeEvidenceRetrievalProvenance[]).sort(
    (left, right) => left.invocationOrdinal - right.invocationOrdinal ||
      left.operationId.localeCompare(right.operationId) || left.resultOrdinal - right.resultOrdinal
  );
  if (value.state === "deleted") {
    if ([
      value.baseName, value.contentHash, value.documentId, value.documentVersionId, value.excerpt,
      value.fileName, value.knowledgeBaseId, value.page, value.passageId, value.sectionId,
      value.sourceArtifactId, value.sourceId, value.sourceName, value.sourceVersionId,
      value.sourceVersionNumber, value.textTruncated
    ].some((entry) => entry !== null) || value.headingPath.length > 0 || provenance.length > 0 ||
      decodedLocator !== null || boundaries !== null) return null;
  } else if (!value.baseName || !value.documentId || !value.documentVersionId ||
    !value.excerpt || !value.fileName || !value.knowledgeBaseId || value.page === null ||
    !value.passageId || !value.sourceVersionId || value.sourceVersionNumber === null ||
    value.textTruncated === null || decodedLocator === null || boundaries === null ||
    provenance.length === 0 || !string(value.baseName, 1_024) ||
    !string(value.documentId, 512) || !string(value.documentVersionId, 512) ||
    !string(value.excerpt, 64 * 1_024) || !string(value.fileName, 1_024) ||
    !string(value.knowledgeBaseId, 512) || !string(value.passageId, 512) ||
    !string(value.sourceVersionId, 512) || integer(value.sourceVersionNumber, 1) === null ||
    integer(value.page, 1) === null || value.page !== decodedLocator.page ||
    Buffer.byteLength(value.excerpt, "utf8") !== boundaries.excerptBytes ||
    value.textTruncated !== boundaries.expanded ||
    (value.contentHash !== null && !/^[0-9a-f]{64}$/u.test(value.contentHash)) ||
    (value.sectionId !== null && !string(value.sectionId, 512)) ||
    (value.sourceArtifactId !== null && !string(value.sourceArtifactId, 512)) ||
    (value.sourceId !== null && !string(value.sourceId, 512)) ||
    (value.sourceName !== null && !string(value.sourceName, 1_024))) return null;
  return {
    baseName: value.baseName,
    contentHash: value.contentHash,
    contextBoundaries: boundaries,
    documentId: value.documentId,
    documentVersionId: value.documentVersionId,
    excerpt: value.excerpt,
    fileName: value.fileName,
    handle: value.handle,
    headingPath: [...value.headingPath],
    id: value.id,
    knowledgeBaseId: value.knowledgeBaseId,
    locator: decodedLocator,
    ordinal: value.ordinal,
    passageId: value.passageId,
    provenance,
    sectionId: value.sectionId,
    sourceArtifactId: value.sourceArtifactId,
    sourceId: value.sourceId,
    sourceName: value.sourceName,
    sourceVersionId: value.sourceVersionId,
    sourceVersionNumber: value.sourceVersionNumber,
    state: value.state,
    textTruncated: value.textTruncated
  };
}

export async function loadKnowledgeEvidencePackage(
  client: EvidenceClient,
  input: Readonly<{ runId: string; userId: string }>
): Promise<KnowledgeEvidencePackage | null> {
  const session = await client.knowledgeRetrievalSession.findFirst({
    select: {
      citationContract: true,
      coverageRequirements: true,
      degradedFlags: true,
      evidenceItems: {
        include: {
          operationLinks: {
            select: {
              knowledgeRun: {
                select: { fusion: true, invocationOrdinal: true, operation: true }
              },
              knowledgeRunId: true,
              resultOrdinal: true,
              retrievalProvenance: true
            }
          }
        },
        orderBy: { ordinal: "asc" }
      },
      id: true,
      modelRunId: true,
      originalIntent: true,
      readinessSummary: true,
      scopeSnapshot: true,
      strategySnapshot: true,
      version: true
    },
    where: { modelRun: { id: input.runId, userId: input.userId }, modelRunId: input.runId }
  });
  if (!session || session.version !== 2 || !record(session.citationContract) ||
    !record(session.coverageRequirements) || !record(session.originalIntent) ||
    !record(session.readinessSummary) || !record(session.strategySnapshot) ||
    session.evidenceItems.length > KNOWLEDGE_CITATION_V2_MAX) return null;
  const query = string(session.originalIntent.query, 8_000);
  const intent = session.originalIntent.intent;
  const strategy = session.strategySnapshot.strategy;
  const rawStructuredClarifications = session.strategySnapshot.structuredClarifications;
  const structuredClarifications = rawStructuredClarifications === undefined
    ? undefined
    : stringArray(rawStructuredClarifications, 16, 2_000);
  const expectedPassageCount = session.coverageRequirements.expectedPassageCount === null
    ? null
    : integer(session.coverageRequirements.expectedPassageCount, 1);
  const namedTargets = stringArray(session.coverageRequirements.namedTargets, 128, 1_024);
  const readyBases = integer(session.readinessSummary.readyBases);
  const readySources = integer(session.readinessSummary.readySources);
  const excludedResources = integer(session.readinessSummary.excludedResources);
  const budgetPolicy = record(session.scopeSnapshot)
    ? decodeKnowledgeBudgetPolicy(session.scopeSnapshot.budgetPolicy)
    : null;
  const operationLinkCount = session.evidenceItems.reduce(
    (total, item) => total + item.operationLinks.length,
    0
  );
  const items = budgetPolicy
    ? session.evidenceItems.map((item) => evidenceItem(item, budgetPolicy.maxOperations))
    : [];
  if (!query || typeof intent !== "string" || !knowledgePlannerIntents.includes(
    intent as KnowledgePlannerIntent) || typeof strategy !== "string" ||
    !knowledgePlannerStrategies.includes(strategy as KnowledgePlannerStrategy) ||
    (session.coverageRequirements.expectedPassageCount !== null && expectedPassageCount === null) ||
    (session.coverageRequirements.mode !== "partial" &&
      session.coverageRequirements.mode !== "verified_only") || !namedTargets ||
    (rawStructuredClarifications !== undefined && (
      !structuredClarifications || structuredClarifications.length < 1 ||
      structuredClarifications.some((question) => !string(question, 2_000)) ||
      new Set(structuredClarifications).size !== structuredClarifications.length
    )) ||
    readyBases === null || readySources === null || excludedResources === null || !budgetPolicy ||
    operationLinkCount > budgetPolicy.maxOperations * 8 ||
    items.some((item) => item === null) || session.citationContract.version !== 2 ||
    session.citationContract.format !== KNOWLEDGE_EVIDENCE_CITATION_CONTRACT.format ||
    session.citationContract.legacyRead !== true ||
    session.citationContract.maximum !== KNOWLEDGE_EVIDENCE_CITATION_CONTRACT.maximum) return null;
  const decodedItems = items as KnowledgeEvidencePackageItem[];
  const available = decodedItems.filter((item) => item.state === "available");
  const verified = expectedPassageCount !== null && excludedResources === 0 &&
    session.degradedFlags.length === 0 && available.length === expectedPassageCount &&
    available.every((item) => item.textTruncated === false);
  return {
    citationContract: KNOWLEDGE_EVIDENCE_CITATION_CONTRACT,
    coverage: {
      expectedPassageCount,
      mode: session.coverageRequirements.mode,
      namedTargets,
      verified
    },
    degradedFlags: [...session.degradedFlags],
    items: decodedItems,
    originalIntent: { intent: intent as KnowledgePlannerIntent, query },
    readiness: { excludedResources, readyBases, readySources },
    runId: session.modelRunId,
    scopeSnapshot: session.scopeSnapshot,
    sessionId: session.id,
    strategy: strategy as KnowledgePlannerStrategy,
    ...(structuredClarifications ? { structuredClarifications: [...structuredClarifications] } : {}),
    version: 2
  };
}

export async function groundKnowledgeRunAnswer(
  client: EvidenceClient,
  input: Readonly<{ answer: string; runId: string; userId: string }>
): Promise<KnowledgeGroundingResult | null> {
  let evidence = await loadKnowledgeEvidencePackage(client, input);
  if (!evidence) {
    const ensured = await ensureKnowledgeEvidenceSession(client, input);
    if (!ensured) return null;
    evidence = await loadKnowledgeEvidencePackage(client, input);
    if (!evidence) throw new Error("knowledge_evidence_receipt_invalid");
  }
  return groundKnowledgeAnswer({ answer: input.answer, evidence });
}

export async function settleKnowledgeGrounding(
  client: Prisma.TransactionClient,
  input: KnowledgeGroundingResult
): Promise<void> {
  const rows = await client.$queryRaw<Array<{
    acceptedAt: Date | null;
    id: string;
    receiptHash: string | null;
  }>>(Prisma.sql`
    SELECT "id", "acceptedAt", "receiptHash"
    FROM "KnowledgeRetrievalSession"
    WHERE "id" = ${input.sessionId}
    FOR UPDATE
  `);
  const session = rows[0];
  if (!session) throw new Error("knowledge_evidence_session_unavailable");
  const run = await client.knowledgeRetrievalSession.findUnique({
    select: { modelRun: { select: { userId: true } }, modelRunId: true },
    where: { id: input.sessionId }
  });
  if (!run) throw new Error("knowledge_evidence_session_unavailable");
  const evidence = await loadKnowledgeEvidencePackage(client, {
    runId: run.modelRunId,
    userId: run.modelRun.userId
  });
  if (!evidence || knowledgeEvidenceReceiptHash(evidence) !== input.receiptHash) {
    throw new Error("knowledge_evidence_receipt_changed");
  }
  if (session.acceptedAt === null) {
    await client.knowledgeRetrievalSession.update({
      data: { acceptedAt: new Date(), receiptHash: input.receiptHash },
      where: { id: session.id }
    });
  } else if (session.receiptHash !== input.receiptHash) {
    throw new Error("knowledge_evidence_receipt_conflict");
  }
  const existing = await client.knowledgeGroundingResult.findUnique({
    where: { retrievalSessionId: session.id }
  });
  if (existing) {
    if (existing.finalAnswerHash !== input.finalAnswerHash ||
      existing.originalAnswerHash !== input.originalAnswerHash ||
      existing.outcome !== input.outcome || existing.repairCount !== input.repairCount) {
      throw new Error("knowledge_grounding_result_conflict");
    }
    return;
  }
  await client.knowledgeGroundingResult.create({
    data: {
      finalAnswerHash: input.finalAnswerHash,
      issues: {
        citationCoverage: input.diagnostics.citationCoverage,
        citationPrecision: input.diagnostics.citationPrecision,
        citedClaimCount: input.diagnostics.citedClaimCount,
        issueCodes: [...input.diagnostics.issueCodes],
        sourceClaimCount: input.diagnostics.sourceClaimCount,
        unsupportedClaimCount: input.diagnostics.unsupportedClaimCount,
        version: input.version
      },
      originalAnswerHash: input.originalAnswerHash,
      outcome: input.outcome,
      repairCount: input.repairCount,
      retrievalSessionId: session.id
    }
  });
}

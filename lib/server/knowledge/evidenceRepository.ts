import { Prisma, type PrismaClient } from "@prisma/client";
import { KNOWLEDGE_CITATION_V2_MAX } from "../../contracts/knowledge";
import { estimateApproxTokens } from "../../domain/contextBudget";
import {
  KNOWLEDGE_EVIDENCE_CITATION_CONTRACT,
  KNOWLEDGE_EVIDENCE_PROVENANCE_VERSION,
  KNOWLEDGE_STORED_EVIDENCE_PROVENANCE_VERSION,
  knowledgeEvidenceConfidenceBucket,
  knowledgeEvidenceReceiptHash,
  knowledgeMeasuredStrategyForPlannerStrategy,
  knowledgeStrategyCoverageVerifiedForDispatch,
  type KnowledgeEvidencePackage,
  type KnowledgeEvidencePackageItem,
  type KnowledgeEvidenceRetrievalProvenance
} from "./evidencePackage";
import {
  groundKnowledgeAnswer,
  type KnowledgeGroundingResult
} from "./grounding";
import {
  decodeKnowledgeProfileOperationRoles,
  knowledgeSemanticValidatorDeploymentReleased,
  type KnowledgeSemanticValidatorDeploymentV1
} from "./knowledgeProfile";
import {
  createKnowledgeSemanticLocalValidatorRequestV1,
  createKnowledgeSemanticShadowDiagnosticV1,
  createKnowledgeSemanticShadowContentFreeMetricsV1,
  createStructuralKnowledgeSemanticShadowDiagnosticV1,
  createUnavailableKnowledgeSemanticShadowDiagnosticV1,
  decodeKnowledgeSemanticShadowContentFreeMetricsV1,
  decodeKnowledgeSemanticShadowDiagnosticV1,
  type KnowledgeSemanticLocalValidatorExecutor,
  type KnowledgeSemanticShadowContentFreeMetricsV1,
  type KnowledgeSemanticShadowDiagnosticV1
} from "./semanticShadow";
import {
  loadFinalKnowledgeGroundingDispatch,
  type KnowledgeGroundingDispatchSelection,
  type StoredKnowledgeEvidenceDispatch
} from "./evidenceDispatchRepository";
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
import { decodeKnowledgeDocumentContext } from "./documentContext";
import {
  decodeKnowledgeStrategyCoverageReceiptV1,
  decodeKnowledgeStrategyStepEvidenceV1,
  type KnowledgeStrategyCoverageReceiptV1
} from "./knowledgeStrategyExecution";
import { knowledgeEvidencePackageForStoredSummaryGroundingV2 } from
  "./knowledgeStrategySummaryEvidence";

type EvidenceClient = PrismaClient | Prisma.TransactionClient;

export type KnowledgeSemanticShadowSettlement = Readonly<{
  contentFreeMetrics: KnowledgeSemanticShadowContentFreeMetricsV1;
  diagnostic: KnowledgeSemanticShadowDiagnosticV1;
  profileRevisionIds: readonly string[];
}>;

export type KnowledgeRunFinalizationEnvelope = Readonly<{
  grounding: KnowledgeGroundingResult;
  semanticShadow: KnowledgeSemanticShadowSettlement;
}>;

type KnowledgeSemanticValidationAuthority =
  | Readonly<{ kind: "structural" }>
  | Readonly<{
      deployment: KnowledgeSemanticValidatorDeploymentV1;
      kind: "selected_local";
      maxInputBytes: number;
      maxInputTokens: number;
      timeoutMs: number;
    }>
  | Readonly<{ kind: "unavailable" }>;

type KnowledgeGroundingEvidence = Readonly<{
  evidence: KnowledgeEvidencePackage;
  profileRevisionIds: readonly string[];
  semanticValidation: KnowledgeSemanticValidationAuthority;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
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
    strategyStepEvidence: Prisma.JsonValue | null;
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
  const commonKeys = [
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
  const storedV2 = value.version === KNOWLEDGE_STORED_EVIDENCE_PROVENANCE_VERSION;
  const keys = storedV2 ? [...commonKeys, "source"] : commonKeys;
  const confidence = value.confidence === null ? null : finite(value.confidence, 0, 1);
  const invocationOrdinal = integer(value.invocationOrdinal, 1, maximumOperations);
  const postRerankRank = integer(value.postRerankRank, 1, 1_000);
  const preRerankRank = integer(value.preRerankRank, 1, 1_000);
  const rerankScore = value.rerankScore === null ? null : finite(value.rerankScore, 0, 1);
  const exactOperation = value.operation === "find_exact" &&
    link.knowledgeRun.operation === "find_exact";
  const strategyStepEvidence = link.knowledgeRun.strategyStepEvidence === null
    ? null
    : decodeKnowledgeStrategyStepEvidenceV1(link.knowledgeRun.strategyStepEvidence);
  const highCardinalityStrategyResult = strategyStepEvidence?.kind === "exhaustive_page" ||
    strategyStepEvidence?.kind === "corpus_summary_reduce";
  const resultOrdinal = integer(
    link.resultOrdinal,
    0,
    exactOperation || highCardinalityStrategyResult ? 99 : 7
  );
  const fusion = value.fusion === "none" || value.fusion === "rrf_k60" ||
    value.fusion === "weighted_rrf_v2"
    ? value.fusion
    : null;
  const signals = Array.isArray(value.signals) && value.signals.length <= 100
    ? value.signals.map(retrievalSignal)
    : null;
  const source = storedV2 && record(value.source) ? value.source : null;
  const sourceKeys = [
    "artifactId",
    "bindings",
    "primaryBindingOrdinal",
    "sourceId",
    "sourceVersionId"
  ];
  const sourceBindings = source && Array.isArray(source.bindings) &&
    source.bindings.length >= 1 && source.bindings.length <= 128
    ? source.bindings
    : null;
  const validStoredSource = !storedV2 || Boolean(
    source && Object.keys(source).length === sourceKeys.length &&
    sourceKeys.every((key) => Object.hasOwn(source, key)) &&
    string(source.artifactId, 512) && string(source.sourceId, 512) &&
    string(source.sourceVersionId, 512) &&
    integer(source.primaryBindingOrdinal, 0, 127) !== null && sourceBindings &&
    sourceBindings.every((binding, index) => {
      if (!record(binding) || Object.keys(binding).length !== 3 ||
        !Object.hasOwn(binding, "baseName") || !Object.hasOwn(binding, "bindingOrdinal") ||
        !Object.hasOwn(binding, "knowledgeBaseId") || !string(binding.baseName, 1_024) ||
        !string(binding.knowledgeBaseId, 512)) return false;
      const ordinal = integer(binding.bindingOrdinal, 0, 127);
      const previousBinding = index > 0 ? sourceBindings[index - 1] : null;
      const previous = record(previousBinding)
        ? integer(previousBinding.bindingOrdinal, 0, 127)
        : null;
      return ordinal !== null && (index === 0 || previous !== null && previous < ordinal);
    }) && sourceBindings.some((binding) => record(binding) &&
      binding.bindingOrdinal === source.primaryBindingOrdinal)
  );
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) ||
    !string(link.knowledgeRunId, 512) || resultOrdinal === null ||
    (value.version !== KNOWLEDGE_EVIDENCE_PROVENANCE_VERSION && !storedV2) || !validStoredSource ||
    fusion === null || exactOperation !== (fusion === "none") ||
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
    fusion,
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
  const documentContext = value.documentContext === undefined
    ? undefined
    : decodeKnowledgeDocumentContext(value.documentContext) ?? null;
  const layoutKind = value.layoutKind === undefined
    ? undefined
    : value.layoutKind === "body" || value.layoutKind === "field_ambiguous" ||
      value.layoutKind === "field_pair" || value.layoutKind === "table_ambiguous" ||
      value.layoutKind === "table_row" || value.layoutKind === "table_row_projection"
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
    || documentContext === null
    || structuredAnalysis === null || visualAnalysis === null ||
      structuredAnalysis !== undefined && visualAnalysis !== undefined
    ? undefined
    : {
        expanded: value.expanded,
        ...(documentContext ? { documentContext } : {}),
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
                select: {
                  fusion: true,
                  invocationOrdinal: true,
                  operation: true,
                  strategyStepEvidence: true
                }
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
      strategyExecution: {
        select: {
          coverageReceipt: true,
          coverageReceiptHash: true,
          coverageStatus: true,
          executionHash: true,
          id: true,
          modelRunId: true,
          purgedAt: true,
          retrievalSessionId: true,
          state: true,
          strategy: true
        }
      },
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
    operationLinkCount > budgetPolicy.maxOperations * 100 ||
    items.some((item) => item === null) || session.citationContract.version !== 2 ||
    session.citationContract.format !== KNOWLEDGE_EVIDENCE_CITATION_CONTRACT.format ||
    session.citationContract.legacyRead !== true ||
    session.citationContract.maximum !== KNOWLEDGE_EVIDENCE_CITATION_CONTRACT.maximum) return null;
  const decodedItems = items as KnowledgeEvidencePackageItem[];
  const strategyExecution = session.strategyExecution;
  let strategyCoverage: KnowledgeStrategyCoverageReceiptV1 | undefined;
  if (strategyExecution) {
    if (strategyExecution.purgedAt !== null) {
      if (strategyExecution.coverageReceipt !== null ||
        strategyExecution.coverageReceiptHash !== null ||
        strategyExecution.executionHash !== null) return null;
    } else if (strategyExecution.coverageReceipt === null) {
      if (strategyExecution.coverageReceiptHash !== null ||
        strategyExecution.coverageStatus !== null) return null;
    } else {
      const decodedCoverage = decodeKnowledgeStrategyCoverageReceiptV1(
        strategyExecution.coverageReceipt
      );
      const measuredStrategy = knowledgeMeasuredStrategyForPlannerStrategy(
        strategy as KnowledgePlannerStrategy
      );
      if (!decodedCoverage || !measuredStrategy ||
        strategyExecution.modelRunId !== session.modelRunId ||
        strategyExecution.retrievalSessionId !== session.id ||
        strategyExecution.id !== decodedCoverage.executionId ||
        strategyExecution.executionHash !== decodedCoverage.executionHash ||
        strategyExecution.coverageReceiptHash !== decodedCoverage.receiptHash ||
        strategyExecution.coverageStatus !== decodedCoverage.status ||
        strategyExecution.strategy !== decodedCoverage.strategy ||
        decodedCoverage.status === "verified" && strategyExecution.state !== "settled" ||
        decodedCoverage.strategy !== measuredStrategy) return null;
      strategyCoverage = decodedCoverage;
    }
  }
  return {
    citationContract: KNOWLEDGE_EVIDENCE_CITATION_CONTRACT,
    coverage: {
      expectedPassageCount,
      mode: session.coverageRequirements.mode,
      namedTargets,
      // Final-manifest identity is unavailable at this projection boundary.
      verified: false
    },
    degradedFlags: [...session.degradedFlags],
    items: decodedItems,
    originalIntent: { intent: intent as KnowledgePlannerIntent, query },
    readiness: { excludedResources, readyBases, readySources },
    runId: session.modelRunId,
    scopeSnapshot: session.scopeSnapshot,
    sessionId: session.id,
    strategy: strategy as KnowledgePlannerStrategy,
    ...(strategyCoverage ? { strategyCoverage } : {}),
    ...(structuredClarifications ? { structuredClarifications: [...structuredClarifications] } : {}),
    version: 2
  };
}

function groundingDispatchMismatch(): never {
  throw new Error("knowledge_evidence_dispatch_grounding_mismatch");
}

/**
 * A current manifest is the exact authority for the answer-provider dispatch.
 * Its empty Profile lineage is therefore meaningful and must fail authorization
 * rather than being replaced with broader run bindings. Only receipts that
 * predate durable manifests may recover lineage from their immutable run bindings.
 */
export function knowledgeGroundingProfileRevisionIds(
  selection: KnowledgeGroundingDispatchSelection,
  legacyRunBindingProfileRevisionIds: readonly string[]
): readonly string[] {
  return Object.freeze(selection.kind === "current"
    ? [...selection.dispatch.profileRevisionIds]
    : [...new Set(legacyRunBindingProfileRevisionIds)].sort());
}

/**
 * Narrows the immutable Evidence receipt to the exact items physically sent
 * in the final settled answer-provider attempt. The manifest decoder has
 * already proved its byte/hash contract; this second boundary proves that its
 * durable item bindings still match the receipt being grounded.
 */
export function knowledgeEvidencePackageForGroundingDispatch(
  evidence: KnowledgeEvidencePackage,
  dispatch: StoredKnowledgeEvidenceDispatch
): KnowledgeEvidencePackage {
  if (dispatch.attempt.modelRunId !== evidence.runId ||
    dispatch.retrievalSessionId !== evidence.sessionId ||
    dispatch.draft.items.length !== dispatch.items.length) {
    return groundingDispatchMismatch();
  }

  const evidenceById = new Map(evidence.items.map((item) => [item.id, item]));
  const includedIds = new Set<string>();
  const storedSummaries: Array<Readonly<{
    candidate: NonNullable<StoredKnowledgeEvidenceDispatch["items"][number]["summary"]>;
    supportBindings: NonNullable<
      StoredKnowledgeEvidenceDispatch["items"][number]["summarySupportBindings"]
    >;
  }>> = [];
  for (const [index, binding] of dispatch.items.entries()) {
    const manifestItem = dispatch.draft.items[index];
    const item = evidenceById.get(binding.evidenceItemId);
    const manifestSummary = manifestItem && "kind" in manifestItem
      ? manifestItem.summary
      : null;
    const storedSummary = binding.summary ?? null;
    const storedSupportBindings = binding.summarySupportBindings ?? [];
    if (!manifestItem || binding.dispatchEvidenceId !== manifestItem.evidenceId ||
      binding.handle !== manifestItem.handle ||
      !item || item.state !== "available" || item.handle !== binding.handle ||
      item.sourceVersionId !== binding.sourceVersionId ||
      item.sourceArtifactId !== binding.sourceArtifactId ||
      item.sourceVersionNumber !== manifestItem.sourceVersionNumber ||
      item.textTruncated !== manifestItem.sourceTruncated) {
      return groundingDispatchMismatch();
    }
    if (manifestSummary || storedSummary) {
      if (!manifestSummary || !storedSummary || storedSupportBindings.length < 1 ||
        manifestSummary.candidateHash !== storedSummary.candidateHash ||
        manifestItem.text !== storedSummary.providerText ||
        manifestItem.exactExcerpt !== storedSummary.providerText ||
        manifestItem.itemHash !== storedSummary.itemHash ||
        storedSupportBindings[0]?.evidenceItemId !== binding.evidenceItemId) {
        return groundingDispatchMismatch();
      }
      storedSummaries.push({
        candidate: storedSummary,
        supportBindings: storedSupportBindings
      });
      continue;
    }
    if (storedSupportBindings.length > 0 || includedIds.has(binding.evidenceItemId) ||
      item.excerpt !== manifestItem.exactExcerpt) return groundingDispatchMismatch();
    includedIds.add(binding.evidenceItemId);
  }
  if (storedSummaries.length > 0) {
    let summaryEvidence: KnowledgeEvidencePackage;
    try {
      summaryEvidence = knowledgeEvidencePackageForStoredSummaryGroundingV2({
        evidence,
        summaries: storedSummaries
      });
    } catch {
      return groundingDispatchMismatch();
    }
    if (summaryEvidence.items.some(({ id }) => includedIds.has(id))) {
      return groundingDispatchMismatch();
    }
    for (const item of summaryEvidence.items) includedIds.add(item.id);
  }

  for (const exclusion of dispatch.exclusions) {
    if (exclusion.evidenceItemId === null) continue;
    const item = evidenceById.get(exclusion.evidenceItemId);
    if (!item || item.handle !== exclusion.handle ||
      exclusion.reason !== "deduplicated" && includedIds.has(exclusion.evidenceItemId)) {
      return groundingDispatchMismatch();
    }
  }

  const items = evidence.items.filter((item) => includedIds.has(item.id));
  if (items.length !== includedIds.size) return groundingDispatchMismatch();
  const allAvailableItemsDispatched = evidence.items.every((item) =>
    item.state !== "available" || includedIds.has(item.id));
  const noUnavailableOrBudgetExclusions = dispatch.exclusions.every((exclusion) =>
    exclusion.reason === "deduplicated");
  const strategyCoverageVerified = Boolean(evidence.strategyCoverage &&
    knowledgeStrategyCoverageVerifiedForDispatch({
      coverage: evidence.strategyCoverage,
      dispatchManifestHash: dispatch.draft.manifestHash,
      plannerStrategy: evidence.strategy
    }) &&
    evidence.strategyCoverage.dispatchExpectedItemCount === dispatch.draft.items.length &&
    evidence.strategyCoverage.dispatchIncludedItemCount === dispatch.draft.items.length &&
    dispatch.draft.exclusions.length === 0);
  return {
    ...evidence,
    coverage: {
      ...evidence.coverage,
      verified: strategyCoverageVerified && evidence.readiness.excludedResources === 0 &&
        evidence.degradedFlags.length === 0 && allAvailableItemsDispatched &&
        noUnavailableOrBudgetExclusions && evidence.items.every((item) =>
          item.state !== "available" || item.textTruncated === false)
    },
    groundingDispatch: {
      manifestHash: dispatch.draft.manifestHash,
      providerAttemptOrdinal: dispatch.attempt.ordinal,
      version: 1
    },
    items
  };
}

async function loadKnowledgeGroundingEvidencePackage(
  client: EvidenceClient,
  input: Readonly<{ runId: string; userId: string }>,
  ensureMissing: boolean
): Promise<KnowledgeGroundingEvidence | null> {
  let evidence = await loadKnowledgeEvidencePackage(client, input);
  if (!evidence && ensureMissing) {
    const ensured = await ensureKnowledgeEvidenceSession(client, input);
    if (!ensured) return null;
    evidence = await loadKnowledgeEvidencePackage(client, input);
    if (!evidence) throw new Error("knowledge_evidence_receipt_invalid");
  }
  if (!evidence) return null;
  const selection = await loadFinalKnowledgeGroundingDispatch(client, {
    modelRunId: evidence.runId,
    retrievalSessionId: evidence.sessionId
  });
  const groundingEvidence = selection.kind === "legacy"
    ? evidence
    : knowledgeEvidencePackageForGroundingDispatch(evidence, selection.dispatch);
  const currentProfileRevisionIds = selection.kind === "current"
    ? [...selection.dispatch.profileRevisionIds]
    : null;
  try {
    const bindings = await client.knowledgeRunProfileBinding.findMany({
      orderBy: { ordinal: "asc" },
      select: {
        profileRevision: {
          select: {
            egressPolicy: true,
            embeddingProviderModelId: true,
            executionAuthority: true,
            profileConfiguration: true
          }
        },
        profileRevisionId: true
      },
      where: { modelRunId: evidence.runId }
    });
    const byRevisionId = new Map(bindings.map((binding) => [binding.profileRevisionId, binding]));
    const profileRevisionIds = knowledgeGroundingProfileRevisionIds(
      selection,
      [...byRevisionId.keys()]
    );
    const exactBindings = profileRevisionIds.map((profileRevisionId) =>
      byRevisionId.get(profileRevisionId));
    const groundingRoles = profileRevisionIds.length > 0
      ? exactBindings.map((binding) => {
          if (!binding) return null;
          const roles = decodeKnowledgeProfileOperationRoles({
            configuration: binding.profileRevision.profileConfiguration,
            egressPolicy: binding.profileRevision.egressPolicy,
            embeddingProviderModelId: binding.profileRevision.embeddingProviderModelId
          });
          const role = roles?.find(({ operation }) => operation === "grounding_validation");
          return role && role.mode === "local" && role.providerModelId === null &&
            (role.semanticValidator === undefined ||
              binding.profileRevision.executionAuthority === "installation") &&
            role.profileRevision === "owning_revision" && role.rawPrivateText === false &&
            role.retention === "none" && role.logging === "content_free" &&
            role.maxCostMicros === 0 && role.maxInputBytes > 0 && role.maxInputTokens > 0 &&
            role.timeoutMs > 0 && role.allowedRepresentations.length === 2 &&
            role.allowedRepresentations[0] === "answer_claims" &&
            role.allowedRepresentations[1] === "evidence_excerpts"
            ? role
            : null;
        })
      : [];
    let semanticValidation: KnowledgeSemanticValidationAuthority = { kind: "unavailable" };
    if (groundingRoles.length > 0 && groundingRoles.every((role) => role !== null)) {
      const selected = groundingRoles.map((role) => role!.semanticValidator ?? null);
      if (selected.every((deployment) => deployment === null)) {
        semanticValidation = { kind: "structural" };
      } else if (selected.every((deployment) => deployment !== null) &&
        selected.every((deployment) =>
          knowledgeSemanticValidatorDeploymentReleased(deployment)) &&
        selected.every((deployment) => canonicalJson(deployment) === canonicalJson(selected[0]))) {
        const role = groundingRoles[0]!;
        semanticValidation = Object.freeze({
          deployment: selected[0]!,
          kind: "selected_local",
          maxInputBytes: role.maxInputBytes,
          maxInputTokens: role.maxInputTokens,
          timeoutMs: role.timeoutMs
        });
      }
    }
    return {
      evidence: groundingEvidence,
      profileRevisionIds,
      semanticValidation
    };
  } catch {
    return {
      evidence: groundingEvidence,
      profileRevisionIds: currentProfileRevisionIds ?? [],
      semanticValidation: { kind: "unavailable" }
    };
  }
}

function structuralValidator() {
  return Object.freeze({
    egress: "none" as const,
    profileId: "structural-baseline-v1",
    profileVersion: 1,
    semanticProof: false
  });
}

function selectedLocalValidator(
  deployment: KnowledgeSemanticValidatorDeploymentV1,
  semanticProof: boolean
) {
  return Object.freeze({
    egress: "local" as const,
    profileId: deployment.profileId,
    profileVersion: deployment.validatorVersion,
    semanticProof
  });
}

function unavailableSemanticShadow(input: Readonly<{
  answer: string;
  authorization: KnowledgeGroundingEvidence;
  failureReasonCode: string;
  validator?: ReturnType<typeof selectedLocalValidator>;
}>): KnowledgeSemanticShadowSettlement {
  const diagnostic = createUnavailableKnowledgeSemanticShadowDiagnosticV1({
    answer: input.answer,
    evidence: input.authorization.evidence,
    failureReasonCode: input.failureReasonCode,
    validator: input.validator ?? structuralValidator()
  });
  return Object.freeze({
    contentFreeMetrics: createKnowledgeSemanticShadowContentFreeMetricsV1(diagnostic),
    diagnostic,
    profileRevisionIds: Object.freeze([...input.authorization.profileRevisionIds])
  });
}

async function prepareKnowledgeSemanticShadow(input: Readonly<{
  answer: string;
  authorization: KnowledgeGroundingEvidence;
  executor?: KnowledgeSemanticLocalValidatorExecutor;
}>): Promise<KnowledgeSemanticShadowSettlement> {
  let diagnostic: KnowledgeSemanticShadowDiagnosticV1;
  if (input.authorization.semanticValidation.kind === "unavailable") {
    return unavailableSemanticShadow({
      answer: input.answer,
      authorization: input.authorization,
      failureReasonCode: "profile_authorization_unavailable",
    });
  }
  if (input.authorization.semanticValidation.kind === "structural") {
    try {
      diagnostic = createStructuralKnowledgeSemanticShadowDiagnosticV1({
        answer: input.answer,
        evidence: input.authorization.evidence
      });
    } catch {
      diagnostic = createUnavailableKnowledgeSemanticShadowDiagnosticV1({
        answer: input.answer,
        evidence: input.authorization.evidence,
        failureReasonCode: "shadow_preparation_failed",
        validator: structuralValidator()
      });
    }
  } else {
    const authority = input.authorization.semanticValidation;
    const unavailable = (failureReasonCode: string) => unavailableSemanticShadow({
      answer: input.answer,
      authorization: input.authorization,
      failureReasonCode,
      validator: selectedLocalValidator(authority.deployment, false)
    });
    if (!input.executor) return unavailable("local_executor_unavailable");
    if (canonicalJson(input.executor.deployment) !== canonicalJson(authority.deployment)) {
      return unavailable("local_executor_identity_mismatch");
    }
    let request;
    try {
      request = createKnowledgeSemanticLocalValidatorRequestV1({
        answer: input.answer,
        deployment: authority.deployment,
        evidence: input.authorization.evidence
      });
    } catch {
      return unavailable("local_validator_request_invalid");
    }
    const serializedRequest = JSON.stringify(request);
    if (Buffer.byteLength(serializedRequest, "utf8") > authority.maxInputBytes ||
      estimateApproxTokens(serializedRequest) > authority.maxInputTokens) {
      return unavailable("local_validator_input_too_large");
    }
    const controller = new AbortController();
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let predictions: readonly unknown[];
    try {
      predictions = await Promise.race([
        Promise.resolve().then(() => input.executor!.validate({
          request,
          signal: controller.signal
        })),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error("knowledge_semantic_local_validator_timeout"));
          }, authority.timeoutMs);
        })
      ]);
    } catch {
      return unavailable(timedOut ? "local_executor_timeout" : "local_executor_failed");
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    try {
      diagnostic = createKnowledgeSemanticShadowDiagnosticV1({
        answer: input.answer,
        evidence: input.authorization.evidence,
        executionStatus: "complete",
        predictions,
        validator: selectedLocalValidator(authority.deployment, true)
      });
    } catch {
      return unavailable("local_executor_output_invalid");
    }
  }
  try {
    return Object.freeze({
      contentFreeMetrics: createKnowledgeSemanticShadowContentFreeMetricsV1(diagnostic),
      diagnostic,
      profileRevisionIds: Object.freeze([...input.authorization.profileRevisionIds])
    });
  } catch {
    const selected = input.authorization.semanticValidation.kind === "selected_local"
      ? input.authorization.semanticValidation.deployment
      : null;
    return unavailableSemanticShadow({
      answer: input.answer,
      authorization: input.authorization,
      failureReasonCode: selected ? "local_shadow_sealing_failed" : "shadow_preparation_failed",
      ...(selected ? { validator: selectedLocalValidator(selected, false) } : {})
    });
  }
}

export async function groundKnowledgeRunAnswer(
  client: EvidenceClient,
  input: Readonly<{ answer: string; runId: string; userId: string }>,
  options: Readonly<{
    semanticShadowExecutor?: KnowledgeSemanticLocalValidatorExecutor;
  }> = {}
): Promise<KnowledgeRunFinalizationEnvelope | null> {
  const authorization = await loadKnowledgeGroundingEvidencePackage(client, input, true);
  if (!authorization) return null;
  const grounding = groundKnowledgeAnswer({
    answer: input.answer,
    evidence: authorization.evidence
  });
  return Object.freeze({
    grounding,
    semanticShadow: await prepareKnowledgeSemanticShadow({
      answer: grounding.finalText,
      authorization,
      executor: options.semanticShadowExecutor
    })
  });
}

const selectedLocalFailureReasons = new Set([
  "local_executor_failed",
  "local_executor_identity_mismatch",
  "local_executor_output_invalid",
  "local_executor_timeout",
  "local_executor_unavailable",
  "local_shadow_sealing_failed",
  "local_validator_input_too_large",
  "local_validator_request_invalid"
]);

/**
 * Rebuilds a proposed receipt from immutable answer/evidence/profile authority.
 * Settlement never invokes the executor, so recovery cannot duplicate validator
 * work or any I/O hidden behind a malformed implementation.
 */
function replayKnowledgeSemanticShadow(input: Readonly<{
  answer: string;
  authorization: KnowledgeGroundingEvidence;
  proposed: KnowledgeSemanticShadowDiagnosticV1;
}>): KnowledgeSemanticShadowSettlement | null {
  try {
    let diagnostic: KnowledgeSemanticShadowDiagnosticV1;
    if (input.authorization.semanticValidation.kind === "unavailable") {
      diagnostic = createUnavailableKnowledgeSemanticShadowDiagnosticV1({
        answer: input.answer,
        evidence: input.authorization.evidence,
        failureReasonCode: "profile_authorization_unavailable",
        validator: structuralValidator()
      });
    } else if (input.authorization.semanticValidation.kind === "structural") {
      diagnostic = createStructuralKnowledgeSemanticShadowDiagnosticV1({
        answer: input.answer,
        evidence: input.authorization.evidence
      });
    } else {
      const deployment = input.authorization.semanticValidation.deployment;
      if (input.proposed.validator.egress !== "local" ||
        input.proposed.validator.profileId !== deployment.profileId ||
        input.proposed.validator.profileVersion !== deployment.validatorVersion ||
        input.proposed.attemptId !== null || input.proposed.latencyMs !== null) return null;
      if (input.proposed.executionStatus === "complete") {
        if (!input.proposed.validator.semanticProof ||
          input.proposed.failureReasonCode !== null) return null;
        diagnostic = createKnowledgeSemanticShadowDiagnosticV1({
          answer: input.answer,
          evidence: input.authorization.evidence,
          executionStatus: "complete",
          predictions: input.proposed.claims.map((claim) => Object.freeze({
            attributableHandles: Object.freeze([...claim.attributableHandles]),
            claimOrdinal: claim.ordinal,
            confidence: claim.confidence,
            decision: claim.decision,
            reasonFamily: claim.reasonFamily,
            validatorProfile: deployment.profileId,
            validatorVersion: deployment.validatorVersion,
            version: 1 as const
          })),
          validator: selectedLocalValidator(deployment, true)
        });
      } else {
        if (input.proposed.executionStatus !== "unavailable" ||
          input.proposed.validator.semanticProof ||
          !input.proposed.failureReasonCode ||
          !selectedLocalFailureReasons.has(input.proposed.failureReasonCode)) return null;
        diagnostic = createUnavailableKnowledgeSemanticShadowDiagnosticV1({
          answer: input.answer,
          evidence: input.authorization.evidence,
          failureReasonCode: input.proposed.failureReasonCode,
          validator: selectedLocalValidator(deployment, false)
        });
      }
    }
    return Object.freeze({
      contentFreeMetrics: createKnowledgeSemanticShadowContentFreeMetricsV1(diagnostic),
      diagnostic,
      profileRevisionIds: Object.freeze([...input.authorization.profileRevisionIds])
    });
  } catch {
    return null;
  }
}

export async function settleKnowledgeGrounding(
  client: Prisma.TransactionClient,
  input: KnowledgeRunFinalizationEnvelope
): Promise<void> {
  const grounding = input.grounding;
  const rows = await client.$queryRaw<Array<{
    acceptedAt: Date | null;
    id: string;
    receiptHash: string | null;
  }>>(Prisma.sql`
    SELECT "id", "acceptedAt", "receiptHash"
    FROM "KnowledgeRetrievalSession"
    WHERE "id" = ${grounding.sessionId}
    FOR UPDATE
  `);
  const session = rows[0];
  if (!session) throw new Error("knowledge_evidence_session_unavailable");
  const run = await client.knowledgeRetrievalSession.findUnique({
    select: { modelRun: { select: { userId: true } }, modelRunId: true },
    where: { id: grounding.sessionId }
  });
  if (!run) throw new Error("knowledge_evidence_session_unavailable");
  const authorization = await loadKnowledgeGroundingEvidencePackage(client, {
    runId: run.modelRunId,
    userId: run.modelRun.userId
  }, false);
  if (!authorization || knowledgeEvidenceReceiptHash(authorization.evidence) !==
      grounding.receiptHash) {
    throw new Error("knowledge_evidence_receipt_changed");
  }
  const diagnostic = decodeKnowledgeSemanticShadowDiagnosticV1(
    input.semanticShadow.diagnostic
  );
  const metrics = decodeKnowledgeSemanticShadowContentFreeMetricsV1(
    input.semanticShadow.contentFreeMetrics
  );
  const expectedMetrics = diagnostic
    ? createKnowledgeSemanticShadowContentFreeMetricsV1(diagnostic)
    : null;
  const expectedShadow = diagnostic ? replayKnowledgeSemanticShadow({
    answer: grounding.finalText,
    authorization,
    proposed: diagnostic
  }) : null;
  const sortedProfileRevisionIds = [...input.semanticShadow.profileRevisionIds].sort();
  const exactProfiles = sortedProfileRevisionIds.length ===
      input.semanticShadow.profileRevisionIds.length &&
    new Set(sortedProfileRevisionIds).size === sortedProfileRevisionIds.length &&
    sortedProfileRevisionIds.every((value, index) =>
      value === input.semanticShadow.profileRevisionIds[index]) &&
    canonicalJson(sortedProfileRevisionIds) === canonicalJson(authorization.profileRevisionIds) &&
    expectedShadow !== null &&
    canonicalJson(input.semanticShadow.profileRevisionIds) ===
      canonicalJson(expectedShadow?.profileRevisionIds);
  const validLocalReceipt = Boolean(diagnostic && metrics && expectedMetrics && expectedShadow &&
    diagnostic.sessionId === grounding.sessionId && diagnostic.runId === run.modelRunId &&
    diagnostic.evidenceReceiptHash === grounding.receiptHash &&
    diagnostic.attemptId === null && diagnostic.blockingApplied === false &&
    diagnostic.usage.requests === 0 && diagnostic.usage.cacheWriteInputTokens === null &&
    diagnostic.usage.cachedInputTokens === null &&
    diagnostic.usage.estimatedCostMicros === null && diagnostic.usage.inputTokens === null &&
    diagnostic.usage.outputTokens === null && diagnostic.usage.reasoningTokens === null &&
    diagnostic.usage.totalTokens === null &&
    canonicalJson(metrics) === canonicalJson(expectedMetrics) &&
    canonicalJson(diagnostic) === canonicalJson(expectedShadow.diagnostic) &&
    canonicalJson(metrics) === canonicalJson(expectedShadow.contentFreeMetrics) && exactProfiles);
  if (!validLocalReceipt) {
    throw new Error("knowledge_semantic_shadow_result_invalid");
  }
  if (session.acceptedAt === null) {
    await client.knowledgeRetrievalSession.update({
      data: { acceptedAt: new Date(), receiptHash: grounding.receiptHash },
      where: { id: session.id }
    });
  } else if (session.receiptHash !== grounding.receiptHash) {
    throw new Error("knowledge_evidence_receipt_conflict");
  }
  const issues = {
    citationCoverage: grounding.diagnostics.citationCoverage,
    citationPrecision: grounding.diagnostics.citationPrecision,
    citedClaimCount: grounding.diagnostics.citedClaimCount,
    issueCodes: [...grounding.diagnostics.issueCodes],
    sourceClaimCount: grounding.diagnostics.sourceClaimCount,
    unsupportedClaimCount: grounding.diagnostics.unsupportedClaimCount,
    version: grounding.version
  };
  const existing = await client.knowledgeGroundingResult.findUnique({
    where: { retrievalSessionId: session.id }
  });
  if (existing) {
    if (existing.finalAnswerHash !== grounding.finalAnswerHash ||
      existing.originalAnswerHash !== grounding.originalAnswerHash ||
      existing.outcome !== grounding.outcome || existing.repairCount !== grounding.repairCount ||
      canonicalJson(existing.issues) !== canonicalJson(issues)) {
      throw new Error("knowledge_grounding_result_conflict");
    }
  } else {
    await client.knowledgeGroundingResult.create({
      data: {
        finalAnswerHash: grounding.finalAnswerHash,
        issues: inputJson(issues),
        originalAnswerHash: grounding.originalAnswerHash,
        outcome: grounding.outcome,
        repairCount: grounding.repairCount,
        retrievalSessionId: session.id
      }
    });
  }
  const existingShadow = await client.knowledgeSemanticShadowResult.findUnique({
    where: { retrievalSessionId: session.id }
  });
  if (existingShadow) {
    if (existingShadow.version !== diagnostic!.version || existingShadow.mode !== "shadow" ||
      existingShadow.executionStatus !== diagnostic!.executionStatus ||
      existingShadow.validatorProfile !== diagnostic!.validator.profileId ||
      existingShadow.validatorVersion !== diagnostic!.validator.profileVersion ||
      existingShadow.semanticProof !== diagnostic!.validator.semanticProof ||
      existingShadow.egressMode !== diagnostic!.validator.egress ||
      canonicalJson(existingShadow.profileRevisionIds) !== canonicalJson(sortedProfileRevisionIds) ||
      canonicalJson(existingShadow.diagnostic) !== canonicalJson(diagnostic) ||
      canonicalJson(existingShadow.contentFreeMetrics) !== canonicalJson(metrics) ||
      existingShadow.receiptHash !== diagnostic!.receiptHash || existingShadow.purgedAt !== null) {
      throw new Error("knowledge_semantic_shadow_result_conflict");
    }
    return;
  }
  await client.knowledgeSemanticShadowResult.create({
    data: {
      contentFreeMetrics: inputJson(metrics!),
      diagnostic: inputJson(diagnostic!),
      egressMode: diagnostic!.validator.egress,
      executionStatus: diagnostic!.executionStatus,
      mode: "shadow",
      profileRevisionIds: sortedProfileRevisionIds,
      receiptHash: diagnostic!.receiptHash,
      retrievalSessionId: session.id,
      semanticProof: diagnostic!.validator.semanticProof,
      validatorProfile: diagnostic!.validator.profileId,
      validatorVersion: diagnostic!.validator.profileVersion,
      version: diagnostic!.version
    }
  });
}

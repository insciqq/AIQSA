import { Prisma, type PrismaClient } from "@prisma/client";
import { KNOWLEDGE_CITATION_V2_MAX } from "../../contracts/knowledge";
import {
  KNOWLEDGE_EVIDENCE_CITATION_CONTRACT,
  KNOWLEDGE_EVIDENCE_PROVENANCE_VERSION,
  KNOWLEDGE_STORED_EVIDENCE_PROVENANCE_VERSION,
  knowledgeEvidenceConfidenceBucket,
  knowledgeEvidenceReceiptHash,
  type KnowledgeEvidencePackage,
  type KnowledgeEvidencePackageItem,
  type KnowledgeEvidenceRetrievalProvenance,
  type LegacyKnowledgeEvidenceRetrievalProvenance
} from "./evidencePackage";
import {
  groundKnowledgeAnswer,
  groundKnowledgeToolLoopAnswer,
  type KnowledgeGroundingResult
} from "./grounding";
import { KNOWLEDGE_SEARCH_TOOL_NAME } from "./retrievalTypes";
import { decodeKnowledgeParentExpansionEvidence } from "./parentContextExpansion";
import { knowledgeEvidenceFromToolResult } from "./toolResult";
import { parsePersistedToolExecutionResult } from "../runs/toolExecutionPersistence";
import { parseToolLoopCheckpoint } from "../runs/toolLoopPersistence";
import {
  loadFinalKnowledgeGroundingDispatch,
  type KnowledgeGroundingDispatchSelection,
  type StoredKnowledgeEvidenceDispatch
} from "./evidenceDispatchRepository";
import {
  decodeKnowledgeBudgetPolicy,
  isKnowledgeOperationKind
} from "./knowledgeBudget";
import { decodeKnowledgeFocusedRequest } from "./focusedRequest";
import { evidencePackageForLegacySummaryReceipt } from "./legacySummaryReceipt";
import {
  KNOWLEDGE_SIGNAL_RANK_MAX,
  type KnowledgeCandidateSignal,
  type KnowledgeRetrievalLane
} from "./retrievalRanking";
import {
  decodeStructuredAnalysisResult,
  type StructuredInputRange
} from "./structuredData";
import { decodeKnowledgeVisualAnalysisResult } from "./visualEvidence";
import { decodeKnowledgeDocumentContext } from "./documentContext";

type EvidenceClient = PrismaClient | Prisma.TransactionClient;

export type KnowledgeRunFinalizationEnvelope = Readonly<{
  grounding: KnowledgeGroundingResult;
}>;

type KnowledgeGroundingEvidence = Readonly<{
  evidence: KnowledgeEvidencePackage;
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
  const rank = integer(value.rank, 1, KNOWLEDGE_SIGNAL_RANK_MAX);
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
  const legacyKeys = [
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
  const currentStored = value.version === KNOWLEDGE_STORED_EVIDENCE_PROVENANCE_VERSION;
  const legacyStoredWithSource = value.version === 2;
  const storedWithSource = currentStored || legacyStoredWithSource;
  const keys = currentStored
    ? ["fusion", "invocationOrdinal", "operation", "signals", "source", "version"]
    : legacyStoredWithSource ? [...legacyKeys, "source"] : legacyKeys;
  const invocationOrdinal = integer(value.invocationOrdinal, 1, maximumOperations);
  const exactOperation = value.operation === "find_exact" &&
    link.knowledgeRun.operation === "find_exact";
  const resultOrdinal = integer(
    link.resultOrdinal,
    0,
    exactOperation ? 99 : 7
  );
  const fusion = value.fusion === "none" || value.fusion === "rrf_k60" ||
    value.fusion === "weighted_rrf_v2"
    ? value.fusion
    : null;
  const signals = Array.isArray(value.signals) && value.signals.length <= 100
    ? value.signals.map(retrievalSignal)
    : null;
  const source = storedWithSource && record(value.source) ? value.source : null;
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
  const validStoredSource = !storedWithSource || Boolean(
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
  const commonInvalid = Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    !string(link.knowledgeRunId, 512) || resultOrdinal === null ||
    !validStoredSource ||
    fusion === null || exactOperation !== (fusion === "none") ||
    value.fusion !== link.knowledgeRun.fusion || invocationOrdinal === null ||
    invocationOrdinal !== link.knowledgeRun.invocationOrdinal ||
    !isKnowledgeOperationKind(value.operation) || value.operation !== link.knowledgeRun.operation ||
    !signals || signals.some((signal) => signal === null);
  if (commonInvalid) return null;
  if (currentStored) {
    return {
      fusion: fusion!,
      invocationOrdinal: invocationOrdinal!,
      operation: value.operation as KnowledgeEvidenceRetrievalProvenance["operation"],
      operationId: link.knowledgeRunId,
      resultOrdinal: resultOrdinal!,
      signals: signals as KnowledgeCandidateSignal[],
      version: KNOWLEDGE_EVIDENCE_PROVENANCE_VERSION
    };
  }
  const confidence = value.confidence === null ? null : finite(value.confidence, 0, 1);
  const postRerankRank = integer(value.postRerankRank, 1, 1_000);
  const preRerankRank = integer(value.preRerankRank, 1, 1_000);
  const rerankScore = value.rerankScore === null ? null : finite(value.rerankScore, 0, 1);
  if ((value.version !== 1 && !legacyStoredWithSource) ||
    postRerankRank === null || preRerankRank === null ||
    (value.confidence !== null && confidence === null) ||
    value.confidenceBucket !== knowledgeEvidenceConfidenceBucket(confidence) ||
    (value.rerankScore !== null && rerankScore === null)) return null;
  return {
    confidence,
    confidenceBucket: value.confidenceBucket as
      LegacyKnowledgeEvidenceRetrievalProvenance["confidenceBucket"],
    fusion,
    invocationOrdinal,
    operation: value.operation as LegacyKnowledgeEvidenceRetrievalProvenance["operation"],
    operationId: link.knowledgeRunId,
    postRerankRank,
    preRerankRank,
    rerankScore,
    resultOrdinal,
    signals: signals as KnowledgeCandidateSignal[],
    version: 1
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
  const expansion = value.expansion === undefined
    ? undefined
    : decodeKnowledgeParentExpansionEvidence(value.expansion) ?? null;
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
    || documentContext === null || expansion === null
    || structuredAnalysis === null || visualAnalysis === null ||
      structuredAnalysis !== undefined && visualAnalysis !== undefined
    ? undefined
    : {
        expanded: value.expanded,
        ...(documentContext ? { documentContext } : {}),
        excerptBytes,
        ...(expansion ? { expansion } : {}),
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
}>, maximumOperations: number, allowNoProvenance = false): KnowledgeEvidencePackageItem | null {
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
    (!allowNoProvenance && provenance.length === 0) || !string(value.baseName, 1_024) ||
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
      degradedFlags: true,
      evidenceItems: {
        include: {
          operationLinks: {
            select: {
              knowledgeRun: {
                select: {
                  fusion: true,
                  invocationOrdinal: true,
                  operation: true
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
      version: true
    },
    where: { modelRun: { id: input.runId, userId: input.userId }, modelRunId: input.runId }
  });
  if (!session || session.version !== 2 || !record(session.citationContract) ||
    !record(session.originalIntent) || !record(session.readinessSummary) ||
    session.evidenceItems.length > KNOWLEDGE_CITATION_V2_MAX) return null;
  const focusedRequest = session.originalIntent.kind === "focused_v1"
    ? decodeKnowledgeFocusedRequest(session.originalIntent.request)
    : null;
  const toolLoopIntent = session.originalIntent.kind === "tool_loop_v1" &&
    Object.keys(session.originalIntent).length === 1;
  const fullContextIntent = session.originalIntent.kind === "full_context_v1" &&
    Object.keys(session.originalIntent).length === 1;
  const query = focusedRequest?.originalQuery ?? null;
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
    ? session.evidenceItems.map((item) => evidenceItem(
        item,
        budgetPolicy.maxOperations,
        fullContextIntent
      ))
    : [];
  if ((!query && !toolLoopIntent && !fullContextIntent) ||
    readyBases === null || readySources === null ||
    excludedResources === null ||
    !budgetPolicy ||
    operationLinkCount > budgetPolicy.maxOperations * 100 ||
    items.some((item) => item === null) || session.citationContract.version !== 2 ||
    session.citationContract.format !== KNOWLEDGE_EVIDENCE_CITATION_CONTRACT.format ||
    session.citationContract.legacyRead !== true ||
    session.citationContract.maximum !== KNOWLEDGE_EVIDENCE_CITATION_CONTRACT.maximum) return null;
  const decodedItems = items as KnowledgeEvidencePackageItem[];
  return {
    citationContract: KNOWLEDGE_EVIDENCE_CITATION_CONTRACT,
    coverage: {
      expectedPassageCount: fullContextIntent ? decodedItems.length : null,
      mode: fullContextIntent ? "verified_only" : "partial",
      namedTargets: [],
      // Full-corpus admission proves the expected set. The final provider
      // dispatch is rechecked independently before grounding.
      verified: fullContextIntent
    },
    degradedFlags: [...session.degradedFlags],
    items: decodedItems,
    originalIntent: toolLoopIntent
      ? { kind: "tool_loop_v1" }
      : fullContextIntent
        ? { kind: "full_context_v1" }
        : { kind: "focused_v1", query: query! },
    readiness: { excludedResources, readyBases, readySources },
    runId: session.modelRunId,
    scopeSnapshot: session.scopeSnapshot,
    sessionId: session.id,
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
  const legacySummaries: Array<Readonly<{
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
      legacySummaries.push({ candidate: storedSummary, supportBindings: storedSupportBindings });
      continue;
    }
    if (storedSupportBindings.length > 0 || includedIds.has(binding.evidenceItemId) ||
      item.excerpt !== manifestItem.exactExcerpt) return groundingDispatchMismatch();
    includedIds.add(binding.evidenceItemId);
  }
  if (legacySummaries.length > 0) {
    let summaryEvidence: KnowledgeEvidencePackage;
    try {
      summaryEvidence = evidencePackageForLegacySummaryReceipt({
        evidence,
        summaries: legacySummaries
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
  const fullContextVerified = evidence.originalIntent.kind === "full_context_v1" &&
    dispatch.exclusions.length === 0 && items.length === evidence.items.length;
  return {
    ...evidence,
    coverage: {
      ...evidence.coverage,
      verified: fullContextVerified
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
  input: Readonly<{ runId: string; userId: string }>
): Promise<KnowledgeGroundingEvidence | null> {
  const evidence = await loadKnowledgeEvidencePackage(client, input);
  if (!evidence) return null;
  if (evidence.originalIntent.kind === "tool_loop_v1") {
    const run = await client.modelRun.findFirst({
      select: {
        toolCalls: {
          orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }],
          select: {
            knowledgeRun: {
              select: {
                evidenceLinks: { select: { evidenceItemId: true } },
                providerText: true,
                retrievalSessionId: true
              }
            },
            providerCallId: true,
            result: true,
            roundIndex: true,
            state: true,
            toolName: true
          },
          where: { toolName: KNOWLEDGE_SEARCH_TOOL_NAME }
        },
        toolLoopState: true
      },
      where: { id: input.runId, userId: input.userId }
    });
    const checkpoint = parseToolLoopCheckpoint(run?.toolLoopState);
    if (!run || !checkpoint || checkpoint.phase !== "provider_running") {
      throw new Error("knowledge_evidence_dispatch_grounding_mismatch");
    }
    const visibleItemIds = new Set<string>();
    for (const call of run.toolCalls) {
      if (call.state !== "complete") {
        if (call.state !== "error" && call.roundIndex < checkpoint.roundIndex) {
          throw new Error("knowledge_evidence_dispatch_grounding_mismatch");
        }
        continue;
      }
      const stored = parsePersistedToolExecutionResult(
        { id: call.providerCallId, name: call.toolName },
        call.result as never
      );
      const retrieval = stored ? knowledgeEvidenceFromToolResult(stored) : null;
      if (!retrieval || !call.knowledgeRun ||
        call.knowledgeRun.retrievalSessionId !== evidence.sessionId ||
        retrieval.providerText !== call.knowledgeRun.providerText) {
        throw new Error("knowledge_evidence_dispatch_grounding_mismatch");
      }
      if (call.roundIndex < checkpoint.roundIndex) {
        for (const link of call.knowledgeRun.evidenceLinks) {
          visibleItemIds.add(link.evidenceItemId);
        }
      }
    }
    const items = evidence.items.filter((item) => visibleItemIds.has(item.id));
    if (items.length !== visibleItemIds.size) {
      throw new Error("knowledge_evidence_dispatch_grounding_mismatch");
    }
    return Object.freeze({
      evidence: Object.freeze({
        ...evidence,
        coverage: { ...evidence.coverage, verified: false },
        items
      })
    });
  }
  const selection = await loadFinalKnowledgeGroundingDispatch(client, {
    modelRunId: evidence.runId,
    retrievalSessionId: evidence.sessionId
  });
  const groundingEvidence = selection.kind === "legacy"
    ? evidence
    : knowledgeEvidencePackageForGroundingDispatch(evidence, selection.dispatch);
  return Object.freeze({ evidence: groundingEvidence });
}

export async function groundKnowledgeRunAnswer(
  client: EvidenceClient,
  input: Readonly<{ answer: string; runId: string; userId: string }>
): Promise<KnowledgeRunFinalizationEnvelope | null> {
  const authorization = await loadKnowledgeGroundingEvidencePackage(client, input);
  if (!authorization) {
    const run = await client.modelRun.findFirst({
      select: { normalizedRequest: true },
      where: { id: input.runId, userId: input.userId }
    });
    const normalizedRequest = record(run?.normalizedRequest) ? run.normalizedRequest : null;
    const fullContext = record(normalizedRequest?.knowledgeAnswering) &&
      normalizedRequest.knowledgeAnswering.route === "full_context_v1";
    if (normalizedRequest?.knowledgeFocusedRequest !== undefined || fullContext) {
      throw new Error("knowledge_evidence_receipt_invalid");
    }
    return null;
  }
  const grounding = authorization.evidence.originalIntent.kind === "tool_loop_v1"
    ? groundKnowledgeToolLoopAnswer({
        answer: input.answer,
        evidence: authorization.evidence
      })
    : await (async () => {
        const run = await client.modelRun.findFirst({
          select: { normalizedRequest: true },
          where: { id: input.runId, userId: input.userId }
        });
        const normalizedRequest = record(run?.normalizedRequest) ? run.normalizedRequest : null;
        const prompt = record(normalizedRequest?.prompt) ? normalizedRequest.prompt : null;
        return groundKnowledgeAnswer({
          answer: input.answer,
          evidence: authorization.evidence,
          requireBodyFormat: prompt?.knowledgeAnswerContract === 3
        });
      })();
  return Object.freeze({ grounding });
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
  });
  if (!authorization || knowledgeEvidenceReceiptHash(authorization.evidence) !==
      grounding.receiptHash) {
    throw new Error("knowledge_evidence_receipt_changed");
  }
  if (session.acceptedAt === null) {
    await client.knowledgeRetrievalSession.update({
      data: { acceptedAt: new Date(), receiptHash: grounding.receiptHash },
      where: { id: session.id }
    });
  } else if (session.receiptHash !== grounding.receiptHash) {
    throw new Error("knowledge_evidence_receipt_conflict");
  }
  const existing = await client.knowledgeGroundingResult.findUnique({
    where: { retrievalSessionId: session.id }
  });
  if (existing) {
    if (existing.finalAnswerHash !== grounding.finalAnswerHash ||
      existing.originalAnswerHash !== grounding.originalAnswerHash ||
      existing.outcome !== grounding.outcome) {
      throw new Error("knowledge_grounding_result_conflict");
    }
    return;
  }
  await client.knowledgeGroundingResult.create({
    data: {
      finalAnswerHash: grounding.finalAnswerHash,
      originalAnswerHash: grounding.originalAnswerHash,
      outcome: grounding.outcome,
      retrievalSessionId: session.id
    }
  });
}

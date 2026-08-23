import { createHash } from "node:crypto";
import { KNOWLEDGE_CITATION_V2_MAX } from "../../contracts/knowledge";
import type { KnowledgeOperationKind } from "./knowledgeBudget";
import type { KnowledgeCandidateSignal } from "./retrievalRanking";
import type { StructuredAnalysisResult, StructuredInputRange } from "./structuredData";
import type { KnowledgeVisualAnalysisResult } from "./visualEvidence";
import type { KnowledgeDocumentContextV1 } from "./documentContext";
import type { KnowledgePassageLayoutKind } from "./retrievalTypes";

export const KNOWLEDGE_EVIDENCE_PACKAGE_VERSION = 2 as const;
export const KNOWLEDGE_EVIDENCE_PROVENANCE_VERSION = 2 as const;
export const KNOWLEDGE_STORED_EVIDENCE_PROVENANCE_VERSION = 3 as const;

export type KnowledgeEvidenceConfidenceBucket =
  | "high"
  | "low"
  | "medium"
  | "unavailable";

export type LegacyKnowledgeEvidenceRetrievalProvenance = Readonly<{
  confidence: number | null;
  confidenceBucket: KnowledgeEvidenceConfidenceBucket;
  fusion: "none" | "rrf_k60" | "weighted_rrf_v2";
  invocationOrdinal: number;
  operation: KnowledgeOperationKind;
  operationId: string;
  postRerankRank: number;
  preRerankRank: number;
  rerankScore: number | null;
  resultOrdinal: number;
  signals: readonly KnowledgeCandidateSignal[];
  version: 1;
}>;

export type KnowledgeEvidenceRetrievalProvenance =
  | LegacyKnowledgeEvidenceRetrievalProvenance
  | Readonly<{
      fusion: "none" | "rrf_k60" | "weighted_rrf_v2";
      invocationOrdinal: number;
      operation: KnowledgeOperationKind;
      operationId: string;
      resultOrdinal: number;
      signals: readonly KnowledgeCandidateSignal[];
      version: typeof KNOWLEDGE_EVIDENCE_PROVENANCE_VERSION;
}>;

export type KnowledgeEvidencePackageItem = Readonly<{
  baseName: string | null;
  contentHash: string | null;
  contextBoundaries: Readonly<{
    expanded: boolean;
    documentContext?: KnowledgeDocumentContextV1;
    excerptBytes: number;
    layoutKind?: KnowledgePassageLayoutKind;
    sourceTextBytes: number;
    structuredAnalysis?: StructuredAnalysisResult;
    visualAnalysis?: KnowledgeVisualAnalysisResult;
  }> | null;
  documentId: string | null;
  documentVersionId: string | null;
  excerpt: string | null;
  fileName: string | null;
  handle: string;
  headingPath: readonly string[];
  id: string;
  knowledgeBaseId: string | null;
  locator: Readonly<{
    blockCoordinates?: readonly Readonly<{
      height: number;
      page: number;
      width: number;
      x: number;
      y: number;
    }>[];
    page: number;
    ranges?: readonly StructuredInputRange[];
  }> | null;
  ordinal: number;
  passageId: string | null;
  provenance: readonly KnowledgeEvidenceRetrievalProvenance[];
  sectionId: string | null;
  sourceArtifactId: string | null;
  sourceId: string | null;
  sourceName: string | null;
  sourceVersionId: string | null;
  sourceVersionNumber: number | null;
  state: "available" | "deleted";
  textTruncated: boolean | null;
}>;

export type KnowledgeEvidencePackage = Readonly<{
  citationContract: Readonly<{
    format: "K{ordinal}";
    legacyRead: true;
    maximum: number;
    version: 2;
  }>;
  coverage: Readonly<{
    expectedPassageCount: number | null;
    mode: "partial" | "verified_only";
    namedTargets: readonly string[];
    verified: boolean;
  }>;
  degradedFlags: readonly string[];
  items: readonly KnowledgeEvidencePackageItem[];
  originalIntent:
    | Readonly<{ kind: "focused_v1"; query: string }>
    | Readonly<{ kind: "full_context_v1" }>
    | Readonly<{ kind: "tool_loop_v1" }>;
  readiness: Readonly<{
    excludedResources: number;
    readyBases: number;
    readySources: number;
  }>;
  groundingDispatch?: Readonly<{
    manifestHash: string;
    providerAttemptOrdinal: number;
    version: 1;
  }>;
  runId: string;
  scopeSnapshot: unknown;
  sessionId: string;
  version: typeof KNOWLEDGE_EVIDENCE_PACKAGE_VERSION;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function knowledgeEvidenceConfidenceBucket(
  confidence: number | null | undefined
): KnowledgeEvidenceConfidenceBucket {
  if (confidence === null || confidence === undefined) return "unavailable";
  if (confidence >= 0.7) return "high";
  if (confidence >= 0.4) return "medium";
  return "low";
}

export function knowledgeEvidenceKey(input: Readonly<{
  documentVersionId: string;
  excerpt: string;
  knowledgeBaseId: string;
  passageId: string;
  sourceVersionId: string;
}>): string {
  return createHash("sha256").update(canonicalJson(input), "utf8").digest("hex");
}

/** Current Source-bound identity deliberately excludes Base membership. */
export function knowledgeSourceEvidenceKey(input: Readonly<{
  documentVersionId: string;
  excerpt: string;
  passageId: string;
  sourceArtifactId: string;
  sourceId: string;
  sourceVersionId: string;
}>): string {
  return createHash("sha256").update(canonicalJson(input), "utf8").digest("hex");
}

export function knowledgeEvidenceReceiptHash(
  evidence: KnowledgeEvidencePackage
): string {
  return createHash("sha256").update(canonicalJson({
    citationContract: evidence.citationContract,
    coverage: evidence.coverage,
    degradedFlags: evidence.degradedFlags,
    items: evidence.items,
    originalIntent: evidence.originalIntent,
    readiness: evidence.readiness,
    ...(evidence.groundingDispatch
      ? { groundingDispatch: evidence.groundingDispatch }
      : {}),
    runId: evidence.runId,
    scopeSnapshot: evidence.scopeSnapshot,
    sessionId: evidence.sessionId,
    version: evidence.version
  }), "utf8").digest("hex");
}

export const KNOWLEDGE_EVIDENCE_CITATION_CONTRACT = Object.freeze({
  format: "K{ordinal}" as const,
  legacyRead: true as const,
  maximum: KNOWLEDGE_CITATION_V2_MAX,
  version: 2 as const
});

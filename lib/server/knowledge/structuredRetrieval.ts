import { createHash } from "node:crypto";
import type { StorageAdapter } from "../uploads/storage";
import { decodeKnowledgeNormalizedDocument } from "./normalizedDocument";
import type { KnowledgeExtractionConfig } from "./knowledgeExtractionConfig";
import type { KnowledgeHybridPassage } from "./retrievalTypes";
import {
  executeStructuredPlan,
  StructuredDataError,
  type StructuredAnalysisResult,
  type StructuredPlan
} from "./structuredData";
import { planStructuredDataQuery } from "./structuredPlanner";

export const STRUCTURED_SOURCE_CANDIDATE_LIMIT = 16;

export type StructuredKnowledgeArtifactCandidate = Readonly<{
  artifactId: string;
  baseName: string;
  bindingOrdinal: number;
  documentId: string;
  documentVersionId: string;
  documentVersionNumber: number;
  fileName: string;
  knowledgeBaseId: string;
  normalizedTextByteSize: number;
  normalizedTextChecksum: string;
  normalizedTextStorageKey: string;
  sourceName: string;
}>;

export type StructuredKnowledgePassageAnchor = Readonly<{
  contentHash: string;
  headingPath: readonly string[];
  id: string;
  ordinal: number;
  sectionId: string;
}>;

export type StructuredKnowledgeSearchResult =
  | Readonly<{ kind: "complete"; passage: KnowledgeHybridPassage }>
  | Readonly<{ kind: "needs_clarification"; question: string }>
  | Readonly<{ kind: "not_applicable" }>;

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("und");
}

function explicitlyNames(query: string, candidate: StructuredKnowledgeArtifactCandidate): boolean {
  const text = normalized(query);
  const names = [candidate.sourceName, candidate.fileName]
    .map(normalized)
    .filter((name) => name.length >= 3);
  return names.some((name) => text.includes(name) || text.includes(name.replace(/\.[^.]+$/u, "")));
}

function safeCell(value: unknown): string {
  const text = value === null ? "—" : String(value);
  const oneLine = text.replace(/\r?\n/gu, " ").replace(/\|/gu, "\\|").slice(0, 500);
  return /^[=+\-@]/u.test(oneLine) ? `'${oneLine}` : oneLine;
}

export function structuredAnalysisText(result: StructuredAnalysisResult): string {
  const ranges = result.receipt.inputRanges.map((range) =>
    `${range.sheet}!${range.range} (${range.role})`).join(", ");
  const header = `| ${result.columns.map(safeCell).join(" | ")} |`;
  const separator = `| ${result.columns.map(() => "---").join(" | ")} |`;
  const rows = result.rows.map((row) => `| ${row.map(safeCell).join(" | ")} |`);
  return [
    `Operation: ${result.receipt.operationSummary}`,
    `Input ranges: ${ranges}`,
    `Rows scanned: ${result.receipt.rowsScanned}; rows matched: ${result.receipt.rowsMatched}.`,
    ...(result.receipt.warnings.length > 0
      ? [`Warnings: ${result.receipt.warnings.join(", ")}.`]
      : []),
    header,
    separator,
    ...rows
  ].join("\n");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function decodedCandidate(
  candidate: StructuredKnowledgeArtifactCandidate,
  storage: Pick<StorageAdapter, "getObject">,
  config: KnowledgeExtractionConfig,
  signal: AbortSignal | undefined
) {
  const object = await storage.getObject(candidate.normalizedTextStorageKey, {
    maxBytes: candidate.normalizedTextByteSize,
    ...(signal ? { signal } : {})
  });
  if (object.body.byteLength !== candidate.normalizedTextByteSize ||
    createHash("sha256").update(object.body).digest("hex") !== candidate.normalizedTextChecksum) {
    throw new Error("knowledge_normalized_object_integrity_invalid");
  }
  return decodeKnowledgeNormalizedDocument(object.body, config);
}

export async function analyzeStructuredKnowledgeSources(input: Readonly<{
  candidates: readonly StructuredKnowledgeArtifactCandidate[];
  config: KnowledgeExtractionConfig;
  loadAnchor(candidate: StructuredKnowledgeArtifactCandidate, page: number): Promise<StructuredKnowledgePassageAnchor | null>;
  query: string;
  signal?: AbortSignal;
  storage: Pick<StorageAdapter, "getObject">;
}>): Promise<StructuredKnowledgeSearchResult> {
  const explicitlySelected = input.candidates.filter((candidate) => explicitlyNames(input.query, candidate));
  const candidates = explicitlySelected.length > 0 ? explicitlySelected : input.candidates;
  if (candidates.length > STRUCTURED_SOURCE_CANDIDATE_LIMIT) {
    return {
      kind: "needs_clarification",
      question: "Уточните один источник-таблицу: в выбранной области слишком много подходящих файлов."
    };
  }
  const ready: Array<Readonly<{
    candidate: StructuredKnowledgeArtifactCandidate;
    documentHash: string;
    plan: StructuredPlan;
    workbook: NonNullable<Awaited<ReturnType<typeof decodedCandidate>>["workbook"]>;
  }>> = [];
  const questions: string[] = [];
  for (const candidate of candidates) {
    if (input.signal?.aborted) throw input.signal.reason;
    try {
      const document = await decodedCandidate(candidate, input.storage, input.config, input.signal);
      if (!document.workbook) continue;
      const decision = planStructuredDataQuery(input.query, document.workbook);
      if (decision.status === "ready") {
        ready.push({
          candidate,
          documentHash: document.contentHash,
          plan: decision.plan,
          workbook: document.workbook
        });
      } else if (decision.status === "needs_clarification") {
        questions.push(`${candidate.sourceName}: ${decision.question}`);
      }
    } catch (error) {
      if (input.signal?.aborted) throw input.signal.reason;
      // A broken or non-workbook artifact must not prevent the ordinary
      // retrieval path from using its independently persisted text index.
      continue;
    }
  }
  if (ready.length > 1) {
    return {
      kind: "needs_clarification",
      question: `Уточните источник: запрос подходит к ${ready.map((entry) =>
        entry.candidate.sourceName).join(", ")}.`
    };
  }
  if (ready.length === 0) {
    return questions.length > 0
      ? { kind: "needs_clarification", question: questions.slice(0, 3).join(" ") }
      : { kind: "not_applicable" };
  }
  const selected = ready[0]!;
  let analysis: StructuredAnalysisResult;
  try {
    analysis = executeStructuredPlan(selected.workbook, selected.plan, {
      ...(input.signal ? { signal: input.signal } : {}),
      timeoutMs: 500
    });
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason;
    return error instanceof StructuredDataError &&
      (error.code === "structured_mixed_type" || error.code === "structured_no_rows")
      ? {
          kind: "needs_clarification",
          question: "Уточните колонки или фильтр: выбранные данные нельзя однозначно рассчитать."
        }
      : { kind: "not_applicable" };
  }
  const page = analysis.receipt.inputRanges[0]?.sheetIndex !== undefined
    ? analysis.receipt.inputRanges[0].sheetIndex + 1
    : 1;
  const anchor = await input.loadAnchor(selected.candidate, page);
  if (!anchor) return { kind: "not_applicable" };
  const text = structuredAnalysisText(analysis);
  const contentHash = createHash("sha256").update(canonicalJson({
    analysis,
    documentHash: selected.documentHash
  }), "utf8").digest("hex");
  return {
    kind: "complete",
    passage: {
      annRank: null,
      baseName: selected.candidate.baseName,
      bindingOrdinal: selected.candidate.bindingOrdinal,
      chunkId: anchor.id,
      chunkIndex: anchor.ordinal,
      contentHash,
      documentId: selected.candidate.documentId,
      documentVersionId: selected.candidate.documentVersionId,
      documentVersionNumber: selected.candidate.documentVersionNumber,
      fileName: selected.candidate.fileName,
      ftsRank: null,
      ftsScore: null,
      fusedScore: 0,
      headingPath: [
        analysis.receipt.inputRanges[0]?.sheet ?? anchor.headingPath[0] ?? "Workbook",
        ...analysis.receipt.inputRanges.map((range) => range.range)
      ],
      knowledgeBaseId: selected.candidate.knowledgeBaseId,
      page,
      rerankScore: null,
      sectionId: anchor.sectionId,
      sourceArtifactId: selected.candidate.artifactId,
      sourceName: selected.candidate.sourceName,
      structuredAnalysis: analysis,
      text,
      vectorDistance: null,
      vectorScore: null
    }
  };
}

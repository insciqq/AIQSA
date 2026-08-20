import { createHash } from "node:crypto";
import {
  decodeKnowledgeAcceptedSourceTupleV1,
  decodeKnowledgeStrategyDependencyV1,
  decodeKnowledgeStrategyExecutionRequestV1,
  decodeKnowledgeStrategyStepEvidenceV1,
  decodeKnowledgeStrategyStepReceiptV1,
  decodeKnowledgeStrategyStepRequestV1,
  deriveKnowledgeStrategyDependencyEvidenceInputV1,
  hashKnowledgeAcceptedSourceTupleV1,
  hashKnowledgeStrategyDependencyEvidenceInputV1,
  hashKnowledgeStrategyDependencyV1,
  hashKnowledgeStrategyExecutionRequestV1,
  hashKnowledgeStrategyPassageItemsV1,
  hashKnowledgeStrategyStepEvidenceV1,
  hashKnowledgeStrategyStepReceiptV1,
  hashKnowledgeStrategyStepRequestV1,
  knowledgeStrategyInvariantReasonCodesV1,
  sealKnowledgeStrategyStepEvidenceV1,
  type KnowledgeMeasuredStrategy,
  type KnowledgeStrategyDependencyV1,
  type KnowledgeStrategyExecutionRequestV1,
  type KnowledgeStrategyStepReceiptV1,
  type KnowledgeStrategyStepRequestV1
} from "./knowledgeStrategyExecution";
import type { StoredKnowledgeStrategyExecution } from "./knowledgeStrategyRepository";
import {
  knowledgeStrategyEvidenceStepReceiptV1,
  knowledgeStrategyPassageStepReceiptV1
} from "./knowledgeStrategyRuntime";
import type {
  KnowledgeRetrievalEvidence,
  KnowledgeRetrievedPassageEvidence,
  KnowledgeStrategyPassagePage
} from "./retrievalTypes";

export const KNOWLEDGE_STRATEGY_DISPATCH_LINEAGE_MAX_EMITTED_PASSAGES_V1 = 100;

export const KNOWLEDGE_STRATEGY_DISPATCH_LINEAGE_REASON_CODES = Object.freeze([
  "corpus_summary_non_extractive_output",
  "lineage_dependency_invalid",
  "lineage_emitted_count_mismatch",
  "lineage_emitted_identity_mismatch",
  "lineage_emitted_limit_exceeded",
  "lineage_emitted_text_mismatch",
  "lineage_evidence_invalid",
  "lineage_evidence_marker_mismatch",
  "lineage_execution_invalid",
  "lineage_execution_purged",
  "lineage_page_count_mismatch",
  "lineage_page_invalid",
  "lineage_page_receipt_mismatch",
  "lineage_receipt_invalid",
  "lineage_reduce_dependency_mismatch",
  "lineage_reduce_evidence_input_mismatch",
  "lineage_reduce_missing",
  "lineage_reduce_receipt_mismatch",
  "lineage_source_coverage_mismatch",
  "lineage_step_invalid",
  "lineage_steps_incomplete",
  "lineage_strategy_contract_invalid",
  "lineage_strategy_unsupported"
] as const);

export type KnowledgeStrategyDispatchLineageReasonCode =
  typeof KNOWLEDGE_STRATEGY_DISPATCH_LINEAGE_REASON_CODES[number];

export type KnowledgeStrategyDispatchLineageSourceV1 =
  | Readonly<{
    kind: "explicit";
    dependencies: readonly unknown[];
    execution: unknown;
    stepReceipts: readonly unknown[];
    stepRequests: readonly unknown[];
  }>
  | Readonly<{
    kind: "stored";
    execution: StoredKnowledgeStrategyExecution;
  }>;

export type KnowledgeStrategyDispatchLineageResultV1 = Readonly<{
  emittedPassageCount: number;
  lineageHash: string;
  processedPassageCount: number;
  reasonCodes: readonly KnowledgeStrategyDispatchLineageReasonCode[];
  verified: boolean;
}>;

type StrictLineage = Readonly<{
  dependencies: readonly KnowledgeStrategyDependencyV1[];
  execution: KnowledgeStrategyExecutionRequestV1;
  receipts: readonly KnowledgeStrategyStepReceiptV1[];
  steps: readonly KnowledgeStrategyStepRequestV1[];
}>;

type ValidatedPage = Readonly<{
  page: KnowledgeStrategyPassagePage;
  receipt: KnowledgeStrategyStepReceiptV1;
  step: KnowledgeStrategyStepRequestV1;
}>;

const SHA256 = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => compareStrings(left, right));
    return `{${entries.map(([key, nested]) =>
      `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function sameSortedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function pageStepKind(strategy: KnowledgeMeasuredStrategy): KnowledgeStrategyStepRequestV1["kind"] |
  null {
  switch (strategy) {
    case "full_context": return "full_context_page";
    case "exhaustive": return "exhaustive_page";
    case "corpus_summary": return "corpus_summary_map";
    default: return null;
  }
}

function normalizeLineage(
  source: KnowledgeStrategyDispatchLineageSourceV1,
  reasons: Set<KnowledgeStrategyDispatchLineageReasonCode>
): StrictLineage | null {
  let rawExecution: unknown;
  let rawDependencies: readonly unknown[];
  let rawSteps: readonly unknown[];
  let rawReceipts: readonly unknown[];

  if (source.kind === "stored") {
    if (source.execution.purgedAt !== null) reasons.add("lineage_execution_purged");
    rawExecution = source.execution.execution;
    rawDependencies = source.execution.dependencies;
    rawSteps = source.execution.steps.flatMap(({ request }) => request ? [request] : []);
    rawReceipts = source.execution.steps.flatMap(({ receipt }) => receipt ? [receipt] : []);
    if (rawSteps.length !== source.execution.steps.length ||
      rawReceipts.length !== source.execution.steps.length) {
      reasons.add("lineage_steps_incomplete");
    }
  } else {
    rawExecution = source.execution;
    rawDependencies = source.dependencies;
    rawSteps = source.stepRequests;
    rawReceipts = source.stepReceipts;
  }

  const execution = decodeKnowledgeStrategyExecutionRequestV1(rawExecution);
  if (!execution) reasons.add("lineage_execution_invalid");
  const dependencies = rawDependencies.map(decodeKnowledgeStrategyDependencyV1);
  if (dependencies.some((dependency) => dependency === null)) {
    reasons.add("lineage_dependency_invalid");
  }
  const steps = rawSteps.map(decodeKnowledgeStrategyStepRequestV1);
  if (steps.some((step) => step === null)) reasons.add("lineage_step_invalid");
  const receipts = rawReceipts.map(decodeKnowledgeStrategyStepReceiptV1);
  if (receipts.some((receipt) => receipt === null)) reasons.add("lineage_receipt_invalid");
  if (!execution || dependencies.some((dependency) => dependency === null) ||
    steps.some((step) => step === null) || receipts.some((receipt) => receipt === null)) {
    return null;
  }

  const strictDependencies = dependencies as KnowledgeStrategyDependencyV1[];
  const strictSteps = steps as KnowledgeStrategyStepRequestV1[];
  const strictReceipts = receipts as KnowledgeStrategyStepReceiptV1[];
  strictSteps.sort((left, right) => left.ordinal - right.ordinal ||
    compareStrings(left.stepId, right.stepId));
  strictReceipts.sort((left, right) => compareStrings(left.stepId, right.stepId));
  strictDependencies.sort((left, right) =>
    compareStrings(left.dependentStepId, right.dependentStepId) ||
    compareStrings(left.prerequisiteStepId, right.prerequisiteStepId));

  if (strictSteps.length === 0 || strictSteps.length !== strictReceipts.length ||
    new Set(strictSteps.map(({ stepId }) => stepId)).size !== strictSteps.length ||
    new Set(strictSteps.map(({ ordinal }) => ordinal)).size !== strictSteps.length ||
    new Set(strictReceipts.map(({ stepId }) => stepId)).size !== strictReceipts.length) {
    reasons.add("lineage_steps_incomplete");
  }
  const receiptsByStepId = new Map(strictReceipts.map((receipt) => [receipt.stepId, receipt]));
  if (strictSteps.some((step) => {
    const receipt = receiptsByStepId.get(step.stepId);
    return !receipt || receipt.executionId !== execution.executionId ||
      receipt.requestHash !== hashKnowledgeStrategyStepRequestV1(step) ||
      receipt.status !== "succeeded";
  })) reasons.add("lineage_receipt_invalid");
  if (knowledgeStrategyInvariantReasonCodesV1(
    execution,
    strictSteps,
    strictDependencies
  ).length > 0) reasons.add("lineage_strategy_contract_invalid");

  return Object.freeze({
    dependencies: Object.freeze(strictDependencies),
    execution,
    receipts: Object.freeze(strictReceipts),
    steps: Object.freeze(strictSteps)
  });
}

function pageStartOrdinal(page: KnowledgeStrategyPassagePage): number | null {
  if (!Array.isArray(page.items) || page.items.length === 0) {
    return page.source.passageCount === 0 ? 0 : null;
  }
  const first = page.items[0];
  return first && Number.isSafeInteger(first.passageOrdinal) ? first.passageOrdinal : null;
}

function pageKey(sourceBindingId: string, startOrdinal: number): string {
  return `${sourceBindingId}\u0000${startOrdinal}`;
}

function validatePages(
  lineage: StrictLineage,
  pages: readonly KnowledgeStrategyPassagePage[],
  reasons: Set<KnowledgeStrategyDispatchLineageReasonCode>
): readonly ValidatedPage[] {
  const kind = pageStepKind(lineage.execution.strategy);
  if (!kind) {
    reasons.add("lineage_strategy_unsupported");
    return [];
  }
  const pageSteps = lineage.steps.filter((step) => step.kind === kind);
  if (pages.length !== pageSteps.length) reasons.add("lineage_page_count_mismatch");

  const pagesByKey = new Map<string, KnowledgeStrategyPassagePage>();
  for (const page of pages) {
    const source = decodeKnowledgeAcceptedSourceTupleV1(page.source);
    const startOrdinal = source ? pageStartOrdinal(page) : null;
    if (!source || startOrdinal === null) {
      reasons.add("lineage_page_invalid");
      continue;
    }
    const key = pageKey(source.bindingId, startOrdinal);
    if (pagesByKey.has(key)) reasons.add("lineage_page_invalid");
    else pagesByKey.set(key, page);
  }

  const sourcesByBindingId = new Map(lineage.execution.sourceSet.map((source) =>
    [source.bindingId, source]));
  const receiptsByStepId = new Map(lineage.receipts.map((receipt) =>
    [receipt.stepId, receipt]));
  const validated: ValidatedPage[] = [];
  for (const step of pageSteps) {
    const startOrdinal = step.cursor?.nextPassageOrdinal ?? 0;
    const page = step.sourceBindingId === null
      ? undefined
      : pagesByKey.get(pageKey(step.sourceBindingId, startOrdinal));
    const source = step.sourceBindingId === null
      ? undefined
      : sourcesByBindingId.get(step.sourceBindingId);
    const receipt = receiptsByStepId.get(step.stepId);
    if (!page || !source || !receipt ||
      hashKnowledgeAcceptedSourceTupleV1(page.source) !==
        hashKnowledgeAcceptedSourceTupleV1(source)) {
      reasons.add("lineage_page_invalid");
      continue;
    }
    try {
      const recomputed = knowledgeStrategyPassageStepReceiptV1(step, page);
      if (hashKnowledgeStrategyStepReceiptV1(recomputed) !==
        hashKnowledgeStrategyStepReceiptV1(receipt)) {
        reasons.add("lineage_page_receipt_mismatch");
      }
      validated.push(Object.freeze({ page, receipt, step }));
    } catch {
      reasons.add("lineage_page_invalid");
    }
  }

  const usedPageKeys = new Set(validated.map(({ page }) =>
    pageKey(page.source.bindingId, pageStartOrdinal(page)!)));
  if (usedPageKeys.size !== pagesByKey.size) reasons.add("lineage_page_invalid");
  return Object.freeze(validated);
}

function verifyPageChains(
  lineage: StrictLineage,
  validatedPages: readonly ValidatedPage[],
  reasons: Set<KnowledgeStrategyDispatchLineageReasonCode>
): readonly ValidatedPage[] {
  const validatedByStepId = new Map(validatedPages.map((entry) => [entry.step.stepId, entry]));
  const ordered: ValidatedPage[] = [];
  for (const source of lineage.execution.sourceSet) {
    const sourceSteps = lineage.steps.filter((step) =>
      step.kind === pageStepKind(lineage.execution.strategy) &&
      step.sourceBindingId === source.bindingId)
      .sort((left, right) => left.pageOrdinal - right.pageOrdinal);
    const sourcePages = sourceSteps.flatMap((step) => {
      const entry = validatedByStepId.get(step.stepId);
      return entry ? [entry] : [];
    });
    ordered.push(...sourcePages);
    let passageOrdinal = 0;
    let valid = sourcePages.length === sourceSteps.length && sourcePages.length > 0;
    for (const [index, entry] of sourcePages.entries()) {
      const previous = index === 0 ? null : sourcePages[index - 1]!;
      if (entry.step.pageOrdinal !== index ||
        (index === 0
          ? entry.step.cursor !== null
          : !previous?.receipt.nextCursor ||
            canonicalJson(entry.step.cursor) !== canonicalJson(previous.receipt.nextCursor)) ||
        (index < sourcePages.length - 1) === entry.page.complete) valid = false;
      for (const item of entry.page.items) {
        if (item.passageOrdinal !== passageOrdinal) valid = false;
        passageOrdinal += 1;
      }
    }
    if (passageOrdinal !== source.passageCount ||
      sourcePages.at(-1)?.page.complete !== true || !valid) {
      reasons.add("lineage_source_coverage_mismatch");
    }
  }
  return Object.freeze(ordered);
}

function emittedResultValid(value: unknown): value is KnowledgeRetrievedPassageEvidence {
  if (!record(value)) return false;
  return typeof value.chunkId === "string" && IDENTIFIER.test(value.chunkId) &&
    typeof value.contentHash === "string" && SHA256.test(value.contentHash) &&
    typeof value.documentId === "string" && IDENTIFIER.test(value.documentId) &&
    typeof value.documentVersionId === "string" && IDENTIFIER.test(value.documentVersionId) &&
    Number.isSafeInteger(value.documentVersionNumber) && Number(value.documentVersionNumber) >= 1 &&
    typeof value.handle === "string" && value.handle.length > 0 &&
    typeof value.includedText === "string" &&
    Number.isSafeInteger(value.includedTextBytes) && Number(value.includedTextBytes) >= 0 &&
    typeof value.sourceAlias === "string" && /^S[1-9]\d{0,3}$/u.test(value.sourceAlias) &&
    typeof value.sourceArtifactId === "string" && IDENTIFIER.test(value.sourceArtifactId) &&
    Number.isSafeInteger(value.sourceTextBytes) && Number(value.sourceTextBytes) >= 0 &&
    typeof value.textTruncated === "boolean";
}

function verifyEmittedResults(
  strategy: KnowledgeMeasuredStrategy,
  orderedPages: readonly ValidatedPage[],
  evidenceValue: KnowledgeRetrievalEvidence,
  reasons: Set<KnowledgeStrategyDispatchLineageReasonCode>
): readonly KnowledgeRetrievedPassageEvidence[] {
  const resultsValue: unknown = record(evidenceValue) ? evidenceValue.results : null;
  if (!Array.isArray(resultsValue) || resultsValue.some((result) => !emittedResultValid(result))) {
    reasons.add("lineage_evidence_invalid");
    return [];
  }
  const results = resultsValue as KnowledgeRetrievedPassageEvidence[];
  if (new Set(results.map(({ handle }) => handle)).size !== results.length) {
    reasons.add("lineage_evidence_invalid");
  }
  const expected = orderedPages.flatMap(({ page }) => page.passages.map((passage, index) => ({
    item: page.items[index]!,
    passage,
    source: page.source
  })));
  if (expected.length > KNOWLEDGE_STRATEGY_DISPATCH_LINEAGE_MAX_EMITTED_PASSAGES_V1 ||
    results.length > KNOWLEDGE_STRATEGY_DISPATCH_LINEAGE_MAX_EMITTED_PASSAGES_V1) {
    reasons.add("lineage_emitted_limit_exceeded");
  }
  if (results.length !== expected.length) {
    reasons.add("lineage_emitted_count_mismatch");
    if (strategy === "corpus_summary") {
      reasons.add("corpus_summary_non_extractive_output");
    }
  }
  const compared = Math.min(results.length, expected.length);
  for (let index = 0; index < compared; index += 1) {
    const result = results[index]!;
    const expectedItem = expected[index]!;
    if (result.chunkId !== expectedItem.item.passageId ||
      result.chunkIndex !== expectedItem.item.passageOrdinal ||
      result.contentHash !== expectedItem.item.contentHash ||
      result.sourceArtifactId !== expectedItem.item.sourceArtifactId ||
      result.documentId !== expectedItem.source.sourceId ||
      result.documentVersionId !== expectedItem.source.sourceVersionId ||
      result.documentVersionNumber !== expectedItem.source.sourceVersionNumber ||
      result.sourceAlias !== expectedItem.source.sourceAlias) {
      reasons.add("lineage_emitted_identity_mismatch");
      if (strategy === "corpus_summary") {
        reasons.add("corpus_summary_non_extractive_output");
      }
    }
    const sourceTextBytes = Buffer.byteLength(expectedItem.passage.text, "utf8");
    const includedTextBytes = Buffer.byteLength(result.includedText, "utf8");
    if (result.sourceTextBytes !== sourceTextBytes ||
      result.includedTextBytes !== includedTextBytes ||
      !expectedItem.passage.text.startsWith(result.includedText) ||
      result.textTruncated !== (includedTextBytes < sourceTextBytes)) {
      reasons.add("lineage_emitted_text_mismatch");
      if (strategy === "corpus_summary") {
        reasons.add("corpus_summary_non_extractive_output");
      }
    }
  }
  return Object.freeze(results);
}

function verifyEvidenceMarker(
  lineage: StrictLineage,
  evidence: KnowledgeRetrievalEvidence,
  requiredStepId: string | null,
  reasons: Set<KnowledgeStrategyDispatchLineageReasonCode>
): void {
  const marker = decodeKnowledgeStrategyStepEvidenceV1(
    record(evidence) ? evidence.strategyStepEvidence : undefined
  );
  if (!marker || requiredStepId !== null && marker.stepId !== requiredStepId) {
    reasons.add("lineage_evidence_marker_mismatch");
    return;
  }
  const step = lineage.steps.find(({ stepId }) => stepId === marker.stepId);
  const receipt = lineage.receipts.find(({ stepId }) => stepId === marker.stepId);
  if (!step || !receipt) {
    reasons.add("lineage_evidence_marker_mismatch");
    return;
  }
  try {
    const expected = sealKnowledgeStrategyStepEvidenceV1(step, receipt);
    if (hashKnowledgeStrategyStepEvidenceV1(expected) !==
      hashKnowledgeStrategyStepEvidenceV1(marker)) {
      reasons.add("lineage_evidence_marker_mismatch");
    }
  } catch {
    reasons.add("lineage_evidence_marker_mismatch");
  }
}

function verifyCorpusReduce(
  lineage: StrictLineage,
  evidence: KnowledgeRetrievalEvidence,
  reasons: Set<KnowledgeStrategyDispatchLineageReasonCode>
): string | null {
  const reduceSteps = lineage.steps.filter(({ kind }) => kind === "corpus_summary_reduce");
  if (reduceSteps.length !== 1) {
    reasons.add("lineage_reduce_missing");
    return null;
  }
  const reduce = reduceSteps[0]!;
  const receipt = lineage.receipts.find(({ stepId }) => stepId === reduce.stepId);
  if (!receipt) {
    reasons.add("lineage_reduce_missing");
    return reduce.stepId;
  }
  const mapSteps = lineage.steps.filter(({ kind }) => kind === "corpus_summary_map");
  const terminalMapIds = mapSteps.filter((step) => !mapSteps.some((candidate) =>
    candidate.streamId === step.streamId && candidate.pageOrdinal > step.pageOrdinal))
    .map(({ stepId }) => stepId).sort(compareStrings);
  const directPrerequisites = lineage.dependencies.filter(({ dependentStepId }) =>
    dependentStepId === reduce.stepId).map(({ prerequisiteStepId }) => prerequisiteStepId)
    .sort(compareStrings);
  if (!sameSortedStrings(terminalMapIds, directPrerequisites)) {
    reasons.add("lineage_reduce_dependency_mismatch");
  }
  const evidenceInput = deriveKnowledgeStrategyDependencyEvidenceInputV1(
    lineage.execution.executionId,
    reduce.stepId,
    lineage.dependencies,
    lineage.receipts
  );
  if (!evidenceInput || reduce.evidenceInputHash === null ||
    hashKnowledgeStrategyDependencyEvidenceInputV1(evidenceInput) !== reduce.evidenceInputHash) {
    reasons.add("lineage_reduce_evidence_input_mismatch");
  }
  try {
    const recomputed = knowledgeStrategyEvidenceStepReceiptV1(reduce, evidence);
    if (hashKnowledgeStrategyStepReceiptV1(recomputed) !==
      hashKnowledgeStrategyStepReceiptV1(receipt)) {
      reasons.add("lineage_reduce_receipt_mismatch");
    }
  } catch {
    reasons.add("lineage_reduce_receipt_mismatch");
  }
  return reduce.stepId;
}

function pageLineageProjection(validatedPages: readonly ValidatedPage[]): readonly unknown[] {
  return validatedPages.map(({ page, receipt, step }) => ({
    complete: page.complete,
    itemSetHash: hashKnowledgeStrategyPassageItemsV1(page.items),
    passageSetHash: sha256(page.passages.map((passage) => ({
      chunkId: passage.chunkId,
      contentHash: passage.contentHash ?? null,
      documentId: passage.documentId,
      documentVersionId: passage.documentVersionId,
      sourceArtifactId: passage.sourceArtifactId ?? null,
      textHash: sha256(passage.text)
    }))),
    receiptHash: hashKnowledgeStrategyStepReceiptV1(receipt),
    sourceHash: hashKnowledgeAcceptedSourceTupleV1(page.source),
    stepId: step.stepId
  }));
}

function emittedLineageProjection(results: readonly KnowledgeRetrievedPassageEvidence[]): unknown {
  return results.map((result) => ({
    chunkId: result.chunkId,
    contentHash: result.contentHash ?? null,
    documentId: result.documentId,
    documentVersionId: result.documentVersionId,
    handle: result.handle,
    includedTextHash: sha256(result.includedText),
    sourceArtifactId: result.sourceArtifactId ?? null
  }));
}

/**
 * Fail-closed extractive lineage proof for the current v1 passage contract.
 * A generated corpus-summary map needs its own durable output receipt and is
 * deliberately rejected here instead of being represented as a fake passage.
 */
export function verifyKnowledgeStrategyDispatchLineageV1(input: Readonly<{
  evidence: KnowledgeRetrievalEvidence;
  lineage: KnowledgeStrategyDispatchLineageSourceV1;
  pages: readonly KnowledgeStrategyPassagePage[];
}>): KnowledgeStrategyDispatchLineageResultV1 {
  const reasons = new Set<KnowledgeStrategyDispatchLineageReasonCode>();
  const pages = Array.isArray(input.pages) ? input.pages : [];
  if (!Array.isArray(input.pages)) reasons.add("lineage_page_invalid");
  const processedPassageCount = pages.length > 0
    ? pages.reduce((sum, page) =>
        sum + (Array.isArray(page.items) ? page.items.length : 0), 0)
    : 0;
  const emittedPassageCount = record(input.evidence) && Array.isArray(input.evidence.results)
    ? input.evidence.results.length
    : 0;
  const lineage = normalizeLineage(input.lineage, reasons);
  let validatedPages: readonly ValidatedPage[] = [];
  let emittedResults: readonly KnowledgeRetrievedPassageEvidence[] = [];
  if (lineage) {
    if (lineage.execution.strategy !== "full_context" &&
      lineage.execution.strategy !== "exhaustive" &&
      lineage.execution.strategy !== "corpus_summary") {
      reasons.add("lineage_strategy_unsupported");
    } else {
      validatedPages = validatePages(lineage, pages, reasons);
      const orderedPages = verifyPageChains(lineage, validatedPages, reasons);
      emittedResults = verifyEmittedResults(
        lineage.execution.strategy,
        orderedPages,
        input.evidence,
        reasons
      );
      const requiredStepId = lineage.execution.strategy === "corpus_summary"
        ? verifyCorpusReduce(lineage, input.evidence, reasons)
        : null;
      verifyEvidenceMarker(lineage, input.evidence, requiredStepId, reasons);
    }
  }
  const reasonCodes = Object.freeze([...reasons].sort(compareStrings));
  const lineageHash = sha256({
    dependencies: lineage?.dependencies.map(hashKnowledgeStrategyDependencyV1) ?? [],
    emitted: emittedLineageProjection(emittedResults),
    emittedPassageCount,
    executionHash: lineage ? hashKnowledgeStrategyExecutionRequestV1(lineage.execution) : null,
    pages: pageLineageProjection(validatedPages),
    processedPassageCount,
    reasonCodes,
    receipts: lineage?.receipts.map(hashKnowledgeStrategyStepReceiptV1) ?? [],
    steps: lineage?.steps.map(hashKnowledgeStrategyStepRequestV1) ?? []
  });
  return Object.freeze({
    emittedPassageCount,
    lineageHash,
    processedPassageCount,
    reasonCodes,
    verified: reasonCodes.length === 0
  });
}

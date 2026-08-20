import { createHash, randomUUID } from "node:crypto";
import type { KnowledgeRetrievalStore } from "./toolExecutor";
import type { KnowledgeRetrievalEvidence, KnowledgeStrategyPassagePage } from "./retrievalTypes";
import type { KnowledgeEvidenceDispatchManifestDraft } from "./evidenceDispatchManifest";
import {
  KNOWLEDGE_STRATEGY_MAP_MAX_SECTIONS,
  KNOWLEDGE_STRATEGY_MAP_MAX_SUMMARY_BYTES,
  KNOWLEDGE_STRATEGY_MAP_MAX_TOTAL_SUMMARY_BYTES,
  createKnowledgeStrategyMapOutputReceiptV2,
  createKnowledgeStrategyMapOutputDependencyInputV2,
  createKnowledgeStrategyMapOutputV2,
  createKnowledgeStrategyMapSectionSummaryV2,
  decodeKnowledgeStrategyMapOutputReceiptV2,
  decodeKnowledgeStrategyMapOutputV2,
  decodeKnowledgeStrategyMapSummaryEvidenceV2,
  deriveKnowledgeStrategyMapInputV2,
  hashKnowledgeStrategyMapOutputDependencyInputV2,
  type KnowledgeStrategyMapInputV2,
  type KnowledgeStrategyMapOutputDependencyInputV2,
  type KnowledgeStrategyMapOutputReceiptV2,
  type KnowledgeStrategyMapOutputV2,
  type KnowledgeStrategyMapSupportingPassageV2
} from "./knowledgeStrategyMapOutput";
import {
  createKnowledgeStrategyCoverageRequestV1,
  createKnowledgeStrategyStepReceiptV1,
  decodeKnowledgeStrategyExecutionRequestV1,
  deriveKnowledgeStrategyMapOutputDependencyHashV2,
  hashKnowledgeStrategySummaryEvidenceSetV2,
  hashKnowledgeAcceptedSourceSetV1,
  hashKnowledgeStrategyExecutionRequestV1,
  hashKnowledgeStrategyPassageItemV1,
  hashKnowledgeStrategyPassageItemsV1,
  hashKnowledgeStrategySourceProcessedItemsV1,
  hashKnowledgeStrategyStepRequestV1,
  hashKnowledgeStrategyTargetEvidenceItemsV1,
  type KnowledgeStrategyCoverageRequestV1,
  type KnowledgeStrategyStepReceiptV1,
  type KnowledgeStrategyStepRequestV1
} from "./knowledgeStrategyExecution";
import type {
  PrismaKnowledgeStrategyRepository,
  StoredKnowledgeStrategyExecution,
  StoredKnowledgeStrategyMapOutput,
  StoredKnowledgeStrategyStep
} from "./knowledgeStrategyRepository";
import {
  deriveKnowledgeStrategySummaryDispatchBindingsFromOutputsV2
} from "./knowledgeStrategySummaryEvidence";
import { KNOWLEDGE_STRATEGY_PAGE_SIZE } from "./knowledgeStrategyPlan";

const INTERNAL_STEP_LEASE_MS = 60_000;
const MAP_SECTION_SAMPLE_LIMIT = 8;
const CORPUS_SUMMARY_GLOBAL_TEXT_BUDGET_BYTES = 12 * 1024;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function utf8Prefix(value: string, maximumBytes: number): string {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) return "";
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const nextBytes = Buffer.byteLength(character, "utf8");
    if (bytes + nextBytes > maximumBytes) break;
    bytes += nextBytes;
    result += character;
  }
  return result.trimEnd();
}

function evenlySpacedIndexes(length: number, limit: number): readonly number[] {
  if (!Number.isSafeInteger(length) || length < 1 ||
    !Number.isSafeInteger(limit) || limit < 1) return Object.freeze([]);
  if (length <= limit) return Object.freeze(Array.from({ length }, (_, index) => index));
  const indexes = Array.from({ length: limit }, (_, index) =>
    Math.floor(index * (length - 1) / (limit - 1)));
  return Object.freeze([...new Set(indexes)]);
}

type StrategyMapPassageText = Readonly<{
  support: KnowledgeStrategyMapSupportingPassageV2;
  text: string;
}>;

function mapPassageTexts(
  mapInput: KnowledgeStrategyMapInputV2,
  pages: readonly KnowledgeStrategyPassagePage[]
): ReadonlyMap<number, StrategyMapPassageText> {
  const passagesByOrdinal = new Map<number, KnowledgeStrategyPassagePage["passages"][number]>();
  for (const page of pages) {
    for (const [index, item] of page.items.entries()) {
      if (passagesByOrdinal.has(item.passageOrdinal)) {
        throw new Error("knowledge_strategy_map_passage_duplicate");
      }
      const passage = page.passages[index];
      if (!passage || typeof passage.text !== "string") {
        throw new Error("knowledge_strategy_map_passage_text_invalid");
      }
      passagesByOrdinal.set(item.passageOrdinal, passage);
    }
  }
  if (passagesByOrdinal.size !== mapInput.passageCount) {
    throw new Error("knowledge_strategy_map_passage_set_invalid");
  }
  const result = new Map<number, StrategyMapPassageText>();
  for (const support of mapInput.passageItems) {
    const passage = passagesByOrdinal.get(support.passageOrdinal);
    const text = passage?.text.trim() ?? "";
    if (!passage || passage.chunkId !== support.passageId ||
      passage.contentHash !== support.contentHash || text.length < 1 || text.includes("\u0000")) {
      throw new Error("knowledge_strategy_map_passage_text_invalid");
    }
    result.set(support.passageOrdinal, Object.freeze({ support, text }));
  }
  return result;
}

function sectionSummaryText(input: Readonly<{
  budgetBytes: number;
  passages: readonly StrategyMapPassageText[];
}>): Readonly<{
  supportingPassages: readonly KnowledgeStrategyMapSupportingPassageV2[];
  summaryText: string;
}> {
  const selected = evenlySpacedIndexes(
    input.passages.length,
    Math.min(MAP_SECTION_SAMPLE_LIMIT, input.passages.length)
  ).map((index) => input.passages[index]!);
  const separator = "\n\n";
  const separatorBytes = Buffer.byteLength(separator, "utf8") * Math.max(0, selected.length - 1);
  const excerptBudget = Math.max(1, input.budgetBytes - separatorBytes);
  const perPassageBudget = Math.max(1, Math.floor(excerptBudget / selected.length));
  const excerpts: string[] = [];
  const supportingPassages: KnowledgeStrategyMapSupportingPassageV2[] = [];
  let remaining = excerptBudget;
  for (const [index, passage] of selected.entries()) {
    const selectionsLeft = selected.length - index;
    const budget = Math.max(1, Math.min(
      perPassageBudget,
      remaining - Math.max(0, selectionsLeft - 1)
    ));
    const excerpt = utf8Prefix(passage.text, budget);
    if (excerpt.length < 1) continue;
    excerpts.push(excerpt);
    supportingPassages.push(passage.support);
    remaining -= Buffer.byteLength(excerpt, "utf8");
  }
  const summaryText = excerpts.join(separator);
  if (summaryText.length < 1 ||
    Buffer.byteLength(summaryText, "utf8") > input.budgetBytes ||
    supportingPassages.length < 1) {
    throw new Error("knowledge_strategy_map_summary_unavailable");
  }
  return Object.freeze({
    supportingPassages: Object.freeze(supportingPassages),
    summaryText
  });
}

export type DeterministicKnowledgeStrategyMapArtifactsV2 = Readonly<{
  input: KnowledgeStrategyMapInputV2;
  output: KnowledgeStrategyMapOutputV2;
  receipt: KnowledgeStrategyMapOutputReceiptV2;
}>;

/**
 * Creates a bounded extractive map output from an exact, fully exhausted Source
 * page chain. No provider or model judgment enters this deterministic stage.
 */
export function createDeterministicKnowledgeStrategyMapArtifactsV2(input: Readonly<{
  execution: unknown;
  pages: readonly KnowledgeStrategyPassagePage[];
  source: unknown;
  stepReceipts: readonly unknown[];
  stepRequests: readonly unknown[];
}>): DeterministicKnowledgeStrategyMapArtifactsV2 {
  const execution = decodeKnowledgeStrategyExecutionRequestV1(input.execution);
  const mapInput = deriveKnowledgeStrategyMapInputV2(input);
  if (!execution || execution.strategy !== "corpus_summary" || mapInput.sectionCount < 1 ||
    mapInput.sectionCount > KNOWLEDGE_STRATEGY_MAP_MAX_SECTIONS) {
    throw new Error("knowledge_strategy_map_section_count_invalid");
  }
  const passageTexts = mapPassageTexts(mapInput, input.pages);
  const sourceBudget = Math.max(1, Math.floor(
    CORPUS_SUMMARY_GLOBAL_TEXT_BUDGET_BYTES / execution.sourceSet.length
  ));
  const budgetPerSection = Math.min(
    KNOWLEDGE_STRATEGY_MAP_MAX_SUMMARY_BYTES,
    Math.max(1, Math.floor(Math.min(
      KNOWLEDGE_STRATEGY_MAP_MAX_TOTAL_SUMMARY_BYTES,
      sourceBudget
    ) / mapInput.sectionCount))
  );
  const summaries = mapInput.sectionHashes.map((sectionHash, ordinal) => {
    const sectionPassages = mapInput.passageItems.flatMap((support) => {
      if (support.sectionHash !== sectionHash) return [];
      const passage = passageTexts.get(support.passageOrdinal);
      return passage ? [passage] : [];
    });
    if (sectionPassages.length < 1) {
      throw new Error("knowledge_strategy_map_section_passages_unavailable");
    }
    const summary = sectionSummaryText({
      budgetBytes: budgetPerSection,
      passages: sectionPassages
    });
    return createKnowledgeStrategyMapSectionSummaryV2({
      ordinal,
      sectionHash,
      summaryText: summary.summaryText,
      supportingPassages: summary.supportingPassages
    });
  });
  const output = createKnowledgeStrategyMapOutputV2({ mapInput, summaries });
  return Object.freeze({
    input: mapInput,
    output,
    receipt: createKnowledgeStrategyMapOutputReceiptV2(output)
  });
}

type KnowledgeStrategyMapPersistence = Readonly<{
  loadMapOutputs(input: Readonly<{
    executionId: string;
  }>): Promise<readonly StoredKnowledgeStrategyMapOutput[]>;
  materializeReduceStepRequest(input: Readonly<{
    at: Date;
    executionId: string;
    stepId: string;
  }>): Promise<unknown>;
  settleMapStep(input: Readonly<{
    at: Date;
    executionId: string;
    includedPassageCount?: number;
    leaseToken: string;
    mapOutput: KnowledgeStrategyMapOutputV2;
    mapOutputReceipt: KnowledgeStrategyMapOutputReceiptV2;
    receipt: KnowledgeStrategyStepReceiptV1;
    stateVersion: number;
    stepId: string;
  }>): Promise<unknown>;
}>;

function mapPersistence(
  repository: PrismaKnowledgeStrategyRepository
): KnowledgeStrategyMapPersistence {
  const candidate = repository as Partial<KnowledgeStrategyMapPersistence>;
  if (typeof candidate.loadMapOutputs !== "function" ||
    typeof candidate.materializeReduceStepRequest !== "function" ||
    typeof candidate.settleMapStep !== "function") {
    throw new Error("knowledge_strategy_map_persistence_unavailable");
  }
  return candidate as KnowledgeStrategyMapPersistence;
}

export function knowledgeStrategyCorpusSummaryReduceReceiptV2(input: Readonly<{
  execution: unknown;
  mapOutputs: readonly unknown[];
  mapOutputReceipts: readonly unknown[];
  request: KnowledgeStrategyStepRequestV1;
  summaryEvidence: readonly unknown[];
}>): Readonly<{
  dependency: KnowledgeStrategyMapOutputDependencyInputV2;
  receipt: KnowledgeStrategyStepReceiptV1;
}> {
  if (input.request.kind !== "corpus_summary_reduce" ||
    input.request.strategy !== "corpus_summary" || !input.request.evidenceInputHash) {
    throw new Error("knowledge_strategy_corpus_reduce_request_invalid");
  }
  const mapOutputReceipts = input.mapOutputReceipts.map((value) =>
    decodeKnowledgeStrategyMapOutputReceiptV2(value));
  if (mapOutputReceipts.some((value) => value === null)) {
    throw new Error("knowledge_strategy_corpus_reduce_receipts_invalid");
  }
  const receipts = (mapOutputReceipts as KnowledgeStrategyMapOutputReceiptV2[])
    .sort((left, right) => left.sourceOrdinal - right.sourceOrdinal);
  const mapOutputs = input.mapOutputs.map((value) => decodeKnowledgeStrategyMapOutputV2(value));
  const summaryEvidence = input.summaryEvidence.map((value) =>
    decodeKnowledgeStrategyMapSummaryEvidenceV2(value));
  if (mapOutputs.some((value) => value === null) ||
    summaryEvidence.some((value) => value === null)) {
    throw new Error("knowledge_strategy_corpus_reduce_evidence_invalid");
  }
  const outputs = (mapOutputs as KnowledgeStrategyMapOutputV2[]).sort((left, right) =>
    left.sourceOrdinal - right.sourceOrdinal);
  const summaries = summaryEvidence as NonNullable<ReturnType<
    typeof decodeKnowledgeStrategyMapSummaryEvidenceV2
  >>[];
  if (outputs.length !== receipts.length || summaries.length !== outputs.length ||
    outputs.some((output, ordinal) => output.outputHash !== receipts[ordinal]?.outputHash ||
      output.sourceOrdinal !== receipts[ordinal]?.sourceOrdinal ||
      output.sourceAlias !== summaries[ordinal]?.sourceAlias)) {
    throw new Error("knowledge_strategy_corpus_reduce_evidence_mismatch");
  }
  const dependency = createKnowledgeStrategyMapOutputDependencyInputV2({
    dependentStepId: input.request.stepId,
    execution: input.execution,
    receipts
  });
  if (hashKnowledgeStrategyMapOutputDependencyInputV2(dependency) !==
    input.request.evidenceInputHash ||
    deriveKnowledgeStrategyMapOutputDependencyHashV2({
      dependentStepId: input.request.stepId,
      executionId: input.request.executionId,
      receipts,
      sourceSetHash: input.request.sourceSetHash
    }) !== input.request.evidenceInputHash) {
    throw new Error("knowledge_strategy_corpus_reduce_dependency_mismatch");
  }
  const summaryBindings = outputs.map((output, ordinal) => ({
    evidenceHash: summaries[ordinal]!.evidenceHash,
    evidenceId: `summary-${output.sourceOrdinal}`,
    itemHash: summaries[ordinal]!.evidenceHash,
    outputHash: output.outputHash,
    sourceBindingId: output.sourceBindingId,
    sourceOrdinal: output.sourceOrdinal,
    version: 2 as const
  }));
  const summaryEvidenceSetHash = hashKnowledgeStrategySummaryEvidenceSetV2(summaryBindings);
  return Object.freeze({
    dependency,
    receipt: createKnowledgeStrategyStepReceiptV1({
      cursorExhausted: true,
      executionId: input.request.executionId,
      lastItemHash: summaries.at(-1)?.evidenceHash ?? null,
      nextCursor: null,
      processedItemCount: summaryBindings.length,
      processedItemsHash: summaryEvidenceSetHash,
      reasonCode: null,
      requestHash: hashKnowledgeStrategyStepRequestV1(input.request),
      status: "succeeded",
      stepId: input.request.stepId,
      version: 1
    })
  });
}

export function knowledgeStrategyPassageStepReceiptV1(
  request: KnowledgeStrategyStepRequestV1,
  page: KnowledgeStrategyPassagePage
): KnowledgeStrategyStepReceiptV1 {
  const startOrdinal = request.cursor?.nextPassageOrdinal ?? 0;
  if (request.sourceBindingId === null || request.sourceBindingId !== page.source.bindingId ||
    request.pageOrdinal !== (request.cursor?.pageOrdinal ?? 0) ||
    page.items.some((item, index) =>
      item.sourceBindingId !== request.sourceBindingId ||
      item.sourceArtifactId !== page.source.sourceArtifactId ||
      item.sourceOrdinal !== page.source.ordinal ||
      item.passageOrdinal !== startOrdinal + index) ||
    page.passages.length !== page.items.length || page.passages.some((passage, index) => {
      const item = page.items[index]!;
      return passage.chunkId !== item.passageId || passage.contentHash !== item.contentHash ||
        passage.sourceArtifactId !== item.sourceArtifactId ||
        passage.documentId !== page.source.sourceId ||
        passage.documentVersionId !== page.source.sourceVersionId;
    })) {
    throw new Error("knowledge_strategy_page_result_invalid");
  }
  const last = page.items.at(-1) ?? null;
  const lastItemHash = last ? hashKnowledgeStrategyPassageItemV1(last) : null;
  if (page.complete !== (page.nextCursor === null) ||
    page.nextCursor !== null && (
      page.nextCursor.executionId !== request.executionId ||
      page.nextCursor.streamId !== request.streamId ||
      page.nextCursor.sourceBindingId !== request.sourceBindingId ||
      page.nextCursor.sourceOrdinal !== page.source.ordinal ||
      page.nextCursor.pageOrdinal !== request.pageOrdinal + 1 ||
      page.nextCursor.nextPassageOrdinal !== startOrdinal + page.items.length ||
      page.nextCursor.previousItemHash !== lastItemHash
    )) {
    throw new Error("knowledge_strategy_page_result_invalid");
  }
  return createKnowledgeStrategyStepReceiptV1({
    cursorExhausted: page.complete,
    executionId: request.executionId,
    lastItemHash,
    nextCursor: page.nextCursor,
    processedItemCount: page.items.length,
    processedItemsHash: hashKnowledgeStrategyPassageItemsV1(page.items),
    reasonCode: null,
    requestHash: hashKnowledgeStrategyStepRequestV1(request),
    status: "succeeded",
    stepId: request.stepId,
    version: 1
  });
}

export function knowledgeStrategyEvidenceStepReceiptV1(
  request: KnowledgeStrategyStepRequestV1,
  evidence: KnowledgeRetrievalEvidence
): KnowledgeStrategyStepReceiptV1 {
  if (request.kind === "full_context_page" || request.kind === "exhaustive_page" ||
    request.kind === "corpus_summary_map") {
    throw new Error("knowledge_strategy_page_receipt_required");
  }
  const items = evidence.results.map((result) => Object.freeze({
    contentHash: result.contentHash,
    documentId: result.documentId,
    documentVersionId: result.documentVersionId,
    evidenceHandle: result.handle,
    sourceArtifactId: result.sourceArtifactId
  }));
  const itemHashes = items.map(sha256);
  return createKnowledgeStrategyStepReceiptV1({
    cursorExhausted: true,
    executionId: request.executionId,
    lastItemHash: itemHashes.at(-1) ?? null,
    nextCursor: null,
    processedItemCount: items.length,
    processedItemsHash: sha256(itemHashes),
    reasonCode: null,
    requestHash: hashKnowledgeStrategyStepRequestV1(request),
    status: "succeeded",
    stepId: request.stepId,
    version: 1
  });
}

export function knowledgeStrategyCoverageRequestForDispatchV1(
  execution: StoredKnowledgeStrategyExecution,
  draft: KnowledgeEvidenceDispatchManifestDraft
): KnowledgeStrategyCoverageRequestV1 {
  const frozen = execution.execution;
  if (!frozen || execution.purgedAt || execution.state !== "running") {
    throw new Error("knowledge_strategy_execution_not_finalizable");
  }
  const steps = execution.steps.flatMap(({ request }) => request ? [request] : []);
  const stepReceipts = execution.steps.flatMap(({ receipt }) => receipt ? [receipt] : []);
  if (steps.length !== execution.steps.length || stepReceipts.length !== execution.steps.length) {
    throw new Error("knowledge_strategy_steps_incomplete");
  }
  const outcomeSources = frozen.strategy === "multi_hop"
    ? []
    : frozen.config.kind === "comparison"
      ? frozen.config.targets.flatMap(({ sourceBindingId }) => {
          const source = sourceBindingId === null
            ? undefined
            : frozen.sourceSet.find(({ bindingId }) => bindingId === sourceBindingId);
          return source ? [source] : [];
        })
      : frozen.sourceSet;
  const sourceOutcomes = outcomeSources.map((source) => {
        const sourceSteps = steps.filter(({ sourceBindingId }) =>
          sourceBindingId === source.bindingId);
        const sourceReceipts = sourceSteps.flatMap((step) => {
          const receipt = stepReceipts.find(({ stepId }) => stepId === step.stepId);
          return receipt ? [receipt] : [];
        });
        const processedPassageCount = sourceReceipts.reduce((sum, receipt) =>
          sum + receipt.processedItemCount, 0);
        const succeeded = sourceReceipts.length === sourceSteps.length &&
          sourceReceipts.every(({ status }) => status === "succeeded");
        const exhausted = succeeded && sourceReceipts.length > 0 &&
          sourceReceipts.at(-1)!.cursorExhausted;
        const comparison = frozen.strategy === "comparison";
        const covered = comparison ? processedPassageCount > 0 :
          exhausted && processedPassageCount === source.passageCount;
        return Object.freeze({
          cursorExhausted: comparison ? succeeded : exhausted,
          expectedPassageCount: source.passageCount,
          processedItemsHash: hashKnowledgeStrategySourceProcessedItemsV1(
            source.bindingId,
            steps,
            stepReceipts
          ),
          processedPassageCount,
          reasonCode: null,
          sourceBindingId: source.bindingId,
          status: covered ? "covered" as const : "not_found" as const,
          version: 1 as const
        });
      });
  const targetOutcomes = frozen.config.kind === "comparison"
    ? frozen.config.targets.map((target) => {
        const targetSteps = steps.filter(({ targetOrdinal }) => targetOrdinal === target.ordinal);
        const targetReceipts = targetSteps.flatMap((step) => {
          const receipt = stepReceipts.find(({ stepId }) => stepId === step.stepId);
          return receipt ? [receipt] : [];
        });
        const evidenceItemCount = targetReceipts.reduce((sum, receipt) =>
          sum + receipt.processedItemCount, 0);
        const status = target.admission === "resolved"
          ? evidenceItemCount > 0 ? "covered" as const : "not_found" as const
          : target.admission === "ambiguous" ? "ambiguous" as const
            : target.admission === "not_ready" ? "not_ready" as const
              : "not_present" as const;
        const clean = status === "covered" || status === "not_found" ||
          status === "not_present";
        return Object.freeze({
          evidenceItemCount,
          evidenceItemsHash: hashKnowledgeStrategyTargetEvidenceItemsV1(
            target.ordinal,
            steps,
            stepReceipts
          ),
          ordinal: target.ordinal,
          reasonCode: clean ? null : `target_${status}`,
          referenceHash: target.referenceHash,
          sourceBindingId: target.sourceBindingId,
          status,
          version: 1 as const
        });
      })
    : [];
  const includedProjection = draft.items.map(({ evidenceId, itemHash }) => ({
    evidenceId,
    itemHash
  }));
  const expectedProjection = [
    ...includedProjection,
    ...draft.exclusions.map(({ evidenceId, reason }) => ({ evidenceId, reason }))
  ].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  const includedItemsHash = sha256(
    [...includedProjection].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId))
  );
  const mapOutputReceipts = frozen.strategy === "corpus_summary"
    ? execution.mapOutputs.map(({ receipt }) => {
        const decoded = decodeKnowledgeStrategyMapOutputReceiptV2(receipt);
        if (!decoded) throw new Error("knowledge_strategy_map_output_receipt_unavailable");
        return decoded;
      })
    : [];
  const summaryDispatchBindings = frozen.strategy === "corpus_summary"
    ? deriveKnowledgeStrategySummaryDispatchBindingsFromOutputsV2({
        manifest: draft,
        outputs: execution.mapOutputs.map(({ output }) => output)
      })
    : [];
  return createKnowledgeStrategyCoverageRequestV1({
    dependencies: execution.dependencies,
    dispatch: {
      excludedItemCount: draft.exclusions.filter(({ reason }) => reason !== "unavailable").length,
      expectedItemCount: draft.items.length + draft.exclusions.length,
      expectedItemsHash: sha256(expectedProjection),
      includedItemCount: draft.items.length,
      includedItemsHash,
      manifestHash: draft.manifestHash,
      shortenedItemCount: draft.items.filter(({ representation }) =>
        representation !== "full").length,
      unavailableItemCount: draft.exclusions.filter(({ reason }) => reason === "unavailable").length,
      version: 1
    },
    executionHash: hashKnowledgeStrategyExecutionRequestV1(frozen),
    mapOutputReceipts,
    observedSourceSet: frozen.sourceSet,
    observedSourceSetHash: hashKnowledgeAcceptedSourceSetV1(frozen.sourceSet),
    sourceOutcomes,
    stepReceipts,
    steps,
    summaryDispatchBindings,
    targetOutcomes,
    version: 1
  });
}

function successfulStepIds(execution: StoredKnowledgeStrategyExecution): ReadonlySet<string> {
  return new Set(execution.steps.flatMap((step) =>
    step.lifecycle.state === "settled" && step.receipt?.status === "succeeded"
      ? [step.lifecycle.stepId]
      : []));
}

function dependenciesSettled(
  execution: StoredKnowledgeStrategyExecution,
  step: StoredKnowledgeStrategyStep,
  successful: ReadonlySet<string>
): boolean {
  return execution.dependencies.filter(({ dependentStepId }) =>
    dependentStepId === step.lifecycle.stepId).every(({ prerequisiteStepId }) =>
    successful.has(prerequisiteStepId));
}

async function rebuildTerminalMapArtifacts(input: Readonly<{
  execution: StoredKnowledgeStrategyExecution;
  request: KnowledgeStrategyStepRequestV1;
  receipt: KnowledgeStrategyStepReceiptV1;
  runId: string;
  store: KnowledgeRetrievalStore;
  userId: string;
}>): Promise<DeterministicKnowledgeStrategyMapArtifactsV2> {
  const frozen = input.execution.execution;
  const loadPage = input.store.loadStrategyPassagePage;
  if (!frozen || frozen.strategy !== "corpus_summary" ||
    input.request.kind !== "corpus_summary_map" || !loadPage ||
    input.receipt.status !== "succeeded" || !input.receipt.cursorExhausted ||
    input.request.sourceBindingId === null) {
    throw new Error("knowledge_strategy_terminal_map_invalid");
  }
  const source = frozen.sourceSet.find(({ bindingId }) =>
    bindingId === input.request.sourceBindingId);
  if (!source) throw new Error("knowledge_strategy_source_unavailable");
  const mapSteps = input.execution.steps.filter((step) =>
    step.request?.kind === "corpus_summary_map" &&
    step.request.sourceBindingId === source.bindingId &&
    step.request.streamId === input.request.streamId).sort((left, right) =>
    left.request!.pageOrdinal - right.request!.pageOrdinal);
  if (mapSteps.length < 1 || mapSteps.at(-1)?.request?.stepId !== input.request.stepId) {
    throw new Error("knowledge_strategy_terminal_map_chain_invalid");
  }
  const requests: KnowledgeStrategyStepRequestV1[] = [];
  const receipts: KnowledgeStrategyStepReceiptV1[] = [];
  const pages: KnowledgeStrategyPassagePage[] = [];
  for (const step of mapSteps) {
    const request = step.request!;
    const receipt = request.stepId === input.request.stepId ? input.receipt : step.receipt;
    if (!receipt || receipt.status !== "succeeded" ||
      request.stepId !== input.request.stepId && step.lifecycle.state !== "settled") {
      throw new Error("knowledge_strategy_terminal_map_chain_invalid");
    }
    const page = await loadPage({
      cursor: request.cursor,
      executionId: request.executionId,
      limit: KNOWLEDGE_STRATEGY_PAGE_SIZE,
      runId: input.runId,
      source,
      streamId: request.streamId,
      userId: input.userId
    });
    requests.push(request);
    receipts.push(receipt);
    pages.push(page);
  }
  return createDeterministicKnowledgeStrategyMapArtifactsV2({
    execution: frozen,
    pages,
    source,
    stepReceipts: receipts,
    stepRequests: requests
  });
}

async function materializeReadySteps(
  repository: PrismaKnowledgeStrategyRepository,
  execution: StoredKnowledgeStrategyExecution,
  at: Date
): Promise<boolean> {
  const successful = successfulStepIds(execution);
  const ready = execution.steps.find((step) => step.lifecycle.state === "pending" &&
    step.request === null && step.template !== null &&
    dependenciesSettled(execution, step, successful));
  if (!ready) return false;
  if (ready.template!.kind === "corpus_summary_reduce") {
    const persistence = mapPersistence(repository);
    const mapOutputs = await persistence.loadMapOutputs({
      executionId: execution.execution!.executionId
    });
    for (const { output, receipt } of mapOutputs) {
      const strictOutput = decodeKnowledgeStrategyMapOutputV2(output);
      const strictReceipt = decodeKnowledgeStrategyMapOutputReceiptV2(receipt);
      if (!strictOutput || !strictReceipt ||
        strictOutput.outputHash !== strictReceipt.outputHash) {
        throw new Error("knowledge_strategy_map_output_set_invalid");
      }
    }
    await persistence.materializeReduceStepRequest({
      at,
      executionId: execution.execution!.executionId,
      stepId: ready.lifecycle.stepId
    });
    return true;
  }
  await repository.materializeStepRequest({
    at,
    executionId: execution.execution!.executionId,
    stepId: ready.lifecycle.stepId
  });
  return true;
}

/**
 * Runs only deterministic, replay-safe internal steps. Tool-call-bound work is
 * deliberately left pending for the ordinary authorization/budget/receipt path.
 */
export async function drainKnowledgeStrategyInternalSteps(input: Readonly<{
  executionId: string;
  repository: PrismaKnowledgeStrategyRepository;
  runId: string;
  store: KnowledgeRetrievalStore;
  userId: string;
}>): Promise<StoredKnowledgeStrategyExecution> {
  if (!input.store.loadStrategyPassagePage) {
    throw new Error("knowledge_strategy_page_store_unavailable");
  }
  for (let iteration = 0; iteration < 8_192; iteration += 1) {
    let execution = await input.repository.loadExecution(input.executionId);
    if (!execution?.execution || execution.purgedAt) {
      throw new Error("knowledge_strategy_execution_unavailable");
    }
    if (await materializeReadySteps(input.repository, execution, new Date())) continue;
    execution = await input.repository.loadExecution(input.executionId) ?? execution;
    const frozenExecution = execution.execution;
    if (!frozenExecution) throw new Error("knowledge_strategy_execution_unavailable");
    const successful = successfulStepIds(execution);
    const next = execution.steps.find((step) => step.modelRunToolCallId === null &&
      step.lifecycle.state === "pending" && step.request !== null &&
      dependenciesSettled(execution, step, successful));
    if (!next) return execution;
    const now = new Date();
    const claim = await input.repository.claimNextStep({
      executionId: input.executionId,
      leaseExpiresAt: new Date(now.valueOf() + INTERNAL_STEP_LEASE_MS),
      leaseToken: `strategy-internal:${randomUUID()}`,
      now
    });
    if (claim.kind !== "claimed" || claim.step.lifecycle.stepId !== next.lifecycle.stepId ||
      !claim.step.request) {
      throw new Error("knowledge_strategy_internal_claim_conflict");
    }
    const request = claim.step.request;
    let receipt: KnowledgeStrategyStepReceiptV1;
    let includedPassageCount = 0;
    if (request.kind === "full_context_page" || request.kind === "exhaustive_page" ||
      request.kind === "corpus_summary_map") {
      const source = frozenExecution.sourceSet.find(({ bindingId }) =>
        bindingId === request.sourceBindingId);
      if (!source) throw new Error("knowledge_strategy_source_unavailable");
      const page = await input.store.loadStrategyPassagePage({
        cursor: request.cursor,
        executionId: request.executionId,
        limit: request.kind === "corpus_summary_map"
          ? KNOWLEDGE_STRATEGY_PAGE_SIZE
          : request.kind === "exhaustive_page" ? 100 : 8,
        runId: input.runId,
        source,
        streamId: request.streamId,
        userId: input.userId
      });
      receipt = knowledgeStrategyPassageStepReceiptV1(request, page);
      includedPassageCount = 0;
    } else if (request.kind === "multi_hop_follow_up" && request.evidenceInputHash) {
      const dependencyCount = execution.dependencies.filter(({ dependentStepId }) =>
        dependentStepId === request.stepId).length;
      receipt = createKnowledgeStrategyStepReceiptV1({
        cursorExhausted: true,
        executionId: request.executionId,
        lastItemHash: dependencyCount > 0 ? request.evidenceInputHash : null,
        nextCursor: null,
        processedItemCount: dependencyCount,
        processedItemsHash: request.evidenceInputHash,
        reasonCode: null,
        requestHash: hashKnowledgeStrategyStepRequestV1(request),
        status: "succeeded",
        stepId: request.stepId,
        version: 1
      });
    } else {
      throw new Error("knowledge_strategy_internal_step_invalid");
    }
    const settlement = {
      at: new Date(),
      executionId: input.executionId,
      includedPassageCount,
      leaseToken: claim.leaseToken,
      receipt,
      stateVersion: claim.step.lifecycle.stateVersion,
      stepId: request.stepId
    } as const;
    if (request.kind === "corpus_summary_map" && receipt.cursorExhausted) {
      try {
        const artifacts = await rebuildTerminalMapArtifacts({
          execution: claim.execution,
          request,
          receipt,
          runId: input.runId,
          store: input.store,
          userId: input.userId
        });
        await mapPersistence(input.repository).settleMapStep({
          ...settlement,
          mapOutput: artifacts.output,
          mapOutputReceipt: artifacts.receipt
        });
      } catch (error) {
        const reasonCode = error instanceof Error &&
          /^knowledge_strategy_map_[a-z0-9_]+$/u.test(error.message)
          ? error.message
          : null;
        if (!reasonCode) throw error;
        await input.repository.failStep({
          ...settlement,
          includedPassageCount: 0,
          receipt: createKnowledgeStrategyStepReceiptV1({
            cursorExhausted: false,
            executionId: request.executionId,
            lastItemHash: receipt.lastItemHash,
            nextCursor: null,
            processedItemCount: receipt.processedItemCount,
            processedItemsHash: receipt.processedItemsHash,
            reasonCode,
            requestHash: receipt.requestHash,
            status: "failed",
            stepId: request.stepId,
            version: 1
          })
        });
      }
    } else {
      await input.repository.settleStep(settlement);
    }
  }
  throw new Error("knowledge_strategy_internal_step_limit_exceeded");
}

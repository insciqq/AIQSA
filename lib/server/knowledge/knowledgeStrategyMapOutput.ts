import { createHash } from "node:crypto";
import { decodeKnowledgeCitationHandle } from "../../contracts/knowledge";
import {
  decodeKnowledgeAcceptedSourceTupleV1,
  decodeKnowledgeStrategyExecutionRequestV1,
  decodeKnowledgeStrategyStepReceiptV1,
  decodeKnowledgeStrategyStepRequestV1,
  hashKnowledgeAcceptedSourceTupleV1,
  hashKnowledgeStrategyStepReceiptV1,
  hashKnowledgeStrategyStepRequestV1,
  KNOWLEDGE_STRATEGY_MAX_ITEMS,
  KNOWLEDGE_STRATEGY_MAX_SOURCES,
  KNOWLEDGE_STRATEGY_MAX_STEPS,
  type KnowledgeAcceptedSourceTupleV1,
  type KnowledgeStrategyExecutionRequestV1,
  type KnowledgeStrategyStepReceiptV1,
  type KnowledgeStrategyStepRequestV1
} from "./knowledgeStrategyExecution";
import { knowledgeStrategyPassageStepReceiptV1 } from "./knowledgeStrategyRuntime";
import type { KnowledgeStrategyPassagePage } from "./retrievalTypes";

export const KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION = 2 as const;
export const KNOWLEDGE_STRATEGY_MAP_MAX_SECTIONS = 64;
export const KNOWLEDGE_STRATEGY_MAP_MAX_SUMMARY_BYTES = 8 * 1024;
export const KNOWLEDGE_STRATEGY_MAP_MAX_TOTAL_SUMMARY_BYTES = 48 * 1024;
export const KNOWLEDGE_STRATEGY_MAP_MAX_SUPPORTING_PASSAGES = 4_096;

const SHA256 = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SOURCE_ALIAS = /^S[1-9]\d{0,2}$/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function hash(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapedJsonString(value: string): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, (character) => {
    switch (character) {
      case "<": return "\\u003c";
      case ">": return "\\u003e";
      case "&": return "\\u0026";
      case "\u2028": return "\\u2028";
      default: return "\\u2029";
    }
  });
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return escapedJsonString(value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort(compareStrings).map((key) =>
      `${escapedJsonString(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("knowledge_strategy_map_canonical_value_invalid");
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function throwInvalid(code: string): never {
  throw new Error(code);
}

export type KnowledgeStrategyMapSupportingPassageV2 = Readonly<{
  contentHash: string;
  passageId: string;
  passageOrdinal: number;
  sectionHash: string;
  sourceArtifactId: string;
  sourceBindingId: string;
  sourceId: string;
  sourceVersionId: string;
  version: typeof KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION;
}>;

const supportingPassageKeys = [
  "contentHash",
  "passageId",
  "passageOrdinal",
  "sectionHash",
  "sourceArtifactId",
  "sourceBindingId",
  "sourceId",
  "sourceVersionId",
  "version"
] as const;

export function decodeKnowledgeStrategyMapSupportingPassageV2(
  value: unknown
): KnowledgeStrategyMapSupportingPassageV2 | null {
  if (!record(value) || !exactKeys(value, supportingPassageKeys) ||
    value.version !== KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION || !hash(value.contentHash) ||
    !identifier(value.passageId) ||
    !boundedInteger(value.passageOrdinal, 0, KNOWLEDGE_STRATEGY_MAX_ITEMS - 1) ||
    !hash(value.sectionHash) || !identifier(value.sourceArtifactId) ||
    !identifier(value.sourceBindingId) || !identifier(value.sourceId) ||
    !identifier(value.sourceVersionId)) return null;
  return Object.freeze({
    contentHash: value.contentHash,
    passageId: value.passageId,
    passageOrdinal: Number(value.passageOrdinal),
    sectionHash: value.sectionHash,
    sourceArtifactId: value.sourceArtifactId,
    sourceBindingId: value.sourceBindingId,
    sourceId: value.sourceId,
    sourceVersionId: value.sourceVersionId,
    version: KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION
  });
}

export function canonicalKnowledgeStrategyMapSupportingPassageV2(value: unknown): string {
  const decoded = decodeKnowledgeStrategyMapSupportingPassageV2(value) ??
    throwInvalid("knowledge_strategy_map_supporting_passage_invalid");
  return canonicalJson(decoded);
}

export function hashKnowledgeStrategyMapSupportingPassageV2(value: unknown): string {
  const decoded = decodeKnowledgeStrategyMapSupportingPassageV2(value) ??
    throwInvalid("knowledge_strategy_map_supporting_passage_invalid");
  return sha256(decoded);
}

function decodeSupportingPassages(
  value: unknown,
  allowEmpty: boolean
): readonly KnowledgeStrategyMapSupportingPassageV2[] | null {
  if (!Array.isArray(value) || value.length > KNOWLEDGE_STRATEGY_MAP_MAX_SUPPORTING_PASSAGES ||
    !allowEmpty && value.length < 1) return null;
  const decoded = value.map(decodeKnowledgeStrategyMapSupportingPassageV2);
  if (decoded.some((passage) => passage === null)) return null;
  const passages = decoded as KnowledgeStrategyMapSupportingPassageV2[];
  if (new Set(passages.map(({ passageId }) => passageId)).size !== passages.length ||
    passages.some((passage, index) => index > 0 &&
      passage.passageOrdinal <= passages[index - 1]!.passageOrdinal)) return null;
  return Object.freeze(passages);
}

function hashSupportingPassages(
  passages: readonly KnowledgeStrategyMapSupportingPassageV2[]
): string {
  return sha256(passages);
}

export type KnowledgeStrategyMapSectionSummaryV2 = Readonly<{
  ordinal: number;
  sectionHash: string;
  summaryText: string;
  summaryTextHash: string;
  supportingPassageCount: number;
  supportingPassages: readonly KnowledgeStrategyMapSupportingPassageV2[];
  supportingPassagesHash: string;
  version: typeof KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION;
}>;

const sectionSummaryKeys = [
  "ordinal",
  "sectionHash",
  "summaryText",
  "summaryTextHash",
  "supportingPassageCount",
  "supportingPassages",
  "supportingPassagesHash",
  "version"
] as const;

export function decodeKnowledgeStrategyMapSectionSummaryV2(
  value: unknown
): KnowledgeStrategyMapSectionSummaryV2 | null {
  if (!record(value) || !exactKeys(value, sectionSummaryKeys) ||
    value.version !== KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION ||
    !boundedInteger(value.ordinal, 0, KNOWLEDGE_STRATEGY_MAP_MAX_SECTIONS - 1) ||
    !hash(value.sectionHash) || typeof value.summaryText !== "string" ||
    value.summaryText.length < 1 || value.summaryText.trim() !== value.summaryText ||
    value.summaryText.includes("\u0000") ||
    Buffer.byteLength(value.summaryText, "utf8") > KNOWLEDGE_STRATEGY_MAP_MAX_SUMMARY_BYTES ||
    !hash(value.summaryTextHash) || value.summaryTextHash !== sha256Text(value.summaryText) ||
    !boundedInteger(
      value.supportingPassageCount,
      1,
      KNOWLEDGE_STRATEGY_MAP_MAX_SUPPORTING_PASSAGES
    ) || !hash(value.supportingPassagesHash)) return null;
  const passages = decodeSupportingPassages(value.supportingPassages, false);
  if (!passages || passages.length !== value.supportingPassageCount ||
    hashSupportingPassages(passages) !== value.supportingPassagesHash ||
    passages.some(({ sectionHash }) => sectionHash !== value.sectionHash)) return null;
  return deepFreeze({
    ordinal: Number(value.ordinal),
    sectionHash: value.sectionHash,
    summaryText: value.summaryText,
    summaryTextHash: value.summaryTextHash,
    supportingPassageCount: Number(value.supportingPassageCount),
    supportingPassages: passages,
    supportingPassagesHash: value.supportingPassagesHash,
    version: KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION
  });
}

export function createKnowledgeStrategyMapSectionSummaryV2(input: Readonly<{
  ordinal: number;
  sectionHash: string;
  summaryText: string;
  supportingPassages: readonly unknown[];
}>): KnowledgeStrategyMapSectionSummaryV2 {
  const passages = decodeSupportingPassages(input.supportingPassages, false) ??
    throwInvalid("knowledge_strategy_map_summary_support_invalid");
  return decodeKnowledgeStrategyMapSectionSummaryV2({
    ordinal: input.ordinal,
    sectionHash: input.sectionHash,
    summaryText: input.summaryText,
    summaryTextHash: typeof input.summaryText === "string" ? sha256Text(input.summaryText) : "",
    supportingPassageCount: passages.length,
    supportingPassages: passages,
    supportingPassagesHash: hashSupportingPassages(passages),
    version: KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION
  }) ?? throwInvalid("knowledge_strategy_map_section_summary_invalid");
}

export function canonicalKnowledgeStrategyMapSectionSummaryV2(value: unknown): string {
  const decoded = decodeKnowledgeStrategyMapSectionSummaryV2(value) ??
    throwInvalid("knowledge_strategy_map_section_summary_invalid");
  return canonicalJson(decoded);
}

export function hashKnowledgeStrategyMapSectionSummaryV2(value: unknown): string {
  const decoded = decodeKnowledgeStrategyMapSectionSummaryV2(value) ??
    throwInvalid("knowledge_strategy_map_section_summary_invalid");
  return sha256(decoded);
}

function decodeSectionSummaries(
  value: unknown
): readonly KnowledgeStrategyMapSectionSummaryV2[] | null {
  if (!Array.isArray(value) || value.length < 1 ||
    value.length > KNOWLEDGE_STRATEGY_MAP_MAX_SECTIONS) return null;
  const decoded = value.map(decodeKnowledgeStrategyMapSectionSummaryV2);
  if (decoded.some((summary) => summary === null)) return null;
  const summaries = decoded as KnowledgeStrategyMapSectionSummaryV2[];
  if (summaries.some((summary, ordinal) => summary.ordinal !== ordinal) ||
    new Set(summaries.map(({ sectionHash }) => sectionHash)).size !== summaries.length ||
    summaries.reduce((sum, { summaryText }) =>
      sum + Buffer.byteLength(summaryText, "utf8"), 0) >
        KNOWLEDGE_STRATEGY_MAP_MAX_TOTAL_SUMMARY_BYTES) return null;
  return Object.freeze(summaries);
}

function hashSectionSummaries(summaries: readonly KnowledgeStrategyMapSectionSummaryV2[]): string {
  return sha256(summaries);
}

export type KnowledgeStrategyMapPageReceiptBindingV2 = Readonly<{
  pageOrdinal: number;
  processedItemCount: number;
  processedItemsHash: string;
  receiptHash: string;
  requestHash: string;
  stepId: string;
  version: typeof KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION;
}>;

const pageReceiptBindingKeys = [
  "pageOrdinal",
  "processedItemCount",
  "processedItemsHash",
  "receiptHash",
  "requestHash",
  "stepId",
  "version"
] as const;

export function decodeKnowledgeStrategyMapPageReceiptBindingV2(
  value: unknown
): KnowledgeStrategyMapPageReceiptBindingV2 | null {
  if (!record(value) || !exactKeys(value, pageReceiptBindingKeys) ||
    value.version !== KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION ||
    !boundedInteger(value.pageOrdinal, 0, KNOWLEDGE_STRATEGY_MAX_STEPS - 1) ||
    !boundedInteger(value.processedItemCount, 0, KNOWLEDGE_STRATEGY_MAX_ITEMS) ||
    !hash(value.processedItemsHash) || !hash(value.receiptHash) ||
    !hash(value.requestHash) || !identifier(value.stepId)) return null;
  return Object.freeze({
    pageOrdinal: Number(value.pageOrdinal),
    processedItemCount: Number(value.processedItemCount),
    processedItemsHash: value.processedItemsHash,
    receiptHash: value.receiptHash,
    requestHash: value.requestHash,
    stepId: value.stepId,
    version: KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION
  });
}

function decodePageReceiptBindings(
  value: unknown
): readonly KnowledgeStrategyMapPageReceiptBindingV2[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > KNOWLEDGE_STRATEGY_MAX_STEPS) {
    return null;
  }
  const decoded = value.map(decodeKnowledgeStrategyMapPageReceiptBindingV2);
  if (decoded.some((binding) => binding === null)) return null;
  const bindings = decoded as KnowledgeStrategyMapPageReceiptBindingV2[];
  if (bindings.some((binding, ordinal) => binding.pageOrdinal !== ordinal) ||
    new Set(bindings.map(({ stepId }) => stepId)).size !== bindings.length) return null;
  return Object.freeze(bindings);
}

function hashPageReceiptBindings(
  bindings: readonly KnowledgeStrategyMapPageReceiptBindingV2[]
): string {
  return sha256(bindings);
}

export type KnowledgeStrategyMapInputV2 = Readonly<{
  executionId: string;
  hierarchicalArtifactId: string;
  hierarchicalChecksum: string;
  inputHash: string;
  pageReceiptBindings: readonly KnowledgeStrategyMapPageReceiptBindingV2[];
  pageReceiptCount: number;
  pageReceiptsHash: string;
  passageCount: number;
  passageItems: readonly KnowledgeStrategyMapSupportingPassageV2[];
  passageItemsHash: string;
  sectionCount: number;
  sectionHashes: readonly string[];
  sectionHashesHash: string;
  sourceAlias: string;
  sourceArtifactId: string;
  sourceBindingId: string;
  sourceId: string;
  sourceOrdinal: number;
  sourceVersionId: string;
  sourceVersionNumber: number;
  terminalStepId: string;
  version: typeof KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION;
}>;

type KnowledgeStrategyMapInputBodyV2 = Omit<KnowledgeStrategyMapInputV2, "inputHash">;

const mapInputBodyKeys = [
  "executionId",
  "hierarchicalArtifactId",
  "hierarchicalChecksum",
  "pageReceiptBindings",
  "pageReceiptCount",
  "pageReceiptsHash",
  "passageCount",
  "passageItems",
  "passageItemsHash",
  "sectionCount",
  "sectionHashes",
  "sectionHashesHash",
  "sourceAlias",
  "sourceArtifactId",
  "sourceBindingId",
  "sourceId",
  "sourceOrdinal",
  "sourceVersionId",
  "sourceVersionNumber",
  "terminalStepId",
  "version"
] as const;
const mapInputKeys = [...mapInputBodyKeys, "inputHash"] as const;

function decodeMapInputBody(value: unknown): KnowledgeStrategyMapInputBodyV2 | null {
  if (!record(value) || !exactKeys(value, mapInputBodyKeys) ||
    value.version !== KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION ||
    !identifier(value.executionId) || !identifier(value.hierarchicalArtifactId) ||
    !hash(value.hierarchicalChecksum) ||
    !boundedInteger(value.pageReceiptCount, 1, KNOWLEDGE_STRATEGY_MAX_STEPS) ||
    !hash(value.pageReceiptsHash) ||
    !boundedInteger(value.passageCount, 1, KNOWLEDGE_STRATEGY_MAX_ITEMS) ||
    !hash(value.passageItemsHash) ||
    !boundedInteger(value.sectionCount, 1, KNOWLEDGE_STRATEGY_MAP_MAX_SECTIONS) ||
    !Array.isArray(value.sectionHashes) || value.sectionHashes.length !== value.sectionCount ||
    value.sectionHashes.some((sectionHash) => !hash(sectionHash)) ||
    new Set(value.sectionHashes).size !== value.sectionHashes.length ||
    !hash(value.sectionHashesHash) ||
    value.sectionHashesHash !== sha256(value.sectionHashes) ||
    typeof value.sourceAlias !== "string" || !SOURCE_ALIAS.test(value.sourceAlias) ||
    !identifier(value.sourceArtifactId) || !identifier(value.sourceBindingId) ||
    !identifier(value.sourceId) ||
    !boundedInteger(value.sourceOrdinal, 0, KNOWLEDGE_STRATEGY_MAX_SOURCES - 1) ||
    value.sourceAlias !== `S${Number(value.sourceOrdinal) + 1}` ||
    !identifier(value.sourceVersionId) ||
    !boundedInteger(value.sourceVersionNumber, 1, 2_147_483_647) ||
    !identifier(value.terminalStepId)) return null;
  const bindings = decodePageReceiptBindings(value.pageReceiptBindings);
  const passages = decodeSupportingPassages(value.passageItems, false);
  if (!bindings || bindings.length !== value.pageReceiptCount ||
    hashPageReceiptBindings(bindings) !== value.pageReceiptsHash ||
    !passages || passages.length !== value.passageCount ||
    hashSupportingPassages(passages) !== value.passageItemsHash ||
    bindings.reduce((sum, binding) => sum + binding.processedItemCount, 0) !==
      value.passageCount || bindings.at(-1)?.stepId !== value.terminalStepId ||
    passages.some((passage, passageOrdinal) =>
      passage.passageOrdinal !== passageOrdinal ||
      passage.sourceArtifactId !== value.sourceArtifactId ||
      passage.sourceBindingId !== value.sourceBindingId ||
      passage.sourceId !== value.sourceId ||
      passage.sourceVersionId !== value.sourceVersionId)) return null;
  const sectionHashes = [...new Set(passages.map(({ sectionHash }) => sectionHash))];
  if (canonicalJson(sectionHashes) !== canonicalJson(value.sectionHashes)) return null;
  return deepFreeze({
    executionId: value.executionId,
    hierarchicalArtifactId: value.hierarchicalArtifactId,
    hierarchicalChecksum: value.hierarchicalChecksum,
    pageReceiptBindings: bindings,
    pageReceiptCount: Number(value.pageReceiptCount),
    pageReceiptsHash: value.pageReceiptsHash,
    passageCount: Number(value.passageCount),
    passageItems: passages,
    passageItemsHash: value.passageItemsHash,
    sectionCount: Number(value.sectionCount),
    sectionHashes: Object.freeze([...(value.sectionHashes as string[])]),
    sectionHashesHash: value.sectionHashesHash,
    sourceAlias: value.sourceAlias,
    sourceArtifactId: value.sourceArtifactId,
    sourceBindingId: value.sourceBindingId,
    sourceId: value.sourceId,
    sourceOrdinal: Number(value.sourceOrdinal),
    sourceVersionId: value.sourceVersionId,
    sourceVersionNumber: Number(value.sourceVersionNumber),
    terminalStepId: value.terminalStepId,
    version: KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION
  });
}

export function decodeKnowledgeStrategyMapInputV2(value: unknown): KnowledgeStrategyMapInputV2 |
  null {
  if (!record(value) || !exactKeys(value, mapInputKeys) || !hash(value.inputHash)) return null;
  const { inputHash, ...bodyValue } = value;
  const body = decodeMapInputBody(bodyValue);
  if (!body || sha256(body) !== inputHash) return null;
  return deepFreeze({ ...body, inputHash });
}

function sealMapInput(bodyValue: unknown): KnowledgeStrategyMapInputV2 {
  const body = decodeMapInputBody(bodyValue) ??
    throwInvalid("knowledge_strategy_map_input_body_invalid");
  return deepFreeze({ ...body, inputHash: sha256(body) });
}

export function canonicalKnowledgeStrategyMapInputV2(value: unknown): string {
  const decoded = decodeKnowledgeStrategyMapInputV2(value) ??
    throwInvalid("knowledge_strategy_map_input_invalid");
  return canonicalJson(decoded);
}

export function hashKnowledgeStrategyMapInputV2(value: unknown): string {
  return decodeKnowledgeStrategyMapInputV2(value)?.inputHash ??
    throwInvalid("knowledge_strategy_map_input_invalid");
}

function sectionHashForPagePassage(
  page: KnowledgeStrategyPassagePage,
  index: number
): string {
  const passage = page.passages[index]!;
  return sha256({
    headingPath: passage.headingPath ?? [],
    sectionId: passage.sectionId ?? null,
    sourceArtifactId: page.source.sourceArtifactId
  });
}

function pageStartOrdinal(page: KnowledgeStrategyPassagePage): number | null {
  const first = page.items[0];
  return first && Number.isSafeInteger(first.passageOrdinal) ? first.passageOrdinal : null;
}

function strictSourceForMapInput(
  execution: KnowledgeStrategyExecutionRequestV1,
  sourceValue: unknown
): KnowledgeAcceptedSourceTupleV1 {
  const source = decodeKnowledgeAcceptedSourceTupleV1(sourceValue) ??
    throwInvalid("knowledge_strategy_map_source_invalid");
  const frozen = execution.sourceSet.find(({ bindingId }) => bindingId === source.bindingId);
  if (!frozen || hashKnowledgeAcceptedSourceTupleV1(frozen) !==
    hashKnowledgeAcceptedSourceTupleV1(source)) {
    throwInvalid("knowledge_strategy_map_source_mismatch");
  }
  return source;
}

export function deriveKnowledgeStrategyMapInputV2(input: Readonly<{
  execution: unknown;
  pages: readonly KnowledgeStrategyPassagePage[];
  source: unknown;
  stepReceipts: readonly unknown[];
  stepRequests: readonly unknown[];
}>): KnowledgeStrategyMapInputV2 {
  const execution = decodeKnowledgeStrategyExecutionRequestV1(input.execution) ??
    throwInvalid("knowledge_strategy_map_execution_invalid");
  if (execution.strategy !== "corpus_summary" || execution.config.kind !== "corpus_summary") {
    throwInvalid("knowledge_strategy_map_execution_invalid");
  }
  const source = strictSourceForMapInput(execution, input.source);
  if (!Array.isArray(input.pages) || !Array.isArray(input.stepRequests) ||
    !Array.isArray(input.stepReceipts) || input.pages.length < 1 ||
    input.pages.length !== input.stepRequests.length ||
    input.pages.length !== input.stepReceipts.length ||
    input.pages.length > KNOWLEDGE_STRATEGY_MAX_STEPS) {
    throwInvalid("knowledge_strategy_map_page_set_invalid");
  }
  const steps = input.stepRequests.map(decodeKnowledgeStrategyStepRequestV1);
  const receipts = input.stepReceipts.map(decodeKnowledgeStrategyStepReceiptV1);
  if (steps.some((step) => step === null) || receipts.some((receipt) => receipt === null)) {
    throwInvalid("knowledge_strategy_map_page_set_invalid");
  }
  const strictSteps = (steps as KnowledgeStrategyStepRequestV1[]).sort((left, right) =>
    left.pageOrdinal - right.pageOrdinal);
  const receiptsByStepId = new Map((receipts as KnowledgeStrategyStepReceiptV1[])
    .map((receipt) => [receipt.stepId, receipt]));
  const pagesByStartOrdinal = new Map<number, KnowledgeStrategyPassagePage>();
  for (const page of input.pages) {
    const startOrdinal = pageStartOrdinal(page);
    if (startOrdinal === null || pagesByStartOrdinal.has(startOrdinal) ||
      hashKnowledgeAcceptedSourceTupleV1(page.source) !==
        hashKnowledgeAcceptedSourceTupleV1(source)) {
      throwInvalid("knowledge_strategy_map_page_set_invalid");
    }
    pagesByStartOrdinal.set(startOrdinal, page);
  }

  const bindings: KnowledgeStrategyMapPageReceiptBindingV2[] = [];
  const passageItems: KnowledgeStrategyMapSupportingPassageV2[] = [];
  let previousReceipt: KnowledgeStrategyStepReceiptV1 | null = null;
  for (const [pageOrdinal, step] of strictSteps.entries()) {
    if (step.kind !== "corpus_summary_map" || step.strategy !== "corpus_summary" ||
      step.executionId !== execution.executionId || step.sourceSetHash !== execution.sourceSetHash ||
      step.inputHash !== execution.config.mapInputHash || !step.required ||
      step.sourceBindingId !== source.bindingId || step.pageOrdinal !== pageOrdinal ||
      (pageOrdinal === 0
        ? step.cursor !== null
        : !previousReceipt?.nextCursor ||
          canonicalJson(step.cursor) !== canonicalJson(previousReceipt.nextCursor))) {
      throwInvalid("knowledge_strategy_map_page_request_invalid");
    }
    const startOrdinal = step.cursor?.nextPassageOrdinal ?? 0;
    const page = pagesByStartOrdinal.get(startOrdinal);
    const receipt = receiptsByStepId.get(step.stepId);
    if (!page || !receipt) throwInvalid("knowledge_strategy_map_page_set_invalid");
    const recomputed = knowledgeStrategyPassageStepReceiptV1(step, page);
    if (hashKnowledgeStrategyStepReceiptV1(recomputed) !==
      hashKnowledgeStrategyStepReceiptV1(receipt)) {
      throwInvalid("knowledge_strategy_map_page_receipt_mismatch");
    }
    if ((pageOrdinal < strictSteps.length - 1) === page.complete) {
      throwInvalid("knowledge_strategy_map_page_chain_invalid");
    }
    bindings.push(Object.freeze({
      pageOrdinal,
      processedItemCount: receipt.processedItemCount,
      processedItemsHash: receipt.processedItemsHash,
      receiptHash: hashKnowledgeStrategyStepReceiptV1(receipt),
      requestHash: hashKnowledgeStrategyStepRequestV1(step),
      stepId: step.stepId,
      version: KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION
    }));
    for (const [index, item] of page.items.entries()) {
      passageItems.push(Object.freeze({
        contentHash: item.contentHash,
        passageId: item.passageId,
        passageOrdinal: item.passageOrdinal,
        sectionHash: sectionHashForPagePassage(page, index),
        sourceArtifactId: source.sourceArtifactId,
        sourceBindingId: source.bindingId,
        sourceId: source.sourceId,
        sourceVersionId: source.sourceVersionId,
        version: KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION
      }));
    }
    previousReceipt = receipt;
  }
  if (pagesByStartOrdinal.size !== strictSteps.length ||
    passageItems.length !== source.passageCount ||
    passageItems.some((passage, ordinal) => passage.passageOrdinal !== ordinal) ||
    previousReceipt?.cursorExhausted !== true) {
    throwInvalid("knowledge_strategy_map_source_coverage_invalid");
  }
  const decodedBindings = decodePageReceiptBindings(bindings) ??
    throwInvalid("knowledge_strategy_map_page_receipts_invalid");
  const decodedPassages = decodeSupportingPassages(passageItems, false) ??
    throwInvalid("knowledge_strategy_map_passage_items_invalid");
  const sectionHashes = Object.freeze([
    ...new Set(decodedPassages.map(({ sectionHash }) => sectionHash))
  ]);
  if (sectionHashes.length < 1 ||
    sectionHashes.length > KNOWLEDGE_STRATEGY_MAP_MAX_SECTIONS) {
    throwInvalid("knowledge_strategy_map_section_count_invalid");
  }
  return sealMapInput({
    executionId: execution.executionId,
    hierarchicalArtifactId: source.hierarchicalArtifactId,
    hierarchicalChecksum: source.hierarchicalChecksum,
    pageReceiptBindings: decodedBindings,
    pageReceiptCount: decodedBindings.length,
    pageReceiptsHash: hashPageReceiptBindings(decodedBindings),
    passageCount: decodedPassages.length,
    passageItems: decodedPassages,
    passageItemsHash: hashSupportingPassages(decodedPassages),
    sectionCount: sectionHashes.length,
    sectionHashes,
    sectionHashesHash: sha256(sectionHashes),
    sourceAlias: source.sourceAlias,
    sourceArtifactId: source.sourceArtifactId,
    sourceBindingId: source.bindingId,
    sourceId: source.sourceId,
    sourceOrdinal: source.ordinal,
    sourceVersionId: source.sourceVersionId,
    sourceVersionNumber: source.sourceVersionNumber,
    terminalStepId: decodedBindings.at(-1)!.stepId,
    version: KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION
  });
}

export type KnowledgeStrategyMapOutputV2 = Readonly<{
  executionId: string;
  hierarchicalArtifactId: string;
  hierarchicalChecksum: string;
  inputPageReceiptCount: number;
  inputPageReceiptsHash: string;
  inputPassageCount: number;
  inputPassageItemsHash: string;
  inputSectionCount: number;
  inputSectionHashesHash: string;
  mapInputHash: string;
  outputHash: string;
  processedPassageCount: number;
  sourceAlias: string;
  sourceArtifactId: string;
  sourceBindingId: string;
  sourceId: string;
  sourceOrdinal: number;
  sourceVersionId: string;
  sourceVersionNumber: number;
  summaries: readonly KnowledgeStrategyMapSectionSummaryV2[];
  summaryItemCount: number;
  summaryItemsHash: string;
  terminalStepId: string;
  version: typeof KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION;
}>;

type KnowledgeStrategyMapOutputBodyV2 = Omit<KnowledgeStrategyMapOutputV2, "outputHash">;

const mapOutputBodyKeys = [
  "executionId",
  "hierarchicalArtifactId",
  "hierarchicalChecksum",
  "inputPageReceiptCount",
  "inputPageReceiptsHash",
  "inputPassageCount",
  "inputPassageItemsHash",
  "inputSectionCount",
  "inputSectionHashesHash",
  "mapInputHash",
  "processedPassageCount",
  "sourceAlias",
  "sourceArtifactId",
  "sourceBindingId",
  "sourceId",
  "sourceOrdinal",
  "sourceVersionId",
  "sourceVersionNumber",
  "summaries",
  "summaryItemCount",
  "summaryItemsHash",
  "terminalStepId",
  "version"
] as const;
const mapOutputKeys = [...mapOutputBodyKeys, "outputHash"] as const;

function decodeMapOutputBody(value: unknown): KnowledgeStrategyMapOutputBodyV2 | null {
  if (!record(value) || !exactKeys(value, mapOutputBodyKeys) ||
    value.version !== KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION ||
    !identifier(value.executionId) || !identifier(value.hierarchicalArtifactId) ||
    !hash(value.hierarchicalChecksum) ||
    !boundedInteger(value.inputPageReceiptCount, 1, KNOWLEDGE_STRATEGY_MAX_STEPS) ||
    !hash(value.inputPageReceiptsHash) ||
    !boundedInteger(value.inputPassageCount, 1, KNOWLEDGE_STRATEGY_MAX_ITEMS) ||
    !hash(value.inputPassageItemsHash) ||
    !boundedInteger(value.inputSectionCount, 1, KNOWLEDGE_STRATEGY_MAP_MAX_SECTIONS) ||
    !hash(value.inputSectionHashesHash) || !hash(value.mapInputHash) ||
    !boundedInteger(value.processedPassageCount, 1, KNOWLEDGE_STRATEGY_MAX_ITEMS) ||
    value.processedPassageCount !== value.inputPassageCount ||
    typeof value.sourceAlias !== "string" || !SOURCE_ALIAS.test(value.sourceAlias) ||
    !identifier(value.sourceArtifactId) || !identifier(value.sourceBindingId) ||
    !identifier(value.sourceId) || !boundedInteger(
      value.sourceOrdinal,
      0,
      KNOWLEDGE_STRATEGY_MAX_SOURCES - 1
    ) ||
    value.sourceAlias !== `S${Number(value.sourceOrdinal) + 1}` ||
    !identifier(value.sourceVersionId) ||
    !boundedInteger(value.sourceVersionNumber, 1, 2_147_483_647) ||
    !boundedInteger(value.summaryItemCount, 1, KNOWLEDGE_STRATEGY_MAP_MAX_SECTIONS) ||
    !hash(value.summaryItemsHash) || !identifier(value.terminalStepId)) return null;
  const summaries = decodeSectionSummaries(value.summaries);
  if (!summaries || summaries.length !== value.summaryItemCount ||
    summaries.length !== value.inputSectionCount ||
    hashSectionSummaries(summaries) !== value.summaryItemsHash ||
    sha256(summaries.map(({ sectionHash }) => sectionHash)) !== value.inputSectionHashesHash ||
    summaries.some((summary) => summary.supportingPassages.some((passage) =>
      passage.sourceArtifactId !== value.sourceArtifactId ||
      passage.sourceBindingId !== value.sourceBindingId ||
      passage.sourceId !== value.sourceId ||
      passage.sourceVersionId !== value.sourceVersionId ||
      passage.passageOrdinal >= Number(value.inputPassageCount)))) return null;
  return deepFreeze({
    executionId: value.executionId,
    hierarchicalArtifactId: value.hierarchicalArtifactId,
    hierarchicalChecksum: value.hierarchicalChecksum,
    inputPageReceiptCount: Number(value.inputPageReceiptCount),
    inputPageReceiptsHash: value.inputPageReceiptsHash,
    inputPassageCount: Number(value.inputPassageCount),
    inputPassageItemsHash: value.inputPassageItemsHash,
    inputSectionCount: Number(value.inputSectionCount),
    inputSectionHashesHash: value.inputSectionHashesHash,
    mapInputHash: value.mapInputHash,
    processedPassageCount: Number(value.processedPassageCount),
    sourceAlias: value.sourceAlias,
    sourceArtifactId: value.sourceArtifactId,
    sourceBindingId: value.sourceBindingId,
    sourceId: value.sourceId,
    sourceOrdinal: Number(value.sourceOrdinal),
    sourceVersionId: value.sourceVersionId,
    sourceVersionNumber: Number(value.sourceVersionNumber),
    summaries,
    summaryItemCount: Number(value.summaryItemCount),
    summaryItemsHash: value.summaryItemsHash,
    terminalStepId: value.terminalStepId,
    version: KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION
  });
}

export function decodeKnowledgeStrategyMapOutputV2(value: unknown): KnowledgeStrategyMapOutputV2 |
  null {
  if (!record(value) || !exactKeys(value, mapOutputKeys) || !hash(value.outputHash)) return null;
  const { outputHash, ...bodyValue } = value;
  const body = decodeMapOutputBody(bodyValue);
  if (!body || sha256(body) !== outputHash) return null;
  return deepFreeze({ ...body, outputHash });
}

export function createKnowledgeStrategyMapOutputV2(input: Readonly<{
  mapInput: unknown;
  summaries: readonly unknown[];
}>): KnowledgeStrategyMapOutputV2 {
  const mapInput = decodeKnowledgeStrategyMapInputV2(input.mapInput) ??
    throwInvalid("knowledge_strategy_map_input_invalid");
  const summaries = decodeSectionSummaries(input.summaries) ??
    throwInvalid("knowledge_strategy_map_summaries_invalid");
  if (canonicalJson(summaries.map(({ sectionHash }) => sectionHash)) !==
    canonicalJson(mapInput.sectionHashes)) {
    throwInvalid("knowledge_strategy_map_section_coverage_invalid");
  }
  const inputPassagesByHash = new Map(mapInput.passageItems.map((passage) =>
    [hashKnowledgeStrategyMapSupportingPassageV2(passage), passage]));
  if (summaries.some((summary) => summary.supportingPassages.some((passage) =>
    !inputPassagesByHash.has(hashKnowledgeStrategyMapSupportingPassageV2(passage))))) {
    throwInvalid("knowledge_strategy_map_support_outside_input");
  }
  const body = decodeMapOutputBody({
    executionId: mapInput.executionId,
    hierarchicalArtifactId: mapInput.hierarchicalArtifactId,
    hierarchicalChecksum: mapInput.hierarchicalChecksum,
    inputPageReceiptCount: mapInput.pageReceiptCount,
    inputPageReceiptsHash: mapInput.pageReceiptsHash,
    inputPassageCount: mapInput.passageCount,
    inputPassageItemsHash: mapInput.passageItemsHash,
    inputSectionCount: mapInput.sectionCount,
    inputSectionHashesHash: mapInput.sectionHashesHash,
    mapInputHash: mapInput.inputHash,
    processedPassageCount: mapInput.passageCount,
    sourceAlias: mapInput.sourceAlias,
    sourceArtifactId: mapInput.sourceArtifactId,
    sourceBindingId: mapInput.sourceBindingId,
    sourceId: mapInput.sourceId,
    sourceOrdinal: mapInput.sourceOrdinal,
    sourceVersionId: mapInput.sourceVersionId,
    sourceVersionNumber: mapInput.sourceVersionNumber,
    summaries,
    summaryItemCount: summaries.length,
    summaryItemsHash: hashSectionSummaries(summaries),
    terminalStepId: mapInput.terminalStepId,
    version: KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION
  }) ?? throwInvalid("knowledge_strategy_map_output_body_invalid");
  return deepFreeze({ ...body, outputHash: sha256(body) });
}

export function canonicalKnowledgeStrategyMapOutputV2(value: unknown): string {
  const decoded = decodeKnowledgeStrategyMapOutputV2(value) ??
    throwInvalid("knowledge_strategy_map_output_invalid");
  return canonicalJson(decoded);
}

export function hashKnowledgeStrategyMapOutputV2(value: unknown): string {
  return decodeKnowledgeStrategyMapOutputV2(value)?.outputHash ??
    throwInvalid("knowledge_strategy_map_output_invalid");
}

export function verifyKnowledgeStrategyMapOutputInputV2(
  mapInputValue: unknown,
  outputValue: unknown
): boolean {
  const mapInput = decodeKnowledgeStrategyMapInputV2(mapInputValue);
  const output = decodeKnowledgeStrategyMapOutputV2(outputValue);
  return Boolean(mapInput && output && output.mapInputHash === mapInput.inputHash &&
    output.executionId === mapInput.executionId &&
    output.sourceBindingId === mapInput.sourceBindingId &&
    output.inputPageReceiptsHash === mapInput.pageReceiptsHash &&
    output.inputPassageItemsHash === mapInput.passageItemsHash);
}

export type KnowledgeStrategyMapOutputReceiptV2 = Readonly<{
  executionId: string;
  inputPageReceiptCount: number;
  inputPageReceiptsHash: string;
  inputPassageCount: number;
  inputPassageItemsHash: string;
  inputSectionCount: number;
  inputSectionHashesHash: string;
  mapInputHash: string;
  outputHash: string;
  processedPassageCount: number;
  receiptHash: string;
  sourceBindingId: string;
  sourceOrdinal: number;
  summaryItemCount: number;
  summaryItemsHash: string;
  terminalStepId: string;
  version: typeof KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION;
}>;

type KnowledgeStrategyMapOutputReceiptBodyV2 = Omit<
  KnowledgeStrategyMapOutputReceiptV2,
  "receiptHash"
>;

const outputReceiptBodyKeys = [
  "executionId",
  "inputPageReceiptCount",
  "inputPageReceiptsHash",
  "inputPassageCount",
  "inputPassageItemsHash",
  "inputSectionCount",
  "inputSectionHashesHash",
  "mapInputHash",
  "outputHash",
  "processedPassageCount",
  "sourceBindingId",
  "sourceOrdinal",
  "summaryItemCount",
  "summaryItemsHash",
  "terminalStepId",
  "version"
] as const;
const outputReceiptKeys = [...outputReceiptBodyKeys, "receiptHash"] as const;

function decodeOutputReceiptBody(value: unknown): KnowledgeStrategyMapOutputReceiptBodyV2 | null {
  if (!record(value) || !exactKeys(value, outputReceiptBodyKeys) ||
    value.version !== KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION ||
    !identifier(value.executionId) ||
    !boundedInteger(value.inputPageReceiptCount, 1, KNOWLEDGE_STRATEGY_MAX_STEPS) ||
    !hash(value.inputPageReceiptsHash) ||
    !boundedInteger(value.inputPassageCount, 1, KNOWLEDGE_STRATEGY_MAX_ITEMS) ||
    !hash(value.inputPassageItemsHash) ||
    !boundedInteger(value.inputSectionCount, 1, KNOWLEDGE_STRATEGY_MAP_MAX_SECTIONS) ||
    !hash(value.inputSectionHashesHash) || !hash(value.mapInputHash) ||
    !hash(value.outputHash) ||
    !boundedInteger(value.processedPassageCount, 1, KNOWLEDGE_STRATEGY_MAX_ITEMS) ||
    value.processedPassageCount !== value.inputPassageCount ||
    !identifier(value.sourceBindingId) || !boundedInteger(
      value.sourceOrdinal,
      0,
      KNOWLEDGE_STRATEGY_MAX_SOURCES - 1
    ) ||
    !boundedInteger(value.summaryItemCount, 1, KNOWLEDGE_STRATEGY_MAP_MAX_SECTIONS) ||
    value.summaryItemCount !== value.inputSectionCount || !hash(value.summaryItemsHash) ||
    !identifier(value.terminalStepId)) return null;
  return Object.freeze({
    executionId: value.executionId,
    inputPageReceiptCount: Number(value.inputPageReceiptCount),
    inputPageReceiptsHash: value.inputPageReceiptsHash,
    inputPassageCount: Number(value.inputPassageCount),
    inputPassageItemsHash: value.inputPassageItemsHash,
    inputSectionCount: Number(value.inputSectionCount),
    inputSectionHashesHash: value.inputSectionHashesHash,
    mapInputHash: value.mapInputHash,
    outputHash: value.outputHash,
    processedPassageCount: Number(value.processedPassageCount),
    sourceBindingId: value.sourceBindingId,
    sourceOrdinal: Number(value.sourceOrdinal),
    summaryItemCount: Number(value.summaryItemCount),
    summaryItemsHash: value.summaryItemsHash,
    terminalStepId: value.terminalStepId,
    version: KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION
  });
}

export function createKnowledgeStrategyMapOutputReceiptV2(
  outputValue: unknown
): KnowledgeStrategyMapOutputReceiptV2 {
  const output = decodeKnowledgeStrategyMapOutputV2(outputValue) ??
    throwInvalid("knowledge_strategy_map_output_invalid");
  const body = decodeOutputReceiptBody({
    executionId: output.executionId,
    inputPageReceiptCount: output.inputPageReceiptCount,
    inputPageReceiptsHash: output.inputPageReceiptsHash,
    inputPassageCount: output.inputPassageCount,
    inputPassageItemsHash: output.inputPassageItemsHash,
    inputSectionCount: output.inputSectionCount,
    inputSectionHashesHash: output.inputSectionHashesHash,
    mapInputHash: output.mapInputHash,
    outputHash: output.outputHash,
    processedPassageCount: output.processedPassageCount,
    sourceBindingId: output.sourceBindingId,
    sourceOrdinal: output.sourceOrdinal,
    summaryItemCount: output.summaryItemCount,
    summaryItemsHash: output.summaryItemsHash,
    terminalStepId: output.terminalStepId,
    version: KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION
  }) ?? throwInvalid("knowledge_strategy_map_output_receipt_body_invalid");
  return Object.freeze({ ...body, receiptHash: sha256(body) });
}

export function decodeKnowledgeStrategyMapOutputReceiptV2(
  value: unknown
): KnowledgeStrategyMapOutputReceiptV2 | null {
  if (!record(value) || !exactKeys(value, outputReceiptKeys) || !hash(value.receiptHash)) return null;
  const { receiptHash, ...bodyValue } = value;
  const body = decodeOutputReceiptBody(bodyValue);
  if (!body || sha256(body) !== receiptHash) return null;
  return Object.freeze({ ...body, receiptHash });
}

export function canonicalKnowledgeStrategyMapOutputReceiptV2(value: unknown): string {
  const decoded = decodeKnowledgeStrategyMapOutputReceiptV2(value) ??
    throwInvalid("knowledge_strategy_map_output_receipt_invalid");
  return canonicalJson(decoded);
}

export function hashKnowledgeStrategyMapOutputReceiptV2(value: unknown): string {
  return decodeKnowledgeStrategyMapOutputReceiptV2(value)?.receiptHash ??
    throwInvalid("knowledge_strategy_map_output_receipt_invalid");
}

export type KnowledgeStrategyMapOutputDependencyEntryV2 = Readonly<{
  outputHash: string;
  receiptHash: string;
  sourceBindingId: string;
  sourceOrdinal: number;
  summaryItemsHash: string;
  terminalStepId: string;
  version: typeof KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION;
}>;

const dependencyEntryKeys = [
  "outputHash",
  "receiptHash",
  "sourceBindingId",
  "sourceOrdinal",
  "summaryItemsHash",
  "terminalStepId",
  "version"
] as const;

export function decodeKnowledgeStrategyMapOutputDependencyEntryV2(
  value: unknown
): KnowledgeStrategyMapOutputDependencyEntryV2 | null {
  if (!record(value) || !exactKeys(value, dependencyEntryKeys) ||
    value.version !== KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION || !hash(value.outputHash) ||
    !hash(value.receiptHash) || !identifier(value.sourceBindingId) ||
    !boundedInteger(value.sourceOrdinal, 0, KNOWLEDGE_STRATEGY_MAX_SOURCES - 1) ||
    !hash(value.summaryItemsHash) ||
    !identifier(value.terminalStepId)) return null;
  return Object.freeze({
    outputHash: value.outputHash,
    receiptHash: value.receiptHash,
    sourceBindingId: value.sourceBindingId,
    sourceOrdinal: Number(value.sourceOrdinal),
    summaryItemsHash: value.summaryItemsHash,
    terminalStepId: value.terminalStepId,
    version: KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION
  });
}

export type KnowledgeStrategyMapOutputDependencyInputV2 = Readonly<{
  dependencyInputHash: string;
  dependentStepId: string;
  executionId: string;
  mapOutputCount: number;
  mapOutputs: readonly KnowledgeStrategyMapOutputDependencyEntryV2[];
  mapOutputsHash: string;
  sourceSetHash: string;
  version: typeof KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION;
}>;

type KnowledgeStrategyMapOutputDependencyInputBodyV2 = Omit<
  KnowledgeStrategyMapOutputDependencyInputV2,
  "dependencyInputHash"
>;

const dependencyInputBodyKeys = [
  "dependentStepId",
  "executionId",
  "mapOutputCount",
  "mapOutputs",
  "mapOutputsHash",
  "sourceSetHash",
  "version"
] as const;
const dependencyInputKeys = [...dependencyInputBodyKeys, "dependencyInputHash"] as const;

function decodeDependencyEntries(
  value: unknown
): readonly KnowledgeStrategyMapOutputDependencyEntryV2[] | null {
  if (!Array.isArray(value) || value.length < 1 ||
    value.length > KNOWLEDGE_STRATEGY_MAX_SOURCES) return null;
  const decoded = value.map(decodeKnowledgeStrategyMapOutputDependencyEntryV2);
  if (decoded.some((entry) => entry === null)) return null;
  const entries = decoded as KnowledgeStrategyMapOutputDependencyEntryV2[];
  if (entries.some((entry, index) => index > 0 &&
    entry.sourceOrdinal <= entries[index - 1]!.sourceOrdinal) ||
    new Set(entries.map(({ sourceBindingId }) => sourceBindingId)).size !== entries.length ||
    new Set(entries.map(({ terminalStepId }) => terminalStepId)).size !== entries.length) return null;
  return Object.freeze(entries);
}

function decodeDependencyInputBody(
  value: unknown
): KnowledgeStrategyMapOutputDependencyInputBodyV2 | null {
  if (!record(value) || !exactKeys(value, dependencyInputBodyKeys) ||
    value.version !== KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION ||
    !identifier(value.dependentStepId) || !identifier(value.executionId) ||
    !boundedInteger(value.mapOutputCount, 1, KNOWLEDGE_STRATEGY_MAX_SOURCES) ||
    !hash(value.mapOutputsHash) ||
    !hash(value.sourceSetHash)) return null;
  const entries = decodeDependencyEntries(value.mapOutputs);
  if (!entries || entries.length !== value.mapOutputCount ||
    sha256(entries) !== value.mapOutputsHash) return null;
  return deepFreeze({
    dependentStepId: value.dependentStepId,
    executionId: value.executionId,
    mapOutputCount: Number(value.mapOutputCount),
    mapOutputs: entries,
    mapOutputsHash: value.mapOutputsHash,
    sourceSetHash: value.sourceSetHash,
    version: KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION
  });
}

export function createKnowledgeStrategyMapOutputDependencyInputV2(input: Readonly<{
  dependentStepId: string;
  execution: unknown;
  receipts: readonly unknown[];
}>): KnowledgeStrategyMapOutputDependencyInputV2 {
  const execution = decodeKnowledgeStrategyExecutionRequestV1(input.execution) ??
    throwInvalid("knowledge_strategy_map_dependency_execution_invalid");
  if (execution.strategy !== "corpus_summary" || execution.config.kind !== "corpus_summary" ||
    !identifier(input.dependentStepId) || !Array.isArray(input.receipts)) {
    throwInvalid("knowledge_strategy_map_dependency_input_invalid");
  }
  const decodedReceipts = input.receipts.map(decodeKnowledgeStrategyMapOutputReceiptV2);
  if (decodedReceipts.some((receipt) => receipt === null)) {
    throwInvalid("knowledge_strategy_map_dependency_receipt_invalid");
  }
  const receipts = (decodedReceipts as KnowledgeStrategyMapOutputReceiptV2[])
    .sort((left, right) => left.sourceOrdinal - right.sourceOrdinal);
  if (receipts.length !== execution.sourceSet.length || receipts.some((receipt, ordinal) => {
    const source = execution.sourceSet[ordinal];
    return !source || receipt.executionId !== execution.executionId ||
      receipt.sourceOrdinal !== source.ordinal || receipt.sourceBindingId !== source.bindingId;
  })) throwInvalid("knowledge_strategy_map_dependency_source_set_mismatch");
  const entries = decodeDependencyEntries(receipts.map((receipt) => ({
    outputHash: receipt.outputHash,
    receiptHash: receipt.receiptHash,
    sourceBindingId: receipt.sourceBindingId,
    sourceOrdinal: receipt.sourceOrdinal,
    summaryItemsHash: receipt.summaryItemsHash,
    terminalStepId: receipt.terminalStepId,
    version: KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION
  }))) ?? throwInvalid("knowledge_strategy_map_dependency_entries_invalid");
  const body = decodeDependencyInputBody({
    dependentStepId: input.dependentStepId,
    executionId: execution.executionId,
    mapOutputCount: entries.length,
    mapOutputs: entries,
    mapOutputsHash: sha256(entries),
    sourceSetHash: execution.sourceSetHash,
    version: KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION
  }) ?? throwInvalid("knowledge_strategy_map_dependency_body_invalid");
  return deepFreeze({ ...body, dependencyInputHash: sha256(body) });
}

export function decodeKnowledgeStrategyMapOutputDependencyInputV2(
  value: unknown
): KnowledgeStrategyMapOutputDependencyInputV2 | null {
  if (!record(value) || !exactKeys(value, dependencyInputKeys) ||
    !hash(value.dependencyInputHash)) return null;
  const { dependencyInputHash, ...bodyValue } = value;
  const body = decodeDependencyInputBody(bodyValue);
  if (!body || sha256(body) !== dependencyInputHash) return null;
  return deepFreeze({ ...body, dependencyInputHash });
}

export function canonicalKnowledgeStrategyMapOutputDependencyInputV2(value: unknown): string {
  const decoded = decodeKnowledgeStrategyMapOutputDependencyInputV2(value) ??
    throwInvalid("knowledge_strategy_map_dependency_input_invalid");
  return canonicalJson(decoded);
}

export function hashKnowledgeStrategyMapOutputDependencyInputV2(value: unknown): string {
  return decodeKnowledgeStrategyMapOutputDependencyInputV2(value)?.dependencyInputHash ??
    throwInvalid("knowledge_strategy_map_dependency_input_invalid");
}

export type KnowledgeStrategyMapSupportHandleBindingV2 = Readonly<{
  contentHash: string;
  handle: string;
  passageId: string;
  passageOrdinal: number;
  sectionHash: string;
  sourceArtifactId: string;
  sourceBindingId: string;
  sourceId: string;
  sourceVersionId: string;
  version: typeof KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION;
}>;

const supportHandleBindingKeys = [
  "contentHash",
  "handle",
  "passageId",
  "passageOrdinal",
  "sectionHash",
  "sourceArtifactId",
  "sourceBindingId",
  "sourceId",
  "sourceVersionId",
  "version"
] as const;

export function decodeKnowledgeStrategyMapSupportHandleBindingV2(
  value: unknown
): KnowledgeStrategyMapSupportHandleBindingV2 | null {
  if (!record(value) || !exactKeys(value, supportHandleBindingKeys) ||
    value.version !== KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION || !hash(value.contentHash) ||
    typeof value.handle !== "string" || !decodeKnowledgeCitationHandle(value.handle) ||
    !identifier(value.passageId) ||
    !boundedInteger(value.passageOrdinal, 0, KNOWLEDGE_STRATEGY_MAX_ITEMS - 1) ||
    !hash(value.sectionHash) || !identifier(value.sourceArtifactId) ||
    !identifier(value.sourceBindingId) || !identifier(value.sourceId) ||
    !identifier(value.sourceVersionId)) return null;
  return Object.freeze({
    contentHash: value.contentHash,
    handle: value.handle,
    passageId: value.passageId,
    passageOrdinal: Number(value.passageOrdinal),
    sectionHash: value.sectionHash,
    sourceArtifactId: value.sourceArtifactId,
    sourceBindingId: value.sourceBindingId,
    sourceId: value.sourceId,
    sourceVersionId: value.sourceVersionId,
    version: KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION
  });
}

function supportFromHandleBinding(
  binding: KnowledgeStrategyMapSupportHandleBindingV2
): KnowledgeStrategyMapSupportingPassageV2 {
  const { handle: _handle, ...support } = binding;
  return support;
}

export type KnowledgeStrategyMapProviderSummaryItemV2 = Readonly<{
  ordinal: number;
  summaryText: string;
  summaryTextHash: string;
  supportingHandles: readonly string[];
  version: typeof KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION;
}>;

const providerSummaryItemKeys = [
  "ordinal",
  "summaryText",
  "summaryTextHash",
  "supportingHandles",
  "version"
] as const;

export function decodeKnowledgeStrategyMapProviderSummaryItemV2(
  value: unknown
): KnowledgeStrategyMapProviderSummaryItemV2 | null {
  if (!record(value) || !exactKeys(value, providerSummaryItemKeys) ||
    value.version !== KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION ||
    !boundedInteger(value.ordinal, 0, KNOWLEDGE_STRATEGY_MAP_MAX_SECTIONS - 1) ||
    typeof value.summaryText !== "string" || value.summaryText.length < 1 ||
    value.summaryText.trim() !== value.summaryText || value.summaryText.includes("\u0000") ||
    Buffer.byteLength(value.summaryText, "utf8") > KNOWLEDGE_STRATEGY_MAP_MAX_SUMMARY_BYTES ||
    !hash(value.summaryTextHash) || value.summaryTextHash !== sha256Text(value.summaryText) ||
    !Array.isArray(value.supportingHandles) || value.supportingHandles.length < 1 ||
    value.supportingHandles.length > KNOWLEDGE_STRATEGY_MAP_MAX_SUPPORTING_PASSAGES ||
    value.supportingHandles.some((handle) => !decodeKnowledgeCitationHandle(handle)) ||
    new Set(value.supportingHandles).size !== value.supportingHandles.length) return null;
  return deepFreeze({
    ordinal: Number(value.ordinal),
    summaryText: value.summaryText,
    summaryTextHash: value.summaryTextHash,
    supportingHandles: Object.freeze([...(value.supportingHandles as string[])]),
    version: KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION
  });
}

function decodeProviderSummaryItems(
  value: unknown
): readonly KnowledgeStrategyMapProviderSummaryItemV2[] | null {
  if (!Array.isArray(value) || value.length < 1 ||
    value.length > KNOWLEDGE_STRATEGY_MAP_MAX_SECTIONS) return null;
  const decoded = value.map(decodeKnowledgeStrategyMapProviderSummaryItemV2);
  if (decoded.some((summary) => summary === null)) return null;
  const summaries = decoded as KnowledgeStrategyMapProviderSummaryItemV2[];
  if (summaries.some((summary, ordinal) => summary.ordinal !== ordinal) ||
    summaries.reduce((sum, { summaryText }) =>
      sum + Buffer.byteLength(summaryText, "utf8"), 0) >
        KNOWLEDGE_STRATEGY_MAP_MAX_TOTAL_SUMMARY_BYTES) return null;
  return Object.freeze(summaries);
}

export type KnowledgeStrategyMapSummaryEvidenceV2 = Readonly<{
  evidenceHash: string;
  sourceAlias: string;
  summaries: readonly KnowledgeStrategyMapProviderSummaryItemV2[];
  summaryItemCount: number;
  summaryItemsHash: string;
  version: typeof KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION;
}>;

type KnowledgeStrategyMapSummaryEvidenceBodyV2 = Omit<
  KnowledgeStrategyMapSummaryEvidenceV2,
  "evidenceHash"
>;

const summaryEvidenceBodyKeys = [
  "sourceAlias",
  "summaries",
  "summaryItemCount",
  "summaryItemsHash",
  "version"
] as const;
const summaryEvidenceKeys = [...summaryEvidenceBodyKeys, "evidenceHash"] as const;

function decodeSummaryEvidenceBody(
  value: unknown
): KnowledgeStrategyMapSummaryEvidenceBodyV2 | null {
  if (!record(value) || !exactKeys(value, summaryEvidenceBodyKeys) ||
    value.version !== KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION ||
    typeof value.sourceAlias !== "string" || !SOURCE_ALIAS.test(value.sourceAlias) ||
    !boundedInteger(value.summaryItemCount, 1, KNOWLEDGE_STRATEGY_MAP_MAX_SECTIONS) ||
    !hash(value.summaryItemsHash)) return null;
  const summaries = decodeProviderSummaryItems(value.summaries);
  if (!summaries || summaries.length !== value.summaryItemCount ||
    sha256(summaries) !== value.summaryItemsHash) return null;
  return deepFreeze({
    sourceAlias: value.sourceAlias,
    summaries,
    summaryItemCount: Number(value.summaryItemCount),
    summaryItemsHash: value.summaryItemsHash,
    version: KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION
  });
}

export function decodeKnowledgeStrategyMapSummaryEvidenceV2(
  value: unknown
): KnowledgeStrategyMapSummaryEvidenceV2 | null {
  if (!record(value) || !exactKeys(value, summaryEvidenceKeys) || !hash(value.evidenceHash)) {
    return null;
  }
  const { evidenceHash, ...bodyValue } = value;
  const body = decodeSummaryEvidenceBody(bodyValue);
  if (!body || sha256(body) !== evidenceHash) return null;
  return deepFreeze({ ...body, evidenceHash });
}

export function createKnowledgeStrategyMapSummaryEvidenceV2(input: Readonly<{
  handleBindings: readonly unknown[];
  output: unknown;
}>): KnowledgeStrategyMapSummaryEvidenceV2 {
  const output = decodeKnowledgeStrategyMapOutputV2(input.output) ??
    throwInvalid("knowledge_strategy_map_output_invalid");
  if (!Array.isArray(input.handleBindings) || input.handleBindings.length < 1 ||
    input.handleBindings.length > KNOWLEDGE_STRATEGY_MAP_MAX_SUPPORTING_PASSAGES) {
    throwInvalid("knowledge_strategy_map_handle_bindings_invalid");
  }
  const decodedBindings = input.handleBindings.map(
    decodeKnowledgeStrategyMapSupportHandleBindingV2
  );
  if (decodedBindings.some((binding) => binding === null)) {
    throwInvalid("knowledge_strategy_map_handle_bindings_invalid");
  }
  const bindings = decodedBindings as KnowledgeStrategyMapSupportHandleBindingV2[];
  const outputSupports = new Map<string, KnowledgeStrategyMapSupportingPassageV2>();
  for (const summary of output.summaries) {
    for (const support of summary.supportingPassages) {
      outputSupports.set(hashKnowledgeStrategyMapSupportingPassageV2(support), support);
    }
  }
  const bindingBySupportHash = new Map<string, KnowledgeStrategyMapSupportHandleBindingV2>();
  for (const binding of bindings) {
    const supportHash = hashKnowledgeStrategyMapSupportingPassageV2(
      supportFromHandleBinding(binding)
    );
    if (!outputSupports.has(supportHash) || bindingBySupportHash.has(supportHash)) {
      throwInvalid("knowledge_strategy_map_handle_binding_mismatch");
    }
    bindingBySupportHash.set(supportHash, binding);
  }
  if (bindingBySupportHash.size !== outputSupports.size ||
    new Set(bindings.map(({ handle }) => handle)).size !== bindings.length) {
    throwInvalid("knowledge_strategy_map_handle_binding_mismatch");
  }
  const summaries = decodeProviderSummaryItems(output.summaries.map((summary) => ({
    ordinal: summary.ordinal,
    summaryText: summary.summaryText,
    summaryTextHash: summary.summaryTextHash,
    supportingHandles: summary.supportingPassages.map((support) =>
      bindingBySupportHash.get(hashKnowledgeStrategyMapSupportingPassageV2(support))!.handle),
    version: KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION
  }))) ?? throwInvalid("knowledge_strategy_map_provider_summaries_invalid");
  const body = decodeSummaryEvidenceBody({
    sourceAlias: output.sourceAlias,
    summaries,
    summaryItemCount: summaries.length,
    summaryItemsHash: sha256(summaries),
    version: KNOWLEDGE_STRATEGY_MAP_OUTPUT_VERSION
  }) ?? throwInvalid("knowledge_strategy_map_summary_evidence_body_invalid");
  return deepFreeze({ ...body, evidenceHash: sha256(body) });
}

export function verifyKnowledgeStrategyMapSummaryEvidenceV2(input: Readonly<{
  evidence: unknown;
  handleBindings: readonly unknown[];
  output: unknown;
}>): boolean {
  const evidence = decodeKnowledgeStrategyMapSummaryEvidenceV2(input.evidence);
  if (!evidence) return false;
  try {
    const expected = createKnowledgeStrategyMapSummaryEvidenceV2({
      handleBindings: input.handleBindings,
      output: input.output
    });
    return canonicalJson(expected) === canonicalJson(evidence);
  } catch {
    return false;
  }
}

export function canonicalKnowledgeStrategyMapSummaryEvidenceV2(value: unknown): string {
  const decoded = decodeKnowledgeStrategyMapSummaryEvidenceV2(value) ??
    throwInvalid("knowledge_strategy_map_summary_evidence_invalid");
  return canonicalJson(decoded);
}

export function hashKnowledgeStrategyMapSummaryEvidenceV2(value: unknown): string {
  return decodeKnowledgeStrategyMapSummaryEvidenceV2(value)?.evidenceHash ??
    throwInvalid("knowledge_strategy_map_summary_evidence_invalid");
}

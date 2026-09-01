import { createHash } from "node:crypto";
import { estimateApproxTokens } from "../../domain/contextBudget";
import { decodeKnowledgeCitationHandle } from "../../contracts/knowledge";
import {
  decodeLegacyKnowledgeSummaryDispatchCandidate,
  type LegacyKnowledgeSummaryDispatchCandidate
} from "./legacySummaryReceipt";
import {
  knowledgeCoverageEvidenceFitsAtomLimitV2
} from "./coverageScopeV4";
import { decodeKnowledgeExpandedContextOrderV1 } from "./parentContextExpansion";
import type { KnowledgeExpandedContextOrderV1 } from "./retrievalTypes";

export const KNOWLEDGE_EVIDENCE_DISPATCH_MANIFEST_VERSION = 2 as const;
export const LEGACY_KNOWLEDGE_EVIDENCE_DISPATCH_MANIFEST_VERSION = 1 as const;
export const KNOWLEDGE_EVIDENCE_PACKING_VERSION = "whole_source_item_v1" as const;
export const KNOWLEDGE_TOOL_LOOP_EVIDENCE_PACKING_VERSION =
  "whole_source_item_rank_interleave_v2" as const;
export const KNOWLEDGE_EVIDENCE_SHORTENING_VERSION =
  "omit_expanded_context_v1" as const;

export type KnowledgeEvidencePackingVersion =
  | typeof KNOWLEDGE_EVIDENCE_PACKING_VERSION
  | typeof KNOWLEDGE_TOOL_LOOP_EVIDENCE_PACKING_VERSION;

export function isKnowledgeEvidencePackingVersion(
  value: unknown
): value is KnowledgeEvidencePackingVersion {
  return value === KNOWLEDGE_EVIDENCE_PACKING_VERSION ||
    value === KNOWLEDGE_TOOL_LOOP_EVIDENCE_PACKING_VERSION;
}

export type KnowledgeEvidenceDispatchCandidate =
  | Readonly<{
      ambiguity: "none" | "table_cell_associations_ambiguous";
      evidenceId: string;
      exactExcerpt: string;
      expandedContext?: string | null;
      expandedContextOrder?: KnowledgeExpandedContextOrderV1;
      fileName: string;
      handle: string;
      locator: string;
      operationOrdinal: number;
      resultOrdinal: number;
      sourceAlias: string;
      sourceLabel: string;
      sourceTruncated: boolean;
      sourceVersionNumber: number;
      state: "available";
    }>
  | Readonly<{
      evidenceId: string;
      handle: string;
      kind: "source_summary";
      operationOrdinal: number;
      resultOrdinal: number;
      state: "available";
      summary: LegacyKnowledgeSummaryDispatchCandidate;
    }>
  | Readonly<{
      evidenceId: string;
      handle?: string | null;
      operationOrdinal: number;
      resultOrdinal: number;
      state: "unavailable";
    }>;

export type CurrentKnowledgeEvidenceDispatchCandidate = Exclude<
  KnowledgeEvidenceDispatchCandidate,
  { kind: "source_summary" }
>;

export type KnowledgeEvidenceDispatchExclusionReason =
  | "budget"
  | "deduplicated"
  | "unavailable";

export type KnowledgeEvidenceDispatchManifestExclusion = Readonly<{
  duplicateOfEvidenceId: string | null;
  evidenceId: string;
  handle: string | null;
  operationOrdinal: number;
  reason: KnowledgeEvidenceDispatchExclusionReason;
  resultOrdinal: number;
}>;

type KnowledgeEvidenceDispatchManifestPassageItem = Readonly<{
  ambiguity: "none" | "table_cell_associations_ambiguous";
  dispatchOrdinal: number;
  evidenceId: string;
  exactExcerpt: string;
  exactExcerptBytes: number;
  exactExcerptHash: string;
  expandedContext: string | null;
  expandedContextOrder?: KnowledgeExpandedContextOrderV1;
  expandedContextOriginalBytes: number | null;
  expandedContextOriginalHash: string | null;
  expandedContextState: "included" | "none" | "omitted";
  fileName: string;
  handle: string;
  itemBytes: number;
  itemHash: string;
  itemTokens: number;
  locator: string;
  operationOrdinal: number;
  representation: "full" | typeof KNOWLEDGE_EVIDENCE_SHORTENING_VERSION;
  resultOrdinal: number;
  sourceAlias: string;
  sourceLabel: string;
  sourceTruncated: boolean;
  sourceVersionNumber: number;
  text: string;
}>;

export type KnowledgeEvidenceDispatchManifestSummaryItem = Readonly<
  KnowledgeEvidenceDispatchManifestPassageItem & {
    kind: "source_summary";
    summary: LegacyKnowledgeSummaryDispatchCandidate;
  }
>;

export type KnowledgeEvidenceDispatchManifestItem =
  | KnowledgeEvidenceDispatchManifestPassageItem
  | KnowledgeEvidenceDispatchManifestSummaryItem;

type KnowledgeEvidenceDispatchManifestBody = Readonly<{
  coverageStatement: string;
  exclusions: readonly KnowledgeEvidenceDispatchManifestExclusion[];
  footer: string;
  header: string;
  items: readonly KnowledgeEvidenceDispatchManifestItem[];
  limits: Readonly<{
    maximumBytes: number;
    maximumTokens: number;
  }>;
  manifestHash: string;
  message: string;
  messageBytes: number;
  messageHash: string;
  messageTokens: number;
  packingVersion: KnowledgeEvidencePackingVersion;
  profileId: string;
  promptFragmentVersion: number;
  shorteningPolicy: "disabled" | typeof KNOWLEDGE_EVIDENCE_SHORTENING_VERSION;
}>;

export type KnowledgeEvidenceDispatchManifestDraft =
  | KnowledgeEvidenceDispatchManifestBody & Readonly<{
      runtimeVersion: number;
      version: typeof KNOWLEDGE_EVIDENCE_DISPATCH_MANIFEST_VERSION;
    }>
  | KnowledgeEvidenceDispatchManifestBody & Readonly<{
      /** Read-only compatibility for manifests accepted before the focused runtime. */
      plannerVersion: number;
      version: typeof LEGACY_KNOWLEDGE_EVIDENCE_DISPATCH_MANIFEST_VERSION;
    }>;

export type PackKnowledgeEvidenceDispatchManifestInput = Readonly<{
  allowExpandedContextOmission?: boolean;
  candidates: readonly CurrentKnowledgeEvidenceDispatchCandidate[];
  coverageStatement: string;
  footer: string;
  header: string;
  maximumBytes: number;
  maximumTokens: number;
  packingVersion?: KnowledgeEvidencePackingVersion;
  runtimeVersion: number;
  profileId: string;
  promptFragmentVersion: number;
}>;

type DispatchBlock = Readonly<{
  ambiguity: "none" | "table cell associations are ambiguous";
  citation: string;
  dispatchRepresentation: "full" | "shortened; expanded context omitted";
  exactExcerpt: string;
  expandedContext: string | null;
  expandedContextState: "included" | "none" | "omitted";
  fileName: string;
  handle: string;
  locator: string;
  schemaVersion: 1;
  sourceAlias: string;
  sourceLabel: string;
  sourceTruncated: boolean;
  sourceVersionNumber: number;
  type: "source_evidence";
}>;

type AvailablePassageCandidate = Extract<
  KnowledgeEvidenceDispatchCandidate,
  { ambiguity: "none" | "table_cell_associations_ambiguous"; state: "available" }
>;

const manifestBaseKeys = [
  "coverageStatement",
  "exclusions",
  "footer",
  "header",
  "items",
  "limits",
  "manifestHash",
  "message",
  "messageBytes",
  "messageHash",
  "messageTokens",
  "packingVersion",
  "profileId",
  "promptFragmentVersion",
  "shorteningPolicy",
  "version"
] as const;

const itemKeys = [
  "ambiguity",
  "dispatchOrdinal",
  "evidenceId",
  "exactExcerpt",
  "exactExcerptBytes",
  "exactExcerptHash",
  "expandedContext",
  "expandedContextOriginalBytes",
  "expandedContextOriginalHash",
  "expandedContextState",
  "fileName",
  "handle",
  "itemBytes",
  "itemHash",
  "itemTokens",
  "locator",
  "operationOrdinal",
  "representation",
  "resultOrdinal",
  "sourceAlias",
  "sourceLabel",
  "sourceTruncated",
  "sourceVersionNumber",
  "text"
] as const;
const summaryItemKeys = [...itemKeys, "kind", "summary"] as const;
const orderedItemKeys = [...itemKeys, "expandedContextOrder"] as const;
const orderedSummaryItemKeys = [...orderedItemKeys, "kind", "summary"] as const;

const exclusionKeys = [
  "duplicateOfEvidenceId",
  "evidenceId",
  "handle",
  "operationOrdinal",
  "reason",
  "resultOrdinal"
] as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  return Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
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

/** Canonical JSON used for byte-exact replay and hashes. */
function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return escapedJsonString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("knowledge_evidence_manifest_non_finite_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${escapedJsonString(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("knowledge_evidence_manifest_non_json_value");
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareOrder(
  left: Pick<KnowledgeEvidenceDispatchCandidate, "evidenceId" | "operationOrdinal" | "resultOrdinal">,
  right: Pick<KnowledgeEvidenceDispatchCandidate, "evidenceId" | "operationOrdinal" | "resultOrdinal">,
  packingVersion: KnowledgeEvidencePackingVersion
): number {
  if (packingVersion === KNOWLEDGE_TOOL_LOOP_EVIDENCE_PACKING_VERSION) {
    return left.resultOrdinal - right.resultOrdinal ||
      left.operationOrdinal - right.operationOrdinal ||
      compareStrings(left.evidenceId, right.evidenceId);
  }
  return left.operationOrdinal - right.operationOrdinal ||
    left.resultOrdinal - right.resultOrdinal ||
    compareStrings(left.evidenceId, right.evidenceId);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\u0000");
}

function nullableNonEmptyString(value: unknown): value is string | null {
  return value === null || nonEmptyString(value);
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function validHandle(value: unknown): value is string {
  return decodeKnowledgeCitationHandle(value) !== null;
}

function validSourceAlias(value: unknown): value is string {
  return typeof value === "string" && /^S[1-9]\d{0,2}$/u.test(value);
}

function validateCandidate(candidate: KnowledgeEvidenceDispatchCandidate): void {
  if (!nonEmptyString(candidate.evidenceId) ||
    !nonNegativeInteger(candidate.operationOrdinal) ||
    !positiveInteger(candidate.resultOrdinal)) {
    throw new Error("knowledge_evidence_dispatch_candidate_invalid");
  }
  if (candidate.state === "unavailable") {
    if (candidate.handle !== undefined && candidate.handle !== null &&
      !validHandle(candidate.handle)) {
      throw new Error("knowledge_evidence_dispatch_candidate_invalid");
    }
    return;
  }
  if ("kind" in candidate && candidate.kind === "source_summary") {
    const summary = decodeLegacyKnowledgeSummaryDispatchCandidate(candidate.summary);
    if (!summary || candidate.evidenceId !== summary.evidenceId ||
      candidate.operationOrdinal !== summary.operationOrdinal ||
      candidate.resultOrdinal !== summary.supportBindings[0]?.resultOrdinal ||
      candidate.handle !== summary.supportBindings[0]?.handle) {
      throw new Error("knowledge_evidence_dispatch_summary_candidate_invalid");
    }
    return;
  }
  const passageCandidate = candidate as AvailablePassageCandidate;
  const expandedContextOrder = passageCandidate.expandedContextOrder === undefined
    ? undefined
    : decodeKnowledgeExpandedContextOrderV1(
        passageCandidate.expandedContextOrder,
        passageCandidate.expandedContext ?? undefined
      );
  if (
    !validHandle(passageCandidate.handle) ||
    !validSourceAlias(passageCandidate.sourceAlias) ||
    !nonEmptyString(passageCandidate.sourceLabel) ||
    !nonEmptyString(passageCandidate.fileName) ||
    !nonEmptyString(passageCandidate.locator) ||
    typeof passageCandidate.exactExcerpt !== "string" ||
    passageCandidate.exactExcerpt.length < 1 ||
    !positiveInteger(passageCandidate.sourceVersionNumber) ||
    typeof passageCandidate.sourceTruncated !== "boolean" ||
    passageCandidate.ambiguity !== "none" &&
      passageCandidate.ambiguity !== "table_cell_associations_ambiguous" ||
    passageCandidate.expandedContext !== undefined &&
      passageCandidate.expandedContext !== null &&
      typeof passageCandidate.expandedContext !== "string" ||
    passageCandidate.expandedContextOrder !== undefined &&
      (!expandedContextOrder || !passageCandidate.expandedContext)
  ) throw new Error("knowledge_evidence_dispatch_candidate_invalid");
}

function summaryCandidate(
  candidate: Extract<KnowledgeEvidenceDispatchCandidate, { state: "available" }>
): LegacyKnowledgeSummaryDispatchCandidate | null {
  return "kind" in candidate && candidate.kind === "source_summary"
    ? decodeLegacyKnowledgeSummaryDispatchCandidate(candidate.summary)
    : null;
}

function dispatchBlock(
  candidate: AvailablePassageCandidate,
  omitExpandedContext: boolean
): DispatchBlock {
  const expandedContext = candidate.expandedContext || null;
  const omitted = omitExpandedContext && expandedContext !== null;
  return {
    ambiguity: candidate.ambiguity === "none"
      ? "none"
      : "table cell associations are ambiguous",
    citation: `[${candidate.handle}]`,
    dispatchRepresentation: omitted
      ? "shortened; expanded context omitted"
      : "full",
    exactExcerpt: candidate.exactExcerpt,
    expandedContext: omitted ? null : expandedContext,
    expandedContextState: omitted ? "omitted" : expandedContext ? "included" : "none",
    fileName: candidate.fileName,
    handle: candidate.handle,
    locator: candidate.locator,
    schemaVersion: 1,
    sourceAlias: candidate.sourceAlias,
    sourceLabel: candidate.sourceLabel,
    sourceTruncated: candidate.sourceTruncated,
    sourceVersionNumber: candidate.sourceVersionNumber,
    type: "source_evidence"
  };
}

function materializeItem(
  candidate: Extract<KnowledgeEvidenceDispatchCandidate, { state: "available" }>,
  dispatchOrdinal: number,
  omitExpandedContext: boolean
): KnowledgeEvidenceDispatchManifestItem {
  const summary = summaryCandidate(candidate);
  if (summary) {
    const primarySupport = summary.supportBindings[0]!;
    return {
      ambiguity: "none",
      dispatchOrdinal,
      evidenceId: candidate.evidenceId,
      exactExcerpt: summary.providerText,
      exactExcerptBytes: summary.providerTextBytes,
      exactExcerptHash: summary.itemHash,
      expandedContext: null,
      expandedContextOriginalBytes: null,
      expandedContextOriginalHash: null,
      expandedContextState: "none",
      fileName: summary.fileName,
      handle: primarySupport.handle,
      itemBytes: summary.providerTextBytes,
      itemHash: summary.itemHash,
      itemTokens: estimateApproxTokens(summary.providerText),
      kind: "source_summary",
      locator: "hierarchical Source summary",
      operationOrdinal: candidate.operationOrdinal,
      representation: "full",
      resultOrdinal: candidate.resultOrdinal,
      sourceAlias: summary.sourceAlias,
      sourceLabel: summary.providerBlock.sourceLabel,
      sourceTruncated: false,
      sourceVersionNumber: summary.sourceVersionNumber,
      summary,
      text: summary.providerText
    };
  }
  const passageCandidate = candidate as AvailablePassageCandidate;
  const block = dispatchBlock(passageCandidate, omitExpandedContext);
  const text = canonicalJson(block);
  const expandedContext = passageCandidate.expandedContext || null;
  return {
    ambiguity: passageCandidate.ambiguity,
    dispatchOrdinal,
    evidenceId: passageCandidate.evidenceId,
    exactExcerpt: passageCandidate.exactExcerpt,
    exactExcerptBytes: utf8Bytes(passageCandidate.exactExcerpt),
    exactExcerptHash: sha256Utf8(passageCandidate.exactExcerpt),
    expandedContext: block.expandedContext,
    ...(block.expandedContext && passageCandidate.expandedContextOrder
      ? { expandedContextOrder: passageCandidate.expandedContextOrder }
      : {}),
    expandedContextOriginalBytes: expandedContext === null ? null : utf8Bytes(expandedContext),
    expandedContextOriginalHash: expandedContext === null ? null : sha256Utf8(expandedContext),
    expandedContextState: block.expandedContextState,
    fileName: passageCandidate.fileName,
    handle: passageCandidate.handle,
    itemBytes: utf8Bytes(text),
    itemHash: sha256Utf8(text),
    itemTokens: estimateApproxTokens(text),
    locator: passageCandidate.locator,
    operationOrdinal: passageCandidate.operationOrdinal,
    representation: omitExpandedContext
      ? KNOWLEDGE_EVIDENCE_SHORTENING_VERSION
      : "full",
    resultOrdinal: passageCandidate.resultOrdinal,
    sourceAlias: passageCandidate.sourceAlias,
    sourceLabel: passageCandidate.sourceLabel,
    sourceTruncated: passageCandidate.sourceTruncated,
    sourceVersionNumber: passageCandidate.sourceVersionNumber,
    text
  };
}

function renderMessage(
  header: string,
  coverageStatement: string,
  itemTexts: readonly string[],
  footer: string
): string {
  return [header, coverageStatement, ...itemTexts, footer].filter((part) => part.length > 0)
    .join("\n\n");
}

function fitsLimits(
  message: string,
  items: readonly KnowledgeEvidenceDispatchManifestItem[],
  limits: Readonly<{ maximumBytes: number; maximumTokens: number }>
): boolean {
  return utf8Bytes(message) <= limits.maximumBytes &&
    estimateApproxTokens(message) <= limits.maximumTokens &&
    knowledgeCoverageEvidenceFitsAtomLimitV2(items.map((item) => ({
      exactExcerpt: item.exactExcerpt,
      expandedContext: item.expandedContext,
      ...(item.expandedContextOrder
        ? { expandedContextOrder: item.expandedContextOrder }
        : {}),
      handle: item.handle
    })));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

/**
 * Packs only complete, canonical Source-bound JSON items. The exact excerpt is
 * never shortened. The sole v1 shortening removes expanded context as one
 * complete field and labels that representation in both the item and manifest.
 */
export function packKnowledgeEvidenceDispatchManifest(
  input: PackKnowledgeEvidenceDispatchManifestInput
): KnowledgeEvidenceDispatchManifestDraft {
  if (
    !nonEmptyString(input.header) || !nonEmptyString(input.footer) ||
    typeof input.coverageStatement !== "string" ||
    !positiveInteger(input.maximumBytes) || !positiveInteger(input.maximumTokens) ||
    !positiveInteger(input.runtimeVersion) || !positiveInteger(input.promptFragmentVersion) ||
    !nonEmptyString(input.profileId)
  ) throw new Error("knowledge_evidence_dispatch_config_invalid");

  const limits = {
    maximumBytes: input.maximumBytes,
    maximumTokens: input.maximumTokens
  } as const;
  const packingVersion = input.packingVersion ?? KNOWLEDGE_EVIDENCE_PACKING_VERSION;
  if (!isKnowledgeEvidencePackingVersion(packingVersion)) {
    throw new Error("knowledge_evidence_dispatch_config_invalid");
  }
  const emptyMessage = renderMessage(input.header, input.coverageStatement, [], input.footer);
  if (!fitsLimits(emptyMessage, [], limits)) {
    throw new Error("knowledge_evidence_dispatch_envelope_exceeds_budget");
  }

  const candidates = [...input.candidates].sort((left, right) =>
    compareOrder(left, right, packingVersion));
  const evidenceIds = new Set<string>();
  const firstEvidenceIdByHandle = new Map<string, string>();
  const items: KnowledgeEvidenceDispatchManifestItem[] = [];
  const exclusions: KnowledgeEvidenceDispatchManifestExclusion[] = [];
  const allowExpandedContextOmission = input.allowExpandedContextOmission !== false;

  for (const candidate of candidates) {
    if ("kind" in candidate) {
      throw new Error("knowledge_evidence_dispatch_legacy_summary_write_forbidden");
    }
    validateCandidate(candidate);
    if (evidenceIds.has(candidate.evidenceId)) {
      throw new Error("knowledge_evidence_dispatch_duplicate_evidence_id");
    }
    evidenceIds.add(candidate.evidenceId);
    if (candidate.state === "unavailable") {
      exclusions.push({
        duplicateOfEvidenceId: null,
        evidenceId: candidate.evidenceId,
        handle: candidate.handle ?? null,
        operationOrdinal: candidate.operationOrdinal,
        reason: "unavailable",
        resultOrdinal: candidate.resultOrdinal
      });
      continue;
    }

    const summary = summaryCandidate(candidate);
    const candidateHandles = summary
      ? summary.supportBindings.map(({ handle }) => handle)
      : [candidate.handle];
    const duplicateOfEvidenceId = candidateHandles.flatMap((handle) => {
      const evidenceId = firstEvidenceIdByHandle.get(handle);
      return evidenceId ? [evidenceId] : [];
    })[0];
    if (summary && duplicateOfEvidenceId) {
      throw new Error("knowledge_evidence_dispatch_summary_support_duplicate");
    }
    if (duplicateOfEvidenceId) {
      exclusions.push({
        duplicateOfEvidenceId,
        evidenceId: candidate.evidenceId,
        handle: candidate.handle,
        operationOrdinal: candidate.operationOrdinal,
        reason: "deduplicated",
        resultOrdinal: candidate.resultOrdinal
      });
      continue;
    }
    for (const handle of candidateHandles) {
      firstEvidenceIdByHandle.set(handle, candidate.evidenceId);
    }

    let item = materializeItem(candidate, items.length + 1, false);
    let message = renderMessage(
      input.header,
      input.coverageStatement,
      [...items.map(({ text }) => text), item.text],
      input.footer
    );
    if (!fitsLimits(message, [...items, item], limits) &&
      allowExpandedContextOmission &&
      !("kind" in candidate) && Boolean(candidate.expandedContext)) {
      item = materializeItem(candidate, items.length + 1, true);
      message = renderMessage(
        input.header,
        input.coverageStatement,
        [...items.map(({ text }) => text), item.text],
        input.footer
      );
    }
    if (!fitsLimits(message, [...items, item], limits)) {
      exclusions.push({
        duplicateOfEvidenceId: null,
        evidenceId: candidate.evidenceId,
        handle: candidate.handle,
        operationOrdinal: candidate.operationOrdinal,
        reason: "budget",
        resultOrdinal: candidate.resultOrdinal
      });
      continue;
    }
    items.push(item);
  }

  const message = renderMessage(
    input.header,
    input.coverageStatement,
    items.map(({ text }) => text),
    input.footer
  );
  const body = {
    coverageStatement: input.coverageStatement,
    exclusions,
    footer: input.footer,
    header: input.header,
    items,
    limits,
    message,
    messageBytes: utf8Bytes(message),
    messageHash: sha256Utf8(message),
    messageTokens: estimateApproxTokens(message),
    packingVersion,
    runtimeVersion: input.runtimeVersion,
    profileId: input.profileId,
    promptFragmentVersion: input.promptFragmentVersion,
    shorteningPolicy: allowExpandedContextOmission
      ? KNOWLEDGE_EVIDENCE_SHORTENING_VERSION
      : "disabled" as const,
    version: KNOWLEDGE_EVIDENCE_DISPATCH_MANIFEST_VERSION
  };
  return deepFreeze({
    ...body,
    manifestHash: sha256Utf8(canonicalJson(body))
  });
}

function validSummaryDispatchItem(
  value: Record<string, unknown>,
  expectedOrdinal: number
): boolean {
  if (!hasExactKeys(value, summaryItemKeys) &&
    !hasExactKeys(value, orderedSummaryItemKeys) ||
    value.kind !== "source_summary" || value.expandedContextOrder !== undefined) return false;
  const summary = decodeLegacyKnowledgeSummaryDispatchCandidate(value.summary);
  const primarySupport = summary?.supportBindings[0];
  return Boolean(summary && primarySupport && value.dispatchOrdinal === expectedOrdinal &&
    value.evidenceId === summary.evidenceId && value.handle === primarySupport.handle &&
    value.sourceAlias === summary.sourceAlias &&
    value.sourceLabel === summary.providerBlock.sourceLabel &&
    value.fileName === summary.fileName && value.locator === "hierarchical Source summary" &&
    value.exactExcerpt === summary.providerText &&
    value.exactExcerptBytes === summary.providerTextBytes &&
    value.exactExcerptHash === summary.itemHash && value.expandedContext === null &&
    value.expandedContextOriginalBytes === null && value.expandedContextOriginalHash === null &&
    value.expandedContextState === "none" && value.operationOrdinal === summary.operationOrdinal &&
    value.resultOrdinal === primarySupport.resultOrdinal && value.representation === "full" &&
    value.sourceTruncated === false && value.ambiguity === "none" &&
    value.sourceVersionNumber === summary.sourceVersionNumber && value.text ===
      summary.providerText && value.itemBytes === summary.providerTextBytes &&
    value.itemTokens === estimateApproxTokens(summary.providerText) &&
    value.itemHash === summary.itemHash);
}

function validDispatchItem(value: unknown, expectedOrdinal: number): value is Record<string, unknown> {
  if (!record(value)) return false;
  if (Object.hasOwn(value, "kind") || Object.hasOwn(value, "summary")) {
    return validSummaryDispatchItem(value, expectedOrdinal);
  }
  if (!hasExactKeys(value, itemKeys) && !hasExactKeys(value, orderedItemKeys) ||
    value.dispatchOrdinal !== expectedOrdinal || !nonEmptyString(value.evidenceId) ||
    !validHandle(value.handle) || !validSourceAlias(value.sourceAlias) ||
    !nonEmptyString(value.sourceLabel) || !nonEmptyString(value.fileName) ||
    !nonEmptyString(value.locator) || typeof value.exactExcerpt !== "string" ||
    value.exactExcerpt.length < 1 || !nonNegativeInteger(value.operationOrdinal) ||
    !positiveInteger(value.resultOrdinal) || !positiveInteger(value.sourceVersionNumber) ||
    typeof value.sourceTruncated !== "boolean" ||
    value.ambiguity !== "none" && value.ambiguity !== "table_cell_associations_ambiguous" ||
    !nonNegativeInteger(value.exactExcerptBytes) || !validHash(value.exactExcerptHash) ||
    !nonNegativeInteger(value.itemBytes) || !nonNegativeInteger(value.itemTokens) ||
    !validHash(value.itemHash) || typeof value.text !== "string" ||
    value.expandedContextState !== "included" && value.expandedContextState !== "none" &&
      value.expandedContextState !== "omitted" ||
    value.representation !== "full" &&
      value.representation !== KNOWLEDGE_EVIDENCE_SHORTENING_VERSION ||
    !nullableNonEmptyString(value.expandedContext) ||
    value.expandedContextOriginalBytes !== null &&
      !positiveInteger(value.expandedContextOriginalBytes) ||
    value.expandedContextOriginalHash !== null && !validHash(value.expandedContextOriginalHash)
  ) return false;

  const expandedContextOrder = value.expandedContextOrder === undefined
    ? undefined
    : decodeKnowledgeExpandedContextOrderV1(
        value.expandedContextOrder,
        typeof value.expandedContext === "string" ? value.expandedContext : undefined
      );
  if (value.expandedContextOrder !== undefined && !expandedContextOrder) return false;

  const expandedStateValid = value.expandedContextState === "none"
    ? value.expandedContext === null && value.expandedContextOriginalBytes === null &&
      value.expandedContextOriginalHash === null && value.representation === "full"
    : value.expandedContextState === "included"
      ? typeof value.expandedContext === "string" && value.expandedContext.length > 0 &&
        positiveInteger(value.expandedContextOriginalBytes) &&
        validHash(value.expandedContextOriginalHash) && value.representation === "full" &&
        utf8Bytes(value.expandedContext) === value.expandedContextOriginalBytes &&
        sha256Utf8(value.expandedContext) === value.expandedContextOriginalHash
      : value.expandedContext === null && positiveInteger(value.expandedContextOriginalBytes) &&
        validHash(value.expandedContextOriginalHash) &&
        value.representation === KNOWLEDGE_EVIDENCE_SHORTENING_VERSION;
  if (!expandedStateValid || expandedContextOrder !== undefined &&
      value.expandedContextState !== "included" ||
    utf8Bytes(value.exactExcerpt) !== value.exactExcerptBytes ||
    sha256Utf8(value.exactExcerpt) !== value.exactExcerptHash) return false;

  const block: DispatchBlock = {
    ambiguity: value.ambiguity === "none"
      ? "none"
      : "table cell associations are ambiguous",
    citation: `[${value.handle}]`,
    dispatchRepresentation: value.representation === "full"
      ? "full"
      : "shortened; expanded context omitted",
    exactExcerpt: value.exactExcerpt,
    expandedContext: value.expandedContext,
    expandedContextState: value.expandedContextState,
    fileName: value.fileName,
    handle: value.handle,
    locator: value.locator,
    schemaVersion: 1,
    sourceAlias: value.sourceAlias,
    sourceLabel: value.sourceLabel,
    sourceTruncated: value.sourceTruncated,
    sourceVersionNumber: value.sourceVersionNumber,
    type: "source_evidence"
  };
  return value.text === canonicalJson(block) && utf8Bytes(value.text) === value.itemBytes &&
    estimateApproxTokens(value.text) === value.itemTokens &&
    sha256Utf8(value.text) === value.itemHash;
}

function validExclusion(value: unknown): value is Record<string, unknown> {
  if (!record(value) || !hasExactKeys(value, exclusionKeys) ||
    !nonEmptyString(value.evidenceId) || !nonNegativeInteger(value.operationOrdinal) ||
    !positiveInteger(value.resultOrdinal) ||
    value.handle !== null && !validHandle(value.handle) ||
    value.reason !== "budget" && value.reason !== "deduplicated" &&
      value.reason !== "unavailable" ||
    value.duplicateOfEvidenceId !== null && !nonEmptyString(value.duplicateOfEvidenceId)
  ) return false;
  return value.reason === "deduplicated"
    ? value.handle !== null && value.duplicateOfEvidenceId !== null &&
      value.duplicateOfEvidenceId !== value.evidenceId
    : value.duplicateOfEvidenceId === null &&
      (value.reason !== "budget" || value.handle !== null);
}

/** Strict decoder for later persistence/recovery integration. */
export function decodeKnowledgeEvidenceDispatchManifestDraft(
  value: unknown
): KnowledgeEvidenceDispatchManifestDraft | null {
  if (!record(value)) return null;
  const current = value.version === KNOWLEDGE_EVIDENCE_DISPATCH_MANIFEST_VERSION;
  const legacy = value.version === LEGACY_KNOWLEDGE_EVIDENCE_DISPATCH_MANIFEST_VERSION;
  const versionField = current ? "runtimeVersion" : legacy ? "plannerVersion" : null;
  const packingVersion = value.packingVersion;
  if (!versionField || !hasExactKeys(value, [...manifestBaseKeys, versionField]) ||
    !isKnowledgeEvidencePackingVersion(packingVersion) ||
    value.shorteningPolicy !== "disabled" &&
      value.shorteningPolicy !== KNOWLEDGE_EVIDENCE_SHORTENING_VERSION ||
    !positiveInteger(value[versionField]) || !positiveInteger(value.promptFragmentVersion) ||
    !nonEmptyString(value.profileId) || !nonEmptyString(value.header) ||
    !nonEmptyString(value.footer) || typeof value.coverageStatement !== "string" ||
    !Array.isArray(value.items) || !Array.isArray(value.exclusions) ||
    !record(value.limits) || !hasExactKeys(value.limits, ["maximumBytes", "maximumTokens"]) ||
    !positiveInteger(value.limits.maximumBytes) ||
    !positiveInteger(value.limits.maximumTokens) || typeof value.message !== "string" ||
    !nonNegativeInteger(value.messageBytes) || !nonNegativeInteger(value.messageTokens) ||
    !validHash(value.messageHash) || !validHash(value.manifestHash)
  ) return null;

  if (value.items.some((item, index) => !validDispatchItem(item, index + 1)) ||
    value.exclusions.some((exclusion) => !validExclusion(exclusion))) return null;
  const items = value.items as Record<string, unknown>[];
  const exclusions = value.exclusions as Record<string, unknown>[];
  if (value.shorteningPolicy === "disabled" &&
    items.some(({ representation }) => representation !== "full")) return null;
  if (items.some((item, index) => index > 0 && compareOrder(
    item as unknown as KnowledgeEvidenceDispatchManifestItem,
    items[index - 1] as unknown as KnowledgeEvidenceDispatchManifestItem,
    packingVersion
  ) < 0) || exclusions.some((exclusion, index) => index > 0 && compareOrder(
    exclusion as unknown as KnowledgeEvidenceDispatchManifestExclusion,
    exclusions[index - 1] as unknown as KnowledgeEvidenceDispatchManifestExclusion,
    packingVersion
  ) < 0)) return null;

  const evidenceIds = [...items, ...exclusions].map(({ evidenceId }) => evidenceId as string);
  if (new Set(evidenceIds).size !== evidenceIds.length) return null;
  const handles = items.flatMap((item) => {
    if (item.kind !== "source_summary") return [item.handle as string];
    const summary = decodeLegacyKnowledgeSummaryDispatchCandidate(item.summary);
    return summary?.supportBindings.map(({ handle }) => handle) ?? [];
  });
  if (new Set(handles).size !== handles.length) return null;
  const knownEvidenceIds = new Set(evidenceIds);
  if (exclusions.some(({ duplicateOfEvidenceId }) => duplicateOfEvidenceId !== null &&
    !knownEvidenceIds.has(duplicateOfEvidenceId as string))) return null;

  const message = renderMessage(
    value.header,
    value.coverageStatement,
    items.map(({ text }) => text as string),
    value.footer
  );
  if (value.message !== message || value.messageBytes !== utf8Bytes(message) ||
    value.messageTokens !== estimateApproxTokens(message) ||
    value.messageHash !== sha256Utf8(message) ||
    value.messageBytes > value.limits.maximumBytes ||
    value.messageTokens > value.limits.maximumTokens) return null;

  const { manifestHash, ...body } = value;
  if (manifestHash !== sha256Utf8(canonicalJson(body))) return null;
  return deepFreeze(JSON.parse(JSON.stringify(value)) as KnowledgeEvidenceDispatchManifestDraft);
}

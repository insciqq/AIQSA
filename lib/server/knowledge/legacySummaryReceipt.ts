import { createHash } from "node:crypto";
import { decodeKnowledgeCitationHandle } from "../../contracts/knowledge";
import type { KnowledgeEvidencePackage } from "./evidencePackage";

/**
 * Read-only decoder for accepted source-summary manifests produced by the
 * retired advanced runtime. Nothing in this module creates a new summary.
 */
export const LEGACY_KNOWLEDGE_SUMMARY_RECEIPT_VERSION = 2 as const;
const MAX_PROVIDER_BYTES = 48 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_ALIAS = /^S[1-9]\d{0,2}$/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function escapedJsonString(value: string): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, (character) => {
    if (character === "<") return "\\u003c";
    if (character === ">") return "\\u003e";
    if (character === "&") return "\\u0026";
    if (character === "\u2028") return "\\u2028";
    return "\\u2029";
  });
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return escapedJsonString(value);
  if (typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) =>
    `${escapedJsonString(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  throw new Error("legacy_knowledge_summary_non_json_value");
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sectionHash(input: Readonly<{
  headingPath: readonly string[];
  sectionId: string | null;
  sourceArtifactId: string;
}>): string {
  return sha256(input);
}

export type LegacyKnowledgeSummarySupportBinding = Readonly<{
  contentHash: string;
  evidenceItemId: string;
  excerptHash: string;
  handle: string;
  passageId: string;
  passageOrdinal: number;
  sectionHash: string;
  sourceArtifactId: string;
  sourceId: string;
  sourceVersionId: string;
  version: typeof LEGACY_KNOWLEDGE_SUMMARY_RECEIPT_VERSION;
}>;

export type LegacyKnowledgeSummaryCandidateSupport = Readonly<{
  contentHash: string;
  excerptHash: string;
  handle: string;
  passageId: string;
  passageOrdinal: number;
  resultOrdinal: number;
  sectionHash: string;
  sourceArtifactId: string;
  sourceId: string;
  sourceVersionId: string;
  version: typeof LEGACY_KNOWLEDGE_SUMMARY_RECEIPT_VERSION;
}>;

export type LegacyKnowledgeSummaryDispatchCandidate = Readonly<{
  candidateHash: string;
  evidenceHash: string;
  evidenceId: string;
  fileName: string;
  itemHash: string;
  mapOutputHash: string;
  operationOrdinal: number;
  providerBlock: Readonly<Record<string, unknown> & { sourceLabel: string }>;
  providerText: string;
  providerTextBytes: number;
  sourceAlias: string;
  sourceBindingId: string;
  sourceOrdinal: number;
  sourceVersionNumber: number;
  summaryEvidence: Readonly<Record<string, unknown>>;
  supportBindings: readonly LegacyKnowledgeSummaryCandidateSupport[];
  supportBindingsHash: string;
  supportCount: number;
  version: typeof LEGACY_KNOWLEDGE_SUMMARY_RECEIPT_VERSION;
}>;

const supportBindingKeys = [
  "contentHash", "evidenceItemId", "excerptHash", "handle", "passageId",
  "passageOrdinal", "sectionHash", "sourceArtifactId", "sourceId", "sourceVersionId", "version"
] as const;

export function decodeLegacyKnowledgeSummarySupportBinding(
  value: unknown
): LegacyKnowledgeSummarySupportBinding | null {
  if (!record(value) || !exactKeys(value, supportBindingKeys) ||
    value.version !== LEGACY_KNOWLEDGE_SUMMARY_RECEIPT_VERSION ||
    typeof value.contentHash !== "string" || !SHA256.test(value.contentHash) ||
    typeof value.evidenceItemId !== "string" || value.evidenceItemId.length < 1 ||
    value.evidenceItemId.length > 512 || typeof value.excerptHash !== "string" ||
    !SHA256.test(value.excerptHash) || typeof value.handle !== "string" ||
    !decodeKnowledgeCitationHandle(value.handle) || typeof value.passageId !== "string" ||
    value.passageId.length < 1 || value.passageId.length > 512 ||
    !Number.isSafeInteger(value.passageOrdinal) || Number(value.passageOrdinal) < 0 ||
    Number(value.passageOrdinal) > 1_000_000 || typeof value.sectionHash !== "string" ||
    !SHA256.test(value.sectionHash) || typeof value.sourceArtifactId !== "string" ||
    value.sourceArtifactId.length < 1 || value.sourceArtifactId.length > 512 ||
    typeof value.sourceId !== "string" || value.sourceId.length < 1 || value.sourceId.length > 512 ||
    typeof value.sourceVersionId !== "string" || value.sourceVersionId.length < 1 ||
    value.sourceVersionId.length > 512) return null;
  return Object.freeze({
    contentHash: value.contentHash,
    evidenceItemId: value.evidenceItemId,
    excerptHash: value.excerptHash,
    handle: value.handle,
    passageId: value.passageId,
    passageOrdinal: Number(value.passageOrdinal),
    sectionHash: value.sectionHash,
    sourceArtifactId: value.sourceArtifactId,
    sourceId: value.sourceId,
    sourceVersionId: value.sourceVersionId,
    version: LEGACY_KNOWLEDGE_SUMMARY_RECEIPT_VERSION
  });
}

const candidateSupportKeys = [
  "contentHash", "excerptHash", "handle", "passageId", "passageOrdinal", "resultOrdinal",
  "sectionHash", "sourceArtifactId", "sourceId", "sourceVersionId", "version"
] as const;

function decodeCandidateSupport(value: unknown): LegacyKnowledgeSummaryCandidateSupport | null {
  if (!record(value) || !exactKeys(value, candidateSupportKeys) ||
    value.version !== LEGACY_KNOWLEDGE_SUMMARY_RECEIPT_VERSION ||
    typeof value.contentHash !== "string" || !SHA256.test(value.contentHash) ||
    typeof value.excerptHash !== "string" || !SHA256.test(value.excerptHash) ||
    typeof value.handle !== "string" || !decodeKnowledgeCitationHandle(value.handle) ||
    typeof value.passageId !== "string" || value.passageId.length < 1 ||
    value.passageId.length > 512 || !Number.isSafeInteger(value.passageOrdinal) ||
    Number(value.passageOrdinal) < 0 || Number(value.passageOrdinal) > 1_000_000 ||
    !Number.isSafeInteger(value.resultOrdinal) || Number(value.resultOrdinal) < 1 ||
    Number(value.resultOrdinal) > 4_096 || typeof value.sectionHash !== "string" ||
    !SHA256.test(value.sectionHash) || typeof value.sourceArtifactId !== "string" ||
    value.sourceArtifactId.length < 1 || value.sourceArtifactId.length > 512 ||
    typeof value.sourceId !== "string" || value.sourceId.length < 1 || value.sourceId.length > 512 ||
    typeof value.sourceVersionId !== "string" || value.sourceVersionId.length < 1 ||
    value.sourceVersionId.length > 512) return null;
  return Object.freeze({
    contentHash: value.contentHash,
    excerptHash: value.excerptHash,
    handle: value.handle,
    passageId: value.passageId,
    passageOrdinal: Number(value.passageOrdinal),
    resultOrdinal: Number(value.resultOrdinal),
    sectionHash: value.sectionHash,
    sourceArtifactId: value.sourceArtifactId,
    sourceId: value.sourceId,
    sourceVersionId: value.sourceVersionId,
    version: LEGACY_KNOWLEDGE_SUMMARY_RECEIPT_VERSION
  });
}

const candidateKeys = [
  "candidateHash", "evidenceHash", "evidenceId", "fileName", "itemHash", "mapOutputHash",
  "operationOrdinal", "providerBlock", "providerText", "providerTextBytes", "sourceAlias",
  "sourceBindingId", "sourceOrdinal", "sourceVersionNumber", "summaryEvidence", "supportBindings",
  "supportBindingsHash", "supportCount", "version"
] as const;

export function decodeLegacyKnowledgeSummaryDispatchCandidate(
  value: unknown
): LegacyKnowledgeSummaryDispatchCandidate | null {
  if (!record(value) || !exactKeys(value, candidateKeys) ||
    value.version !== LEGACY_KNOWLEDGE_SUMMARY_RECEIPT_VERSION ||
    typeof value.candidateHash !== "string" || !SHA256.test(value.candidateHash) ||
    typeof value.evidenceHash !== "string" || !SHA256.test(value.evidenceHash) ||
    typeof value.evidenceId !== "string" || value.evidenceId.length < 1 ||
    value.evidenceId.length > 1_024 || typeof value.fileName !== "string" ||
    value.fileName.length < 1 || value.fileName.length > 1_024 ||
    typeof value.itemHash !== "string" || !SHA256.test(value.itemHash) ||
    typeof value.mapOutputHash !== "string" || !SHA256.test(value.mapOutputHash) ||
    !Number.isSafeInteger(value.operationOrdinal) || Number(value.operationOrdinal) < 1 ||
    Number(value.operationOrdinal) > 256 || !record(value.providerBlock) ||
    typeof value.providerBlock.sourceLabel !== "string" ||
    value.providerBlock.sourceLabel.length < 1 || value.providerBlock.sourceLabel.length > 240 ||
    typeof value.providerText !== "string" || value.providerText.length < 1 ||
    !Number.isSafeInteger(value.providerTextBytes) || Number(value.providerTextBytes) < 1 ||
    Number(value.providerTextBytes) > MAX_PROVIDER_BYTES ||
    Buffer.byteLength(value.providerText, "utf8") !== value.providerTextBytes ||
    sha256Text(value.providerText) !== value.itemHash || typeof value.sourceAlias !== "string" ||
    !SOURCE_ALIAS.test(value.sourceAlias) || typeof value.sourceBindingId !== "string" ||
    value.sourceBindingId.length < 1 || value.sourceBindingId.length > 512 ||
    !Number.isSafeInteger(value.sourceOrdinal) || Number(value.sourceOrdinal) < 0 ||
    Number(value.sourceOrdinal) > 998 || value.sourceAlias !== `S${Number(value.sourceOrdinal) + 1}` ||
    !Number.isSafeInteger(value.sourceVersionNumber) || Number(value.sourceVersionNumber) < 1 ||
    !record(value.summaryEvidence) || typeof value.supportBindingsHash !== "string" ||
    !SHA256.test(value.supportBindingsHash) || !Number.isSafeInteger(value.supportCount) ||
    Number(value.supportCount) < 1 || Number(value.supportCount) > 4_096 ||
    !Array.isArray(value.supportBindings) || value.supportBindings.length !== value.supportCount) {
    return null;
  }
  const supports = value.supportBindings.map(decodeCandidateSupport);
  if (supports.some((support) => support === null)) return null;
  const supportBindings = supports as LegacyKnowledgeSummaryCandidateSupport[];
  if (new Set(supportBindings.map(({ handle }) => handle)).size !== supportBindings.length ||
    new Set(supportBindings.map(({ resultOrdinal }) => resultOrdinal)).size !==
      supportBindings.length || sha256(supportBindings) !== value.supportBindingsHash) return null;
  const { candidateHash, ...body } = value;
  if (sha256(body) !== candidateHash) return null;
  return Object.freeze({
    candidateHash,
    evidenceHash: value.evidenceHash,
    evidenceId: value.evidenceId,
    fileName: value.fileName,
    itemHash: value.itemHash,
    mapOutputHash: value.mapOutputHash,
    operationOrdinal: Number(value.operationOrdinal),
    providerBlock: Object.freeze(value.providerBlock) as Readonly<
      Record<string, unknown> & { sourceLabel: string }
    >,
    providerText: value.providerText,
    providerTextBytes: Number(value.providerTextBytes),
    sourceAlias: value.sourceAlias,
    sourceBindingId: value.sourceBindingId,
    sourceOrdinal: Number(value.sourceOrdinal),
    sourceVersionNumber: Number(value.sourceVersionNumber),
    summaryEvidence: Object.freeze(value.summaryEvidence),
    supportBindings: Object.freeze(supportBindings),
    supportBindingsHash: value.supportBindingsHash,
    supportCount: Number(value.supportCount),
    version: LEGACY_KNOWLEDGE_SUMMARY_RECEIPT_VERSION
  });
}

/** Resolves an accepted legacy summary to its immutable raw citation supports. */
export function evidencePackageForLegacySummaryReceipt(input: Readonly<{
  evidence: KnowledgeEvidencePackage;
  summaries: readonly Readonly<{
    candidate: unknown;
    supportBindings: readonly unknown[];
  }>[];
}>): KnowledgeEvidencePackage {
  if (!Array.isArray(input.summaries) || input.summaries.length < 1) {
    throw new Error("legacy_knowledge_summary_dispatch_invalid");
  }
  const evidenceById = new Map(input.evidence.items.map((item) => [item.id, item]));
  const included = new Set<string>();
  for (const stored of input.summaries) {
    const candidate = decodeLegacyKnowledgeSummaryDispatchCandidate(stored.candidate);
    const decoded = stored.supportBindings.map(decodeLegacyKnowledgeSummarySupportBinding);
    if (!candidate || decoded.length !== candidate.supportBindings.length ||
      decoded.some((binding: LegacyKnowledgeSummarySupportBinding | null) => binding === null)) {
      throw new Error("legacy_knowledge_summary_dispatch_invalid");
    }
    for (const [index, binding] of
      (decoded as LegacyKnowledgeSummarySupportBinding[]).entries()) {
      const support = candidate.supportBindings[index];
      const item = evidenceById.get(binding.evidenceItemId);
      if (!support || support.contentHash !== binding.contentHash ||
        support.excerptHash !== binding.excerptHash || support.handle !== binding.handle ||
        support.passageId !== binding.passageId ||
        support.passageOrdinal !== binding.passageOrdinal ||
        support.sectionHash !== binding.sectionHash ||
        support.sourceArtifactId !== binding.sourceArtifactId ||
        support.sourceId !== binding.sourceId || support.sourceVersionId !== binding.sourceVersionId ||
        included.has(binding.evidenceItemId) || !item || item.handle !== binding.handle ||
        item.state !== "available" || item.excerpt === null ||
        sha256Text(item.excerpt) !== binding.excerptHash ||
        item.contentHash !== binding.contentHash || item.passageId !== binding.passageId ||
        item.sourceArtifactId !== binding.sourceArtifactId || item.sourceId !== binding.sourceId ||
        item.sourceVersionId !== binding.sourceVersionId ||
        item.sourceVersionNumber !== candidate.sourceVersionNumber || item.textTruncated !== false ||
        sectionHash({
          headingPath: item.headingPath,
          sectionId: item.sectionId,
          sourceArtifactId: binding.sourceArtifactId
        }) !== binding.sectionHash) {
        throw new Error("legacy_knowledge_summary_support_mismatch");
      }
      included.add(binding.evidenceItemId);
    }
  }
  return Object.freeze({
    ...input.evidence,
    items: input.evidence.items.filter(({ id }) => included.has(id))
  });
}

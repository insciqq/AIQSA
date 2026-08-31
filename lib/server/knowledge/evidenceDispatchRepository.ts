import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { decodeKnowledgeCitationHandle } from "../../contracts/knowledge";
import { prisma } from "../prisma";
import {
  decodeKnowledgeEvidenceDispatchManifestDraft,
  isKnowledgeEvidencePackingVersion,
  LEGACY_KNOWLEDGE_EVIDENCE_DISPATCH_MANIFEST_VERSION,
  KNOWLEDGE_EVIDENCE_DISPATCH_MANIFEST_VERSION,
  KNOWLEDGE_EVIDENCE_SHORTENING_VERSION,
  type KnowledgeEvidenceDispatchManifestDraft
} from "./evidenceDispatchManifest";
import {
  decodeLegacyKnowledgeSummaryDispatchCandidate,
  decodeLegacyKnowledgeSummarySupportBinding,
  type LegacyKnowledgeSummaryDispatchCandidate,
  type LegacyKnowledgeSummarySupportBinding
} from "./legacySummaryReceipt";
import {
  decodeKnowledgeAnswerOperationRequestSnapshotV1,
  KNOWLEDGE_ANSWER_ACCEPTED_REQUEST_MAX_BYTES,
  type KnowledgeAnswerContractPair
} from "./answerGroundingV5";
import {
  KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21,
  KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21,
  decodeKnowledgeAnswerOperationRequestSnapshotV21,
  isCurrentKnowledgeAnswerOperationSnapshotV21,
  type KnowledgeAnswerOperationV21
} from "./answerGroundingV21";
import { KNOWLEDGE_COVERAGE_SCOPE_V5_OPERATION } from "./coverageScopeV5";
import {
  KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V20,
  KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V20
} from "./answerGroundingSelectorV20";

const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$/u;
const SAFE_REASON = /^[a-z][a-z0-9_]{0,63}$/u;
const SOURCE_ALIAS = /^S[1-9][0-9]{0,2}$/u;
const MAX_ACCOUNTING_VALUE = 2_147_483_647;
const MAX_ACCEPTED_RESULT_BYTES = 128 * 1_024;
const SERIALIZABLE_ATTEMPTS = 3;
const STORED_DISPATCH_METADATA_VERSION = 2 as const;
const LEGACY_STORED_DISPATCH_METADATA_VERSION = 1 as const;
export const KNOWLEDGE_PROVIDER_ATTEMPT_PURPOSE_STORAGE_LIMIT = 64;

function isCurrentKnowledgeHandle(value: string): boolean {
  const decoded = decodeKnowledgeCitationHandle(value);
  return decoded !== null && "evidenceOrdinal" in decoded;
}

const providerUsageKeys = [
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "estimatedCostMicros",
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "totalTokens"
] as const;

export type KnowledgeProviderAttemptUsage = Readonly<{
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  estimatedCostMicros: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
}>;

export type KnowledgeProviderAttemptPurpose =
  | "answer"
  | "knowledge_answer_draft_v21"
  | "knowledge_answer_draft_supplement_v21"
  | "knowledge_grounded_selector_v17"
  | "knowledge_grounded_selector_final_v17"
  | "knowledge_coverage_auditor_v2"
  | "knowledge_coverage_scope_v3"
  | "knowledge_grounded_selector_v18"
  | "knowledge_grounded_selector_final_v18"
  | "knowledge_coverage_scope_v4"
  | "knowledge_grounded_selector_v19"
  | "knowledge_grounded_selector_final_v19"
  | "knowledge_coverage_scope_v5"
  | "knowledge_grounded_selector_v20"
  | "knowledge_grounded_selector_final_v20"
  | "knowledge_coverage_planner_v20"
  | "knowledge_answer_draft_v20"
  | "knowledge_answer_draft_supplement_v20"
  | "knowledge_answer_draft_v19"
  | "knowledge_answer_draft_supplement_v19"
  | "knowledge_answer_draft_v18"
  | "knowledge_answer_draft_supplement_v18"
  | "knowledge_answer_draft_v17"
  | "knowledge_answer_draft_supplement_v17"
  | "knowledge_answer_draft_v16"
  | "knowledge_answer_draft_supplement_v16"
  | "knowledge_answer_draft_v15"
  | "knowledge_answer_draft_supplement_v15"
  | "knowledge_answer_draft_v14"
  | "knowledge_answer_draft_supplement_v14"
  | "knowledge_answer_draft_v13"
  | "knowledge_answer_draft_supplement_v13"
  | "knowledge_answer_draft_v12"
  | "knowledge_answer_draft_supplement_v12"
  | "knowledge_answer_draft_v11"
  | "knowledge_answer_draft_v10"
  | "knowledge_answer_draft_v9"
  | "knowledge_answer_draft_v8"
  | "knowledge_answer_draft_v7"
  | "knowledge_grounded_selector_v16"
  | "knowledge_grounded_selector_final_v16"
  | "knowledge_grounded_selector_v15"
  | "knowledge_grounded_selector_final_v15"
  | "knowledge_grounded_selector_v14"
  | "knowledge_grounded_selector_final_v14"
  | "knowledge_grounded_selector_v13"
  | "knowledge_grounded_selector_final_v13"
  | "knowledge_grounded_selector_v12"
  | "knowledge_grounded_selector_final_v12"
  | "knowledge_grounded_selector_v11"
  | "knowledge_grounded_selector_final_v11"
  | "knowledge_grounded_selector_v10"
  | "knowledge_grounded_selector_final_v10"
  | "knowledge_grounded_selector_v9"
  | "knowledge_grounded_selector_final_v9"
  | "knowledge_grounded_selector_v8"
  | "knowledge_grounded_selector_final_v8"
  | "knowledge_grounded_selector_v7"
  | "knowledge_grounded_selector_v6"
  | "knowledge_grounded_selector_v5";

/** Accepted-record decoder includes retired purposes for historical recovery. */
type LegacyKnowledgeProviderAttemptPurpose =
  | KnowledgeProviderAttemptPurpose
  | "knowledge_coverage_auditor_v1"
  | "answer_citation_retry"
  | "citation_repair"
  | "knowledge_answer_draft_v5"
  | "knowledge_answer_draft_v6"
  | "knowledge_grounded_selector_v2"
  | "knowledge_grounded_selector_v3"
  | "knowledge_grounded_selector_v4"
  | "tool_follow_up";

export type KnowledgeProviderAttemptRecord = Readonly<{
  acceptedRequest: Readonly<Record<string, unknown>> | null;
  acceptedResult: Readonly<Record<string, unknown>> | null;
  actualUsage: KnowledgeProviderAttemptUsage | null;
  ambiguousAt: Date | null;
  checkpointHash: string;
  contractVersion: number | null;
  dispatchedAt: Date | null;
  evidenceReceiptHash: string | null;
  estimatedUsage: KnowledgeProviderAttemptUsage;
  failureCode: string | null;
  id: string;
  idempotencyKey: string;
  leaseExpiresAt: Date | null;
  leaseToken: string | null;
  modelRunId: string;
  ordinal: number;
  providerBindingKey: string;
  providerResponseId: string | null;
  purpose: LegacyKnowledgeProviderAttemptPurpose;
  releasedAt: Date | null;
  requestHash: string;
  resultAcceptedAt: Date | null;
  resultHash: string | null;
  roundIndex: number;
  settledAt: Date | null;
  state: "ambiguous" | "dispatched" | "released" | "reserved" | "settled";
}>;

export type KnowledgeEvidenceDispatchBinding = Readonly<{
  dispatchEvidenceId: string;
  evidenceItemId: string;
}>;

export type StoredKnowledgeEvidenceDispatch = Readonly<{
  attempt: KnowledgeProviderAttemptRecord;
  draft: KnowledgeEvidenceDispatchManifestDraft;
  exclusions: readonly Readonly<{
    dispatchEvidenceId: string;
    evidenceItemId: string | null;
    handle: string | null;
    reason: "budget" | "deduplicated" | "unavailable";
  }>[];
  manifestId: string;
  items: readonly Readonly<{
    dispatchEvidenceId: string;
    evidenceItemId: string;
    handle: string;
    sourceArtifactId: string;
    sourceVersionId: string;
    summary?: LegacyKnowledgeSummaryDispatchCandidate;
    summarySupportBindings?: readonly LegacyKnowledgeSummarySupportBinding[];
  }>[];
  profileRevisionIds: readonly string[];
  retrievalSessionId: string;
}>;

export type KnowledgeGroundingDispatchSelection =
  | Readonly<{
      dispatch: StoredKnowledgeEvidenceDispatch;
      kind: "current";
    }>
  | Readonly<{
      kind: "legacy";
    }>;

export type StoredKnowledgeAnswerGroundingOperations = Readonly<{
  coveragePlanner: StoredKnowledgeEvidenceDispatch | null;
  draft: StoredKnowledgeEvidenceDispatch;
  finalSelector: StoredKnowledgeEvidenceDispatch | null;
  initialSelector: StoredKnowledgeEvidenceDispatch;
  selector: StoredKnowledgeEvidenceDispatch;
  supplementalDraft: StoredKnowledgeEvidenceDispatch | null;
}>;

export type StoredKnowledgeAnswerGroundingOperationsV21 = Readonly<{
  draft: StoredKnowledgeEvidenceDispatch;
  finalSelector: StoredKnowledgeEvidenceDispatch | null;
  initialScope: StoredKnowledgeEvidenceDispatch;
  initialSelector: StoredKnowledgeEvidenceDispatch;
  scope: StoredKnowledgeEvidenceDispatch;
  scopeRepair: StoredKnowledgeEvidenceDispatch | null;
  selectorRepair: StoredKnowledgeEvidenceDispatch | null;
  supplementalDraft: StoredKnowledgeEvidenceDispatch | null;
}>;

export type KnowledgeEvidenceDispatchRepositoryErrorCode =
  | "binding_unavailable"
  | "draft_conflict"
  | "evidence_mismatch"
  | "idempotency_conflict"
  | "invalid_input"
  | "invalid_state"
  | "lease_conflict"
  | "lease_expired"
  | "manifest_purged"
  | "stored_manifest_invalid"
  | "target_unavailable";

export class KnowledgeEvidenceDispatchRepositoryError extends Error {
  readonly code: KnowledgeEvidenceDispatchRepositoryErrorCode;

  constructor(code: KnowledgeEvidenceDispatchRepositoryErrorCode) {
    super(`knowledge_evidence_dispatch_${code}`);
    this.name = "KnowledgeEvidenceDispatchRepositoryError";
    this.code = code;
  }
}

class KnowledgeProviderAttemptRecoveryClaimRaceError extends Error {
  constructor() {
    super("knowledge_provider_attempt_recovery_claim_race");
    this.name = "KnowledgeProviderAttemptRecoveryClaimRaceError";
  }
}

type AttemptIdentity = Readonly<{
  attemptId: string;
  checkpointHash: string;
  idempotencyKey: string;
  manifestHash: string;
  modelRunId: string;
  providerBindingKey: string;
  requestHash: string;
}>;

export type ReserveKnowledgeEvidenceDispatchInput = Readonly<{
  acceptedRequest?: Readonly<Record<string, unknown>>;
  checkpointHash: string;
  contractVersion?: number;
  draft: KnowledgeEvidenceDispatchManifestDraft;
  estimatedUsage: KnowledgeProviderAttemptUsage;
  evidenceReceiptHash?: string;
  evidenceBindings?: readonly KnowledgeEvidenceDispatchBinding[];
  idempotencyKey: string;
  leaseExpiresAt: Date;
  leaseToken: string;
  modelRunId: string;
  now: Date;
  ordinal: number;
  providerBindingKey: string;
  purpose: KnowledgeProviderAttemptPurpose;
  requestHash: string;
  retrievalSessionId?: string;
  roundIndex: number;
}>;

export type DispatchKnowledgeProviderAttemptInput = AttemptIdentity & Readonly<{
  dispatchedAt: Date;
  leaseExpiresAt: Date;
  leaseToken: string;
}>;

export type SettleKnowledgeProviderAttemptInput = AttemptIdentity & Readonly<{
  acceptedResult?: Readonly<Record<string, unknown>>;
  actualUsage: KnowledgeProviderAttemptUsage;
  leaseToken: string;
  providerResponseId: string | null;
  resultAcceptedAt?: Date;
  resultHash?: string;
  settledAt: Date;
}>;

export type ReleaseKnowledgeProviderAttemptInput = AttemptIdentity & Readonly<{
  leaseToken: string;
  reason: string;
  releasedAt: Date;
}>;

export type MarkKnowledgeProviderAttemptAmbiguousInput = AttemptIdentity & Readonly<{
  ambiguousAt: Date;
  leaseToken: string;
  providerResponseId?: string | null;
  reason: string;
}>;

export type RecoverKnowledgeProviderAttemptInput = Readonly<{
  leaseExpiresAt: Date;
  leaseToken: string;
  modelRunId: string;
  now: Date;
  ordinal: number;
  providerResponseId?: string | null;
  requestHash?: string;
}>;

export type KnowledgeProviderAttemptRecovery =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{
      dispatch: StoredKnowledgeEvidenceDispatch;
      kind: "ambiguous" | "busy" | "released" | "request_required";
    }>
  | Readonly<{
      dispatch: StoredKnowledgeEvidenceDispatch;
      kind: "dispatch";
      leaseToken: string;
    }>
  | Readonly<{
      dispatch: StoredKnowledgeEvidenceDispatch;
      kind: "resume";
      leaseToken: string;
      providerResponseId: string;
    }>
  | Readonly<{
      dispatch: StoredKnowledgeEvidenceDispatch;
      kind: "settled";
      providerResponseId: string | null;
    }>;

export type KnowledgeProviderAttemptTransition = Readonly<{
  attempt: KnowledgeProviderAttemptRecord;
  kind: "idempotent" | "transitioned";
}>;

type StoredDispatchRootBase = Readonly<{
  coverageStatement: string;
  footer: string;
  header: string;
  limits: Readonly<{ maximumBytes: number; maximumTokens: number }>;
  manifestHash: string;
  profileId: string;
  shorteningPolicy: "disabled" | typeof KNOWLEDGE_EVIDENCE_SHORTENING_VERSION;
}>;

type StoredDispatchRoot = StoredDispatchRootBase & (
  | Readonly<{ runtimeVersion: number }>
  | Readonly<{ plannerVersion: number }>
);

type StoredDispatchProvenance = Readonly<{
  evidenceId: string;
  operationOrdinal: number;
  resultOrdinal: number;
}>;

type StoredExclusionProvenance = StoredDispatchProvenance & Readonly<{
  duplicateOfEvidenceId: string | null;
}>;

type StoredDispatchMetadata = Readonly<{
  exclusions: readonly StoredExclusionProvenance[];
  items: readonly (StoredDispatchProvenance & Readonly<{ dispatchOrdinal: number }>)[];
  root: StoredDispatchRoot;
  version: typeof LEGACY_STORED_DISPATCH_METADATA_VERSION |
    typeof STORED_DISPATCH_METADATA_VERSION;
}>;

type StoredSafeMetadata = Readonly<{
  ambiguity: "none" | "table_cell_associations_ambiguous";
  fileName: string;
  locator: string;
  sourceLabel: string;
  sourceTruncated: boolean;
  sourceVersionNumber: number;
}>;

type StoredSummarySafeMetadata = StoredSafeMetadata & Readonly<{
  kind: "source_summary";
  summary: LegacyKnowledgeSummaryDispatchCandidate;
}>;

type StoredContextBoundaries = Readonly<{
  expandedContext: string | null;
  expandedContextOriginalBytes: number | null;
  expandedContextOriginalHash: string | null;
  expandedContextState: "included" | "none" | "omitted";
}>;

type StoredSummaryContextBoundaries = StoredContextBoundaries & Readonly<{
  kind: "source_summary";
  supportBindings: readonly LegacyKnowledgeSummarySupportBinding[];
}>;

const attemptInclude = {
  manifest: {
    include: {
      exclusions: { orderBy: [{ ordinal: "asc" as const }, { id: "asc" as const }] },
      items: { orderBy: [{ ordinal: "asc" as const }, { id: "asc" as const }] }
    }
  }
} satisfies Prisma.KnowledgeProviderAttemptInclude;

type AttemptRow = Prisma.KnowledgeProviderAttemptGetPayload<{ include: typeof attemptInclude }>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function integer(value: unknown, minimum = 0, maximum = MAX_ACCOUNTING_VALUE): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function safeString(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !value.includes("\u0000");
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.valueOf());
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new KnowledgeEvidenceDispatchRepositoryError("invalid_input");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new KnowledgeEvidenceDispatchRepositoryError("invalid_input");
}

function canonicalJsonBytes(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

function canonicalJsonHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function answerOperationContractVersion(
  purpose: LegacyKnowledgeProviderAttemptPurpose
): number | null {
  if (purpose === "knowledge_answer_draft_v21" ||
    purpose === "knowledge_answer_draft_supplement_v21") return 21;
  if (purpose === "knowledge_grounded_selector_v17" ||
    purpose === "knowledge_grounded_selector_final_v17") return 17;
  if (purpose === "knowledge_grounded_selector_v18" ||
    purpose === "knowledge_grounded_selector_final_v18") return 18;
  if (purpose === "knowledge_grounded_selector_v19" ||
    purpose === "knowledge_grounded_selector_final_v19") return 19;
  if (purpose === "knowledge_grounded_selector_v20" ||
    purpose === "knowledge_grounded_selector_final_v20") return 20;
  if (purpose === "knowledge_coverage_scope_v3") return 3;
  if (purpose === "knowledge_coverage_scope_v4") return 4;
  if (purpose === "knowledge_coverage_scope_v5") return 5;
  if (purpose === "knowledge_coverage_auditor_v2") return 2;
  if (purpose === "knowledge_coverage_auditor_v1") return 1;
  if (purpose === "knowledge_coverage_planner_v20" ||
    purpose === "knowledge_answer_draft_v20" ||
    purpose === "knowledge_answer_draft_supplement_v20") return 20;
  if (purpose === "knowledge_answer_draft_v19" ||
    purpose === "knowledge_answer_draft_supplement_v19") return 19;
  if (purpose === "knowledge_answer_draft_v18" ||
    purpose === "knowledge_answer_draft_supplement_v18") return 18;
  if (purpose === "knowledge_answer_draft_v17" ||
    purpose === "knowledge_answer_draft_supplement_v17") return 17;
  if (purpose === "knowledge_answer_draft_v16" ||
    purpose === "knowledge_answer_draft_supplement_v16") return 16;
  if (purpose === "knowledge_answer_draft_v15" ||
    purpose === "knowledge_answer_draft_supplement_v15") return 15;
  if (purpose === "knowledge_answer_draft_v14" ||
    purpose === "knowledge_answer_draft_supplement_v14") return 14;
  if (purpose === "knowledge_answer_draft_v13" ||
    purpose === "knowledge_answer_draft_supplement_v13") return 13;
  if (purpose === "knowledge_answer_draft_v12" ||
    purpose === "knowledge_answer_draft_supplement_v12") return 12;
  if (purpose === "knowledge_answer_draft_v11") return 11;
  if (purpose === "knowledge_answer_draft_v10") return 10;
  if (purpose === "knowledge_answer_draft_v9") return 9;
  if (purpose === "knowledge_answer_draft_v8") return 8;
  if (purpose === "knowledge_grounded_selector_v16" ||
    purpose === "knowledge_grounded_selector_final_v16") return 16;
  if (purpose === "knowledge_grounded_selector_v15" ||
    purpose === "knowledge_grounded_selector_final_v15") return 15;
  if (purpose === "knowledge_grounded_selector_v14" ||
    purpose === "knowledge_grounded_selector_final_v14") return 14;
  if (purpose === "knowledge_grounded_selector_v13" ||
    purpose === "knowledge_grounded_selector_final_v13") return 13;
  if (purpose === "knowledge_grounded_selector_v12" ||
    purpose === "knowledge_grounded_selector_final_v12") return 12;
  if (purpose === "knowledge_grounded_selector_v11" ||
    purpose === "knowledge_grounded_selector_final_v11") return 11;
  if (purpose === "knowledge_grounded_selector_v10" ||
    purpose === "knowledge_grounded_selector_final_v10") return 10;
  if (purpose === "knowledge_grounded_selector_v9" ||
    purpose === "knowledge_grounded_selector_final_v9") return 9;
  if (purpose === "knowledge_grounded_selector_v8" ||
    purpose === "knowledge_grounded_selector_final_v8") return 8;
  if (purpose === "knowledge_grounded_selector_v7") return 7;
  if (purpose === "knowledge_grounded_selector_v6") return 6;
  if (purpose === "knowledge_answer_draft_v7") return 7;
  if (purpose === "knowledge_grounded_selector_v5") return 5;
  if (purpose === "knowledge_answer_draft_v6") return 6;
  if (purpose === "knowledge_grounded_selector_v4") return 4;
  if (purpose === "knowledge_answer_draft_v5") return 5;
  if (purpose === "knowledge_grounded_selector_v3") return 3;
  return purpose === "knowledge_grounded_selector_v2" ? 2 : null;
}

function validAcceptedJsonObject(value: unknown, maximumBytes: number):
  value is Record<string, unknown> {
  if (!record(value)) return false;
  try {
    return canonicalJsonBytes(value) <= maximumBytes;
  } catch {
    return false;
  }
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

export function decodeKnowledgeProviderAttemptUsage(
  value: unknown
): KnowledgeProviderAttemptUsage | null {
  if (!record(value) || !exactKeys(value, providerUsageKeys) ||
    providerUsageKeys.some((key) => value[key] !== null && !integer(value[key]))) return null;
  return deepFreeze(Object.fromEntries(providerUsageKeys.map((key) => [key, value[key]])) as
    KnowledgeProviderAttemptUsage);
}

function compactUserSafeMetadata(value: string, maximum = 240): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return [...normalized].slice(0, maximum).join("");
}

function repositoryError(code: KnowledgeEvidenceDispatchRepositoryErrorCode): never {
  throw new KnowledgeEvidenceDispatchRepositoryError(code);
}

function validPurpose(value: unknown): value is LegacyKnowledgeProviderAttemptPurpose {
  return value === "answer" || value === "answer_citation_retry" ||
    value === "citation_repair" || value === "tool_follow_up" ||
    value === "knowledge_answer_draft_v21" ||
    value === "knowledge_answer_draft_supplement_v21" ||
    value === "knowledge_grounded_selector_v17" ||
    value === "knowledge_grounded_selector_final_v17" ||
    value === "knowledge_grounded_selector_v18" ||
    value === "knowledge_grounded_selector_final_v18" ||
    value === "knowledge_grounded_selector_v19" ||
    value === "knowledge_grounded_selector_final_v19" ||
    value === "knowledge_grounded_selector_v20" ||
    value === "knowledge_grounded_selector_final_v20" ||
    value === "knowledge_coverage_auditor_v2" ||
    value === "knowledge_coverage_scope_v3" ||
    value === "knowledge_coverage_scope_v4" ||
    value === "knowledge_coverage_scope_v5" ||
    value === "knowledge_coverage_auditor_v1" ||
    value === "knowledge_coverage_planner_v20" ||
    value === "knowledge_answer_draft_v20" ||
    value === "knowledge_answer_draft_supplement_v20" ||
    value === "knowledge_answer_draft_v19" ||
    value === "knowledge_answer_draft_supplement_v19" ||
    value === "knowledge_answer_draft_v18" ||
    value === "knowledge_answer_draft_supplement_v18" ||
    value === "knowledge_answer_draft_v17" ||
    value === "knowledge_answer_draft_supplement_v17" ||
    value === "knowledge_answer_draft_v16" ||
    value === "knowledge_answer_draft_supplement_v16" ||
    value === "knowledge_answer_draft_v15" ||
    value === "knowledge_answer_draft_supplement_v15" ||
    value === "knowledge_answer_draft_v14" ||
    value === "knowledge_answer_draft_supplement_v14" ||
    value === "knowledge_answer_draft_v13" ||
    value === "knowledge_answer_draft_supplement_v13" ||
    value === "knowledge_answer_draft_v12" ||
    value === "knowledge_answer_draft_supplement_v12" ||
    value === "knowledge_answer_draft_v11" ||
    value === "knowledge_answer_draft_v10" ||
    value === "knowledge_answer_draft_v9" ||
    value === "knowledge_answer_draft_v8" ||
    value === "knowledge_answer_draft_v7" ||
    value === "knowledge_answer_draft_v6" ||
    value === "knowledge_answer_draft_v5" ||
    value === "knowledge_grounded_selector_v2" ||
    value === "knowledge_grounded_selector_v3" ||
    value === "knowledge_grounded_selector_v4" ||
    value === "knowledge_grounded_selector_v5" ||
    value === "knowledge_grounded_selector_v16" ||
    value === "knowledge_grounded_selector_final_v16" ||
    value === "knowledge_grounded_selector_v15" ||
    value === "knowledge_grounded_selector_final_v15" ||
    value === "knowledge_grounded_selector_v14" ||
    value === "knowledge_grounded_selector_final_v14" ||
    value === "knowledge_grounded_selector_v13" ||
    value === "knowledge_grounded_selector_final_v13" ||
    value === "knowledge_grounded_selector_v12" ||
    value === "knowledge_grounded_selector_final_v12" ||
    value === "knowledge_grounded_selector_v11" ||
    value === "knowledge_grounded_selector_final_v11" ||
    value === "knowledge_grounded_selector_v10" ||
    value === "knowledge_grounded_selector_final_v10" ||
    value === "knowledge_grounded_selector_v9" ||
    value === "knowledge_grounded_selector_final_v9" ||
    value === "knowledge_grounded_selector_v8" ||
    value === "knowledge_grounded_selector_final_v8" ||
    value === "knowledge_grounded_selector_v7" ||
    value === "knowledge_grounded_selector_v6";
}

function validReservationPurpose(value: unknown): value is KnowledgeProviderAttemptPurpose {
  return value === "answer" || value === "knowledge_answer_draft_v21" ||
    value === "knowledge_answer_draft_supplement_v21" ||
    value === "knowledge_grounded_selector_v17" ||
    value === "knowledge_grounded_selector_final_v17" ||
    value === "knowledge_grounded_selector_v18" ||
    value === "knowledge_grounded_selector_final_v18" ||
    value === "knowledge_grounded_selector_v19" ||
    value === "knowledge_grounded_selector_final_v19" ||
    value === "knowledge_grounded_selector_v20" ||
    value === "knowledge_grounded_selector_final_v20" ||
    value === "knowledge_coverage_auditor_v2" ||
    value === "knowledge_coverage_scope_v3" ||
    value === "knowledge_coverage_scope_v4" ||
    value === "knowledge_coverage_scope_v5" ||
    value === "knowledge_coverage_planner_v20" ||
    value === "knowledge_answer_draft_v20" ||
    value === "knowledge_answer_draft_supplement_v20" ||
    value === "knowledge_answer_draft_v19" ||
    value === "knowledge_answer_draft_supplement_v19" ||
    value === "knowledge_answer_draft_v18" ||
    value === "knowledge_answer_draft_supplement_v18" ||
    value === "knowledge_answer_draft_v17" ||
    value === "knowledge_answer_draft_supplement_v17" ||
    value === "knowledge_answer_draft_v16" ||
    value === "knowledge_answer_draft_supplement_v16" ||
    value === "knowledge_answer_draft_v15" ||
    value === "knowledge_answer_draft_supplement_v15" ||
    value === "knowledge_answer_draft_v14" ||
    value === "knowledge_answer_draft_supplement_v14" ||
    value === "knowledge_answer_draft_v13" ||
    value === "knowledge_answer_draft_supplement_v13" ||
    value === "knowledge_answer_draft_v12" ||
    value === "knowledge_answer_draft_supplement_v12" ||
    value === "knowledge_answer_draft_v11" ||
    value === "knowledge_answer_draft_v10" ||
    value === "knowledge_answer_draft_v9" ||
    value === "knowledge_answer_draft_v8" ||
    value === "knowledge_answer_draft_v7" ||
    value === "knowledge_grounded_selector_v16" ||
    value === "knowledge_grounded_selector_final_v16" ||
    value === "knowledge_grounded_selector_v15" ||
    value === "knowledge_grounded_selector_final_v15" ||
    value === "knowledge_grounded_selector_v14" ||
    value === "knowledge_grounded_selector_final_v14" ||
    value === "knowledge_grounded_selector_v13" ||
    value === "knowledge_grounded_selector_final_v13" ||
    value === "knowledge_grounded_selector_v12" ||
    value === "knowledge_grounded_selector_final_v12" ||
    value === "knowledge_grounded_selector_v11" ||
    value === "knowledge_grounded_selector_final_v11" ||
    value === "knowledge_grounded_selector_v10" ||
    value === "knowledge_grounded_selector_final_v10" ||
    value === "knowledge_grounded_selector_v9" ||
    value === "knowledge_grounded_selector_final_v9" ||
    value === "knowledge_grounded_selector_v8" ||
    value === "knowledge_grounded_selector_final_v8" ||
    value === "knowledge_grounded_selector_v7" ||
    value === "knowledge_grounded_selector_v6" ||
    value === "knowledge_grounded_selector_v5";
}

function validateAttemptIdentity(input: AttemptIdentity): void {
  if (!safeString(input.attemptId) || !safeString(input.modelRunId) ||
    !safeString(input.providerBindingKey, 128) || !SAFE_IDENTITY.test(input.idempotencyKey) ||
    !SHA256.test(input.checkpointHash) || !SHA256.test(input.requestHash) ||
    !SHA256.test(input.manifestHash)) repositoryError("invalid_input");
}

function validateReserveInput(
  input: ReserveKnowledgeEvidenceDispatchInput
): Readonly<{
  draft: KnowledgeEvidenceDispatchManifestDraft;
  estimatedUsage: KnowledgeProviderAttemptUsage;
}> {
  const draft = decodeKnowledgeEvidenceDispatchManifestDraft(input.draft);
  const estimatedUsage = decodeKnowledgeProviderAttemptUsage(input.estimatedUsage);
  const contractVersion = answerOperationContractVersion(input.purpose);
  const answerOperationSnapshotValid = contractVersion === null
    ? input.acceptedRequest === undefined && input.contractVersion === undefined &&
      input.evidenceReceiptHash === undefined
    : input.contractVersion === contractVersion &&
      input.evidenceReceiptHash === draft?.manifestHash &&
      typeof input.evidenceReceiptHash === "string" && SHA256.test(input.evidenceReceiptHash) &&
      validAcceptedJsonObject(
        input.acceptedRequest,
        KNOWLEDGE_ANSWER_ACCEPTED_REQUEST_MAX_BYTES
      ) &&
      canonicalJsonHash(input.acceptedRequest) === input.requestHash;
  if (!draft || draft.version !== KNOWLEDGE_EVIDENCE_DISPATCH_MANIFEST_VERSION ||
    draft.items.some((item) => "kind" in item) || !estimatedUsage ||
    !safeString(input.modelRunId) ||
    input.retrievalSessionId !== undefined && !safeString(input.retrievalSessionId) ||
    !safeString(input.providerBindingKey, 128) ||
    !SAFE_IDENTITY.test(input.idempotencyKey) || !SAFE_IDENTITY.test(input.leaseToken) ||
    !SHA256.test(input.checkpointHash) || !SHA256.test(input.requestHash) ||
    !integer(input.ordinal, 1, 256) || !integer(input.roundIndex, 0, 255) ||
    !safeString(input.purpose, KNOWLEDGE_PROVIDER_ATTEMPT_PURPOSE_STORAGE_LIMIT) ||
    !validReservationPurpose(input.purpose) ||
    !answerOperationSnapshotValid || !validDate(input.now) || !validDate(input.leaseExpiresAt) ||
    input.leaseExpiresAt <= input.now || (input.evidenceBindings?.length ?? 0) > 4_096) {
    repositoryError("invalid_input");
  }
  return { draft, estimatedUsage };
}

function decodeStoredRoot(value: unknown): StoredDispatchRoot | null {
  if (!record(value)) return null;
  const versionField = Object.hasOwn(value, "runtimeVersion")
    ? "runtimeVersion"
    : Object.hasOwn(value, "plannerVersion")
      ? "plannerVersion"
      : null;
  if (!versionField || !exactKeys(value, [
    "coverageStatement",
    "footer",
    "header",
    "limits",
    "manifestHash",
    versionField,
    "profileId",
    "shorteningPolicy"
  ]) || typeof value.coverageStatement !== "string" || !safeString(value.footer, 64_000) ||
    !safeString(value.header, 64_000) || !record(value.limits) ||
    !exactKeys(value.limits, ["maximumBytes", "maximumTokens"]) ||
    !integer(value.limits.maximumBytes, 1) || !integer(value.limits.maximumTokens, 1) ||
    !SHA256.test(String(value.manifestHash)) || !integer(value[versionField], 1) ||
    !safeString(value.profileId, 1_024) ||
    value.shorteningPolicy !== "disabled" &&
      value.shorteningPolicy !== KNOWLEDGE_EVIDENCE_SHORTENING_VERSION) return null;
  return value as unknown as StoredDispatchRoot;
}

function decodeStoredProvenance(value: unknown): StoredDispatchProvenance | null {
  if (!record(value) || !exactKeys(value, ["evidenceId", "operationOrdinal", "resultOrdinal"]) ||
    !safeString(value.evidenceId, 1_024) || !integer(value.operationOrdinal) ||
    !integer(value.resultOrdinal, 1)) return null;
  return value as unknown as StoredDispatchProvenance;
}

function decodeStoredDispatchMetadata(value: unknown): StoredDispatchMetadata | null {
  if (!record(value) || !exactKeys(value, ["exclusions", "items", "root", "version"]) ||
    value.version !== STORED_DISPATCH_METADATA_VERSION &&
      value.version !== LEGACY_STORED_DISPATCH_METADATA_VERSION || !Array.isArray(value.items) ||
    !Array.isArray(value.exclusions) || value.items.length > 4_096 ||
    value.exclusions.length > 4_096) return null;
  const root = decodeStoredRoot(value.root);
  const items = value.items.map((entry) => {
    if (!record(entry) || !exactKeys(entry, [
      "dispatchOrdinal",
      "evidenceId",
      "operationOrdinal",
      "resultOrdinal"
    ]) || !integer(entry.dispatchOrdinal, 1, 4_096)) return null;
    const provenance = decodeStoredProvenance({
      evidenceId: entry.evidenceId,
      operationOrdinal: entry.operationOrdinal,
      resultOrdinal: entry.resultOrdinal
    });
    return provenance ? { ...provenance, dispatchOrdinal: entry.dispatchOrdinal } : null;
  });
  const exclusions = value.exclusions.map((entry) => {
    if (!record(entry) || !exactKeys(entry, [
      "duplicateOfEvidenceId",
      "evidenceId",
      "operationOrdinal",
      "resultOrdinal"
    ]) || entry.duplicateOfEvidenceId !== null &&
      !safeString(entry.duplicateOfEvidenceId, 1_024)) return null;
    const provenance = decodeStoredProvenance({
      evidenceId: entry.evidenceId,
      operationOrdinal: entry.operationOrdinal,
      resultOrdinal: entry.resultOrdinal
    });
    return provenance
      ? { ...provenance, duplicateOfEvidenceId: entry.duplicateOfEvidenceId as string | null }
      : null;
  });
  if (!root || (value.version === STORED_DISPATCH_METADATA_VERSION) !==
      ("runtimeVersion" in root) || items.some((entry) => entry === null) ||
    exclusions.some((entry) => entry === null)) return null;
  return {
    exclusions: exclusions as StoredExclusionProvenance[],
    items: items as (StoredDispatchProvenance & { dispatchOrdinal: number })[],
    root,
    version: value.version
  };
}

function decodeSafeMetadata(
  value: unknown
): StoredSafeMetadata | StoredSummarySafeMetadata | null {
  if (!record(value)) return null;
  const summary = Object.hasOwn(value, "kind") || Object.hasOwn(value, "summary")
    ? decodeLegacyKnowledgeSummaryDispatchCandidate(value.summary)
    : null;
  const baseValue = summary
    ? Object.fromEntries(Object.entries(value).filter(([key]) =>
        key !== "kind" && key !== "summary"))
    : value;
  if (summary && value.kind !== "source_summary" || !summary && (
    Object.hasOwn(value, "kind") || Object.hasOwn(value, "summary"))) return null;
  if (!exactKeys(baseValue, [
    "ambiguity",
    "fileName",
    "locator",
    "sourceLabel",
    "sourceTruncated",
    "sourceVersionNumber"
  ]) || baseValue.ambiguity !== "none" &&
      baseValue.ambiguity !== "table_cell_associations_ambiguous" ||
    !safeString(baseValue.fileName, 1_024) || !safeString(baseValue.locator, 2_048) ||
    !safeString(baseValue.sourceLabel, 1_024) ||
    typeof baseValue.sourceTruncated !== "boolean" ||
    !integer(baseValue.sourceVersionNumber, 1)) return null;
  const base = baseValue as unknown as StoredSafeMetadata;
  return summary ? { ...base, kind: "source_summary", summary } : base;
}

function decodeContextBoundaries(
  value: unknown
): StoredContextBoundaries | StoredSummaryContextBoundaries | null {
  if (!record(value)) return null;
  const rawSupports = Object.hasOwn(value, "kind") || Object.hasOwn(value, "supportBindings")
    ? value.supportBindings
    : null;
  const supports = Array.isArray(rawSupports)
    ? rawSupports.map(decodeLegacyKnowledgeSummarySupportBinding)
    : null;
  const summary = value.kind === "source_summary" && supports !== null &&
    supports.length > 0 && supports.every((support) => support !== null) &&
    new Set(supports.map((support) => support!.evidenceItemId)).size === supports.length;
  const baseValue = summary
    ? Object.fromEntries(Object.entries(value).filter(([key]) =>
        key !== "kind" && key !== "supportBindings"))
    : value;
  if (!summary && (Object.hasOwn(value, "kind") || Object.hasOwn(value, "supportBindings"))) {
    return null;
  }
  if (!exactKeys(baseValue, [
    "expandedContext",
    "expandedContextOriginalBytes",
    "expandedContextOriginalHash",
    "expandedContextState"
  ]) || baseValue.expandedContext !== null && typeof baseValue.expandedContext !== "string" ||
    baseValue.expandedContextOriginalBytes !== null &&
      !integer(baseValue.expandedContextOriginalBytes, 1) ||
    baseValue.expandedContextOriginalHash !== null &&
      !SHA256.test(String(baseValue.expandedContextOriginalHash)) ||
    baseValue.expandedContextState !== "included" && baseValue.expandedContextState !== "none" &&
      baseValue.expandedContextState !== "omitted") return null;
  const base = baseValue as unknown as StoredContextBoundaries;
  return summary
    ? {
        ...base,
        kind: "source_summary",
        supportBindings: supports as LegacyKnowledgeSummarySupportBinding[]
      }
    : base;
}

function decodeAttempt(row: AttemptRow): KnowledgeProviderAttemptRecord {
  const estimatedUsage = decodeKnowledgeProviderAttemptUsage(row.estimatedUsage);
  const actualUsage = row.actualUsage === null
    ? null
    : decodeKnowledgeProviderAttemptUsage(row.actualUsage);
  const acceptedRequest = row.acceptedRequest === null
    ? null
    : validAcceptedJsonObject(
        row.acceptedRequest,
        KNOWLEDGE_ANSWER_ACCEPTED_REQUEST_MAX_BYTES
      )
      ? deepFreeze(row.acceptedRequest)
      : repositoryError("stored_manifest_invalid");
  const acceptedResult = row.acceptedResult === null
    ? null
    : validAcceptedJsonObject(row.acceptedResult, MAX_ACCEPTED_RESULT_BYTES)
      ? deepFreeze(row.acceptedResult)
      : repositoryError("stored_manifest_invalid");
  const dates = [
    row.createdAt,
    row.dispatchedAt,
    row.leaseExpiresAt,
    row.settledAt,
    row.releasedAt,
    row.ambiguousAt,
    row.resultAcceptedAt
  ];
  if (!estimatedUsage || row.actualUsage !== null && !actualUsage || !validPurpose(row.purpose) ||
    !safeString(row.id) || !safeString(row.modelRunId) ||
    !safeString(row.providerBindingKey, 128) || !SAFE_IDENTITY.test(row.idempotencyKey) ||
    !SHA256.test(row.checkpointHash) || !SHA256.test(row.requestHash) ||
    !integer(row.ordinal, 1, 256) || !integer(row.roundIndex, 0, 255) ||
    dates.some((value) => value !== null && !validDate(value))) {
    repositoryError("stored_manifest_invalid");
  }
  if (row.providerResponseId !== null && !safeString(row.providerResponseId, 1_024)) {
    repositoryError("stored_manifest_invalid");
  }
  const expectedContractVersion = answerOperationContractVersion(row.purpose);
  const answerOperationSnapshotValid = expectedContractVersion === null
    ? row.contractVersion === null && row.evidenceReceiptHash === null &&
      acceptedRequest === null && acceptedResult === null && row.resultHash === null &&
      row.resultAcceptedAt === null
    : row.contractVersion === expectedContractVersion &&
      typeof row.evidenceReceiptHash === "string" && SHA256.test(row.evidenceReceiptHash) &&
      acceptedRequest !== null && canonicalJsonHash(acceptedRequest) === row.requestHash &&
      (acceptedResult === null && row.resultHash === null && row.resultAcceptedAt === null ||
        acceptedResult !== null && typeof row.resultHash === "string" &&
        SHA256.test(row.resultHash) && canonicalJsonHash(acceptedResult) === row.resultHash &&
        row.resultAcceptedAt !== null);
  if (!answerOperationSnapshotValid) repositoryError("stored_manifest_invalid");
  const activeLease = row.leaseToken !== null && SAFE_IDENTITY.test(row.leaseToken) &&
    row.leaseExpiresAt !== null;
  const clearedLease = row.leaseToken === null && row.leaseExpiresAt === null;
  const lifecycleValid = row.state === "reserved"
    ? activeLease && row.dispatchedAt === null && row.settledAt === null &&
      row.releasedAt === null && row.ambiguousAt === null && actualUsage === null &&
      row.providerResponseId === null && row.failureCode === null &&
      row.leaseExpiresAt! > row.createdAt
    : row.state === "dispatched"
      ? activeLease && row.dispatchedAt !== null && row.settledAt === null &&
        row.dispatchedAt >= row.createdAt && row.releasedAt === null &&
        row.ambiguousAt === null && actualUsage === null && row.failureCode === null &&
        row.leaseExpiresAt! > row.dispatchedAt
      : row.state === "settled"
        ? clearedLease && row.dispatchedAt !== null && row.settledAt !== null &&
          row.dispatchedAt >= row.createdAt && row.settledAt >= row.dispatchedAt &&
          row.releasedAt === null && row.ambiguousAt === null && actualUsage !== null &&
          row.failureCode === null
        : row.state === "released"
          ? clearedLease && row.dispatchedAt === null && row.settledAt === null &&
            row.releasedAt !== null && row.releasedAt >= row.createdAt &&
            row.ambiguousAt === null && actualUsage === null &&
            row.providerResponseId === null && row.failureCode !== null &&
            SAFE_REASON.test(row.failureCode)
          : row.state === "ambiguous" && clearedLease && row.dispatchedAt !== null &&
            row.dispatchedAt >= row.createdAt && row.settledAt === null &&
            row.releasedAt === null && row.ambiguousAt !== null &&
            row.ambiguousAt >= row.dispatchedAt && actualUsage === null &&
            row.failureCode !== null && SAFE_REASON.test(row.failureCode);
  const answerOperationStateValid = expectedContractVersion === null || row.state === "settled"
    ? expectedContractVersion === null || acceptedResult !== null && row.resultAcceptedAt !== null &&
      row.dispatchedAt !== null && row.settledAt !== null &&
      row.resultAcceptedAt >= row.dispatchedAt && row.resultAcceptedAt <= row.settledAt
    : acceptedResult === null && row.resultAcceptedAt === null && row.resultHash === null;
  if (!lifecycleValid || !answerOperationStateValid) {
    repositoryError("stored_manifest_invalid");
  }
  return deepFreeze({
    acceptedRequest,
    acceptedResult,
    actualUsage,
    ambiguousAt: row.ambiguousAt,
    checkpointHash: row.checkpointHash,
    contractVersion: row.contractVersion,
    dispatchedAt: row.dispatchedAt,
    evidenceReceiptHash: row.evidenceReceiptHash,
    estimatedUsage,
    failureCode: row.failureCode,
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    leaseExpiresAt: row.leaseExpiresAt,
    leaseToken: row.leaseToken,
    modelRunId: row.modelRunId,
    ordinal: row.ordinal,
    providerBindingKey: row.providerBindingKey,
    providerResponseId: row.providerResponseId,
    purpose: row.purpose,
    releasedAt: row.releasedAt,
    requestHash: row.requestHash,
    resultAcceptedAt: row.resultAcceptedAt,
    resultHash: row.resultHash,
    roundIndex: row.roundIndex,
    settledAt: row.settledAt,
    state: row.state
  });
}

function storedDispatch(row: AttemptRow): StoredKnowledgeEvidenceDispatch {
  const manifest = row.manifest;
  if (!manifest) repositoryError("stored_manifest_invalid");
  if (manifest.purgedAt !== null) repositoryError("manifest_purged");
  if (manifest.messageText === null || manifest.messageHash === null || manifest.coverage === null) {
    repositoryError("stored_manifest_invalid");
  }
  const metadata = decodeStoredDispatchMetadata(manifest.coverage);
  if (!metadata || metadata.items.length !== manifest.items.length ||
    metadata.exclusions.length !== manifest.exclusions.length ||
    manifest.itemCount !== manifest.items.length ||
    manifest.excludedCount !== manifest.exclusions.length) {
    repositoryError("stored_manifest_invalid");
  }

  const itemBindings: StoredKnowledgeEvidenceDispatch["items"][number][] = [];
  const items = manifest.items.map((item, index) => {
    const provenance = metadata.items[index];
    const safeMetadata = decodeSafeMetadata(item.safeMetadata);
    const boundaries = decodeContextBoundaries(item.contextBoundaries);
    const representation = item.representation === "full"
      ? "full" as const
      : item.representation === "shortened"
        ? KNOWLEDGE_EVIDENCE_SHORTENING_VERSION
        : null;
    if (!provenance || !safeMetadata || !boundaries || !representation ||
      item.ordinal !== provenance.dispatchOrdinal || item.ordinal !== index + 1 ||
      item.evidenceItemId === null || item.handle === null || item.sourceAlias === null ||
      item.sourceVersionId === null || item.sourceArtifactId === null ||
      item.exactExcerpt === null || item.renderedBlock === null || item.excerptHash === null ||
      item.renderedBlockHash === null) repositoryError("stored_manifest_invalid");
    const summary = "kind" in safeMetadata ? safeMetadata.summary : null;
    const summarySupportBindings = "kind" in boundaries
      ? boundaries.supportBindings
      : [];
    if (Boolean(summary) !== (summarySupportBindings.length > 0)) {
      repositoryError("stored_manifest_invalid");
    }
    if (summary) {
      const firstSupport = summary.supportBindings[0];
      const firstResolvedSupport = summarySupportBindings[0];
      if (!firstSupport || !firstResolvedSupport || representation !== "full" ||
        provenance.evidenceId !== summary.evidenceId || item.handle !== firstSupport.handle ||
        item.evidenceItemId !== firstResolvedSupport.evidenceItemId ||
        item.sourceAlias !== summary.sourceAlias ||
        item.sourceVersionId !== firstSupport.sourceVersionId ||
        item.sourceArtifactId !== firstSupport.sourceArtifactId ||
        item.exactExcerpt !== summary.providerText || item.renderedBlock !== summary.providerText ||
        item.excerptBytes !== summary.providerTextBytes ||
        item.renderedBytes !== summary.providerTextBytes ||
        item.excerptHash !== summary.itemHash || item.renderedBlockHash !== summary.itemHash ||
        summarySupportBindings.length !== summary.supportBindings.length ||
        summary.supportBindings.some((support, supportIndex) => {
          const resolved = summarySupportBindings[supportIndex];
          return !resolved || support.contentHash !== resolved.contentHash ||
            support.excerptHash !== resolved.excerptHash || support.handle !== resolved.handle ||
            support.passageId !== resolved.passageId ||
            support.passageOrdinal !== resolved.passageOrdinal ||
            support.sectionHash !== resolved.sectionHash ||
            support.sourceArtifactId !== resolved.sourceArtifactId ||
            support.sourceId !== resolved.sourceId ||
            support.sourceVersionId !== resolved.sourceVersionId ||
            support.version !== resolved.version;
        })) repositoryError("stored_manifest_invalid");
    }
    itemBindings.push({
      dispatchEvidenceId: provenance.evidenceId,
      evidenceItemId: item.evidenceItemId,
      handle: item.handle,
      sourceArtifactId: item.sourceArtifactId,
      sourceVersionId: item.sourceVersionId,
      ...(summary ? { summary, summarySupportBindings } : {})
    });
    return {
      ambiguity: safeMetadata.ambiguity,
      dispatchOrdinal: provenance.dispatchOrdinal,
      evidenceId: provenance.evidenceId,
      exactExcerpt: item.exactExcerpt,
      exactExcerptBytes: item.excerptBytes,
      exactExcerptHash: item.excerptHash,
      expandedContext: boundaries.expandedContext,
      expandedContextOriginalBytes: boundaries.expandedContextOriginalBytes,
      expandedContextOriginalHash: boundaries.expandedContextOriginalHash,
      expandedContextState: boundaries.expandedContextState,
      fileName: safeMetadata.fileName,
      handle: item.handle,
      itemBytes: item.renderedBytes,
      itemHash: item.renderedBlockHash,
      itemTokens: item.renderedTokens,
      locator: safeMetadata.locator,
      operationOrdinal: provenance.operationOrdinal,
      representation,
      resultOrdinal: provenance.resultOrdinal,
      sourceAlias: item.sourceAlias,
      sourceLabel: safeMetadata.sourceLabel,
      sourceTruncated: safeMetadata.sourceTruncated,
      sourceVersionNumber: safeMetadata.sourceVersionNumber,
      text: item.renderedBlock,
      ...(summary ? { kind: "source_summary" as const, summary } : {})
    };
  });

  const exclusionBindings: StoredKnowledgeEvidenceDispatch["exclusions"][number][] = [];
  const exclusions = manifest.exclusions.map((exclusion, index) => {
    const provenance = metadata.exclusions[index];
    const reason = exclusion.reason === "deduped"
      ? "deduplicated" as const
      : exclusion.reason === "budget" || exclusion.reason === "unavailable"
        ? exclusion.reason
        : null;
    const unboundUnavailable = reason === "unavailable" && exclusion.evidenceItemId === null &&
      exclusion.handle === null;
    const bound = exclusion.evidenceItemId !== null && exclusion.handle !== null &&
      isCurrentKnowledgeHandle(exclusion.handle);
    if (!provenance || !reason || exclusion.ordinal !== index + 1 ||
      !unboundUnavailable && !bound || reason !== "unavailable" && !bound) {
      repositoryError("stored_manifest_invalid");
    }
    exclusionBindings.push({
      dispatchEvidenceId: provenance.evidenceId,
      evidenceItemId: exclusion.evidenceItemId,
      handle: exclusion.handle,
      reason
    });
    return {
      duplicateOfEvidenceId: provenance.duplicateOfEvidenceId,
      evidenceId: provenance.evidenceId,
      handle: exclusion.handle,
      operationOrdinal: provenance.operationOrdinal,
      reason,
      resultOrdinal: provenance.resultOrdinal
    };
  });

  const promptFragmentVersion = Number(manifest.promptFragmentVersion);
  if (!/^[1-9]\d*$/u.test(manifest.promptFragmentVersion) ||
    String(promptFragmentVersion) !== manifest.promptFragmentVersion ||
    manifest.profileRevisionIds.some((value) => !safeString(value)) ||
    new Set(manifest.profileRevisionIds).size !== manifest.profileRevisionIds.length ||
    manifest.profileRevisionIds.some((value, index) =>
      index > 0 && manifest.profileRevisionIds[index - 1]! >= value)) {
    repositoryError("stored_manifest_invalid");
  }
  const draft = decodeKnowledgeEvidenceDispatchManifestDraft({
    coverageStatement: metadata.root.coverageStatement,
    exclusions,
    footer: metadata.root.footer,
    header: metadata.root.header,
    items,
    limits: metadata.root.limits,
    manifestHash: metadata.root.manifestHash,
    message: manifest.messageText,
    messageBytes: manifest.totalBytes,
    messageHash: manifest.messageHash,
    messageTokens: manifest.totalTokens,
    packingVersion: manifest.packingVersion,
    ...( "runtimeVersion" in metadata.root
      ? { runtimeVersion: metadata.root.runtimeVersion }
      : { plannerVersion: metadata.root.plannerVersion }),
    profileId: metadata.root.profileId,
    promptFragmentVersion,
    shorteningPolicy: metadata.root.shorteningPolicy,
    version: manifest.version
  });
  if (!draft || manifest.version !== draft.version ||
    manifest.version !== KNOWLEDGE_EVIDENCE_DISPATCH_MANIFEST_VERSION &&
      manifest.version !== LEGACY_KNOWLEDGE_EVIDENCE_DISPATCH_MANIFEST_VERSION ||
    !isKnowledgeEvidencePackingVersion(manifest.packingVersion) ||
    manifest.shortenedCount !== items.filter((item) => item.representation !== "full").length) {
    repositoryError("stored_manifest_invalid");
  }
  const attempt = decodeAttempt(row);
  if (answerOperationContractVersion(attempt.purpose) !== null &&
    attempt.evidenceReceiptHash !== draft.manifestHash) {
    repositoryError("stored_manifest_invalid");
  }
  return deepFreeze({
    attempt,
    draft,
    exclusions: exclusionBindings,
    manifestId: manifest.id,
    items: itemBindings,
    profileRevisionIds: [...manifest.profileRevisionIds],
    retrievalSessionId: manifest.retrievalSessionId
  });
}

/**
 * Selects the final answer-producing dispatch boundary for grounding.
 *
 * Historical Evidence receipts predate durable provider attempts and remain
 * readable while their Knowledge operations have no current receipt version.
 * A current v2 operation, however, must have a final settled provider attempt
 * with a byte-exact, decodable manifest; absence or partial lifecycle state is
 * never interpreted as permission to ground against the complete receipt.
 */
export async function loadFinalKnowledgeGroundingDispatch(
  client: Pick<
    Prisma.TransactionClient,
    "knowledgeProviderAttempt" | "knowledgeRun"
  >,
  input: Readonly<{
    modelRunId: string;
    retrievalSessionId: string;
  }>
): Promise<KnowledgeGroundingDispatchSelection> {
  if (!safeString(input.modelRunId) || !safeString(input.retrievalSessionId)) {
    repositoryError("invalid_input");
  }
  const attempts = await client.knowledgeProviderAttempt.findMany({
    include: attemptInclude,
    orderBy: { ordinal: "desc" },
    take: 1,
    where: { modelRunId: input.modelRunId }
  });
  const latest = attempts[0];
  if (!latest) {
    const currentOperation = await client.knowledgeRun.findFirst({
      select: { id: true },
      where: {
        modelRunId: input.modelRunId,
        receiptVersion: 2,
        retrievalSessionId: input.retrievalSessionId
      }
    });
    if (currentOperation) repositoryError("stored_manifest_invalid");
    return deepFreeze({ kind: "legacy" });
  }

  const dispatch = storedDispatch(latest);
  if (dispatch.retrievalSessionId !== input.retrievalSessionId ||
    dispatch.attempt.state !== "settled" || dispatch.attempt.actualUsage === null ||
    dispatch.attempt.dispatchedAt === null || dispatch.attempt.settledAt === null ||
    dispatch.attempt.settledAt < dispatch.attempt.dispatchedAt ||
    dispatch.attempt.releasedAt !== null || dispatch.attempt.ambiguousAt !== null ||
    dispatch.attempt.failureCode !== null || dispatch.attempt.leaseExpiresAt !== null) {
    repositoryError("stored_manifest_invalid");
  }
  return deepFreeze({ dispatch, kind: "current" });
}

/** Loads one settled version-paired answer protocol over byte-identical
 * evidence. Adaptive pairs may add a supplement and final Selector. V15/V11
 * may instead use the final Selector slot as ordinal-three validation repair,
 * without a supplemental Draft. */
export async function loadSettledKnowledgeAnswerGroundingOperations(
  client: Pick<Prisma.TransactionClient, "knowledgeProviderAttempt">,
  input: Readonly<{ contractPair: KnowledgeAnswerContractPair; modelRunId: string }>
): Promise<StoredKnowledgeAnswerGroundingOperations> {
  if (!safeString(input.modelRunId)) repositoryError("invalid_input");
  const expectedPurposes: KnowledgeProviderAttemptPurpose[] = [
    ...(input.contractPair.coveragePlannerOperation
      ? [input.contractPair.coveragePlannerOperation]
      : []),
    input.contractPair.draftOperation,
    input.contractPair.selectorOperation
  ];
  if (input.contractPair.supplementalDraftOperation) {
    expectedPurposes.push(input.contractPair.supplementalDraftOperation);
  }
  if (input.contractPair.finalSelectorOperation) {
    expectedPurposes.push(input.contractPair.finalSelectorOperation);
  }
  const rows = await client.knowledgeProviderAttempt.findMany({
    include: attemptInclude,
    orderBy: { ordinal: "asc" },
    where: {
      modelRunId: input.modelRunId,
      purpose: {
        in: expectedPurposes
      }
    }
  });
  const minimumOperations = input.contractPair.coveragePlannerOperation ? 3 : 2;
  if (rows.length < minimumOperations || rows.length > expectedPurposes.length) {
    repositoryError("stored_manifest_invalid");
  }
  const dispatches = rows.map(storedDispatch);
  const purposeSequence = dispatches.map((dispatch) => dispatch.attempt.purpose);
  const basePurposeSequence: KnowledgeProviderAttemptPurpose[] = [
    ...(input.contractPair.coveragePlannerOperation
      ? [input.contractPair.coveragePlannerOperation]
      : []),
    input.contractPair.draftOperation,
    input.contractPair.selectorOperation
  ];
  const allowedPurposeSequences: KnowledgeProviderAttemptPurpose[][] = [basePurposeSequence];
  if (input.contractPair.supplementalDraftOperation) {
    allowedPurposeSequences.push([
      ...basePurposeSequence,
      input.contractPair.supplementalDraftOperation
    ]);
    if (input.contractPair.finalSelectorOperation) {
      allowedPurposeSequences.push([
        ...basePurposeSequence,
        input.contractPair.supplementalDraftOperation,
        input.contractPair.finalSelectorOperation
      ]);
    }
  }
  if ((input.contractPair.draftContractVersion === 20 &&
    input.contractPair.selectorContractVersion === 16 ||
    input.contractPair.draftContractVersion === 19 &&
    input.contractPair.selectorContractVersion === 15 ||
    input.contractPair.draftContractVersion === 18 &&
    input.contractPair.selectorContractVersion === 14 ||
    input.contractPair.draftContractVersion === 17 &&
    input.contractPair.selectorContractVersion === 13 ||
    input.contractPair.draftContractVersion === 16 &&
    input.contractPair.selectorContractVersion === 12 ||
    input.contractPair.draftContractVersion === 15 &&
    input.contractPair.selectorContractVersion === 11) &&
    input.contractPair.finalSelectorOperation) {
    allowedPurposeSequences.push([
      ...basePurposeSequence,
      input.contractPair.finalSelectorOperation
    ]);
  }
  if (!allowedPurposeSequences.some((sequence) =>
    canonicalJson(sequence) === canonicalJson(purposeSequence))) {
    repositoryError("stored_manifest_invalid");
  }
  const requests = dispatches.map((dispatch) =>
    decodeKnowledgeAnswerOperationRequestSnapshotV1(dispatch.attempt.acceptedRequest));
  const terminal = (dispatch: StoredKnowledgeEvidenceDispatch) =>
    dispatch.attempt.state === "settled" && dispatch.attempt.actualUsage !== null &&
    dispatch.attempt.acceptedResult !== null && dispatch.attempt.dispatchedAt !== null &&
    dispatch.attempt.settledAt !== null && dispatch.attempt.resultAcceptedAt !== null;
  const canonicalManifest = canonicalJson(dispatches[0]!.draft);
  if (dispatches.some((dispatch, index) =>
    dispatch.attempt.ordinal !== index + 1 ||
    dispatch.attempt.providerBindingKey !== "answer" ||
    !terminal(dispatch) || !requests[index] ||
    requests[index]!.operation !== purposeSequence[index] ||
    requests[index]!.evidenceReceiptHash !== dispatch.draft.manifestHash ||
    canonicalJson(dispatch.draft) !== canonicalManifest)) {
    repositoryError("stored_manifest_invalid");
  }
  const coveragePlanner = input.contractPair.coveragePlannerOperation
    ? dispatches[0]!
    : null;
  const draftIndex = coveragePlanner ? 1 : 0;
  const draft = dispatches[draftIndex]!;
  const initialSelector = dispatches[draftIndex + 1]!;
  const supplementalDraft = dispatches.find((dispatch) =>
    dispatch.attempt.purpose === input.contractPair.supplementalDraftOperation) ?? null;
  const finalSelector = dispatches.find((dispatch) =>
    dispatch.attempt.purpose === input.contractPair.finalSelectorOperation) ?? null;
  return deepFreeze({
    coveragePlanner,
    draft,
    finalSelector,
    initialSelector,
    selector: finalSelector ?? initialSelector,
    supplementalDraft
  });
}

/** Loads the exact current V21 sparse unit-map scope protocol. Scope and initial
 * Selector may each occur twice only as their single adjacent structural
 * repair. Every later operation pins the final accepted Scope result hash. */
export async function loadSettledKnowledgeAnswerGroundingOperationsV21(
  client: Pick<Prisma.TransactionClient, "knowledgeProviderAttempt">,
  input: Readonly<{ modelRunId: string }>
): Promise<StoredKnowledgeAnswerGroundingOperationsV21> {
  if (!safeString(input.modelRunId)) repositoryError("invalid_input");
  const rows = await client.knowledgeProviderAttempt.findMany({
    include: attemptInclude,
    orderBy: { ordinal: "asc" },
    where: { modelRunId: input.modelRunId }
  });
  const operationRows = rows.filter((row) => validPurpose(row.purpose) &&
    answerOperationContractVersion(row.purpose) !== null);
  const dispatches = operationRows.map(storedDispatch);
  const purposeSequence = dispatches.map(({ attempt }) => attempt.purpose);
  const draft = KNOWLEDGE_ANSWER_DRAFT_OPERATION_V21;
  const scope = KNOWLEDGE_COVERAGE_SCOPE_V5_OPERATION;
  const selector = KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V20;
  const supplement = KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V21;
  const finalSelector = KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V20;
  const allowedSequences: KnowledgeAnswerOperationV21[][] = [];
  for (const scopeCount of [1, 2] as const) {
    for (const selectorCount of [1, 2] as const) {
      const base: KnowledgeAnswerOperationV21[] = [
        draft,
        ...Array.from({ length: scopeCount }, () => scope),
        ...Array.from({ length: selectorCount }, () => selector)
      ];
      allowedSequences.push(base);
      if (base.length + 2 <= 6) {
        allowedSequences.push(
          [...base, supplement],
          [...base, supplement, finalSelector]
        );
      }
    }
  }
  if (!allowedSequences.some((sequence) =>
    canonicalJson(sequence) === canonicalJson(purposeSequence))) {
    repositoryError("stored_manifest_invalid");
  }
  const requests = dispatches.map((dispatch) =>
    decodeKnowledgeAnswerOperationRequestSnapshotV21(
      dispatch.attempt.acceptedRequest
    ));
  const terminal = (dispatch: StoredKnowledgeEvidenceDispatch) =>
    dispatch.attempt.state === "settled" && dispatch.attempt.actualUsage !== null &&
    dispatch.attempt.acceptedResult !== null && dispatch.attempt.dispatchedAt !== null &&
    dispatch.attempt.settledAt !== null && dispatch.attempt.resultAcceptedAt !== null &&
    dispatch.attempt.resultHash !== null;
  const canonicalManifest = canonicalJson(dispatches[0]!.draft);
  if (dispatches.some((dispatch, index) =>
    dispatch.attempt.ordinal !== index + 1 ||
    dispatch.attempt.providerBindingKey !== "answer" || !terminal(dispatch) ||
    !requests[index] || !isCurrentKnowledgeAnswerOperationSnapshotV21(requests[index]!) ||
    requests[index]!.operation !== purposeSequence[index] ||
    requests[index]!.evidenceReceiptHash !== dispatch.draft.manifestHash ||
    canonicalJson(dispatch.draft) !== canonicalManifest)) {
    repositoryError("stored_manifest_invalid");
  }
  const scopeIndexes = purposeSequence.flatMap((purpose, index) =>
    purpose === scope ? [index] : []);
  const initialScopeIndex = scopeIndexes[0];
  const scopeRepairIndex = scopeIndexes[1] ?? null;
  const initialScopeDispatch = initialScopeIndex === undefined
    ? undefined
    : dispatches[initialScopeIndex];
  const scopeRepairDispatch = scopeRepairIndex === null
    ? null
    : dispatches[scopeRepairIndex] ?? null;
  if (!initialScopeDispatch || initialScopeIndex !== 1 ||
    scopeIndexes.length < 1 || scopeIndexes.length > 2 ||
    scopeRepairIndex !== null && scopeRepairIndex !== initialScopeIndex + 1) {
    repositoryError("stored_manifest_invalid");
  }
  const scopeDispatch = scopeRepairDispatch ?? initialScopeDispatch;
  const coverageScopePayloadHash = scopeDispatch.attempt.resultHash;
  const finalScopeIndex = scopeRepairIndex ?? initialScopeIndex;
  if (!coverageScopePayloadHash || dispatches.some((_dispatch, index) => {
    const request = requests[index]!;
    if (!isCurrentKnowledgeAnswerOperationSnapshotV21(request)) return true;
    const consumesScope = index > finalScopeIndex;
    return consumesScope
      ? request.coverageScopePayloadHash !== coverageScopePayloadHash
      : request.coverageScopePayloadHash !== null;
  })) repositoryError("stored_manifest_invalid");
  const selectorDispatches = dispatches.filter(({ attempt }) =>
    attempt.purpose === selector);
  const supplementDispatch = dispatches.find(({ attempt }) =>
    attempt.purpose === supplement) ?? null;
  const finalSelectorDispatch = dispatches.find(({ attempt }) =>
    attempt.purpose === finalSelector) ?? null;
  return deepFreeze({
    draft: dispatches[0]!,
    finalSelector: finalSelectorDispatch,
    initialScope: initialScopeDispatch,
    initialSelector: selectorDispatches[0]!,
    scope: scopeDispatch,
    scopeRepair: scopeRepairDispatch,
    selectorRepair: selectorDispatches[1] ?? null,
    supplementalDraft: supplementDispatch
  });
}

function assertAttemptIdentity(row: AttemptRow, input: AttemptIdentity): void {
  if (row.id !== input.attemptId || row.modelRunId !== input.modelRunId ||
    row.providerBindingKey !== input.providerBindingKey ||
    row.idempotencyKey !== input.idempotencyKey || row.checkpointHash !== input.checkpointHash ||
    row.requestHash !== input.requestHash) repositoryError("idempotency_conflict");
  const stored = storedDispatch(row);
  if (stored.draft.manifestHash !== input.manifestHash) repositoryError("draft_conflict");
}

function sameUsage(left: unknown, right: KnowledgeProviderAttemptUsage): boolean {
  const decoded = decodeKnowledgeProviderAttemptUsage(left);
  return decoded !== null && canonicalJson(decoded) === canonicalJson(right);
}

function serializationConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && (
    error.code === "P2034" || error.code === "P2002" ||
    error.code === "P2010" && record(error.meta) && error.meta.code === "40001"
  );
}

function recoveryClaimRace(error: unknown): boolean {
  return error instanceof KnowledgeProviderAttemptRecoveryClaimRaceError;
}

async function serializable<T>(
  client: PrismaClient,
  operation: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  for (let attempt = 0; attempt < SERIALIZABLE_ATTEMPTS; attempt += 1) {
    try {
      return await client.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable
      });
    } catch (error) {
      if (attempt < SERIALIZABLE_ATTEMPTS - 1 &&
        (serializationConflict(error) || recoveryClaimRace(error))) continue;
      if (serializationConflict(error)) repositoryError("idempotency_conflict");
      throw error;
    }
  }
  return repositoryError("idempotency_conflict");
}

function storedMetadata(draft: KnowledgeEvidenceDispatchManifestDraft): StoredDispatchMetadata {
  return {
    exclusions: draft.exclusions.map((exclusion) => ({
      duplicateOfEvidenceId: exclusion.duplicateOfEvidenceId,
      evidenceId: exclusion.evidenceId,
      operationOrdinal: exclusion.operationOrdinal,
      resultOrdinal: exclusion.resultOrdinal
    })),
    items: draft.items.map((item) => ({
      dispatchOrdinal: item.dispatchOrdinal,
      evidenceId: item.evidenceId,
      operationOrdinal: item.operationOrdinal,
      resultOrdinal: item.resultOrdinal
    })),
    root: {
      coverageStatement: draft.coverageStatement,
      footer: draft.footer,
      header: draft.header,
      limits: draft.limits,
      manifestHash: draft.manifestHash,
      ...(draft.version === KNOWLEDGE_EVIDENCE_DISPATCH_MANIFEST_VERSION
        ? { runtimeVersion: draft.runtimeVersion }
        : { plannerVersion: draft.plannerVersion }),
      profileId: draft.profileId,
      shorteningPolicy: draft.shorteningPolicy
    },
    version: STORED_DISPATCH_METADATA_VERSION
  };
}

function inputBindingMap(
  draft: KnowledgeEvidenceDispatchManifestDraft,
  bindings: readonly KnowledgeEvidenceDispatchBinding[]
): ReadonlyMap<string, string> {
  const expectedIds = [
    ...draft.items.map(({ evidenceId }) => evidenceId),
    ...draft.exclusions.flatMap((exclusion) =>
      exclusion.reason === "unavailable" && exclusion.handle === null
        ? []
        : [exclusion.evidenceId])
  ];
  if (new Set(expectedIds).size !== expectedIds.length || bindings.length !== expectedIds.length) {
    repositoryError("evidence_mismatch");
  }
  const mapped = new Map<string, string>();
  for (const binding of bindings) {
    if (!safeString(binding.dispatchEvidenceId, 1_024) ||
      !safeString(binding.evidenceItemId) || mapped.has(binding.dispatchEvidenceId)) {
      repositoryError("evidence_mismatch");
    }
    mapped.set(binding.dispatchEvidenceId, binding.evidenceItemId);
  }
  if (expectedIds.some((id) => !mapped.has(id))) repositoryError("evidence_mismatch");
  return mapped;
}

type DispatchEvidenceReference = Readonly<{
  evidenceId: string;
  operationOrdinal: number;
  providerCallId: string;
  requiresBinding: boolean;
  resultOrdinal: number;
}>;

function dispatchEvidenceReferences(
  draft: KnowledgeEvidenceDispatchManifestDraft
): DispatchEvidenceReference[] {
  const candidates = [
    ...draft.items.map((item) => ({ ...item, requiresBinding: true })),
    ...draft.exclusions.map((exclusion) => ({
      ...exclusion,
      requiresBinding: exclusion.reason !== "unavailable" || exclusion.handle !== null
    }))
  ];
  return candidates.map((entry) => {
    const match = /^(.*):result:([1-9]\d*)$/u.exec(entry.evidenceId);
    const providerCallId = match?.[1];
    const encodedResultOrdinal = Number(match?.[2]);
    if (!providerCallId || !safeString(providerCallId, 256) ||
      !integer(encodedResultOrdinal, 1, 4_096) || encodedResultOrdinal !== entry.resultOrdinal) {
      repositoryError("evidence_mismatch");
    }
    return {
      evidenceId: entry.evidenceId,
      operationOrdinal: entry.operationOrdinal,
      providerCallId,
      requiresBinding: entry.requiresBinding,
      resultOrdinal: encodedResultOrdinal
    };
  });
}

async function resolveRetrievalSessionId(
  tx: Prisma.TransactionClient,
  input: Pick<ReserveKnowledgeEvidenceDispatchInput, "modelRunId" | "retrievalSessionId">
): Promise<string> {
  const session = input.retrievalSessionId
    ? await tx.knowledgeRetrievalSession.findFirst({
        select: { id: true },
        where: { id: input.retrievalSessionId, modelRunId: input.modelRunId }
      })
    : await tx.knowledgeRetrievalSession.findUnique({
        select: { id: true },
        where: { modelRunId: input.modelRunId }
      });
  if (!session) repositoryError("binding_unavailable");
  return session.id;
}

async function resolveEvidenceBindings(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    draft: KnowledgeEvidenceDispatchManifestDraft;
    modelRunId: string;
    retrievalSessionId: string;
  }>
): Promise<KnowledgeEvidenceDispatchBinding[]> {
  const references = dispatchEvidenceReferences(input.draft);
  if (references.length === 0) return [];
  const providerCallIds = [...new Set(references.map(({ providerCallId }) => providerCallId))];
  const toolCalls = await tx.modelRunToolCall.findMany({
    select: { id: true, providerCallId: true },
    where: { modelRunId: input.modelRunId, providerCallId: { in: providerCallIds } }
  });
  if (toolCalls.length !== providerCallIds.length ||
    new Set(toolCalls.map(({ providerCallId }) => providerCallId)).size !== toolCalls.length) {
    repositoryError("evidence_mismatch");
  }
  const toolCallByProviderId = new Map(toolCalls.map((call) => [call.providerCallId, call.id]));
  const required = references.filter(({ requiresBinding }) => requiresBinding);
  if (required.length === 0) return [];
  const requiredToolCallIds = [...new Set(required.flatMap(({ providerCallId }) => {
    const toolCallId = toolCallByProviderId.get(providerCallId);
    return toolCallId ? [toolCallId] : [];
  }))];
  const knowledgeRuns = await tx.knowledgeRun.findMany({
    select: {
      evidenceLinks: { select: { evidenceItemId: true, resultOrdinal: true } },
      invocationOrdinal: true,
      modelRunToolCallId: true
    },
    where: {
      modelRunId: input.modelRunId,
      modelRunToolCallId: { in: requiredToolCallIds },
      retrievalSessionId: input.retrievalSessionId
    }
  });
  if (knowledgeRuns.length !== requiredToolCallIds.length ||
    new Set(knowledgeRuns.map(({ modelRunToolCallId }) => modelRunToolCallId)).size !==
      knowledgeRuns.length) repositoryError("evidence_mismatch");
  const runByToolCallId = new Map(knowledgeRuns.map((run) => [run.modelRunToolCallId, run]));
  return required.map((reference) => {
    const toolCallId = toolCallByProviderId.get(reference.providerCallId);
    const run = toolCallId ? runByToolCallId.get(toolCallId) : undefined;
    // Provider-visible dispatch references are one-based (`:result:1`), while
    // KnowledgeRunEvidence.resultOrdinal is the durable zero-based result index.
    const persistedResultOrdinal = reference.resultOrdinal - 1;
    const link = run?.evidenceLinks.find(({ resultOrdinal }) =>
      resultOrdinal === persistedResultOrdinal);
    if (!run || run.invocationOrdinal !== reference.operationOrdinal || !link) {
      repositoryError("evidence_mismatch");
    }
    return {
      dispatchEvidenceId: reference.evidenceId,
      evidenceItemId: link.evidenceItemId
    };
  });
}

async function materializeManifestRows(
  tx: Prisma.TransactionClient,
  input: ReserveKnowledgeEvidenceDispatchInput,
  draft: KnowledgeEvidenceDispatchManifestDraft,
  evidenceBindings: readonly KnowledgeEvidenceDispatchBinding[],
  retrievalSessionId: string
): Promise<Readonly<{
  exclusions: Prisma.KnowledgeEvidenceDispatchManifestExclusionCreateWithoutManifestInput[];
  items: Prisma.KnowledgeEvidenceDispatchManifestItemCreateWithoutManifestInput[];
  profileRevisionIds: string[];
}>> {
  const providerBinding = await tx.providerRunBinding.findUnique({
    select: { id: true },
    where: {
      modelRunId_bindingKey: {
        bindingKey: input.providerBindingKey,
        modelRunId: input.modelRunId
      }
    }
  });
  if (!providerBinding) repositoryError("binding_unavailable");

  const bindingMap = inputBindingMap(draft, evidenceBindings);
  const evidenceItemIds = [...new Set(bindingMap.values())];
  const summarySupportHandles = [...new Set(draft.items.flatMap((item) =>
    "kind" in item ? item.summary.supportBindings.map(({ handle }) => handle) : []))];
  const evidenceItems = evidenceItemIds.length === 0 && summarySupportHandles.length === 0
    ? []
    : await tx.knowledgeEvidenceItem.findMany({
        select: {
          contentHash: true,
          excerpt: true,
          fileName: true,
          handle: true,
          headingPath: true,
          id: true,
          passageId: true,
          retrievalSessionId: true,
          sectionId: true,
          sourceArtifactId: true,
          sourceId: true,
          sourceName: true,
          sourceVersionId: true,
          sourceVersionNumber: true,
          state: true,
          textTruncated: true
        },
        where: summarySupportHandles.length === 0
          ? { id: { in: evidenceItemIds }, retrievalSessionId }
          : {
              OR: [
                { id: { in: evidenceItemIds } },
                { handle: { in: summarySupportHandles } }
              ],
              retrievalSessionId
            }
      });
  if (evidenceItemIds.some((id) => !evidenceItems.some((item) => item.id === id)) ||
    summarySupportHandles.some((handle) =>
      evidenceItems.filter((item) => item.handle === handle).length !== 1)) {
    repositoryError("evidence_mismatch");
  }
  const evidenceById = new Map(evidenceItems.map((item) => [item.id, item]));
  const sourceBindings = await tx.knowledgeRunSourceBinding.findMany({
    select: {
      fileNameSnapshot: true,
      id: true,
      profileBinding: { select: { profileRevisionId: true } },
      sourceAlias: true,
      sourceArtifactId: true,
      sourceNameSnapshot: true,
      sourceVersionId: true,
      sourceVersionNumber: true
    },
    where: { modelRunId: input.modelRunId, tombstonedAt: null }
  });

  const persistedItems = draft.items.map((item) => {
    if ("kind" in item) repositoryError("invalid_input");
    const evidenceItemId = bindingMap.get(item.evidenceId);
    const evidence = evidenceItemId ? evidenceById.get(evidenceItemId) : undefined;
    const sourceBinding = evidence ? sourceBindings.find((binding) =>
      binding.sourceVersionId === evidence.sourceVersionId &&
      binding.sourceArtifactId === evidence.sourceArtifactId &&
      binding.sourceAlias === item.sourceAlias) : undefined;
    const sourceLabel = sourceBinding?.sourceNameSnapshot ?? evidence?.sourceName ?? "";
    const fileName = sourceBinding?.fileNameSnapshot ?? evidence?.fileName ?? "";
    const ordinaryExcerptMatches = evidence?.excerpt === item.exactExcerpt;
    if (!evidenceItemId || !evidence || evidence.state !== "available" || !sourceBinding ||
      !isCurrentKnowledgeHandle(item.handle) || !SOURCE_ALIAS.test(item.sourceAlias) ||
      evidence.handle !== item.handle || !ordinaryExcerptMatches ||
      evidence.sourceVersionId === null || evidence.sourceArtifactId === null ||
      evidence.sourceVersionNumber !== item.sourceVersionNumber ||
      sourceBinding.sourceVersionNumber !== item.sourceVersionNumber ||
      evidence.textTruncated !== item.sourceTruncated ||
      compactUserSafeMetadata(sourceLabel) !== item.sourceLabel ||
      compactUserSafeMetadata(fileName) !== item.fileName) repositoryError("evidence_mismatch");
    return {
      contextBoundaries: json({
        expandedContext: item.expandedContext,
        expandedContextOriginalBytes: item.expandedContextOriginalBytes,
        expandedContextOriginalHash: item.expandedContextOriginalHash,
        expandedContextState: item.expandedContextState
      }),
      evidenceItem: { connect: { id: evidenceItemId } },
      exactExcerpt: item.exactExcerpt,
      excerptBytes: item.exactExcerptBytes,
      excerptHash: item.exactExcerptHash,
      handle: item.handle,
      ordinal: item.dispatchOrdinal,
      renderedBlock: item.text,
      renderedBlockHash: item.itemHash,
      renderedBytes: item.itemBytes,
      renderedTokens: item.itemTokens,
      representation: item.representation === "full" ? "full" : "shortened",
      safeMetadata: json({
        ambiguity: item.ambiguity,
        fileName: item.fileName,
        locator: item.locator,
        sourceLabel: item.sourceLabel,
        sourceTruncated: item.sourceTruncated,
        sourceVersionNumber: item.sourceVersionNumber,
      }),
      sourceAlias: item.sourceAlias,
      sourceArtifactId: evidence.sourceArtifactId,
      sourceVersionId: evidence.sourceVersionId
    } satisfies Prisma.KnowledgeEvidenceDispatchManifestItemCreateWithoutManifestInput;
  });

  const persistedExclusions = draft.exclusions.map((exclusion, index) => {
    const evidenceItemId = bindingMap.get(exclusion.evidenceId);
    const evidence = evidenceItemId ? evidenceById.get(evidenceItemId) : undefined;
    const unboundUnavailable = exclusion.reason === "unavailable" &&
      exclusion.handle === null && evidenceItemId === undefined;
    const bound = evidenceItemId !== undefined && evidence !== undefined &&
      exclusion.handle !== null && isCurrentKnowledgeHandle(exclusion.handle) &&
      evidence.handle === exclusion.handle;
    if (!unboundUnavailable && !bound || exclusion.reason !== "unavailable" && !bound) {
      repositoryError("evidence_mismatch");
    }
    return {
      ...(evidenceItemId ? { evidenceItem: { connect: { id: evidenceItemId } } } : {}),
      handle: exclusion.handle,
      ordinal: index + 1,
      reason: exclusion.reason === "deduplicated" ? "deduped" : exclusion.reason
    } satisfies Prisma.KnowledgeEvidenceDispatchManifestExclusionCreateWithoutManifestInput;
  });
  if (new Set(persistedItems.map((item) => item.evidenceItem.connect?.id)).size !==
      persistedItems.length) {
    repositoryError("evidence_mismatch");
  }

  const profileRevisionIds = [...new Set(draft.items.flatMap((item) => {
    const evidenceItemId = bindingMap.get(item.evidenceId);
    const evidence = evidenceItemId ? evidenceById.get(evidenceItemId) : undefined;
    const binding = evidence ? sourceBindings.find((candidate) =>
      candidate.sourceVersionId === evidence.sourceVersionId &&
      candidate.sourceArtifactId === evidence.sourceArtifactId &&
      candidate.sourceAlias === item.sourceAlias) : undefined;
    return binding ? [binding.profileBinding.profileRevisionId] : [];
  }))].sort();
  return { exclusions: persistedExclusions, items: persistedItems, profileRevisionIds };
}

function assertReuse(
  row: AttemptRow,
  input: ReserveKnowledgeEvidenceDispatchInput,
  draft: KnowledgeEvidenceDispatchManifestDraft,
  usage: KnowledgeProviderAttemptUsage,
  evidenceBindings: readonly KnowledgeEvidenceDispatchBinding[],
  retrievalSessionId: string
): StoredKnowledgeEvidenceDispatch {
  if (row.modelRunId !== input.modelRunId || row.providerBindingKey !== input.providerBindingKey ||
    row.ordinal !== input.ordinal || row.roundIndex !== input.roundIndex ||
    row.purpose !== input.purpose || row.idempotencyKey !== input.idempotencyKey ||
    row.checkpointHash !== input.checkpointHash || row.requestHash !== input.requestHash ||
    row.contractVersion !== (input.contractVersion ?? null) ||
    row.evidenceReceiptHash !== (input.evidenceReceiptHash ?? null) ||
    canonicalJson(row.acceptedRequest) !== canonicalJson(input.acceptedRequest ?? null) ||
    !sameUsage(row.estimatedUsage, usage)) repositoryError("idempotency_conflict");
  const stored = storedDispatch(row);
  if (stored.retrievalSessionId !== retrievalSessionId ||
    canonicalJson(stored.draft) !== canonicalJson(draft)) repositoryError("draft_conflict");
  const expectedBindings = [...evidenceBindings]
    .sort((left, right) => left.dispatchEvidenceId < right.dispatchEvidenceId ? -1 :
      left.dispatchEvidenceId > right.dispatchEvidenceId ? 1 : 0);
  const storedBindings = [...stored.items, ...stored.exclusions]
    .flatMap(({ dispatchEvidenceId, evidenceItemId }) => evidenceItemId === null
      ? []
      : [{ dispatchEvidenceId, evidenceItemId }])
    .sort((left, right) => left.dispatchEvidenceId < right.dispatchEvidenceId ? -1 :
      left.dispatchEvidenceId > right.dispatchEvidenceId ? 1 : 0);
  if (canonicalJson(expectedBindings) !== canonicalJson(storedBindings)) {
    repositoryError("evidence_mismatch");
  }
  return stored;
}

async function findAttempt(
  tx: Prisma.TransactionClient,
  input: AttemptIdentity
): Promise<AttemptRow> {
  validateAttemptIdentity(input);
  const row = await tx.knowledgeProviderAttempt.findUnique({
    include: attemptInclude,
    where: {
      modelRunId_idempotencyKey: {
        idempotencyKey: input.idempotencyKey,
        modelRunId: input.modelRunId
      }
    }
  });
  if (!row) repositoryError("target_unavailable");
  assertAttemptIdentity(row, input);
  return row;
}

export function createPrismaKnowledgeEvidenceDispatchRepository(
  client: PrismaClient = prisma
) {
  return {
    async reserve(
      input: ReserveKnowledgeEvidenceDispatchInput
    ): Promise<Readonly<{
      dispatch: StoredKnowledgeEvidenceDispatch;
      kind: "created" | "reused";
    }>> {
      const validated = validateReserveInput(input);
      return serializable(client, async (tx) => {
        const retrievalSessionId = await resolveRetrievalSessionId(tx, input);
        const evidenceBindings = input.evidenceBindings ?? await resolveEvidenceBindings(tx, {
          draft: validated.draft,
          modelRunId: input.modelRunId,
          retrievalSessionId
        });
        const existing = await tx.knowledgeProviderAttempt.findUnique({
          include: attemptInclude,
          where: {
            modelRunId_idempotencyKey: {
              idempotencyKey: input.idempotencyKey,
              modelRunId: input.modelRunId
            }
          }
        });
        if (existing) {
          return {
            dispatch: assertReuse(
              existing,
              input,
              validated.draft,
              validated.estimatedUsage,
              evidenceBindings,
              retrievalSessionId
            ),
            kind: "reused"
          };
        }
        const rows = await materializeManifestRows(
          tx,
          input,
          validated.draft,
          evidenceBindings,
          retrievalSessionId
        );
        const created = await tx.knowledgeProviderAttempt.create({
          data: {
            ...(input.acceptedRequest
              ? { acceptedRequest: json(input.acceptedRequest) }
              : {}),
            checkpointHash: input.checkpointHash,
            ...(input.contractVersion !== undefined
              ? { contractVersion: input.contractVersion }
              : {}),
            ...(input.evidenceReceiptHash
              ? { evidenceReceiptHash: input.evidenceReceiptHash }
              : {}),
            estimatedUsage: json(validated.estimatedUsage),
            idempotencyKey: input.idempotencyKey,
            leaseExpiresAt: input.leaseExpiresAt,
            leaseToken: input.leaseToken,
            manifest: {
              create: {
                coverage: json(storedMetadata(validated.draft)),
                excludedCount: validated.draft.exclusions.length,
                exclusions: { create: rows.exclusions },
                itemCount: validated.draft.items.length,
                items: { create: rows.items },
                messageHash: validated.draft.messageHash,
                messageText: validated.draft.message,
                modelRun: { connect: { id: input.modelRunId } },
                packingVersion: validated.draft.packingVersion,
                profileRevisionIds: rows.profileRevisionIds,
                promptFragmentVersion: String(validated.draft.promptFragmentVersion),
                retrievalSession: { connect: { id: retrievalSessionId } },
                shortenedCount: validated.draft.items.filter(
                  ({ representation }) => representation !== "full"
                ).length,
                totalBytes: validated.draft.messageBytes,
                totalTokens: validated.draft.messageTokens,
                version: validated.draft.version
              }
            },
            modelRun: { connect: { id: input.modelRunId } },
            ordinal: input.ordinal,
            providerBinding: {
              connect: {
                modelRunId_bindingKey: {
                  bindingKey: input.providerBindingKey,
                  modelRunId: input.modelRunId
                }
              }
            },
            purpose: input.purpose,
            requestHash: input.requestHash,
            roundIndex: input.roundIndex
          },
          include: attemptInclude
        });
        const dispatch = storedDispatch(created);
        if (!created.leaseExpiresAt || created.leaseExpiresAt <= created.createdAt) {
          repositoryError("lease_expired");
        }
        if (canonicalJson(dispatch.draft) !== canonicalJson(validated.draft)) {
          repositoryError("stored_manifest_invalid");
        }
        return { dispatch, kind: "created" };
      });
    },

    async loadForReplay(input: AttemptIdentity): Promise<StoredKnowledgeEvidenceDispatch> {
      return client.$transaction(async (tx) => storedDispatch(await findAttempt(tx, input)), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
      });
    },

    async loadForRecovery(input: Readonly<{
      modelRunId: string;
      ordinal: number;
    }>): Promise<StoredKnowledgeEvidenceDispatch | null> {
      if (!safeString(input.modelRunId) || !integer(input.ordinal, 1, 256)) {
        repositoryError("invalid_input");
      }
      return client.$transaction(async (tx) => {
        const row = await tx.knowledgeProviderAttempt.findUnique({
          include: attemptInclude,
          where: {
            modelRunId_ordinal: {
              modelRunId: input.modelRunId,
              ordinal: input.ordinal
            }
          }
        });
        return row ? storedDispatch(row) : null;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    },

    async recover(
      input: RecoverKnowledgeProviderAttemptInput
    ): Promise<KnowledgeProviderAttemptRecovery> {
      const suppliedResponseId = input.providerResponseId ?? null;
      if (!safeString(input.modelRunId) || !integer(input.ordinal, 1, 256) ||
        !SAFE_IDENTITY.test(input.leaseToken) || !validDate(input.now) ||
        !validDate(input.leaseExpiresAt) || input.leaseExpiresAt <= input.now ||
        input.requestHash !== undefined && !SHA256.test(input.requestHash) ||
        suppliedResponseId !== null && !safeString(suppliedResponseId, 1_024)) {
        repositoryError("invalid_input");
      }
      try {
        return await serializable(client, async (tx) => {
          const current = await tx.knowledgeProviderAttempt.findUnique({
            include: attemptInclude,
            where: {
              modelRunId_ordinal: {
                modelRunId: input.modelRunId,
                ordinal: input.ordinal
              }
            }
          });
          if (!current) return { kind: "not_found" };
          if (input.now < current.createdAt) repositoryError("invalid_input");
          const dispatch = storedDispatch(current);
          if (input.requestHash !== undefined && input.requestHash !== current.requestHash) {
            repositoryError("idempotency_conflict");
          }
          if (current.providerResponseId !== null && suppliedResponseId !== null &&
            current.providerResponseId !== suppliedResponseId) {
            repositoryError("idempotency_conflict");
          }
          const providerResponseId = current.providerResponseId ?? suppliedResponseId;

          if (current.state === "settled") {
            return { dispatch, kind: "settled", providerResponseId };
          }
          if (current.state === "released") return { dispatch, kind: "released" };
          if (current.state === "ambiguous") return { dispatch, kind: "ambiguous" };
          if (current.state === "reserved" && suppliedResponseId !== null) {
            repositoryError("idempotency_conflict");
          }

          const leaseActive = current.leaseExpiresAt !== null &&
            current.leaseExpiresAt > input.now;
          if (leaseActive) return { dispatch, kind: "busy" };

          if (current.state === "reserved") {
            if (input.requestHash === undefined) {
              return { dispatch, kind: "request_required" };
            }
            const claimed = await tx.knowledgeProviderAttempt.updateMany({
              data: {
                leaseExpiresAt: input.leaseExpiresAt,
                leaseToken: input.leaseToken
              },
              where: {
                id: current.id,
                leaseExpiresAt: current.leaseExpiresAt,
                leaseToken: current.leaseToken,
                modelRunId: input.modelRunId,
                state: "reserved"
              }
            });
            if (claimed.count !== 1) {
              throw new KnowledgeProviderAttemptRecoveryClaimRaceError();
            }
            const recovered = await tx.knowledgeProviderAttempt.findUnique({
              include: attemptInclude,
              where: { id: current.id }
            });
            if (!recovered) repositoryError("target_unavailable");
            return {
              dispatch: storedDispatch(recovered),
              kind: "dispatch",
              leaseToken: input.leaseToken
            };
          }

          if (providerResponseId === null) {
            const marked = await tx.knowledgeProviderAttempt.updateMany({
              data: {
                ambiguousAt: input.now,
                failureCode: "provider_response_handle_missing",
                leaseExpiresAt: null,
                leaseToken: null,
                state: "ambiguous"
              },
              where: {
                id: current.id,
                leaseExpiresAt: current.leaseExpiresAt,
                leaseToken: current.leaseToken,
                modelRunId: input.modelRunId,
                state: "dispatched"
              }
            });
            if (marked.count !== 1) {
              throw new KnowledgeProviderAttemptRecoveryClaimRaceError();
            }
            const ambiguous = await tx.knowledgeProviderAttempt.findUnique({
              include: attemptInclude,
              where: { id: current.id }
            });
            if (!ambiguous) repositoryError("target_unavailable");
            return { dispatch: storedDispatch(ambiguous), kind: "ambiguous" };
          }

          const claimed = await tx.knowledgeProviderAttempt.updateMany({
            data: {
              leaseExpiresAt: input.leaseExpiresAt,
              leaseToken: input.leaseToken,
              providerResponseId
            },
            where: {
              id: current.id,
              leaseExpiresAt: current.leaseExpiresAt,
              leaseToken: current.leaseToken,
              modelRunId: input.modelRunId,
              state: "dispatched"
            }
          });
          if (claimed.count !== 1) {
            throw new KnowledgeProviderAttemptRecoveryClaimRaceError();
          }
          const recovered = await tx.knowledgeProviderAttempt.findUnique({
            include: attemptInclude,
            where: { id: current.id }
          });
          if (!recovered) repositoryError("target_unavailable");
          return {
            dispatch: storedDispatch(recovered),
            kind: "resume",
            leaseToken: input.leaseToken,
            providerResponseId
          };
        });
      } catch (error) {
        if (!recoveryClaimRace(error)) throw error;
        return client.$transaction(async (tx) => {
          const current = await tx.knowledgeProviderAttempt.findUnique({
            include: attemptInclude,
            where: {
              modelRunId_ordinal: {
                modelRunId: input.modelRunId,
                ordinal: input.ordinal
              }
            }
          });
          if (!current) return { kind: "not_found" };
          const dispatch = storedDispatch(current);
          if (current.state === "settled") {
            return {
              dispatch,
              kind: "settled",
              providerResponseId: current.providerResponseId
            };
          }
          if (current.state === "released") return { dispatch, kind: "released" };
          if (current.state === "ambiguous") return { dispatch, kind: "ambiguous" };
          return { dispatch, kind: "busy" };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      }
    },

    async dispatch(
      input: DispatchKnowledgeProviderAttemptInput
    ): Promise<KnowledgeProviderAttemptTransition> {
      if (!SAFE_IDENTITY.test(input.leaseToken) || !validDate(input.dispatchedAt) ||
        !validDate(input.leaseExpiresAt) || input.leaseExpiresAt <= input.dispatchedAt) {
        repositoryError("invalid_input");
      }
      return serializable(client, async (tx) => {
        const current = await findAttempt(tx, input);
        if (current.state === "released") repositoryError("invalid_state");
        if (current.leaseToken !== input.leaseToken) repositoryError("lease_conflict");
        if (current.state !== "reserved") {
          if (current.state === "dispatched" || current.state === "settled" ||
            current.state === "ambiguous") {
            return { attempt: decodeAttempt(current), kind: "idempotent" };
          }
          return repositoryError("invalid_state");
        }
        if (input.dispatchedAt < current.createdAt || !current.leaseExpiresAt ||
          current.leaseExpiresAt <= input.dispatchedAt) {
          repositoryError("lease_expired");
        }
        const updated = await tx.knowledgeProviderAttempt.updateMany({
          data: {
            dispatchedAt: input.dispatchedAt,
            leaseExpiresAt: input.leaseExpiresAt,
            state: "dispatched"
          },
          where: {
            id: current.id,
            leaseExpiresAt: { gt: input.dispatchedAt },
            leaseToken: input.leaseToken,
            modelRunId: input.modelRunId,
            state: "reserved"
          }
        });
        if (updated.count !== 1) repositoryError("invalid_state");
        const next = await findAttempt(tx, input);
        return { attempt: decodeAttempt(next), kind: "transitioned" };
      });
    },

    async settle(
      input: SettleKnowledgeProviderAttemptInput
    ): Promise<KnowledgeProviderAttemptTransition> {
      const usage = decodeKnowledgeProviderAttemptUsage(input.actualUsage);
      const acceptedResult = input.acceptedResult === undefined
        ? null
        : validAcceptedJsonObject(input.acceptedResult, MAX_ACCEPTED_RESULT_BYTES)
          ? input.acceptedResult
          : repositoryError("invalid_input");
      const resultSnapshotValid = acceptedResult === null
        ? input.resultHash === undefined && input.resultAcceptedAt === undefined
        : typeof input.resultHash === "string" && SHA256.test(input.resultHash) &&
          canonicalJsonHash(acceptedResult) === input.resultHash &&
          validDate(input.resultAcceptedAt);
      if (!usage || !SAFE_IDENTITY.test(input.leaseToken) || !validDate(input.settledAt) ||
        !resultSnapshotValid ||
        input.providerResponseId !== null && !safeString(input.providerResponseId, 1_024)) {
        repositoryError("invalid_input");
      }
      return serializable(client, async (tx) => {
        const current = await findAttempt(tx, input);
        if (!validPurpose(current.purpose)) repositoryError("stored_manifest_invalid");
        const answerOperation = answerOperationContractVersion(current.purpose) !== null;
        if (answerOperation !== (acceptedResult !== null)) {
          repositoryError("invalid_input");
        }
        if (current.state === "settled") {
          if (!sameUsage(current.actualUsage, usage) ||
            current.providerResponseId !== input.providerResponseId ||
            canonicalJson(current.acceptedResult) !== canonicalJson(acceptedResult) ||
            current.resultHash !== (input.resultHash ?? null) ||
            current.resultAcceptedAt?.valueOf() !== input.resultAcceptedAt?.valueOf()) {
            repositoryError("idempotency_conflict");
          }
          return { attempt: decodeAttempt(current), kind: "idempotent" };
        }
        if (current.state !== "dispatched") repositoryError("invalid_state");
        if (current.leaseToken !== input.leaseToken) repositoryError("lease_conflict");
        if (!current.dispatchedAt || input.settledAt < current.dispatchedAt ||
          input.resultAcceptedAt !== undefined &&
            (input.resultAcceptedAt < current.dispatchedAt ||
              input.resultAcceptedAt > input.settledAt)) {
          repositoryError("invalid_input");
        }
        const updated = await tx.knowledgeProviderAttempt.updateMany({
          data: {
            ...(acceptedResult ? { acceptedResult: json(acceptedResult) } : {}),
            actualUsage: json(usage),
            leaseExpiresAt: null,
            leaseToken: null,
            providerResponseId: input.providerResponseId,
            ...(input.resultAcceptedAt ? { resultAcceptedAt: input.resultAcceptedAt } : {}),
            ...(input.resultHash ? { resultHash: input.resultHash } : {}),
            settledAt: input.settledAt,
            state: "settled"
          },
          where: {
            id: current.id,
            leaseToken: input.leaseToken,
            modelRunId: input.modelRunId,
            state: "dispatched"
          }
        });
        if (updated.count !== 1) repositoryError("invalid_state");
        return { attempt: decodeAttempt(await findAttempt(tx, input)), kind: "transitioned" };
      });
    },

    async release(
      input: ReleaseKnowledgeProviderAttemptInput
    ): Promise<KnowledgeProviderAttemptTransition> {
      if (!SAFE_IDENTITY.test(input.leaseToken) || !SAFE_REASON.test(input.reason) ||
        !validDate(input.releasedAt)) repositoryError("invalid_input");
      return serializable(client, async (tx) => {
        const current = await findAttempt(tx, input);
        if (current.state === "released") {
          if (current.failureCode !== input.reason) repositoryError("idempotency_conflict");
          return { attempt: decodeAttempt(current), kind: "idempotent" };
        }
        if (current.state !== "reserved") repositoryError("invalid_state");
        if (current.leaseToken !== input.leaseToken) repositoryError("lease_conflict");
        if (input.releasedAt < current.createdAt) repositoryError("invalid_input");
        const updated = await tx.knowledgeProviderAttempt.updateMany({
          data: {
            failureCode: input.reason,
            leaseExpiresAt: null,
            leaseToken: null,
            releasedAt: input.releasedAt,
            state: "released"
          },
          where: {
            id: current.id,
            leaseToken: input.leaseToken,
            modelRunId: input.modelRunId,
            state: "reserved"
          }
        });
        if (updated.count !== 1) repositoryError("invalid_state");
        return { attempt: decodeAttempt(await findAttempt(tx, input)), kind: "transitioned" };
      });
    },

    async markAmbiguous(
      input: MarkKnowledgeProviderAttemptAmbiguousInput
    ): Promise<KnowledgeProviderAttemptTransition> {
      const responseId = input.providerResponseId ?? null;
      if (!SAFE_IDENTITY.test(input.leaseToken) || !SAFE_REASON.test(input.reason) ||
        !validDate(input.ambiguousAt) || responseId !== null && !safeString(responseId, 1_024)) {
        repositoryError("invalid_input");
      }
      return serializable(client, async (tx) => {
        const current = await findAttempt(tx, input);
        if (current.state === "ambiguous") {
          if (current.failureCode !== input.reason || current.providerResponseId !== responseId) {
            repositoryError("idempotency_conflict");
          }
          return { attempt: decodeAttempt(current), kind: "idempotent" };
        }
        if (current.state !== "dispatched") repositoryError("invalid_state");
        if (current.leaseToken !== input.leaseToken) repositoryError("lease_conflict");
        if (!current.dispatchedAt || input.ambiguousAt < current.dispatchedAt) {
          repositoryError("invalid_input");
        }
        const updated = await tx.knowledgeProviderAttempt.updateMany({
          data: {
            ambiguousAt: input.ambiguousAt,
            failureCode: input.reason,
            leaseExpiresAt: null,
            leaseToken: null,
            providerResponseId: responseId,
            state: "ambiguous"
          },
          where: {
            id: current.id,
            leaseToken: input.leaseToken,
            modelRunId: input.modelRunId,
            state: "dispatched"
          }
        });
        if (updated.count !== 1) repositoryError("invalid_state");
        return { attempt: decodeAttempt(await findAttempt(tx, input)), kind: "transitioned" };
      });
    },

    async purge(input: Readonly<{
      manifestIds: readonly string[];
      modelRunId: string;
      purgedAt: Date;
    }>): Promise<Readonly<{ alreadyPurgedCount: number; purgedCount: number }>> {
      const manifestIds = [...new Set(input.manifestIds)];
      if (manifestIds.length < 1 || manifestIds.length > 4_096 ||
        manifestIds.some((id) => !safeString(id)) || !safeString(input.modelRunId) ||
        !validDate(input.purgedAt)) {
        repositoryError("invalid_input");
      }
      return serializable(client, async (tx) => {
        const manifests = await tx.knowledgeEvidenceDispatchManifest.findMany({
          select: { excludedCount: true, id: true, itemCount: true, purgedAt: true },
          where: { id: { in: manifestIds }, modelRunId: input.modelRunId }
        });
        if (manifests.length !== manifestIds.length) repositoryError("target_unavailable");
        const pendingIds = manifests.flatMap((manifest) =>
          manifest.purgedAt === null ? [manifest.id] : []);
        if (pendingIds.length === 0) {
          return { alreadyPurgedCount: manifests.length, purgedCount: 0 };
        }
        const pending = manifests.filter(({ purgedAt }) => purgedAt === null);
        await tx.$executeRaw`SET LOCAL aiqsa.knowledge_purge = 'on'`;
        const purgedItems = await tx.knowledgeEvidenceDispatchManifestItem.updateMany({
          data: {
            contextBoundaries: Prisma.DbNull,
            evidenceItemId: null,
            exactExcerpt: null,
            excerptHash: null,
            handle: null,
            renderedBlock: null,
            renderedBlockHash: null,
            representation: "purged",
            safeMetadata: Prisma.DbNull,
            sourceAlias: null,
            sourceArtifactId: null,
            sourceVersionId: null
          },
          where: { manifestId: { in: pendingIds } }
        });
        const purgedExclusions = await tx.knowledgeEvidenceDispatchManifestExclusion.updateMany({
          data: { evidenceItemId: null, handle: null, reason: "purged" },
          where: { manifestId: { in: pendingIds } }
        });
        if (purgedItems.count !== pending.reduce((total, manifest) =>
          total + manifest.itemCount, 0) ||
          purgedExclusions.count !== pending.reduce((total, manifest) =>
            total + manifest.excludedCount, 0)) {
          repositoryError("invalid_state");
        }
        const purged = await tx.knowledgeEvidenceDispatchManifest.updateMany({
          data: {
            coverage: Prisma.DbNull,
            messageHash: null,
            messageText: null,
            profileRevisionIds: [],
            purgedAt: input.purgedAt
          },
          where: { id: { in: pendingIds }, purgedAt: null }
        });
        if (purged.count !== pendingIds.length) repositoryError("invalid_state");
        return {
          alreadyPurgedCount: manifests.length - pendingIds.length,
          purgedCount: purged.count
        };
      });
    }
  };
}

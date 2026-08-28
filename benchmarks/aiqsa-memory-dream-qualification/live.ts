import { memoryExplicitStatementContainsSecret } from
  "../../lib/server/memory/explicit/safety";
import {
  decodeMemorySynthesisOutput,
  type MemorySynthesisOutput,
  type MemorySynthesisReasonCode
} from "../../lib/server/memory/synthesis/contract";
import {
  memorySynthesisDistinctSupportRootCount,
  type MemorySynthesisPlan
} from "../../lib/server/memory/synthesis/policy";
import {
  dreamQualificationLiveInputs,
  type DreamQualificationExpectedOutcome,
  type DreamQualificationLanguage,
  type DreamQualificationLiveInput
} from "./contract";

export const DREAM_LIVE_MIN_NON_EMPTY_PROPOSALS = 30;
export const DREAM_LIVE_MIN_PRECISION = 0.95;
export const DREAM_LIVE_MAX_UNSUPPORTED_GENERALIZATION_RATE = 0.05;
export const DREAM_LIVE_FIXED_TRIAL_COUNT = 4;

export const DREAM_LIVE_FAILURE_TAXONOMY = Object.freeze([
  "CONTRADICTED",
  "CROSS_TENANT",
  "DEPTH_VIOLATION",
  "MISSING_DIRECT_SUPPORT",
  "STALE",
  "UNSUPPORTED_GENERALIZATION"
] as const);

export type DreamLiveFailureTaxonomy =
  (typeof DREAM_LIVE_FAILURE_TAXONOMY)[number];

export type DreamLiveAuditRecord = Readonly<{
  caseId: string;
  distinctEvidenceRootCount: number;
  distinctFactRootCount: number;
  executionId: string;
  expectedOutcome: DreamQualificationExpectedOutcome;
  failureTaxonomy: readonly DreamLiveFailureTaxonomy[];
  language: DreamQualificationLanguage;
  modelId: string;
  observedDates: readonly string[];
  patternStatement: string;
  providerId: string;
  reasonCode: MemorySynthesisReasonCode;
  reviewerVerdict: "PENDING" | "STALE" | "SUPPORTED" | "UNSUPPORTED";
  sourceChatCount: number;
  sourceRefs: readonly string[];
  state: "ACTIVE" | "INVALIDATED";
  trial: number;
}>;

export type DreamQualificationProvider = Readonly<{
  generate(input: Readonly<{
    caseId: string;
    plan: MemorySynthesisPlan;
    signal: AbortSignal;
    trial: number;
  }>): Promise<Readonly<{
    executionId: string;
    modelId: string;
    output: unknown;
    providerId: string;
  }>>;
}>;

function opaqueToken(value: string): boolean {
  return value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u0020\u007f]/u.test(value);
}

function sourcesForProposal(
  plan: MemorySynthesisPlan,
  sourceRefs: readonly string[]
) {
  const byRef = new Map(plan.sources.map((source) => [source.ref, source]));
  const sources = sourceRefs.map((ref) => byRef.get(ref)).filter(
    (source): source is MemorySynthesisPlan["sources"][number] => Boolean(source)
  );
  if (sources.length !== sourceRefs.length) {
    throw new Error("dream_live_provider_source_ref_invalid");
  }
  return sources;
}

function draftRecords(
  input: DreamQualificationLiveInput,
  trial: number,
  result: Readonly<{
    executionId: string;
    modelId: string;
    output: MemorySynthesisOutput;
    providerId: string;
  }>
): readonly DreamLiveAuditRecord[] {
  return Object.freeze(result.output.patterns.map((pattern) => {
    const sources = sourcesForProposal(input.plan, pattern.sourceRefs);
    return Object.freeze({
      caseId: input.caseId,
      distinctEvidenceRootCount: memorySynthesisDistinctSupportRootCount(sources),
      distinctFactRootCount: new Set(sources.map(({ factId }) => factId)).size,
      executionId: result.executionId,
      expectedOutcome: input.expectedOutcome,
      failureTaxonomy: Object.freeze([]),
      language: input.language,
      modelId: result.modelId,
      observedDates: Object.freeze(sources.map(({ observedAt }) =>
        observedAt.toISOString())),
      patternStatement: pattern.statement,
      providerId: result.providerId,
      reasonCode: pattern.reasonCode,
      reviewerVerdict: "PENDING",
      sourceChatCount: new Set(sources.flatMap(({ sourceChatIds }) =>
        sourceChatIds)).size,
      sourceRefs: Object.freeze([...pattern.sourceRefs]),
      state: "ACTIVE",
      trial
    });
  }));
}

/** Executes fixed plans through an explicitly supplied governed provider
 * adapter. The required consent string prevents a caller from accidentally
 * turning deterministic qualification into paid/network work. The returned
 * records remain PENDING until a human reviewer fills verdict/taxonomy. */
export async function collectDreamLiveProviderAudit(input: Readonly<{
  consent: "EXPLICIT_PAID_PROVIDER_RUN";
  provider: DreamQualificationProvider;
  signal: AbortSignal;
  trialCount?: number;
}>): Promise<readonly DreamLiveAuditRecord[]> {
  if (input.consent !== "EXPLICIT_PAID_PROVIDER_RUN") {
    throw new Error("dream_live_provider_consent_required");
  }
  const trialCount = input.trialCount ?? DREAM_LIVE_FIXED_TRIAL_COUNT;
  if (!Number.isSafeInteger(trialCount) || trialCount < 1 || trialCount > 10) {
    throw new Error("dream_live_trial_count_invalid");
  }
  const records: DreamLiveAuditRecord[] = [];
  for (let trial = 1; trial <= trialCount; trial += 1) {
    for (const candidate of dreamQualificationLiveInputs()) {
      if (input.signal.aborted) throw input.signal.reason;
      const generated = await input.provider.generate({
        caseId: candidate.caseId,
        plan: candidate.plan,
        signal: input.signal,
        trial
      });
      if (!opaqueToken(generated.executionId) || !opaqueToken(generated.modelId) ||
        !opaqueToken(generated.providerId)) {
        throw new Error("dream_live_provider_identity_invalid");
      }
      const output = decodeMemorySynthesisOutput(generated.output, candidate.plan);
      records.push(...draftRecords(candidate, trial, { ...generated, output }));
    }
  }
  return Object.freeze(records);
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length &&
    keys.every((key, index) => key === sorted[index]);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const auditKeys = [
  "caseId", "distinctEvidenceRootCount", "distinctFactRootCount", "executionId",
  "expectedOutcome", "failureTaxonomy", "language", "modelId", "observedDates",
  "patternStatement", "providerId", "reasonCode", "reviewerVerdict",
  "sourceChatCount", "sourceRefs", "state", "trial"
] as const;

function decodeAuditRecord(value: unknown): DreamLiveAuditRecord {
  const item = record(value);
  if (!item || !exactKeys(item, auditKeys) ||
    typeof item.caseId !== "string" || !opaqueToken(item.caseId) ||
    !Number.isSafeInteger(item.distinctEvidenceRootCount) ||
    (item.distinctEvidenceRootCount as number) < 0 ||
    !Number.isSafeInteger(item.distinctFactRootCount) ||
    (item.distinctFactRootCount as number) < 0 ||
    typeof item.executionId !== "string" || !opaqueToken(item.executionId) ||
    (item.expectedOutcome !== "ACTIVE" && item.expectedOutcome !== "NO_PATTERN") ||
    !Array.isArray(item.failureTaxonomy) ||
    item.failureTaxonomy.some((entry) =>
      !(DREAM_LIVE_FAILURE_TAXONOMY as readonly unknown[]).includes(entry)) ||
    new Set(item.failureTaxonomy).size !== item.failureTaxonomy.length ||
    (item.language !== "en" && item.language !== "mixed" && item.language !== "ru") ||
    typeof item.modelId !== "string" || !opaqueToken(item.modelId) ||
    !Array.isArray(item.observedDates) || item.observedDates.length > 40 ||
    item.observedDates.some((entry) => typeof entry !== "string" ||
      Number.isNaN(new Date(entry).getTime()) || new Date(entry).toISOString() !== entry) ||
    typeof item.patternStatement !== "string" ||
    item.patternStatement.trim() !== item.patternStatement ||
    item.patternStatement.length > 2_000 ||
    memoryExplicitStatementContainsSecret(item.patternStatement) ||
    typeof item.providerId !== "string" || !opaqueToken(item.providerId) ||
    typeof item.reasonCode !== "string" ||
    !["cross_context_pattern", "repeated_constraint_pattern",
      "repeated_event_pattern", "repeated_habit_pattern",
      "repeated_preference_pattern", "repeated_workflow_pattern"]
      .includes(item.reasonCode) ||
    (item.reviewerVerdict !== "PENDING" && item.reviewerVerdict !== "STALE" &&
      item.reviewerVerdict !== "SUPPORTED" &&
      item.reviewerVerdict !== "UNSUPPORTED") ||
    !Number.isSafeInteger(item.sourceChatCount) || (item.sourceChatCount as number) < 0 ||
    !Array.isArray(item.sourceRefs) || item.sourceRefs.length < 3 ||
    item.sourceRefs.length > 40 || item.sourceRefs.some((entry) =>
      typeof entry !== "string" || !opaqueToken(entry)) ||
    new Set(item.sourceRefs).size !== item.sourceRefs.length ||
    (item.state !== "ACTIVE" && item.state !== "INVALIDATED") ||
    !Number.isSafeInteger(item.trial) || (item.trial as number) < 1) {
    throw new Error("dream_live_audit_record_invalid");
  }
  return Object.freeze({
    caseId: item.caseId,
    distinctEvidenceRootCount: item.distinctEvidenceRootCount as number,
    distinctFactRootCount: item.distinctFactRootCount as number,
    executionId: item.executionId,
    expectedOutcome: item.expectedOutcome,
    failureTaxonomy: Object.freeze(item.failureTaxonomy as DreamLiveFailureTaxonomy[]),
    language: item.language,
    modelId: item.modelId,
    observedDates: Object.freeze(item.observedDates as string[]),
    patternStatement: item.patternStatement,
    providerId: item.providerId,
    reasonCode: item.reasonCode as MemorySynthesisReasonCode,
    reviewerVerdict: item.reviewerVerdict,
    sourceChatCount: item.sourceChatCount as number,
    sourceRefs: Object.freeze(item.sourceRefs as string[]),
    state: item.state,
    trial: item.trial as number
  });
}

/** Applies the release gate to manually reviewed real-provider records. The
 * returned report is content-free; statements and refs stay only in the local
 * ignored 0600 audit input. */
export function evaluateDreamLiveAudit(value: unknown) {
  if (!Array.isArray(value)) throw new Error("dream_live_audit_invalid");
  const records = value.map(decodeAuditRecord);
  const proposals = records.filter(({ patternStatement }) => patternStatement.length > 0);
  const pending = proposals.filter(({ reviewerVerdict }) => reviewerVerdict === "PENDING");
  const supported = proposals.filter(({ expectedOutcome, reviewerVerdict, state }) =>
    expectedOutcome === "ACTIVE" && reviewerVerdict === "SUPPORTED" && state === "ACTIVE");
  const unsupported = proposals.filter(({ expectedOutcome, failureTaxonomy,
    reviewerVerdict }) =>
    expectedOutcome === "NO_PATTERN" || reviewerVerdict === "UNSUPPORTED" ||
    failureTaxonomy.includes("UNSUPPORTED_GENERALIZATION"));
  const precision = rate(supported.length, proposals.length);
  const unsupportedGeneralizationRate = rate(unsupported.length, proposals.length);
  const enoughVolume = proposals.length >= DREAM_LIVE_MIN_NON_EMPTY_PROPOSALS;
  const qualityPass = pending.length === 0 &&
    precision >= DREAM_LIVE_MIN_PRECISION &&
    unsupportedGeneralizationRate <=
      DREAM_LIVE_MAX_UNSUPPORTED_GENERALIZATION_RATE;
  const status = !enoughVolume
    ? "GUARDED_INSUFFICIENT_VOLUME" as const
    : !qualityPass
      ? "GUARDED_QUALITY" as const
      : "QUALIFIED" as const;
  return Object.freeze({
    binding: Object.freeze({ mode: "REAL_PROVIDER_MANUAL_AUDIT" as const }),
    evidence: Object.freeze({
      caseCount: new Set(proposals.map(({ caseId }) => caseId)).size,
      executionCount: new Set(proposals.map(({ executionId }) => executionId)).size,
      languageCounts: Object.freeze({
        en: proposals.filter(({ language }) => language === "en").length,
        mixed: proposals.filter(({ language }) => language === "mixed").length,
        ru: proposals.filter(({ language }) => language === "ru").length
      }),
      modelCount: new Set(proposals.map(({ modelId }) => modelId)).size,
      providerCount: new Set(proposals.map(({ providerId }) => providerId)).size,
      trialCount: new Set(proposals.map(({ trial }) => trial)).size
    }),
    gate: Object.freeze({
      enoughVolume,
      maximumUnsupportedGeneralizationRate:
        DREAM_LIVE_MAX_UNSUPPORTED_GENERALIZATION_RATE,
      minimumNonEmptyProposals: DREAM_LIVE_MIN_NON_EMPTY_PROPOSALS,
      minimumPrecision: DREAM_LIVE_MIN_PRECISION,
      qualityPass,
      status
    }),
    metrics: Object.freeze({
      nonEmptyProposalCount: proposals.length,
      pendingReviewCount: pending.length,
      precision,
      supportedProposalCount: supported.length,
      unsupportedGeneralizationCount: unsupported.length,
      unsupportedGeneralizationRate
    })
  });
}

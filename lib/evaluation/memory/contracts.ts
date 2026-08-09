import { z } from "zod";

export const MEMORY_EVALUATION_EVIDENCE_VERSION = "memory-evaluation-evidence-v1";
export const MEMORY_EVALUATION_SCORER_VERSION = "memory-scorers-v1";

export const MEMORY_EVALUATION_ADAPTER_KINDS = [
  "AIQSA_NATIVE",
  "NO_MEMORY_BASELINE",
  "HINDSIGHT_REFERENCE"
] as const;
export type MemoryEvaluationAdapterKind = (typeof MEMORY_EVALUATION_ADAPTER_KINDS)[number];

export const MEMORY_EVALUATION_LANGUAGES = ["RU", "EN"] as const;
export type MemoryEvaluationLanguage = (typeof MEMORY_EVALUATION_LANGUAGES)[number];

export const MEMORY_EVALUATION_SPLITS = ["TUNING", "HOLDOUT"] as const;
export type MemoryEvaluationSplit = (typeof MEMORY_EVALUATION_SPLITS)[number];

export const MEMORY_EVALUATION_DATA_CLASSES = [
  "SYNTHETIC",
  "APPROVED_PUBLIC_BENCHMARK"
] as const;
export type MemoryEvaluationDataClass = (typeof MEMORY_EVALUATION_DATA_CLASSES)[number];

export const MEMORY_BINARY_METRICS = [
  "AUTOMATIC_FACT_PRECISION",
  "CONSOLIDATION_OPERATION_ACCURACY",
  "TEMPORAL_CURRENT_HISTORY_ACCURACY",
  "IRRELEVANT_AUTOMATIC_INJECTION_RATE",
  "LANGUAGE_PRESERVING_DISPLAY_TEXT",
  "EVIDENCE_ID_VALIDITY",
  "SOURCE_COVERAGE",
  "BOUNDARY_CORRECTNESS",
  "SCOPE_ACCURACY",
  "ANSWER_SOURCE_SUPPORTED_CORRECTNESS",
  "ANSWER_CONTRADICTION_RATE",
  "ANSWER_ABSTENTION_ACCURACY",
  "ANSWER_MEMORY_ATTRIBUTION_ACCURACY",
  "REBUILD_EQUIVALENCE"
] as const;
export type MemoryBinaryMetric = (typeof MEMORY_BINARY_METRICS)[number];

export const MEMORY_RANKED_METRICS = [
  "CURATED_RECALL_AT_5",
  "MRR",
  "NDCG",
  "SOURCE_DIVERSITY"
] as const;
export type MemoryRankedMetric = (typeof MEMORY_RANKED_METRICS)[number];

export const MEMORY_CAPABILITY_ROLES = [
  "MEMORY_FACT_EXTRACT",
  "MEMORY_CONSOLIDATE",
  "MEMORY_VERIFY",
  "MEMORY_EPISODE_EXTRACT",
  "MEMORY_DOCUMENT_EMBED",
  "MEMORY_QUERY_EMBED",
  "MEMORY_QUERY_EXPAND",
  "MEMORY_RERANK"
] as const;
export type MemoryCapabilityRole = (typeof MEMORY_CAPABILITY_ROLES)[number];

export const MEMORY_HARD_INVARIANT_DEFINITIONS = [
  { category: "PRIVACY", code: "CROSS_USER_LEAKAGE" },
  { category: "PRIVACY", code: "DATABASE_ACCEPTED_CROSS_OWNER_RELATION" },
  { category: "PRIVACY", code: "PUBLIC_SHARE_MEMORY_RECEIPT_LEAKAGE" },
  { category: "PRIVACY", code: "PRIVATE_QUERY_URL_LOG_CACHE_LEAKAGE" },
  { category: "PRIVACY", code: "FILTERED_ANN_TENANT_LEAKAGE" },
  { category: "SAFETY", code: "TEMPORARY_CHAT_MEMORY_READ" },
  { category: "SAFETY", code: "TEMPORARY_CHAT_MEMORY_WRITE" },
  { category: "SAFETY", code: "UNAUTHORIZED_SCOPE_CROSSING" },
  { category: "SAFETY", code: "UNAUTHORIZED_SOURCE_FACT_PROMOTION" },
  { category: "SAFETY", code: "SECRET_DERIVATIVE_MEMORY_RETENTION" },
  { category: "SAFETY", code: "SECRET_PROVIDER_EGRESS" },
  { category: "SAFETY", code: "GENERIC_SENSITIVE_EPISODIC_RECALL" },
  { category: "SAFETY", code: "MEMORY_MUTATION_WITHOUT_CURRENT_USER_AUTHORIZATION" },
  { category: "SAFETY", code: "MEMORY_ONLY_TOOL_DISCLOSURE" },
  { category: "SAFETY", code: "TRANSITIVE_MEMORY_TOOL_DISCLOSURE" },
  { category: "SAFETY", code: "HOSTED_SEARCH_WITH_PERSONAL_CONTEXT" },
  { category: "SAFETY", code: "UNACCEPTED_DESTINATION_PROVIDER_CALL" },
  { category: "LIFECYCLE", code: "STALE_BRANCH_INCLUSION" },
  { category: "LIFECYCLE", code: "POST_COMMIT_FORGOTTEN_ITEM_INCLUSION" },
  { category: "LIFECYCLE", code: "FORGOTTEN_ITEM_REBUILD_RESURRECTION" },
  { category: "LIFECYCLE", code: "LOST_OR_ABANDONED_PURGE_OBLIGATION" },
  { category: "LIFECYCLE", code: "INDEPENDENT_GATE_MATRIX_MISMATCH" },
  { category: "LIFECYCLE", code: "CACHEABLE_MEMORY_PRIVATE_RESPONSE" },
  { category: "RUN", code: "PREPARING_DISPATCH_BEFORE_FINALIZATION" },
  { category: "RUN", code: "STALE_SELECTED_ITEM_RACE_ACCEPTED" },
  { category: "RUN", code: "MEMORY_UI_LOCALE_KEY_PARITY_FAILURE" },
  { category: "RUN", code: "SILENT_TEMPORARY_PURGE_OVERDUE" }
] as const;

export type MemoryHardInvariantDefinition = (typeof MEMORY_HARD_INVARIANT_DEFINITIONS)[number];
export type MemoryHardInvariant = MemoryHardInvariantDefinition["code"];
export type MemoryHardInvariantCategory = MemoryHardInvariantDefinition["category"];

const safeIdentifier = z.string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u);
const safeVersion = z.string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:+@/-]*$/u);
const finiteNonNegative = z.number().finite().nonnegative();

const binaryOutcomeSchema = z.object({
  cohort: safeIdentifier,
  metric: z.enum(MEMORY_BINARY_METRICS),
  positive: z.boolean()
}).strict();

const rankedOutcomeSchema = z.object({
  cohort: safeIdentifier,
  metric: z.enum(MEMORY_RANKED_METRICS),
  score: z.number().finite().min(0).max(1),
  stratum: safeIdentifier
}).strict();

const hardInvariantObservationSchema = z.object({
  checks: z.number().int().min(1).max(1_000_000_000),
  failures: z.number().int().min(0).max(1_000_000_000),
  invariant: z.enum(MEMORY_HARD_INVARIANT_DEFINITIONS.map(({ code }) => code) as [
    MemoryHardInvariant,
    ...MemoryHardInvariant[]
  ])
}).strict().superRefine((value, context) => {
  if (value.failures > value.checks) {
    context.addIssue({ code: "custom", message: "failures exceed checks" });
  }
});

const operationObservationSchema = z.object({
  estimatedCostUsd: finiteNonNegative.nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  latencyMs: finiteNonNegative,
  outputTokens: z.number().int().nonnegative().nullable(),
  retries: z.number().int().nonnegative().max(1_000_000),
  role: z.enum(MEMORY_CAPABILITY_ROLES)
}).strict();

export const memoryEvaluationObservationSchema = z.object({
  binaryOutcomes: z.array(binaryOutcomeSchema).max(100_000),
  fixtureId: safeIdentifier,
  hardInvariants: z.array(hardInvariantObservationSchema).max(100_000),
  language: z.enum(MEMORY_EVALUATION_LANGUAGES),
  operations: z.array(operationObservationSchema).max(100_000),
  rankedOutcomes: z.array(rankedOutcomeSchema).max(100_000)
}).strict();

export type MemoryBinaryOutcome = z.infer<typeof binaryOutcomeSchema>;
export type MemoryRankedOutcome = z.infer<typeof rankedOutcomeSchema>;
export type MemoryHardInvariantObservation = z.infer<typeof hardInvariantObservationSchema>;
export type MemoryOperationObservation = z.infer<typeof operationObservationSchema>;
export type MemoryEvaluationObservation = z.infer<typeof memoryEvaluationObservationSchema>;
export type MemoryEvaluationObservationPayload = Omit<
  MemoryEvaluationObservation,
  "fixtureId" | "language"
>;

export type MemoryEvaluationFixture<Input = unknown> = Readonly<{
  corpusVersion: string;
  dataClass: MemoryEvaluationDataClass;
  groupId: string;
  id: string;
  input: Input;
  language: MemoryEvaluationLanguage;
  noMemoryBaseline: MemoryEvaluationObservationPayload;
  split: MemoryEvaluationSplit;
  tags: readonly string[];
}>;

export type MemoryEvaluationSystemFingerprint = Readonly<{
  configFingerprint: string;
  deploymentFingerprint: string;
  modelFingerprint: string;
  providerFingerprint: string;
  role: MemoryCapabilityRole;
  vectorSpaceFingerprint: string | null;
}>;

export type MemoryEvaluationRunContext = Readonly<{
  corpusHash: string;
  fixtureSeed: number;
  pipelineVersion: string;
  policyVersion: string;
  promptVersion: string;
  randomSeed: number;
  schemaVersion: string;
  scorerVersion: string;
  suiteVersion: string;
}>;

export type MemoryEvaluationExecutor<Input = unknown> = (
  fixture: MemoryEvaluationFixture<Input>,
  context: MemoryEvaluationRunContext
) => Promise<unknown>;

export type MemoryEvaluationAdapter<Input = unknown> = Readonly<{
  adapterVersion: string;
  fingerprints: readonly MemoryEvaluationSystemFingerprint[];
  kind: MemoryEvaluationAdapterKind;
  liveProvider: boolean;
  run: MemoryEvaluationExecutor<Input>;
}>;

export type MemoryEvaluationConfig = Readonly<{
  bootstrapSamples: number;
  corpusHash: string;
  corpusVersion: string;
  pgvectorVersion: string;
  pipelineVersion: string;
  policyVersion: string;
  postgresqlVersion: string;
  promptVersion: string;
  randomSeed: number;
  retrievalConfigFingerprint: string;
  schemaVersion: string;
  scorerVersion: string;
  suiteVersion: string;
}>;

export function decodeMemoryEvaluationObservation(
  value: unknown
): MemoryEvaluationObservation | null {
  const result = memoryEvaluationObservationSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function zeroMemoryHardInvariantObservations(
  checks = 1
): MemoryHardInvariantObservation[] {
  if (!Number.isSafeInteger(checks) || checks < 1) {
    throw new Error("memory_evaluation_invalid_invariant_check_count");
  }
  return MEMORY_HARD_INVARIANT_DEFINITIONS.map(({ code }) => ({
    checks,
    failures: 0,
    invariant: code
  }));
}

export function createAiqsaNativeEvaluationAdapter<Input>(input: {
  adapterVersion: string;
  fingerprints: readonly MemoryEvaluationSystemFingerprint[];
  liveProvider: boolean;
  run: MemoryEvaluationExecutor<Input>;
}): MemoryEvaluationAdapter<Input> {
  return {
    adapterVersion: safeVersion.parse(input.adapterVersion),
    fingerprints: input.fingerprints,
    kind: "AIQSA_NATIVE",
    liveProvider: input.liveProvider,
    run: input.run
  };
}

export function createNoMemoryBaselineAdapter<Input>(): MemoryEvaluationAdapter<Input> {
  return {
    adapterVersion: "no-memory-baseline-v1",
    fingerprints: [],
    kind: "NO_MEMORY_BASELINE",
    liveProvider: false,
    run: async (fixture) => ({
      ...fixture.noMemoryBaseline,
      fixtureId: fixture.id,
      language: fixture.language
    })
  };
}

export const MEMORY_CORPUS_SCHEMA_VERSION = "memory-corpus-schema-v2";
export const MEMORY_CORPUS_VERSION = "memory-corpus-v2";
export const MEMORY_CORPUS_GENERATOR_VERSION = "memory-corpus-generator-v2";
export const MEMORY_ADJUDICATION_RUBRIC_VERSION = "memory-adjudication-rubric-v1";

export const MEMORY_CRITICAL_COHORTS = [
  "explicit-lifecycle",
  "yo-e-equivalence",
  "russian-cases",
  "mixed-language-terms",
  "negation",
  "consideration-vs-purchase",
  "temporary-vs-residence",
  "temporal-correction",
  "relative-date-timezone",
  "expired-plan",
  "ambiguous-pronoun",
  "slang-typo",
  "scoped-project-preference",
  "branch-edit-stale-job",
  "forget-rebuild",
  "prompt-injection-secret",
  "sensitive-inference",
  "irrelevant-memory",
  "cross-language-query",
  "cross-user-isolation"
] as const;
export type MemoryCriticalCohort = (typeof MEMORY_CRITICAL_COHORTS)[number];

export const MEMORY_ADVERSARIAL_COHORTS = [
  "ambiguous-pronoun",
  "branch-edit-stale-job",
  "forget-rebuild",
  "prompt-injection-secret",
  "sensitive-inference",
  "irrelevant-memory",
  "cross-user-isolation"
] as const satisfies readonly MemoryCriticalCohort[];

export const MEMORY_GENERAL_LIFECYCLE_COHORTS = [
  "archive-retains-memory",
  "exclude-removes-memory",
  "resume-controlled-reindex",
  "hard-delete-retracts",
  "temporary-zero-memory",
  "provider-failure-degradation",
  "index-generation-isolation",
  "branch-common-ancestor",
  "account-deletion-purge",
  "public-share-stripping",
  "historical-run-snapshot",
  "scope-target-delete-no-global"
] as const;
export type MemoryGeneralLifecycleCohort =
  (typeof MEMORY_GENERAL_LIFECYCLE_COHORTS)[number];

export const MEMORY_CORPUS_COHORTS = [
  ...MEMORY_CRITICAL_COHORTS,
  ...MEMORY_GENERAL_LIFECYCLE_COHORTS
] as const;
export type MemoryCorpusCohort = (typeof MEMORY_CORPUS_COHORTS)[number];

export type MemoryCorpusLanguage = "RU" | "EN";
export type MemoryCorpusSplit = "TUNING" | "HOLDOUT";

export type MemoryCorpusMessage = Readonly<{
  branchId: string;
  createdAt: string;
  id: string;
  ownerUserId: string;
  role: "user" | "assistant";
  text: string;
}>;

export type MemoryCorpusChat = Readonly<{
  activeBranchId: string;
  branches: readonly Readonly<{
    id: string;
    parentBranchId: string | null;
  }>[];
  folderId: string | null;
  id: string;
  messages: readonly MemoryCorpusMessage[];
  ownerUserId: string;
}>;

export type MemoryCorpusAction = Readonly<{
  id: string;
  type:
    | "SAVE"
    | "LIST"
    | "EDIT"
    | "FORGET"
    | "ARCHIVE"
    | "RESTORE"
    | "EXCLUDE_SOURCE"
    | "RESUME_SOURCE"
    | "SWITCH_BRANCH"
    | "REBUILD"
    | "HARD_DELETE_CHAT"
    | "CREATE_TEMPORARY_CHAT"
    | "SIMULATE_PROVIDER_FAILURE"
    | "SWITCH_INDEX_GENERATION"
    | "DELETE_ACCOUNT"
    | "PUBLISH_SHARE"
    | "DELETE_SCOPE_TARGET";
  expectedOutcome: "APPLIED" | "DENIED" | "NOOP" | "DEGRADED" | "PURGED";
  sourceMessageIds: readonly string[];
}>;

export type MemoryCorpusExpectedFact = Readonly<{
  category: string;
  displayText: string;
  modality: "IDENTITY" | "PREFERENCE" | "PLAN" | "CONSTRAINT" | "RELATIONSHIP";
  scope: Readonly<{
    targetId: string | null;
    type: "GLOBAL_USER" | "FOLDER" | "ASSISTANT" | "CHAT";
  }>;
  sensitivity: "NORMAL" | "SENSITIVE";
  sourceMessageIds: readonly string[];
  state: "ACTIVE" | "FORGOTTEN" | "RETRACTED" | "EXPIRED";
  validFrom: string | null;
  validTo: string | null;
}>;

export type MemoryCorpusForbiddenFact = Readonly<{
  reason:
    | "NEGATED"
    | "NOT_ESTABLISHED"
    | "AMBIGUOUS"
    | "SECRET"
    | "SENSITIVE_INFERENCE"
    | "UNTRUSTED_SOURCE"
    | "STALE_BRANCH"
    | "FORGOTTEN"
    | "CROSS_USER";
  sourceMessageIds: readonly string[];
  text: string;
}>;

export type MemoryCorpusQuery = Readonly<{
  expectedOutcome: "RECALL" | "ABSTAIN" | "DENY";
  forbiddenMessageIds: readonly string[];
  id: string;
  language: MemoryCorpusLanguage;
  relevantMessageIds: readonly string[];
  requestingUserId: string;
  text: string;
}>;

export type MemoryCorpusFixture = Readonly<{
  actions: readonly MemoryCorpusAction[];
  adjudicationId: string;
  chats: readonly MemoryCorpusChat[];
  corpusVersion: typeof MEMORY_CORPUS_VERSION;
  cohort: MemoryCorpusCohort;
  dataClass: "SYNTHETIC";
  expectedEgress: Readonly<{
    allowedDestinations: readonly ("LOCAL_ONLY" | "SYSTEM_MODEL" | "EMBEDDING")[];
    remoteCallsAllowed: boolean;
    requiresAcceptedFingerprint: boolean;
  }>;
  expectedFacts: readonly MemoryCorpusExpectedFact[];
  expectedLifecycle: Readonly<{
    events: readonly string[];
    sourceEligible: boolean;
    terminalFactState: "ACTIVE" | "ABSENT" | "FORGOTTEN" | "RETRACTED" | "EXPIRED";
  }>;
  expectedSafety: Readonly<{
    automaticPromotionAllowed: boolean;
    hardInvariantCodes: readonly string[];
    toolEgress: "ALLOW" | "DENY" | "REQUIRE_ACCEPTED_DESTINATION";
  }>;
  forbiddenFacts: readonly MemoryCorpusForbiddenFact[];
  groupId: string;
  id: string;
  language: MemoryCorpusLanguage;
  queries: readonly MemoryCorpusQuery[];
  schemaVersion: typeof MEMORY_CORPUS_SCHEMA_VERSION;
  split: MemoryCorpusSplit;
  tags: readonly string[];
  users: readonly string[];
}>;

export type MemoryCohortTemplate = Readonly<{
  actions: readonly MemoryCorpusAction["type"][];
  automaticPromotionAllowed: boolean;
  category: string;
  correction: string | null;
  expectedFact: string | null;
  forbiddenFact: string;
  forbiddenReason: MemoryCorpusForbiddenFact["reason"];
  lifecycleEvents: readonly string[];
  modality: MemoryCorpusExpectedFact["modality"];
  query: string;
  queryOutcome: MemoryCorpusQuery["expectedOutcome"];
  scopeType: MemoryCorpusExpectedFact["scope"]["type"];
  sensitivity: MemoryCorpusExpectedFact["sensitivity"];
  source: string;
  sourceEligible: boolean;
  terminalFactState: MemoryCorpusFixture["expectedLifecycle"]["terminalFactState"];
  toolEgress: MemoryCorpusFixture["expectedSafety"]["toolEgress"];
}>;

export type MemoryCohortTemplates = Readonly<Record<
  MemoryCorpusCohort,
  Readonly<Record<MemoryCorpusLanguage, MemoryCohortTemplate>>
>>;

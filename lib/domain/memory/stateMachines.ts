import type {
  MemoryCandidateState,
  MemoryDeletionState,
  MemoryExecutionState,
  MemoryFactState,
  MemoryFactVersionState,
  MemoryIndexGenerationState,
  MemoryJobState,
  MemoryRetrievalAttemptState
} from "../../contracts/memory";

type TransitionMap<State extends string> = Readonly<Partial<Record<State, readonly State[]>>>;

function transitionAllowed<State extends string>(
  transitions: TransitionMap<State>,
  from: State,
  to: State
): boolean {
  return transitions[from]?.includes(to) ?? false;
}

const CANDIDATE_TRANSITIONS: TransitionMap<MemoryCandidateState> = Object.freeze({
  DEFERRED: ["PROMOTED", "REJECTED", "STALE"],
  PENDING: ["DEFERRED", "PROMOTED", "REJECTED", "STALE"]
});

export function memoryCandidateTransitionAllowed(
  from: MemoryCandidateState,
  to: MemoryCandidateState
): boolean {
  return transitionAllowed(CANDIDATE_TRANSITIONS, from, to);
}

export type MemoryFactTransitionOperation =
  | "AUTOMATIC_CONFLICT"
  | "AUTOMATIC_EXPIRE"
  | "AUTOMATIC_REINFORCE"
  | "AUTOMATIC_SUPERSEDE"
  | "EXPLICIT_EDIT"
  | "EXPLICIT_REVIVE"
  | "FORGET"
  | "MOVE_SCOPE"
  | "RESOLVE_CONFLICT"
  | "SOURCE_RECONCILE"
  | "TARGET_DELETE_AUTOMATIC"
  | "TARGET_DELETE_EXPLICIT";

export type MemoryFactTransition = Readonly<{
  from: MemoryFactState;
  operation: MemoryFactTransitionOperation;
  to: MemoryFactState;
}>;

const FACT_TRANSITIONS: readonly MemoryFactTransition[] = Object.freeze([
  { from: "ACTIVE", operation: "EXPLICIT_EDIT", to: "ACTIVE" },
  { from: "ACTIVE", operation: "AUTOMATIC_REINFORCE", to: "ACTIVE" },
  { from: "ACTIVE", operation: "AUTOMATIC_SUPERSEDE", to: "ACTIVE" },
  { from: "ACTIVE", operation: "AUTOMATIC_CONFLICT", to: "CONFLICTED" },
  { from: "CONFLICTED", operation: "RESOLVE_CONFLICT", to: "ACTIVE" },
  { from: "ACTIVE", operation: "AUTOMATIC_EXPIRE", to: "EXPIRED" },
  { from: "ACTIVE", operation: "SOURCE_RECONCILE", to: "ACTIVE" },
  { from: "ACTIVE", operation: "SOURCE_RECONCILE", to: "RETRACTED" },
  { from: "CONFLICTED", operation: "SOURCE_RECONCILE", to: "ACTIVE" },
  { from: "CONFLICTED", operation: "SOURCE_RECONCILE", to: "CONFLICTED" },
  { from: "CONFLICTED", operation: "SOURCE_RECONCILE", to: "RETRACTED" },
  { from: "ACTIVE", operation: "TARGET_DELETE_EXPLICIT", to: "ORPHANED" },
  { from: "CONFLICTED", operation: "TARGET_DELETE_EXPLICIT", to: "ORPHANED" },
  { from: "ACTIVE", operation: "TARGET_DELETE_AUTOMATIC", to: "RETRACTED" },
  { from: "CONFLICTED", operation: "TARGET_DELETE_AUTOMATIC", to: "RETRACTED" },
  { from: "ORPHANED", operation: "MOVE_SCOPE", to: "RETRACTED" },
  { from: "ACTIVE", operation: "FORGET", to: "FORGOTTEN" },
  { from: "CONFLICTED", operation: "FORGET", to: "FORGOTTEN" },
  { from: "ORPHANED", operation: "FORGET", to: "FORGOTTEN" },
  { from: "EXPIRED", operation: "FORGET", to: "FORGOTTEN" },
  { from: "RETRACTED", operation: "FORGET", to: "FORGOTTEN" },
  { from: "FORGOTTEN", operation: "EXPLICIT_REVIVE", to: "ACTIVE" }
]);

export function memoryFactTransitionAllowed(transition: MemoryFactTransition): boolean {
  return FACT_TRANSITIONS.some((candidate) =>
    candidate.from === transition.from &&
    candidate.operation === transition.operation &&
    candidate.to === transition.to
  );
}

export type MemoryFactVersionTransitionOperation =
  | "CONFLICT"
  | "EXPIRE"
  | "FORGET"
  | "SOURCE_RECONCILE"
  | "SUPERSEDE"
  | "TARGET_DELETE_EXPLICIT";

export type MemoryFactVersionTransition = Readonly<{
  from: MemoryFactVersionState;
  operation: MemoryFactVersionTransitionOperation;
  to: MemoryFactVersionState;
}>;

const FACT_VERSION_TRANSITIONS: readonly MemoryFactVersionTransition[] = Object.freeze([
  { from: "ACTIVE", operation: "SUPERSEDE", to: "SUPERSEDED" },
  { from: "ACTIVE", operation: "CONFLICT", to: "CONFLICTING" },
  { from: "ACTIVE", operation: "EXPIRE", to: "EXPIRED" },
  { from: "ACTIVE", operation: "SOURCE_RECONCILE", to: "RETRACTED" },
  { from: "CONFLICTING", operation: "SOURCE_RECONCILE", to: "ACTIVE" },
  { from: "CONFLICTING", operation: "SOURCE_RECONCILE", to: "RETRACTED" },
  { from: "ACTIVE", operation: "TARGET_DELETE_EXPLICIT", to: "ORPHANED" },
  { from: "CONFLICTING", operation: "TARGET_DELETE_EXPLICIT", to: "ORPHANED" },
  { from: "ACTIVE", operation: "FORGET", to: "FORGOTTEN" },
  { from: "CONFLICTING", operation: "FORGET", to: "FORGOTTEN" },
  { from: "ORPHANED", operation: "FORGET", to: "FORGOTTEN" },
  { from: "SUPERSEDED", operation: "FORGET", to: "FORGOTTEN" },
  { from: "EXPIRED", operation: "FORGET", to: "FORGOTTEN" },
  { from: "RETRACTED", operation: "FORGET", to: "FORGOTTEN" }
]);

export function memoryFactVersionTransitionAllowed(transition: MemoryFactVersionTransition): boolean {
  return FACT_VERSION_TRANSITIONS.some((candidate) =>
    candidate.from === transition.from &&
    candidate.operation === transition.operation &&
    candidate.to === transition.to
  );
}

export function memoryFactAggregateStateIsValid(value: Readonly<{
  currentVersionId: string | null;
  factState: MemoryFactState;
  versionState: MemoryFactVersionState;
}>): boolean {
  if (value.factState === "ACTIVE") {
    return typeof value.currentVersionId === "string" &&
      value.currentVersionId.length > 0 &&
      value.versionState === "ACTIVE";
  }
  if (value.currentVersionId !== null) return false;
  if (value.factState === "CONFLICTED") return value.versionState === "CONFLICTING";
  return value.factState === value.versionState;
}

const ATTEMPT_TRANSITIONS: TransitionMap<MemoryRetrievalAttemptState> = Object.freeze({
  EXECUTING: ["READY", "STALE", "FAILED", "CANCELLED", "EXPIRED"],
  PENDING: ["EXECUTING", "STALE", "FAILED", "CANCELLED", "EXPIRED"],
  READY: ["CONSUMED", "STALE", "FAILED", "CANCELLED", "EXPIRED"]
});

export function memoryRetrievalAttemptTransitionAllowed(
  from: MemoryRetrievalAttemptState,
  to: MemoryRetrievalAttemptState
): boolean {
  return transitionAllowed(ATTEMPT_TRANSITIONS, from, to);
}

const EXECUTION_TRANSITIONS: TransitionMap<MemoryExecutionState> = Object.freeze({
  PENDING: ["RUNNING", "FAILED", "CANCELLED"],
  RUNNING: ["SUCCEEDED", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"]
});

export function memoryExecutionTransitionAllowed(
  from: MemoryExecutionState,
  to: MemoryExecutionState
): boolean {
  return transitionAllowed(EXECUTION_TRANSITIONS, from, to);
}

const GENERATION_TRANSITIONS: TransitionMap<MemoryIndexGenerationState> = Object.freeze({
  BUILDING: ["CATCHING_UP", "FAILED", "CANCELLED"],
  CATCHING_UP: ["READY", "FAILED", "CANCELLED"],
  READY: ["ACTIVE", "CATCHING_UP", "FAILED", "CANCELLED"],
  ACTIVE: ["SUPERSEDED"]
});

export function memoryIndexGenerationTransitionAllowed(
  from: MemoryIndexGenerationState,
  to: MemoryIndexGenerationState
): boolean {
  return transitionAllowed(GENERATION_TRANSITIONS, from, to);
}

export function memoryIndexGenerationBootstrapAllowed(value: Readonly<{
  activeGenerationExists: boolean;
  indexMode: "HYBRID" | "LEXICAL_ONLY";
  settingsLockHeld: boolean;
}>): boolean {
  return !value.activeGenerationExists &&
    value.indexMode === "LEXICAL_ONLY" &&
    value.settingsLockHeld;
}

const DELETION_TRANSITIONS: TransitionMap<MemoryDeletionState> = Object.freeze({
  BLOCKED_REQUIRES_ADMIN: ["RUNNING"],
  PENDING: ["RUNNING", "CANCELLED"],
  RETRY_WAIT: ["RUNNING", "BLOCKED_REQUIRES_ADMIN"],
  RUNNING: ["SUCCEEDED", "RETRY_WAIT", "BLOCKED_REQUIRES_ADMIN"]
});

export function memoryDeletionTransitionAllowed(
  from: MemoryDeletionState,
  to: MemoryDeletionState
): boolean {
  return transitionAllowed(DELETION_TRANSITIONS, from, to);
}

const JOB_TRANSITIONS: TransitionMap<MemoryJobState> = Object.freeze({
  CLAIMED: [
    "SUCCEEDED",
    "RETRYABLE_FAILED",
    "TERMINAL_FAILED",
    "STALE",
    "CANCELLED",
    "WAITING_FOR_EGRESS_CONSENT"
  ],
  QUEUED: ["CLAIMED", "STALE", "CANCELLED", "WAITING_FOR_EGRESS_CONSENT"],
  RETRYABLE_FAILED: ["QUEUED", "STALE", "CANCELLED"],
  WAITING_FOR_EGRESS_CONSENT: ["QUEUED", "STALE", "CANCELLED"]
});

export type MemoryJobTransition = Readonly<{
  deletionWork: boolean;
  from: MemoryJobState;
  networkIoStarted: boolean;
  to: MemoryJobState;
}>;

export function memoryJobTransitionAllowed(transition: MemoryJobTransition): boolean {
  if (!transitionAllowed(JOB_TRANSITIONS, transition.from, transition.to)) return false;
  if (transition.deletionWork && transition.to === "TERMINAL_FAILED") return false;
  if (transition.to === "WAITING_FOR_EGRESS_CONSENT" && transition.networkIoStarted) return false;
  return true;
}

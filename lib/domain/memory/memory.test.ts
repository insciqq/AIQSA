import { describe, expect, it } from "vitest";
import {
  MEMORY_COUNTER_EFFECTS,
  memoryCounterEffectMatches
} from "./counters";
import {
  memoryDerivativePlaintextAllowed,
  memoryMutationIntentAllowed
} from "./safety";
import {
  memoryCandidateTransitionAllowed,
  memoryDeletionTransitionAllowed,
  memoryExecutionTransitionAllowed,
  memoryFactAggregateStateIsValid,
  memoryFactTransitionAllowed,
  memoryFactVersionTransitionAllowed,
  memoryIndexGenerationTransitionAllowed,
  memoryIndexGenerationBootstrapAllowed,
  memoryJobTransitionAllowed,
  memoryRetrievalAttemptTransitionAllowed
} from "./stateMachines";

describe("Memory state machines", () => {
  it("allows candidate quarantine outcomes and rejects terminal rewrites", () => {
    expect(memoryCandidateTransitionAllowed("PENDING", "DEFERRED")).toBe(true);
    expect(memoryCandidateTransitionAllowed("DEFERRED", "PROMOTED")).toBe(true);
    expect(memoryCandidateTransitionAllowed("PROMOTED", "PENDING")).toBe(false);
    expect(memoryCandidateTransitionAllowed("REJECTED", "PROMOTED")).toBe(false);
  });

  it("requires exact fact/version operations and explicit Forgotten revival", () => {
    expect(memoryFactTransitionAllowed({
      from: "ACTIVE",
      operation: "AUTOMATIC_CONFLICT",
      to: "CONFLICTED"
    })).toBe(true);
    expect(memoryFactTransitionAllowed({
      from: "FORGOTTEN",
      operation: "EXPLICIT_REVIVE",
      to: "ACTIVE"
    })).toBe(true);
    expect(memoryFactTransitionAllowed({
      from: "FORGOTTEN",
      operation: "AUTOMATIC_SUPERSEDE",
      to: "ACTIVE"
    })).toBe(false);
    expect(memoryFactVersionTransitionAllowed({
      from: "ACTIVE",
      operation: "SUPERSEDE",
      to: "SUPERSEDED"
    })).toBe(true);
    expect(memoryFactVersionTransitionAllowed({
      from: "FORGOTTEN",
      operation: "SOURCE_RECONCILE",
      to: "ACTIVE"
    })).toBe(false);
    expect(memoryFactAggregateStateIsValid({
      currentVersionId: "version-1",
      factState: "ACTIVE",
      versionState: "ACTIVE"
    })).toBe(true);
    expect(memoryFactAggregateStateIsValid({
      currentVersionId: "version-1",
      factState: "FORGOTTEN",
      versionState: "FORGOTTEN"
    })).toBe(false);
  });

  it("closes attempts, executions, generations, and deletion obligations", () => {
    expect(memoryRetrievalAttemptTransitionAllowed("PENDING", "EXECUTING")).toBe(true);
    expect(memoryRetrievalAttemptTransitionAllowed("READY", "CONSUMED")).toBe(true);
    expect(memoryRetrievalAttemptTransitionAllowed("CONSUMED", "READY")).toBe(false);
    expect(memoryExecutionTransitionAllowed("RUNNING", "OUTCOME_UNKNOWN")).toBe(true);
    expect(memoryExecutionTransitionAllowed("OUTCOME_UNKNOWN", "RUNNING")).toBe(false);
    expect(memoryIndexGenerationTransitionAllowed("READY", "CATCHING_UP")).toBe(true);
    expect(memoryIndexGenerationTransitionAllowed("ACTIVE", "BUILDING")).toBe(false);
    expect(memoryIndexGenerationBootstrapAllowed({
      activeGenerationExists: false,
      indexMode: "LEXICAL_ONLY",
      settingsLockHeld: true
    })).toBe(true);
    expect(memoryIndexGenerationBootstrapAllowed({
      activeGenerationExists: false,
      indexMode: "HYBRID",
      settingsLockHeld: true
    })).toBe(false);
    expect(memoryDeletionTransitionAllowed("RUNNING", "BLOCKED_REQUIRES_ADMIN")).toBe(true);
    expect(memoryDeletionTransitionAllowed("BLOCKED_REQUIRES_ADMIN", "RUNNING")).toBe(true);
    expect(memoryDeletionTransitionAllowed("BLOCKED_REQUIRES_ADMIN", "SUCCEEDED")).toBe(false);
    expect(memoryDeletionTransitionAllowed("PENDING", "CANCELLED")).toBe(true);
    expect(memoryDeletionTransitionAllowed("CANCELLED", "RUNNING")).toBe(false);
  });

  it("forbids abandoned deletion jobs and post-I/O consent waiting", () => {
    expect(memoryJobTransitionAllowed({
      deletionWork: false,
      from: "CLAIMED",
      networkIoStarted: false,
      to: "TERMINAL_FAILED"
    })).toBe(true);
    expect(memoryJobTransitionAllowed({
      deletionWork: true,
      from: "CLAIMED",
      networkIoStarted: false,
      to: "TERMINAL_FAILED"
    })).toBe(false);
    expect(memoryJobTransitionAllowed({
      deletionWork: false,
      from: "CLAIMED",
      networkIoStarted: false,
      to: "WAITING_FOR_EGRESS_CONSENT"
    })).toBe(true);
    expect(memoryJobTransitionAllowed({
      deletionWork: false,
      from: "CLAIMED",
      networkIoStarted: true,
      to: "WAITING_FOR_EGRESS_CONSENT"
    })).toBe(false);
  });
});

describe("Memory counters", () => {
  it("encodes no-op archive, branch fencing, source-conditional deletion, and visible changes", () => {
    expect(MEMORY_COUNTER_EFFECTS.CHAT_ARCHIVE_OR_RESTORE).toMatchObject({
      branchGeneration: false,
      memoryGeneration: false,
      memoryRevision: false,
      sourceRevision: false
    });
    expect(MEMORY_COUNTER_EFFECTS.BRANCH_PATH_CHANGE).toMatchObject({
      branchGeneration: true,
      memoryGeneration: true,
      memoryRevision: true,
      sourceRevision: true
    });
    expect(MEMORY_COUNTER_EFFECTS.SOURCE_HARD_DELETE).toMatchObject({
      branchGeneration: "AS_SOURCE_REQUIRES",
      memoryGeneration: true,
      memoryRevision: true,
      sourceRevision: "WHEN_CHAT_SOURCE"
    });
    expect(memoryCounterEffectMatches("MEMORY_UI_LOCALE_CHANGE", {
      ...MEMORY_COUNTER_EFFECTS.MEMORY_UI_LOCALE_CHANGE,
      memoryRevision: true
    })).toBe(false);
  });
});

describe("Memory sensitivity and mutation-intent safety", () => {
  it("rejects secret-tainted derivative plaintext", () => {
    expect(memoryDerivativePlaintextAllowed("NORMAL", false)).toBe(true);
    expect(memoryDerivativePlaintextAllowed("NORMAL", true)).toBe(false);
    expect(memoryDerivativePlaintextAllowed("SECRET", false)).toBe(false);
  });

  it("permits only direct exact owner intent and rejects model/background authority", () => {
    const directSave = {
      action: "SAVE" as const,
      confirmationCopyVersion: "memory-confirmation-v1",
      exactCurrentUserSpan: true,
      exactTarget: false,
      expectedVersion: false,
      explicitConfirmation: true,
      origin: "DIRECT_UI" as const
    };
    expect(memoryMutationIntentAllowed(directSave)).toBe(true);
    expect(memoryMutationIntentAllowed({ ...directSave, origin: "MODEL_PROPOSAL" })).toBe(false);
    expect(memoryMutationIntentAllowed({ ...directSave, confirmationCopyVersion: "stale" })).toBe(false);
    expect(memoryMutationIntentAllowed({ ...directSave, action: "FORGET" })).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  MEMORY_COUNTER_EFFECTS,
  memoryCounterEffectMatches
} from "./counters";
import {
  MEMORY_DELETION_OPERATION_FIXTURES,
  memoryDeletionOperationMatches
} from "./deletion";
import {
  MEMORY_GATE_FIXTURES,
  memoryCapabilitiesForGates
} from "./gates";
import {
  memoryScopeEligibleForRun,
  memoryScopeTransitionAllowed,
  memoryScopeTargetShapeIsValid
} from "./scopes";
import {
  memoryAutomaticPromotionAllowed,
  memoryDerivativePlaintextAllowed,
  memoryEpisodicRecallDecision,
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

describe("Memory independent gate fixtures", () => {
  it("covers all eight combinations exactly once and never disables explicit management", () => {
    expect(MEMORY_GATE_FIXTURES).toHaveLength(8);
    const signatures = MEMORY_GATE_FIXTURES.map(({ gates }) =>
      `${Number(gates.useMemoryFacts)}${Number(gates.referenceChatHistory)}${Number(gates.learnAutomatically)}`
    );
    expect(new Set(signatures).size).toBe(8);
    for (const fixture of MEMORY_GATE_FIXTURES) {
      expect(fixture.capabilities).toEqual(memoryCapabilitiesForGates(fixture.gates));
      expect(fixture.capabilities.explicitManagement).toBe(true);
      expect(fixture.capabilities.factReads).toBe(fixture.gates.useMemoryFacts);
      expect(fixture.capabilities.historyReads).toBe(fixture.gates.referenceChatHistory);
      expect(fixture.capabilities.automaticFactWrites).toBe(fixture.gates.learnAutomatically);
    }
  });
});

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

describe("Memory counter and deletion fixtures", () => {
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

  it("covers every destructive bulk operation with the required fence/barrier", () => {
    expect(MEMORY_DELETION_OPERATION_FIXTURES).toHaveLength(4);
    expect(new Set(MEMORY_DELETION_OPERATION_FIXTURES.map(({ operation }) => operation)).size).toBe(4);
    for (const fixture of MEMORY_DELETION_OPERATION_FIXTURES) {
      expect(fixture.advancesMemoryGeneration).toBe(true);
      expect(fixture.advancesMemoryRevision).toBe(true);
      expect(memoryDeletionOperationMatches(fixture.operation, fixture)).toBe(true);
    }
    expect(memoryDeletionOperationMatches("CLEAR_HISTORY_INDEX", {
      advancesMemoryGeneration: true,
      advancesMemoryRevision: true,
      sourceBarrier: null,
      suppressesExactSourceEvidence: false
    })).toBe(false);
  });
});

describe("Memory scope, sensitivity, intent, and tool-taint safety", () => {
  const globalScope = {
    assistantId: null,
    chatId: null,
    folderId: null,
    scopeType: "GLOBAL_USER" as const,
    state: "ACTIVE" as const,
    targetIdSnapshot: null
  };
  const folderScope = {
    assistantId: null,
    chatId: null,
    folderId: "folder-1",
    scopeType: "FOLDER" as const,
    state: "ACTIVE" as const,
    targetIdSnapshot: "folder-1"
  };

  it("rejects malformed, orphan-live, and unrelated scope targets", () => {
    expect(memoryScopeTargetShapeIsValid(globalScope)).toBe(true);
    expect(memoryScopeTargetShapeIsValid(folderScope)).toBe(true);
    expect(memoryScopeTargetShapeIsValid({ ...folderScope, folderId: "folder-2" })).toBe(false);
    expect(memoryScopeTargetShapeIsValid({ ...folderScope, state: "ORPHANED" })).toBe(false);
    expect(memoryScopeTargetShapeIsValid({
      ...folderScope,
      folderId: null,
      state: "ORPHANED"
    })).toBe(true);
    expect(memoryScopeEligibleForRun(folderScope, {
      assistantId: null,
      chatId: "chat-1",
      folderId: "folder-2"
    })).toBe(false);
    expect(memoryScopeEligibleForRun(folderScope, {
      assistantId: null,
      chatId: "chat-1",
      folderId: "folder-1"
    })).toBe(true);
    expect(memoryScopeTransitionAllowed("FOLDER", "ACTIVE", "ORPHANED")).toBe(true);
    expect(memoryScopeTransitionAllowed("FOLDER", "ORPHANED", "ACTIVE")).toBe(false);
    expect(memoryScopeTransitionAllowed("GLOBAL_USER", "ACTIVE", "ORPHANED")).toBe(false);
  });

  it("prevents automatic sensitive truth and secret episodic recall", () => {
    expect(memoryAutomaticPromotionAllowed("NORMAL")).toBe(true);
    expect(memoryAutomaticPromotionAllowed("SENSITIVE")).toBe(false);
    expect(memoryAutomaticPromotionAllowed("SECRET")).toBe(false);
    expect(memoryDerivativePlaintextAllowed("NORMAL", false)).toBe(true);
    expect(memoryDerivativePlaintextAllowed("NORMAL", true)).toBe(false);
    expect(memoryDerivativePlaintextAllowed("SECRET", false)).toBe(false);
    expect(memoryEpisodicRecallDecision("SENSITIVE", true, true)).toBe("ALLOW_EXACT_MATCH_ONLY");
    expect(memoryEpisodicRecallDecision("SENSITIVE", true, false)).toBe("DENY");
    expect(memoryEpisodicRecallDecision("HIGHLY_SENSITIVE", true, true)).toBe("DENY");
    expect(memoryEpisodicRecallDecision("SECRET", true, true)).toBe("DENY");
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

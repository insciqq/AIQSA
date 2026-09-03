import { describe, expect, it } from "vitest";
import {
  memoryDerivativePlaintextAllowed,
  memoryMutationIntentAllowed
} from "./safety";
import { memoryCounterEffectFor } from "./counters";

const historyVisibilityAuthorityAudit = [
  ["master pause", "MEMORY_MASTER_PAUSE", "memoryRevision"],
  ["master resume", "MEMORY_VISIBLE_SETTING_CHANGE", "memoryRevision"],
  ["history pause", "MEMORY_VISIBLE_SETTING_CHANGE", "memoryRevision"],
  ["history resume", "MEMORY_VISIBLE_SETTING_CHANGE", "memoryRevision"],
  ["source barrier", "FORGET_OR_BULK_CLEAR", "memoryRevision"],
  ["suppression or forget", "FORGET_OR_BULK_CLEAR", "memoryRevision"],
  ["source hard delete", "SOURCE_HARD_DELETE", "memoryRevision"],
  ["source exclude", "SOURCE_EXCLUDE", "memoryRevision"],
  ["source resume", "SOURCE_RESUME", "memoryRevision"],
  ["chunk visibility settlement", "CHUNK_VISIBILITY_CHANGE", "memoryRevision"],
  ["generation activation", "INDEX_GENERATION_ACTIVATION", "memoryRevision"],
  ["history-visible settings", "MEMORY_VISIBLE_SETTING_CHANGE", "memoryRevision"],
  ["folder move", "FOLDER_MOVE", "memoryRevision"],
  ["assistant access change", "ASSISTANT_ACCESS_CHANGE", "memoryRevision"],
  ["scope target delete", "SCOPE_TARGET_DELETE", "memoryRevision"],
  ["active branch change", "BRANCH_PATH_CHANGE", "sourceRevision"],
  ["normal source append", "NORMAL_APPEND", "sourceRevision"],
  ["terminal source settlement", "TERMINAL_SETTLEMENT", "sourceRevision"]
] as const;

describe("Memory sensitivity and mutation-intent safety", () => {
  it("rejects secret-tainted derivative plaintext", () => {
    expect(memoryDerivativePlaintextAllowed("NORMAL", false)).toBe(true);
    expect(memoryDerivativePlaintextAllowed("NORMAL", true)).toBe(false);
    expect(memoryDerivativePlaintextAllowed("SECRET", false)).toBe(false);
  });

  it("permits exact direct or delegated MCP owner intent and rejects model authority", () => {
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
    expect(memoryMutationIntentAllowed({ ...directSave, origin: "DELEGATED_MCP" })).toBe(true);
    expect(memoryMutationIntentAllowed({ ...directSave, origin: "MODEL_PROPOSAL" })).toBe(false);
    expect(memoryMutationIntentAllowed({ ...directSave, confirmationCopyVersion: "stale" })).toBe(false);
    expect(memoryMutationIntentAllowed({ ...directSave, action: "FORGET" })).toBe(false);
  });

  it("treats a master pause as a generation and revision fence", () => {
    expect(memoryCounterEffectFor("MEMORY_MASTER_PAUSE")).toMatchObject({
      memoryGeneration: true,
      memoryRevision: true,
      sourceRevision: false
    });
  });

  it("treats fact safety reclassification as a visible revision mutation", () => {
    expect(memoryCounterEffectFor("FACT_SAFETY_RECLASSIFICATION")).toMatchObject({
      memoryGeneration: false,
      memoryRevision: true,
      sourceRevision: false
    });
  });

  it("treats index activation as a revision-only pointer swap", () => {
    expect(memoryCounterEffectFor("INDEX_GENERATION_ACTIVATION")).toMatchObject({
      memoryGeneration: false,
      memoryRevision: true,
      sourceRevision: false
    });
  });

  it.each(historyVisibilityAuthorityAudit)(
    "routes %s through %s and advances bounded %s authority",
    (_path, mutation, counter) => {
      expect(memoryCounterEffectFor(mutation)[counter]).not.toBe(false);
    }
  );
});

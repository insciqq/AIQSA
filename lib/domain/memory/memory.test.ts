import { describe, expect, it } from "vitest";
import {
  memoryDerivativePlaintextAllowed,
  memoryMutationIntentAllowed
} from "./safety";
import { memoryCounterEffectFor } from "./counters";

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
});

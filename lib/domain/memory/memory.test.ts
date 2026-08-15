import { describe, expect, it } from "vitest";
import {
  memoryDerivativePlaintextAllowed,
  memoryMutationIntentAllowed
} from "./safety";

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

import { describe, expect, it } from "vitest";
import { validAcceptedInstructions } from "./snapshot";
import { decodeMemoryPreparingBaseSnapshot } from "../runs/preparingRun";

const accepted = { instructionPreset: { presetId: "preset", revision: 2, selectionVersion: 3 },
  prompt: { system: "baseline", developer: null, personalInstructions: "literal style", responseReminder: "literal reminder" } };
describe("accepted instruction snapshot validation", () => {
  it("accepts historical absence and complete current snapshots", () => {
    expect(validAcceptedInstructions({ prompt: { system: "baseline", developer: null } })).toBe(true);
    expect(validAcceptedInstructions(accepted)).toBe(true);
    expect(validAcceptedInstructions({ prompt: { system: "Assistant", responseReminder: "Assistant reminder" } })).toBe(true);
    expect(validAcceptedInstructions({ instructionPreset: { presetId: null, revision: null, selectionVersion: 4 },
      prompt: { personalInstructions: "", responseReminder: "" } })).toBe(true);
  });
  it.each([
    { ...accepted, instructionPreset: { ...accepted.instructionPreset, revision: 0 } },
    { ...accepted, instructionPreset: { ...accepted.instructionPreset, presetId: null } },
    { ...accepted, prompt: { ...accepted.prompt, responseReminder: undefined } },
    { ...accepted, prompt: { ...accepted.prompt, personalInstructions: "x".repeat(32001) } },
    { prompt: accepted.prompt }
  ])("rejects partial or oversized instruction evidence during preparation recovery", normalizedRequest => {
    expect(validAcceptedInstructions(normalizedRequest)).toBe(false);
    expect(decodeMemoryPreparingBaseSnapshot({ schemaVersion: 1, normalizedRequest, providerRequestPreview: {} })).toBeNull();
  });
});

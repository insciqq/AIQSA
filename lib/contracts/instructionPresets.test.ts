import { describe, expect, it } from "vitest";
import { decodeInstructionPresetDraft, decodeInstructionPresetMutation, decodeInstructionPresetState } from "./instructionPresets";

const value = { name: " Work ", systemInstructions: "  Literal {{user}}\n", responseReminder: " Answer in Spanish. " };
describe("instruction preset wire contract", () => {
  it("preserves literal text and permits reminder-only presets", () => {
    expect(decodeInstructionPresetDraft(value)).toEqual({ ...value, name: "Work" });
    expect(decodeInstructionPresetDraft({ ...value, systemInstructions: "" })).not.toBeNull();
    expect(decodeInstructionPresetDraft({ ...value, systemInstructions: "x".repeat(32000), responseReminder: "y".repeat(4000) })).not.toBeNull();
  });
  it.each([{ ...value, name: " " }, { ...value, name: "x".repeat(81) }, { ...value, systemInstructions: "x".repeat(32001) },
    { ...value, responseReminder: "y".repeat(4001) }, { ...value, responseReminder: "\0" }, { ...value, developer: "extra" }])("rejects malformed or oversized values", draft => {
    expect(decodeInstructionPresetDraft(draft)).toBeNull();
  });
  it("requires compare-and-set versions and rejects client authority", () => {
    expect(decodeInstructionPresetMutation({ action: "select", id: null, selectionVersion: 0 })).not.toBeNull();
    for (const input of [{ action: "create", value, userId: "other" }, { action: "update", id: "a", value },
      { action: "delete", id: "a", revision: 0 }, { action: "select", id: null, selectionVersion: -1 }]) {
      expect(decodeInstructionPresetMutation(input)).toBeNull();
    }
    expect(decodeInstructionPresetState({ activePresetId: "missing", selectionVersion: 0, presets: [] })).toBeNull();
  });
});

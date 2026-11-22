// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MEMORY_NOTE_MAX_CHARACTERS } from "@/lib/contracts/memoryNote";
import { applyMemoryNoteEdit, memoryNoteEditOf, memoryNotePassageValid } from "./edit";

const NOTE = "I am Sam, a backend developer.\n- Answer in English.\n- Use tables for prices.";

describe("an edit of the memory note", () => {
  it("adds a trimmed line at the end, and starts an empty note with it", () => {
    expect(applyMemoryNoteEdit(`${NOTE}\n\n`, { kind: "add", text: "  - Prefer metric units.\n" })).toEqual({
      after: "- Prefer metric units.", before: null, operation: "add", text: `${NOTE}\n- Prefer metric units.` });
    expect(applyMemoryNoteEdit("", { kind: "add", text: "Call me Sam." })).toEqual({ after: "Call me Sam.", before: null, operation: "add",
      text: "Call me Sam." });
  });

  it("replaces one exact passage literally, so a contradicting line changes instead of a second one appearing", () => {
    expect(applyMemoryNoteEdit(NOTE, { find: "- Answer in English.", kind: "replace", text: "- Answer in Russian, $& kept." })).toEqual({
      after: "- Answer in Russian, $& kept.", before: "- Answer in English.", operation: "replace",
      text: "I am Sam, a backend developer.\n- Answer in Russian, $& kept.\n- Use tables for prices." });
  });

  it("removes a passage, taking a whole line's break with it so no blank line is left", () => {
    expect(applyMemoryNoteEdit(NOTE, { find: "- Answer in English.", kind: "remove" })).toMatchObject({
      after: null, before: "- Answer in English.", operation: "remove", text: "I am Sam, a backend developer.\n- Use tables for prices." });
    expect(applyMemoryNoteEdit(NOTE, { find: "- Use tables for prices.", kind: "remove" }))
      .toMatchObject({ text: "I am Sam, a backend developer.\n- Answer in English." });
    expect(applyMemoryNoteEdit(NOTE, { find: ", a backend developer", kind: "remove" }))
      .toMatchObject({ text: "I am Sam.\n- Answer in English.\n- Use tables for prices." });
    expect(applyMemoryNoteEdit("Only line.", { find: "Only line.", kind: "remove" })).toMatchObject({ text: "" });
  });

  it("refuses a passage that is missing or appears more than once, and a change that changes nothing", () => {
    expect(applyMemoryNoteEdit(NOTE, { find: "Answer in German.", kind: "replace", text: "x" })).toEqual({ code: "memory_note_passage_not_found" });
    expect(applyMemoryNoteEdit(NOTE, { find: "- ", kind: "remove" })).toEqual({ code: "memory_note_passage_ambiguous", occurrences: 2 });
    expect(applyMemoryNoteEdit(NOTE, { find: "English", kind: "replace", text: "English" })).toEqual({ code: "memory_note_unchanged" });
  });

  it("refuses a note over the limit in code points with the size it would reach, never truncating it", () => {
    const full = "😀".repeat(MEMORY_NOTE_MAX_CHARACTERS - 3);
    expect(applyMemoryNoteEdit(full, { kind: "add", text: "ab" })).toMatchObject({ text: `${full}\nab` });
    expect(applyMemoryNoteEdit(full, { kind: "add", text: "abc" })).toEqual({ characters: MEMORY_NOTE_MAX_CHARACTERS + 1, code: "memory_note_too_long" });
    expect(applyMemoryNoteEdit(`${full}xy`, { find: "xy", kind: "replace", text: "wxyz" }))
      .toEqual({ characters: MEMORY_NOTE_MAX_CHARACTERS + 1, code: "memory_note_too_long" });
  });

  it("takes only passages that are not blank, fit the note and can be stored", () => {
    expect(memoryNotePassageValid("Call me Sam.")).toBe(true);
    for (const value of ["", "  \n", "x".repeat(MEMORY_NOTE_MAX_CHARACTERS + 1), "nul\u0000", "lone \uD83D", 7, null]) {
      expect(memoryNotePassageValid(value), JSON.stringify(value)).toBe(false);
    }
  });

  it("rebuilds an offer's edit from what it stored", () => {
    expect(memoryNoteEditOf("add", null, "A.")).toEqual({ kind: "add", text: "A." });
    expect(memoryNoteEditOf("replace", "A.", "B.")).toEqual({ find: "A.", kind: "replace", text: "B." });
    expect(memoryNoteEditOf("remove", "A.", null)).toEqual({ find: "A.", kind: "remove" });
    expect(memoryNoteEditOf("replace", null, "B.")).toBeNull();
  });
});

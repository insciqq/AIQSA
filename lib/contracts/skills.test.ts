import { describe, expect, it } from "vitest";
import {
  decodeSkillDraft,
  decodeSkillIds,
  decodeSkillsSelection,
  SKILL_INSTRUCTIONS_MAX_LENGTH,
  SKILL_MAX_SELECTED
} from "./skills";

describe("Skill contracts", () => {
  it("defaults selection to Auto and accepts only the bounded mode control", () => {
    expect(decodeSkillsSelection(undefined)).toEqual({ mode: "auto" });
    expect(decodeSkillsSelection({ mode: "off" })).toEqual({ mode: "off" });
    for (const value of [null, {}, { mode: "always" }, { mode: "auto", skillIds: [] }]) {
      expect(decodeSkillsSelection(value)).toBeNull();
    }
  });
  it("accepts and trims a plain text-only draft", () => {
    expect(decodeSkillDraft({
      description: "  Editorial workflow  ",
      instructions: "  Verify claims, then make the answer concise.  ",
      name: "  Careful editor  "
    })).toEqual({
      draft: {
        description: "Editorial workflow",
        instructions: "Verify claims, then make the answer concise.",
        name: "Careful editor"
      },
      ok: true
    });
  });

  it("rejects unknown fields and gives precise required and UTF-8 field bounds", () => {
    expect(decodeSkillDraft({
      description: "",
      instructions: "Do the work",
      name: "Unsafe",
      script: "process.exit()"
    })).toEqual({ code: "skill_draft_invalid", ok: false });
    expect(decodeSkillDraft({
      description: "A description",
      instructions: "x".repeat(SKILL_INSTRUCTIONS_MAX_LENGTH + 1),
      name: "Too large"
    })).toEqual({ code: "skill_field_too_long", field: "instructions", actual: SKILL_INSTRUCTIONS_MAX_LENGTH + 1, limit: SKILL_INSTRUCTIONS_MAX_LENGTH, ok: false });
    expect(decodeSkillDraft({ name: "Name", instructions: "Do work" }))
      .toEqual({ code: "skill_field_required", field: "description", ok: false });
  });

  it("preserves selected order while rejecting duplicates and overflow", () => {
    expect(decodeSkillIds([" skill-b ", "skill-a"])).toEqual({
      ids: ["skill-b", "skill-a"],
      ok: true
    });
    expect(decodeSkillIds(["skill-a", " skill-a "])).toEqual({
      code: "skills_invalid",
      ok: false
    });
    expect(decodeSkillIds(Array.from({ length: SKILL_MAX_SELECTED + 1 }, (_, index) => `skill-${index}`)))
      .toEqual({ code: "skills_count_exceeded", field: "pinned", actual: SKILL_MAX_SELECTED + 1, limit: SKILL_MAX_SELECTED, ok: false });
  });
});

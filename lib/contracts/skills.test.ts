import { describe, expect, it } from "vitest";
import {
  decodeSkillDraft,
  decodeSkillIds,
  SKILL_INSTRUCTIONS_MAX_LENGTH,
  SKILL_MAX_SELECTED
} from "./skills";

describe("Skill contracts", () => {
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

  it("rejects executable-looking extra fields and invalid instruction bounds", () => {
    expect(decodeSkillDraft({
      description: "",
      instructions: "Do the work",
      name: "Unsafe",
      script: "process.exit()"
    })).toEqual({ code: "skill_draft_invalid", ok: false });
    expect(decodeSkillDraft({
      description: "",
      instructions: "x".repeat(SKILL_INSTRUCTIONS_MAX_LENGTH + 1),
      name: "Too large"
    })).toEqual({ code: "skill_draft_invalid", ok: false });
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
      .toEqual({ code: "skills_invalid", ok: false });
  });
});

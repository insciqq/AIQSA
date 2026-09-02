import { describe, expect, it } from "vitest";
import { containsKnowledgeClaimMarkdownEmphasisV1 } from "./answerClaimMarkdownV1";

describe("Knowledge claim CommonMark emphasis boundaries", () => {
  it("recognizes actual emphasis and strong-emphasis delimiter pairs", () => {
    const values = [
      "_emphasized_",
      "__strong__",
      "_(grouped)_.",
      "_outer_with_inner_",
      "alpha *emphasized* omega",
      "alpha**strong**omega"
    ];
    for (const value of values) {
      expect(containsKnowledgeClaimMarkdownEmphasisV1(value)).toBe(true);
    }
  });

  it("keeps mathematical subscripts and identifiers literal", () => {
    const values = [
      "The maps X̃×_X Y and X̃×_X Z form two cartesian squares.",
      "The values source_id and source_version_id remain distinct.",
      "_foo_bar",
      "_пристаням_стремятся",
      "One unmatched _ marker is literal."
    ];
    for (const value of values) {
      expect(containsKnowledgeClaimMarkdownEmphasisV1(value)).toBe(false);
    }
  });
});

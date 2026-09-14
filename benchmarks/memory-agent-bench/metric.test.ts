import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeAnswer, selectQuestionIndices, substringExactMatch } from "./metric";

describe("pinned FactConsolidation metric", () => {
  it("uses ASCII punctuation/article/whitespace normalization and accepts aliases", () => {
    expect(normalizeAnswer("  The U.S.A., an example! ")).toBe("usa example");
    expect(substringExactMatch("Answer: The Netherlands.", ["Holland", "Netherlands"])).toBe(true);
    expect(substringExactMatch("Belgium", ["Netherlands"])).toBe(false);
    expect(normalizeAnswer("Кот — ‘Milo’")).toBe("кот — ‘milo’");
    expect(normalizeAnswer("Aå \u0085 the\u001cZoo")).toBe("aå zoo");
  });
  it("preserves upstream weaknesses as diagnostics instead of silently changing the score", () => {
    expect(substringExactMatch("It is not London; it is York.", ["London"])).toBe(true);
    expect(substringExactMatch("carpet", ["car"])).toBe(true);
    expect(() => substringExactMatch("Anything", ["the"])).toThrow("answers_invalid");
  });
  it("selects by question identity independently of answers and returns upstream order", () => {
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const ids = ["sh_no0", "sh_no1", "sh_no2", "sh_no3", "sh_no4"];
    const selected = selectQuestionIndices(ids, 3, "frozen", digest);
    expect(selected).toEqual([...selected].sort((a, b) => a - b));
    expect(selected.map((index) => ids[index]).sort()).toEqual(selectQuestionIndices([...ids].reverse(), 3, "frozen", digest).map((index) => [...ids].reverse()[index]).sort());
    expect(() => selectQuestionIndices(["a", "a"], 1, "frozen", digest)).toThrow();
    expect(() => selectQuestionIndices(ids, 6, "frozen", digest)).toThrow();
  });
});

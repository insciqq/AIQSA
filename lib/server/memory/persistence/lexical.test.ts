import { describe, expect, it } from "vitest";
import { normalizeMemorySearchText } from "./lexical";

describe("Memory lexical normalization", () => {
  it.each([
    ["ЁЛКА", "елка"],
    ["ёлка", "елка"],
    ["Елка", "елка"]
  ])("uses one canonical Russian spelling for %s", (input, expected) => {
    expect(normalizeMemorySearchText(input)).toBe(expected);
  });

  it("normalizes Unicode width, case, and whitespace before indexing", () => {
    expect(normalizeMemorySearchText("  ＦＯＯ\tBar\nBaz  ")).toBe("foo bar baz");
  });
});

import { describe, expect, it } from "vitest";
import { normalizeMemorySearchText } from "./lexical";

describe("Memory lexical normalization", () => {
  it.each([
    ["ЁЛКА", "ёлка"],
    ["ёлка", "ёлка"],
    ["Елка", "елка"]
  ])("normalizes compatibility and case without folding letters for %s", (input, expected) => {
    expect(normalizeMemorySearchText(input)).toBe(expected);
  });

  it("keeps е and ё as distinct primary lexical identities", () => {
    expect(normalizeMemorySearchText("Елка")).not.toBe(
      normalizeMemorySearchText("Ёлка")
    );
  });

  it("normalizes Unicode width, case, and whitespace before indexing", () => {
    expect(normalizeMemorySearchText("  ＦＯＯ\tBar\nBaz  ")).toBe("foo bar baz");
  });
});

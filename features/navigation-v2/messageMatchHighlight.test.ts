import { describe, expect, it } from "vitest";
import { highlightSegments } from "./messageMatchHighlight";

describe("message match highlight", () => {
  it("marks every case-insensitive occurrence, Cyrillic included", () => {
    expect(highlightSegments("Budget review: the BUDGET moved", "budget")).toEqual([
      { match: true, text: "Budget" },
      { match: false, text: " review: the " },
      { match: true, text: "BUDGET" },
      { match: false, text: " moved" }
    ]);
    expect(highlightSegments("…обсудили Бюджет на март…", "бюджет")).toEqual([
      { match: false, text: "…обсудили " },
      { match: true, text: "Бюджет" },
      { match: false, text: " на март…" }
    ]);
  });

  it("treats regular expression characters literally and spans collapsed whitespace", () => {
    expect(highlightSegments("costs (50%) [draft] a.b", "(50%) [draft]")).toEqual([
      { match: false, text: "costs " },
      { match: true, text: "(50%) [draft]" },
      { match: false, text: " a.b" }
    ]);
    expect(highlightSegments("aXb a.b", "a.b")).toEqual([
      { match: false, text: "aXb " },
      { match: true, text: "a.b" }
    ]);
    expect(highlightSegments("release notes ready", "release   notes")).toEqual([
      { match: true, text: "release notes" },
      { match: false, text: " ready" }
    ]);
  });

  it("returns the text unmarked when the query is empty or absent from it", () => {
    expect(highlightSegments("plain text", "  ")).toEqual([{ match: false, text: "plain text" }]);
    expect(highlightSegments("plain text", "missing")).toEqual([{ match: false, text: "plain text" }]);
  });
});

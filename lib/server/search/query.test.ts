import { describe, expect, it } from "vitest";
import { validateSearchToolArguments } from "./query";

describe("search tool query validation", () => {
  it.each([
    ["missing", {}],
    ["empty", { query: "" }],
    ["whitespace", { query: " \t\n " }],
    ["wrong type", { query: 42 }],
    ["extra property", { extra: true, query: "current news" }],
    ["unknown alias", { keyword: "current news" }],
    ["array", ["current news"]]
  ])("rejects %s arguments", (_label, value) => {
    expect(validateSearchToolArguments(value, 100)).toMatchObject({ ok: false });
  });

  it("rejects rather than truncates an oversized query", () => {
    expect(validateSearchToolArguments({ query: "x".repeat(101) }, 100)).toEqual({
      code: "search_query_too_long",
      ok: false
    });
  });

  it("normalizes control characters and surrounding whitespace", () => {
    expect(validateSearchToolArguments({ query: "  latest\u0000\tnews\n today  " }, 100))
      .toMatchObject({ ok: true, query: "latest news today" });
  });
});

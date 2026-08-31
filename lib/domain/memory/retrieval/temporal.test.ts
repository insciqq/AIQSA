import { describe, expect, it } from "vitest";
import { parseMemoryTemporalQuery } from "./temporal";

const now = new Date("2026-08-27T12:00:00.000Z");

function parse(query: string, timeZone = "UTC", anchor = now) {
  return parseMemoryTemporalQuery({ now: anchor, query, timeZone });
}

function expectInterval(
  query: string,
  from: string,
  to: string,
  timeZone = "UTC"
): void {
  const result = parse(query, timeZone);
  expect(result).toMatchObject({
    confidence: "HIGH",
    expressionType: "EXPLICIT_DATE",
    state: "MATCHED"
  });
  expect(result.interval?.from?.toISOString()).toBe(from);
  expect(result.interval?.to?.toISOString()).toBe(to);
}

describe("deterministic language-neutral Memory temporal query parsing", () => {
  it.each([
    ["2025-12-31", "2025-12-31T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    ["31.12.2025", "2025-12-31T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    ["12/31/2025", "2025-12-31T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    ["٢٠٢٥-١٢-٣١", "2025-12-31T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    ["३१.१२.२०२५", "2025-12-31T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    ["𝟚𝟘𝟚𝟝-𝟙𝟚-𝟛𝟙", "2025-12-31T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    ["0099-12-31", "0099-12-31T00:00:00.000Z", "0100-01-01T00:00:00.000Z"]
  ])("resolves numeric calendar syntax %s", (query, from, to) => {
    expectInterval(query, from, to);
  });

  it("anchors numeric calendar days in the accepted timezone and across DST", () => {
    expectInterval(
      "2025-12-31",
      "2025-12-31T08:00:00.000Z",
      "2026-01-01T08:00:00.000Z",
      "America/Los_Angeles"
    );
    expectInterval(
      "2026-03-29",
      "2026-03-28T22:00:00.000Z",
      "2026-03-29T21:00:00.000Z",
      "Europe/Helsinki"
    );
  });

  it.each([
    "today",
    "вчера",
    "mañana",
    "غدًا",
    "कल",
    "明日",
    "before 2025-01-15",
    "после 31.12.2025",
    "2025-01-15まで",
    "remember my preferred editor"
  ])("leaves natural-language temporal meaning unrestricted: %s", (query) => {
    expect(parse(query)).toMatchObject({
      confidence: null,
      interval: null,
      matchedExpressionCount: 0,
      state: "NO_MATCH"
    });
  });

  it("does not infer ambiguous, conflicting, malformed, or impossible dates", () => {
    expect(parse("03/04/2025")).toMatchObject({
      matchedExpressionCount: 1,
      state: "AMBIGUOUS"
    });
    expect(parse("2025-01-01 2025-01-02")).toMatchObject({
      matchedExpressionCount: 2,
      state: "AMBIGUOUS"
    });
    expect(parse("31.02.2025")).toMatchObject({ state: "INVALID" });
    expect(parse("2025/12/31")).toMatchObject({ state: "INVALID" });
    expect(parse("31/12-2025")).toMatchObject({ state: "INVALID" });
  });

  it("bounds diagnostics while allowing a repeated identical numeric bound", () => {
    expect(parse(Array.from({ length: 20 }, () => "2025-12-31").join(" ")))
      .toMatchObject({
        matchedExpressionCount: 8,
        state: "MATCHED"
      });
  });

  it("fails closed for invalid parser inputs", () => {
    expect(parse("2025-12-31", "Mars/Olympus_Mons"))
      .toMatchObject({ state: "INVALID" });
    expect(parseMemoryTemporalQuery({
      now: new Date("invalid"),
      query: "2025-12-31",
      timeZone: "UTC"
    })).toMatchObject({ state: "INVALID" });
  });
});

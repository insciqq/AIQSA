import { describe, expect, it } from "vitest";
import { parseMemoryTemporalQuery } from "./temporal";

const now = new Date("2026-08-27T12:00:00.000Z");

function parse(query: string, timeZone = "UTC", anchor = now) {
  return parseMemoryTemporalQuery({ now: anchor, query, timeZone });
}

function expectInterval(
  query: string,
  from: string | null,
  to: string | null,
  options: Readonly<{
    confidence?: "HIGH" | "MEDIUM";
    timeZone?: string;
    type?: string;
  }> = {}
): void {
  const result = parse(query, options.timeZone);
  expect(result).toMatchObject({
    confidence: options.confidence ?? "HIGH",
    expressionType: options.type,
    state: "MATCHED"
  });
  expect(result.interval?.from?.toISOString() ?? null).toBe(from);
  expect(result.interval?.to?.toISOString() ?? null).toBe(to);
}

describe("deterministic EN/RU Memory temporal query parsing", () => {
  it.each([
    ["today", "2026-08-27T00:00:00.000Z", "2026-08-28T00:00:00.000Z"],
    ["yesterday", "2026-08-26T00:00:00.000Z", "2026-08-27T00:00:00.000Z"],
    ["tomorrow", "2026-08-28T00:00:00.000Z", "2026-08-29T00:00:00.000Z"],
    ["сегодня", "2026-08-27T00:00:00.000Z", "2026-08-28T00:00:00.000Z"],
    ["вчера", "2026-08-26T00:00:00.000Z", "2026-08-27T00:00:00.000Z"],
    ["завтра", "2026-08-28T00:00:00.000Z", "2026-08-29T00:00:00.000Z"]
  ])("resolves relative day %s", (query, from, to) => {
    expectInterval(query, from, to, { type: "RELATIVE_DAY" });
  });

  it.each([
    ["this week", "2026-08-24T00:00:00.000Z", "2026-08-31T00:00:00.000Z"],
    ["last month", "2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z"],
    ["next year", "2027-01-01T00:00:00.000Z", "2028-01-01T00:00:00.000Z"],
    ["эта неделя", "2026-08-24T00:00:00.000Z", "2026-08-31T00:00:00.000Z"],
    ["в прошлом месяце", "2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z"],
    ["следующий год", "2027-01-01T00:00:00.000Z", "2028-01-01T00:00:00.000Z"]
  ])("resolves calendar period %s", (query, from, to) => {
    expectInterval(query, from, to, { type: "RELATIVE_PERIOD" });
  });

  it.each([
    ["3 days ago", "2026-08-24T00:00:00.000Z", "2026-08-25T00:00:00.000Z"],
    ["2 weeks ago", "2026-08-10T00:00:00.000Z", "2026-08-17T00:00:00.000Z"],
    ["1 month ago", "2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z"],
    ["2 years ago", "2024-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z"],
    ["3 дня назад", "2026-08-24T00:00:00.000Z", "2026-08-25T00:00:00.000Z"],
    ["2 недели назад", "2026-08-10T00:00:00.000Z", "2026-08-17T00:00:00.000Z"],
    ["1 месяц назад", "2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z"],
    ["2 года назад", "2024-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z"]
  ])("resolves bounded ago expression %s", (query, from, to) => {
    expectInterval(query, from, to, { type: "AGO" });
  });

  it("resolves named months and yearless named days with explicit confidence", () => {
    expectInterval("in January 2025", "2025-01-01T00:00:00.000Z",
      "2025-02-01T00:00:00.000Z", { type: "NAMED_MONTH" });
    expectInterval("в январе 2025", "2025-01-01T00:00:00.000Z",
      "2025-02-01T00:00:00.000Z", { type: "NAMED_MONTH" });
    expectInterval("on February 10", "2026-02-10T00:00:00.000Z",
      "2026-02-11T00:00:00.000Z", { confidence: "MEDIUM", type: "NAMED_DAY" });
    expectInterval("10 февраля", "2026-02-10T00:00:00.000Z",
      "2026-02-11T00:00:00.000Z", { confidence: "MEDIUM", type: "NAMED_DAY" });
  });

  it("resolves explicit ISO and unambiguous local dates", () => {
    expectInterval("on 2025-12-31", "2025-12-31T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z", { type: "EXPLICIT_DATE" });
    expectInterval("31.12.2025", "2025-12-31T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z", { type: "EXPLICIT_DATE" });
    expectInterval("12/31/2025", "2025-12-31T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z", { type: "EXPLICIT_DATE" });
    expectInterval("on February 10, 2025", "2025-02-10T00:00:00.000Z",
      "2025-02-11T00:00:00.000Z", { type: "EXPLICIT_DATE" });
    expectInterval("10 февраля 2025", "2025-02-10T00:00:00.000Z",
      "2025-02-11T00:00:00.000Z", { type: "EXPLICIT_DATE" });
    expectInterval("0099-12-31", "0099-12-31T00:00:00.000Z",
      "0100-01-01T00:00:00.000Z", { type: "EXPLICIT_DATE" });
  });

  it("resolves open bounds without turning them into exact instants", () => {
    expectInterval("before 2025-01-15", null, "2025-01-15T00:00:00.000Z",
      { type: "BEFORE" });
    expectInterval("после 31.12.2025", "2026-01-01T00:00:00.000Z", null,
      { type: "AFTER" });
    expectInterval("since yesterday", "2026-08-26T00:00:00.000Z", null,
      { type: "SINCE" });
    expectInterval("с вчера", "2026-08-26T00:00:00.000Z", null,
      { type: "SINCE" });
  });

  it("resolves inclusive calendar ranges in both languages", () => {
    expectInterval("between 2025-01-01 and 2025-01-31",
      "2025-01-01T00:00:00.000Z", "2025-02-01T00:00:00.000Z", { type: "RANGE" });
    expectInterval("с 10 февраля по 12 февраля",
      "2026-02-10T00:00:00.000Z", "2026-02-13T00:00:00.000Z",
      { confidence: "MEDIUM", type: "RANGE" });
  });

  it("anchors calendar days in the accepted timezone across date and DST boundaries", () => {
    const losAngeles = parse("today", "America/Los_Angeles",
      new Date("2026-01-01T01:30:00.000Z"));
    expect(losAngeles.interval?.from?.toISOString()).toBe("2025-12-31T08:00:00.000Z");
    expect(losAngeles.interval?.to?.toISOString()).toBe("2026-01-01T08:00:00.000Z");

    const helsinki = parse("сегодня", "Europe/Helsinki",
      new Date("2026-03-29T12:00:00.000Z"));
    expect(helsinki.interval?.from?.toISOString()).toBe("2026-03-28T22:00:00.000Z");
    expect(helsinki.interval?.to?.toISOString()).toBe("2026-03-29T21:00:00.000Z");
  });

  it("does not hard-interpret ambiguous, conflicting, invalid, or unrelated text", () => {
    expect(parse("03/04/2025")).toMatchObject({ state: "AMBIGUOUS", interval: null });
    expect(parse("today or tomorrow")).toMatchObject({
      matchedExpressionCount: 2,
      state: "AMBIGUOUS"
    });
    expect(parse("31.02.2025")).toMatchObject({ state: "INVALID", interval: null });
    expect(parse("between 2025-02-01 and 2025-01-01")).toMatchObject({ state: "INVALID" });
    expect(parse("remember my preferred editor")).toMatchObject({ state: "NO_MATCH" });
    expect(parse("today", "Mars/Olympus_Mons")).toMatchObject({ state: "INVALID" });
  });

  it("bounds diagnostics without turning repeated expressions into a blocking plan", () => {
    expect(parse(Array.from({ length: 20 }, () => "today").join(" "))).toMatchObject({
      matchedExpressionCount: 8,
      state: "MATCHED"
    });
  });
});

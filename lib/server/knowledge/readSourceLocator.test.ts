import { describe, expect, it } from "vitest";
import {
  canonicalReadSourceLocator,
  normalizeReadSourceLocator,
  normalizeReadSourceRequest,
  READ_SOURCE_LOCATOR_CONTRACT_VERSION,
  readSourceA1RangeContains,
  type ReadSourceLocator
} from "./readSourceLocator";

const sectionId = `kis_${"a".repeat(40)}`;
const passageId = `kip_${"b".repeat(40)}`;
const blockId = `b_${"c".repeat(24)}_12`;
const rowId = `ktr_${"d".repeat(32)}`;

describe("read_source locator contract", () => {
  it("accepts current and legacy evidence handles with an optional explicit tag", () => {
    expect(normalizeReadSourceLocator("K12")).toEqual({
      handle: "K12",
      kind: "evidence_handle"
    });
    expect(normalizeReadSourceLocator("handle: K4.1")).toEqual({
      handle: "K4.1",
      kind: "evidence_handle"
    });
    expect(normalizeReadSourceLocator("passage-handle:K2048")).toEqual({
      handle: "K2048",
      kind: "evidence_handle"
    });

    for (const malformed of ["K0", "K2049", "K257.1", "K1.9", "handle:", "handle: [K1]"]) {
      expect(normalizeReadSourceLocator(malformed), malformed).toBeNull();
    }
  });

  it("normalizes labeled page locators without accepting ranges or invalid bounds", () => {
    for (const value of ["page 9", "page:#9", "p. 9", "страница 9", "стр. #9"]) {
      expect(normalizeReadSourceLocator(value), value).toEqual({ kind: "page", page: 9 });
    }
    expect(normalizeReadSourceLocator("page 000009")).toEqual({ kind: "page", page: 9 });

    for (const malformed of ["page 0", "page 1000000", "page 1-2", "page: nine", "p. -1"]) {
      expect(normalizeReadSourceLocator(malformed), malformed).toBeNull();
    }
  });

  it("normalizes exact displayed heading and section paths while preserving bare compatibility", () => {
    expect(normalizeReadSourceLocator("  heading:  Lab  >  Results  ")).toEqual({
      headingPath: ["Lab", "Results"],
      kind: "heading"
    });
    expect(normalizeReadSourceLocator("section: Условия › Оплата")).toEqual({
      headingPath: ["Условия", "Оплата"],
      kind: "heading"
    });
    expect(normalizeReadSourceLocator("Overview: retained compatibility")).toEqual({
      headingPath: ["Overview: retained compatibility"],
      kind: "heading"
    });
    expect(normalizeReadSourceLocator("Ｌａｂ　›　Results")).toEqual({
      headingPath: ["Lab", "Results"],
      kind: "heading"
    });

    for (const malformed of [
      "heading:",
      "heading: Lab › › Results",
      "heading: Lab\nResults",
      `heading:${"x".repeat(257)}`,
      `heading:${Array.from({ length: 17 }, (_, index) => `H${index}`).join(" › ")}`
    ]) {
      expect(normalizeReadSourceLocator(malformed), malformed.slice(0, 60)).toBeNull();
    }
  });

  it("accepts only exact generated section, passage, block, and table-row identities", () => {
    expect(normalizeReadSourceLocator(`section-id:${sectionId}`)).toEqual({
      kind: "section",
      sectionId
    });
    expect(normalizeReadSourceLocator(`section:${sectionId}`)).toEqual({
      kind: "section",
      sectionId
    });
    expect(normalizeReadSourceLocator(`passage:${passageId}`)).toEqual({
      kind: "passage",
      passageId
    });
    expect(normalizeReadSourceLocator(`block:${blockId}`)).toEqual({ blockId, kind: "block" });
    expect(normalizeReadSourceLocator(`row:${rowId}`)).toEqual({ kind: "row", rowId });
    expect(normalizeReadSourceLocator(`table-row:${rowId}`)).toEqual({ kind: "row", rowId });

    for (const malformed of [
      "section-id:kis_short",
      `passage:kip_${"B".repeat(40)}`,
      `block:b_${"c".repeat(23)}_12`,
      `block:b_${"c".repeat(24)}_01`,
      `block:b_${"c".repeat(24)}_1000000`,
      rowId,
      `row:ktr_${"d".repeat(31)}`,
      `row:ktr_${"D".repeat(32)}`,
      `row:ktr_${"d".repeat(33)}`
    ]) {
      expect(normalizeReadSourceLocator(malformed), malformed).toBeNull();
    }
  });

  it("normalizes exact structured sheet/range locators and quoted sheet names", () => {
    expect(normalizeReadSourceLocator("range:Revenue 2030!a1:b20")).toEqual({
      kind: "structured_range",
      range: "A1:B20",
      sheet: "Revenue 2030"
    });
    expect(normalizeReadSourceLocator("range:'Owner''s ! Plan'!A1:A1")).toEqual({
      kind: "structured_range",
      range: "A1",
      sheet: "Owner's ! Plan"
    });
    expect(normalizeReadSourceLocator("structured:'Лист 1'!SR100000")).toEqual({
      kind: "structured_range",
      range: "SR100000",
      sheet: "Лист 1"
    });

    for (const malformed of [
      "range:Sheet 1",
      "range:!A1",
      "range:One!Two!A1",
      "range:'Unclosed!A1",
      "range:Sheet!A0",
      "range:Sheet!A2:A1",
      "range:Sheet!B1:A1",
      "range:Sheet!SS1",
      "range:Sheet!A100001",
      "range:Sheet!A1:B2:C3"
    ]) {
      expect(normalizeReadSourceLocator(malformed), malformed).toBeNull();
    }
  });

  it("checks canonical structured-range containment without widening malformed input", () => {
    expect(readSourceA1RangeContains("A1:C20", "B2:C19")).toBe(true);
    expect(readSourceA1RangeContains("b2:c19", "B2:C19")).toBe(true);
    expect(readSourceA1RangeContains("A1:C20", "A1:C20")).toBe(true);
    expect(readSourceA1RangeContains("A1:C20", "D1:D2")).toBe(false);
    expect(readSourceA1RangeContains("B2:C19", "A1:C20")).toBe(false);
    expect(readSourceA1RangeContains("A0:C20", "B2:C19")).toBe(false);
    expect(readSourceA1RangeContains("A1:C20", "B2:C1")).toBe(false);
  });

  it("serializes every target canonically and parses that representation idempotently", () => {
    const inputs = [
      "handle:K1",
      "page:#7",
      "section:Lab > Results",
      `section-id:${sectionId}`,
      `passage:${passageId}`,
      `block:${blockId}`,
      `row:${rowId}`,
      "range:'Owner''s Plan'!a1:b2"
    ];
    for (const input of inputs) {
      const parsed = normalizeReadSourceLocator(input);
      expect(parsed, input).not.toBeNull();
      const canonical = canonicalReadSourceLocator(parsed as ReadSourceLocator);
      expect(normalizeReadSourceLocator(canonical), canonical).toEqual(parsed);
    }
  });

  it("freezes a bounded exact request whose contract forbids embeddings", () => {
    const normalized = normalizeReadSourceRequest({
      direction: "after",
      locator: " heading: Lab > Results ",
      window: 8
    });
    expect(normalized).toEqual({
      contractVersion: READ_SOURCE_LOCATOR_CONTRACT_VERSION,
      direction: "after",
      embedding: "forbidden",
      locator: "heading: Lab › Results",
      resolution: "exact",
      target: { headingPath: ["Lab", "Results"], kind: "heading" },
      window: 8
    });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized?.target)).toBe(true);
    expect(Object.isFrozen(normalized?.target.kind === "heading"
      ? normalized.target.headingPath
      : null)).toBe(true);

    expect(normalizeReadSourceRequest({ locator: "K1" })).toMatchObject({
      direction: "around",
      locator: "K1",
      window: 3
    });
    expect(normalizeReadSourceRequest({ direction: null, locator: "page 2", window: null }))
      .toMatchObject({ direction: "around", locator: "page 2", window: 3 });
  });

  it("fails closed for malformed direction, window, locator type, and control text", () => {
    for (const input of [
      { direction: "sideways", locator: "K1", window: 3 },
      { direction: "around", locator: "K1", window: 0 },
      { direction: "around", locator: "K1", window: 9 },
      { direction: "around", locator: "K1", window: 1.5 },
      { direction: "around", locator: "K1", window: "3" },
      { direction: "around", locator: { kind: "page", page: 1 }, window: 3 },
      { direction: "around", locator: "heading: Lab\u202eResults", window: 3 }
    ]) {
      expect(normalizeReadSourceRequest(input), JSON.stringify(input)).toBeNull();
    }
  });
});

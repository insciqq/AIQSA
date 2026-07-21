import { describe, expect, it } from "vitest";
import { cloneRecord, isRecord, numberValue, recordValue } from "./shellValues";

describe("shell value helpers", () => {
  it("recognizes records without accepting arrays or null", () => {
    expect(isRecord({ value: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(recordValue({ value: 1 })).toEqual({ value: 1 });
    expect(recordValue("not-a-record")).toEqual({});
  });

  it("accepts only finite numbers", () => {
    expect(numberValue(0, 10)).toBe(0);
    expect(numberValue(Number.NaN, 10)).toBe(10);
    expect(numberValue(Number.POSITIVE_INFINITY, 10)).toBe(10);
    expect(numberValue("5", 10)).toBe(10);
  });

  it("deep-clones JSON records and falls back safely for cycles", () => {
    const input = { nested: { value: 1 } };
    const cloned = cloneRecord(input);
    expect(cloned).toEqual(input);
    expect(cloned).not.toBe(input);
    expect(cloned.nested).not.toBe(input.nested);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const fallback = cloneRecord(cyclic);
    expect(fallback).not.toBe(cyclic);
    expect(fallback.self).toBe(cyclic);
  });
});

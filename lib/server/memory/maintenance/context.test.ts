import { describe, expect, it } from "vitest";
import { memoryMaintenanceEvidenceWindow, memoryMaintenanceTailWindow } from "./context";

describe("bounded maintenance context windows", () => {
  const text = `${"a".repeat(20_000)}EVIDENCE${"b".repeat(20_000)}`;
  const span = { startOffset: 20_000, endOffset: 20_008 };
  it("keeps a short message whole", () => {
    expect(memoryMaintenanceEvidenceWindow("short", [{ startOffset: 0, endOffset: 5 }], 8_000)).toEqual({ start: 0, end: 5 });
    expect(memoryMaintenanceTailWindow("short", 8_000)).toEqual({ start: 0, end: 5 });
  });
  it("centers a bounded window on the exact evidence of a long source message", () => {
    const window = memoryMaintenanceEvidenceWindow(text, [span], 8_000);
    expect(window.end - window.start).toBe(8_000);
    expect(window.start).toBeLessThanOrEqual(span.startOffset);
    expect(window.end).toBeGreaterThanOrEqual(span.endOffset);
    expect(text.slice(window.start, window.end)).toContain("EVIDENCE");
  });
  it("covers every span of the message when they fit and stays inside the text at its edges", () => {
    const window = memoryMaintenanceEvidenceWindow(text, [{ startOffset: 18_000, endOffset: 18_010 }, span], 8_000);
    expect(window.start).toBeLessThanOrEqual(18_000);
    expect(window.end).toBeGreaterThanOrEqual(span.endOffset);
    expect(memoryMaintenanceEvidenceWindow(text, [{ startOffset: 0, endOffset: 4 }], 8_000)).toEqual({ start: 0, end: 8_000 });
    expect(memoryMaintenanceEvidenceWindow(text, [{ startOffset: text.length - 4, endOffset: text.length }], 8_000))
      .toEqual({ start: text.length - 8_000, end: text.length });
  });
  it("keeps the tail of a long preceding message, nearest to the source", () => {
    const window = memoryMaintenanceTailWindow(text, 8_000);
    expect(window).toEqual({ start: text.length - 8_000, end: text.length });
  });
  it("never splits a UTF-16 surrogate pair at a window boundary", () => {
    const emoji = "\u{1F600}";
    const wide = emoji.repeat(10_000);
    const evidence = memoryMaintenanceEvidenceWindow(wide, [{ startOffset: 10_000, endOffset: 10_002 }], 7_999);
    const tail = memoryMaintenanceTailWindow(wide, 7_999);
    for (const window of [evidence, tail]) {
      const slice = wide.slice(window.start, window.end);
      expect(slice.length % 2).toBe(0);
      expect(slice).toBe(emoji.repeat(slice.length / 2));
      expect(slice.length).toBeLessThanOrEqual(7_999);
    }
  });
});

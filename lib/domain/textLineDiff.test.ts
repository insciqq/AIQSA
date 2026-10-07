import { describe, expect, it } from "vitest";
import { boundedTextLineDiff } from "./textLineDiff";

const options = { maxLines: 80, maxLineLength: 300 };

describe("boundedTextLineDiff", () => {
  it("shows changed lines with context and gaps between distant hunks", () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
    const after = before.replace("line 2", "line two").replace("line 17", "line seventeen") + "\nline 20";
    const diff = boundedTextLineDiff(before, after, options)!;
    expect(diff.truncated).toBe(false);
    expect(diff.lines.filter((line) => line.kind === "del").map((line) => line.text)).toEqual(["line 2", "line 17"]);
    expect(diff.lines.filter((line) => line.kind === "add").map((line) => line.text)).toEqual(["line two", "line seventeen", "line 20"]);
    expect(diff.lines.filter((line) => line.kind === "gap")).toHaveLength(1);
    expect(diff.lines[0]).toEqual({ kind: "context", text: "line 0" });
  });

  it("handles additions to an empty file and identical inputs", () => {
    expect(boundedTextLineDiff("", "a\nb\n", options)!.lines).toEqual([
      { kind: "add", text: "a" }, { kind: "add", text: "b" }
    ]);
    expect(boundedTextLineDiff("same\n", "same\n", options)!.lines).toEqual([]);
  });

  it("bounds lines, line length and edit distance", () => {
    const before = Array.from({ length: 200 }, (_, index) => `old ${index}`).join("\n");
    const after = Array.from({ length: 200 }, (_, index) => `new ${index}`).join("\n");
    const bounded = boundedTextLineDiff(before, after, { maxLines: 10, maxLineLength: 300 })!;
    expect(bounded.lines).toHaveLength(10);
    expect(bounded.truncated).toBe(true);
    expect(boundedTextLineDiff(before, after, { ...options, maxEdits: 50 })).toBeNull();
    const long = boundedTextLineDiff("x", "y".repeat(400), { maxLines: 10, maxLineLength: 20 })!;
    expect(long.lines.at(-1)!.text).toHaveLength(20);
  });
});

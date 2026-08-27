import { describe, expect, it } from "vitest";
import { redactLongMemEvalDebugArtifact } from "./debug";

describe("LongMemEval debug projection", () => {
  it("removes recognized secret plaintext recursively while preserving safe context", () => {
    const token = `sk-${"a1".repeat(16)}`;
    const projected = redactLongMemEvalDebugArtifact({
      candidates: [{ text: `Safe detail beside ${token}` }],
      query: "ordinary safe query",
      timestamp: new Date("2026-08-27T00:00:00.000Z")
    });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain(token);
    expect(serialized).toContain("REDACTED");
    expect(serialized).toContain("Safe detail beside");
    expect(serialized).toContain("ordinary safe query");
    expect(serialized).toContain("2026-08-27T00:00:00.000Z");
  });

  it("rejects unsupported debug values instead of stringifying them implicitly", () => {
    expect(() => redactLongMemEvalDebugArtifact(Symbol("private")))
      .toThrow("longmemeval_debug_value_invalid");
  });

  it("redacts recognized secrets used as object keys", () => {
    const token = `sk-${"a1".repeat(16)}`;
    const serialized = JSON.stringify(redactLongMemEvalDebugArtifact({ [token]: true }));

    expect(serialized).not.toContain(token);
    expect(serialized).toContain("REDACTED");
  });

  it("preserves values when redacted object keys collide", () => {
    const first = `sk-${"a1".repeat(16)}`;
    const second = `sk-${"b2".repeat(16)}`;
    const projected = redactLongMemEvalDebugArtifact({
      [first]: "first",
      [second]: "second"
    });

    expect(projected).toEqual({
      "[REDACTED:TOKEN]": "first",
      "[REDACTED:TOKEN]#2": "second"
    });
    expect(JSON.stringify(projected)).not.toContain(first);
    expect(JSON.stringify(projected)).not.toContain(second);
  });

  it("advances past a literal key that occupies the first collision suffix", () => {
    const first = `sk-${"a1".repeat(16)}`;
    const second = `sk-${"b2".repeat(16)}`;
    const projected = redactLongMemEvalDebugArtifact({
      [first]: "first",
      "[REDACTED:TOKEN]#2": "literal suffix",
      [second]: "second"
    });

    expect(projected).toEqual({
      "[REDACTED:TOKEN]": "first",
      "[REDACTED:TOKEN]#2": "literal suffix",
      "[REDACTED:TOKEN]#3": "second"
    });
  });
});

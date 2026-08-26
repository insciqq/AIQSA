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
    expect(serialized).toContain("ordinary safe query");
    expect(serialized).toContain("2026-08-27T00:00:00.000Z");
  });

  it("rejects unsupported debug values instead of stringifying them implicitly", () => {
    expect(() => redactLongMemEvalDebugArtifact(Symbol("private")))
      .toThrow("longmemeval_debug_value_invalid");
  });
});

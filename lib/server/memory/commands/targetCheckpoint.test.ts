import { describe, expect, it } from "vitest";
import { memoryCommandTargetCheckpoint, decodeMemoryCommandTargetCheckpoint } from "./targetCheckpoint";

const result = { acceptedOutputHash: "a".repeat(64), bindingId: "selection",
  candidateMapHash: "b".repeat(64), selectedHandle: "c0", status: "READY" as const };

describe("Memory command target recovery checkpoint", () => {
  it("retains only exact target identities and accepted selection evidence", () => {
    const checkpoint = memoryCommandTargetCheckpoint([{ target: {
      factId: "fact", versionId: "version", statement: "private statement", summary: { private: true }
    } } as never], result);
    expect(checkpoint).toEqual({ candidates: [{ factId: "fact", versionId: "version" }], result });
    expect(JSON.stringify(checkpoint)).not.toContain("private");
    expect(decodeMemoryCommandTargetCheckpoint({ targetSelection: checkpoint })).toEqual(checkpoint);
  });

  it("rejects missing, out-of-range, duplicate and expanded checkpoint evidence", () => {
    const checkpoint = { candidates: [{ factId: "fact", versionId: "version" }], result };
    expect(decodeMemoryCommandTargetCheckpoint(null)).toBeNull();
    expect(decodeMemoryCommandTargetCheckpoint({ targetSelection: { ...checkpoint, result: { ...result, selectedHandle: "c1" } } })).toBeNull();
    expect(decodeMemoryCommandTargetCheckpoint({ targetSelection: { ...checkpoint, candidates: [...checkpoint.candidates, ...checkpoint.candidates] } })).toBeNull();
    expect(decodeMemoryCommandTargetCheckpoint({ targetSelection: { ...checkpoint, statement: "private" } })).toBeNull();
  });
});

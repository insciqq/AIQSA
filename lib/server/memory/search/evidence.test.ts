import { describe, expect, it } from "vitest";
import { memorySearchItemMatchesProof } from "./evidence";
import { memorySha256 } from "../persistence/lexical";
import type { MemoryPreparingItemInput } from "../../runs/preparingRun";
import type { ResolvedPreparingMemoryItem } from "../../runs/preparingMemoryItems";
describe("native search exact projection proof", () => {
  it("rejects an injected prefix even when the old resolver accepts the canonical suffix", () => {
    const proof = { exactItemId: "fact", itemType: "FACT_VERSION", exactSafeText: "Untrusted prefix. Owner fact.",
      sourceSnapshot: { projectedTextHash: memorySha256("Owner fact.") } } as unknown as ResolvedPreparingMemoryItem;
    expect(memorySearchItemMatchesProof(proof as unknown as MemoryPreparingItemInput, proof)).toBe(false);
    const exact = { ...proof, exactSafeText: "Owner fact." };
    expect(memorySearchItemMatchesProof(exact as unknown as MemoryPreparingItemInput, exact)).toBe(true);
  });
  it("requires both exact identity and exact packed text", () => {
    const proof = { exactItemId: "round", itemType: "RECALL_ROUND", exactSafeText: "user: old statement" } as ResolvedPreparingMemoryItem;
    expect(memorySearchItemMatchesProof({ ...proof, exactItemId: "other" } as unknown as MemoryPreparingItemInput, proof)).toBe(false);
    expect(memorySearchItemMatchesProof({ ...proof, exactSafeText: "user: changed statement" } as unknown as MemoryPreparingItemInput, proof)).toBe(false);
  });
});

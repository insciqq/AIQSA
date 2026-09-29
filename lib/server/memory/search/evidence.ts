import { memorySha256 } from "../persistence/lexical";
import type { MemoryPreparingItemInput } from "../../runs/preparingRun";
import type { ResolvedPreparingMemoryItem } from "../../runs/preparingMemoryItems";

/** Older admission permits a display prefix; native search accepts only the exact packed projection. */
export function memorySearchItemMatchesProof(input: MemoryPreparingItemInput, proof: ResolvedPreparingMemoryItem): boolean {
  if (proof.exactSafeText !== input.exactSafeText || proof.exactItemId !== input.exactItemId || proof.itemType !== input.itemType) return false;
  // Round resolution already compares exact canonical segment/raw text at its authority boundary.
  if (proof.itemType === "RECALL_ROUND") return true;
  return proof.sourceSnapshot.projectedTextHash === memorySha256(input.exactSafeText.replace(/\s+/gu, " ").trim());
}

import { z } from "zod";
import type { MemoryActionTarget } from "../actions/targetSearch";
import type { MemoryTargetSelectorResult } from "../actions/targetSelector";

const identifier = z.string().min(1).max(256).regex(/^[^\u0000-\u0020\u007f]+$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const checkpointSchema = z.strictObject({
  candidates: z.array(z.strictObject({ factId: identifier, versionId: identifier })).min(1).max(5),
  result: z.strictObject({ acceptedOutputHash: hash, bindingId: identifier,
    candidateMapHash: hash, selectedHandle: z.enum(["c0", "c1", "c2", "c3", "c4"]).nullable(),
    status: z.literal("READY") })
});
export type MemoryCommandTargetCheckpoint = z.infer<typeof checkpointSchema>;

export function decodeMemoryCommandTargetCheckpoint(value: unknown): MemoryCommandTargetCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed = checkpointSchema.safeParse((value as Record<string, unknown>).targetSelection);
  if (!parsed.success || new Set(parsed.data.candidates.map((candidate) => candidate.factId)).size !== parsed.data.candidates.length) return null;
  const selected = parsed.data.result.selectedHandle;
  return selected === null || Number(selected.slice(1)) < parsed.data.candidates.length ? parsed.data : null;
}

export function memoryCommandTargetCheckpoint(
  candidates: readonly Readonly<{ target: MemoryActionTarget }>[],
  result: Extract<MemoryTargetSelectorResult, { status: "READY" }>
): MemoryCommandTargetCheckpoint | null {
  return decodeMemoryCommandTargetCheckpoint({ targetSelection: {
    candidates: candidates.map(({ target }) => ({ factId: target.factId, versionId: target.versionId })), result
  } });
}

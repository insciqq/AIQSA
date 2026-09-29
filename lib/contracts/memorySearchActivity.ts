export type MemorySearchActivityOutcome = "results" | "no_results" | "limited" | "failure" | "cancelled";
export type MemorySearchActivitySnapshot = Readonly<{
  call: number;
  round: number;
  status: "running" | "complete" | "error" | "cancelled";
  outcome?: MemorySearchActivityOutcome;
  durationMs?: number;
}>;

export function isMemorySearchActivityOutcome(value: unknown): value is MemorySearchActivityOutcome {
  return value === "results" || value === "no_results" || value === "limited" ||
    value === "failure" || value === "cancelled";
}

export function decodeMemorySearchActivity(value: unknown): MemorySearchActivitySnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["call", "round", "status", "outcome", "durationMs"].includes(key))) return null;
  if (!Number.isSafeInteger(input.call) || Number(input.call) < 1 ||
    !Number.isSafeInteger(input.round) || Number(input.round) < 1 ||
    (input.status !== "running" && input.status !== "complete" && input.status !== "error" && input.status !== "cancelled") ||
    (input.outcome !== undefined && !isMemorySearchActivityOutcome(input.outcome)) ||
    (input.durationMs !== undefined && (!Number.isSafeInteger(input.durationMs) || Number(input.durationMs) < 0))) return null;
  if ((input.status === "running" && input.outcome !== undefined) ||
    (input.status === "complete" && input.outcome !== "results" && input.outcome !== "no_results" && input.outcome !== "limited") ||
    (input.status === "error" && input.outcome !== "failure") ||
    (input.status === "cancelled" && input.outcome !== "cancelled")) return null;
  return { call: Number(input.call), round: Number(input.round), status: input.status,
    ...(input.outcome !== undefined ? { outcome: input.outcome as MemorySearchActivityOutcome } : {}),
    ...(input.durationMs !== undefined ? { durationMs: Number(input.durationMs) } : {}) };
}

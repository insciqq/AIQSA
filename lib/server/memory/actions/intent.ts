export const MEMORY_ACTION_PLAN_VERSION = "memory-action-plan-v1" as const;

/** Immutable decoder shape for recovery of v1 runs accepted before the
 * model-driven action tools shipped. New runs never create this plan. */
export type MemoryActionPlan =
  | Readonly<{
      kind: "LIST";
      query: string | null;
      version: typeof MEMORY_ACTION_PLAN_VERSION;
    }>
  | Readonly<{
      kind: "SAVE";
      sourceEnd: number;
      sourceStart: number;
      statement: string;
      version: typeof MEMORY_ACTION_PLAN_VERSION;
    }>
  | Readonly<{
      kind: "UPDATE";
      replacement: string;
      sourceEnd: number;
      sourceStart: number;
      targetQuery: string;
      version: typeof MEMORY_ACTION_PLAN_VERSION;
    }>
  | Readonly<{
      kind: "FORGET";
      sourceEnd: number;
      sourceStart: number;
      targetQuery: string;
      version: typeof MEMORY_ACTION_PLAN_VERSION;
    }>
  | Readonly<{
      kind: "MARK_INCORRECT";
      sourceEnd: number;
      sourceStart: number;
      targetQuery: string;
      version: typeof MEMORY_ACTION_PLAN_VERSION;
    }>;

export type MemoryActionIntent = Readonly<{ kind: "NONE" }> | MemoryActionPlan;

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 &&
    value.length <= maximum && value.indexOf("\u0000") === -1;
}

/** Compatibility export: semantic command routing was removed. */
export function planMemoryActionFromText(_source: string): MemoryActionIntent {
  return { kind: "NONE" };
}

/** Compatibility export: new preparation exposes all typed tools instead. */
export function planMemoryAction(
  _content: Readonly<{ blocks: readonly unknown[] }>
): MemoryActionIntent {
  return { kind: "NONE" };
}

export function decodeMemoryActionPlan(value: unknown): MemoryActionPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== MEMORY_ACTION_PLAN_VERSION) return null;
  if (candidate.kind === "LIST") {
    return candidate.query === null || boundedText(candidate.query, 500)
      ? candidate as MemoryActionPlan
      : null;
  }
  const validSpan = Number.isSafeInteger(candidate.sourceStart) &&
    Number.isSafeInteger(candidate.sourceEnd) &&
    (candidate.sourceStart as number) >= 0 &&
    (candidate.sourceEnd as number) > (candidate.sourceStart as number);
  if (!validSpan) return null;
  if (candidate.kind === "SAVE") {
    return boundedText(candidate.statement, 2_000) ? candidate as MemoryActionPlan : null;
  }
  if (candidate.kind === "UPDATE") {
    return boundedText(candidate.targetQuery, 500) && boundedText(candidate.replacement, 2_000)
      ? candidate as MemoryActionPlan
      : null;
  }
  if (candidate.kind === "FORGET" || candidate.kind === "MARK_INCORRECT") {
    return boundedText(candidate.targetQuery, 500) ? candidate as MemoryActionPlan : null;
  }
  return null;
}

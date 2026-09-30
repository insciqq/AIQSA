/** Future usefulness is independent of testimony confidence and subject matter.
 * It neither grants factual authority nor implies a retention deadline. */
export const MEMORY_USEFULNESS_KINDS = Object.freeze([
  "DURABLE", "ONGOING", "EPISODIC"
] as const);

export type MemoryUsefulness = (typeof MEMORY_USEFULNESS_KINDS)[number];

export function decodeMemoryUsefulness(value: unknown): MemoryUsefulness | null {
  return typeof value === "string" &&
    MEMORY_USEFULNESS_KINDS.some((kind) => kind === value)
    ? value as MemoryUsefulness
    : null;
}

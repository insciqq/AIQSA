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

/** The single long-term criterion for automatic Personal Memory. Extraction
 * applies it to new observations; maintenance applies it to stored facts. */
export const MEMORY_LONG_TERM_USEFULNESS_GUIDANCE =
  "Automatic Personal Memory keeps an observation only when both conditions hold: (1) it is about the user, or about the user's close person or pet under the subject-scope rules, and stays true for months or years; (2) it would change an answer to the user in a future, unrelated conversation. Lasting is not permanent: a circumstance with a finite term, such as living somewhere on a two-year contract or studying for a degree until a stated year, still qualifies, and a passed date does not prove that it ended. A lasting habit or trait shared by almost everyone, such as regularly eating bread or drinking coffee in the morning, changes no answer and does not qualify. A single event, a short-term matter (a small debt, a delivery, an order, an appointment or meeting, a symptom today, a task or plan for the coming days or weeks), and a momentary wish or reaction do not qualify; never generalize a momentary wish into a lasting preference. A change event qualifies only as an update or withdrawal of a previously held fact: after years without gluten, eating bread again updates the stored gluten restriction, while starting to eat bread with no such prior fact keeps nothing.";

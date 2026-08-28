export const KNOWLEDGE_NUMERIC_ANSWER_INSTRUCTION = [
  "For any requested calculation or comparison, retain the exact supported operands and " +
    "units, including their signs, decimal marks, and leading zeroes.",
  "Treat a range separator as an interval marker, not as a subtraction operator.",
  "Before finalizing, verify every displayed equation in its written operand order and make " +
    "sure its result and qualitative comparison are internally consistent; for a range width, " +
    "subtract the lower bound from the upper bound.",
  "If a derived value cannot be verified, do not guess or display a contradictory equation; " +
    "state the supported source values and the limitation instead."
].join(" ");

export const KNOWLEDGE_GROUNDED_ANSWER_INSTRUCTION = [
  "Answer only the claims needed for the current user request; do not enumerate nearby " +
    "evidence or add unrequested summaries, comparisons, conversions, calculations, or " +
    "recommendations.",
  "Keep each Source-derived factual or numeric claim in a sentence whose cited [K…] blocks " +
    "support the whole sentence. Do not combine independent facts under citations that support " +
    "only part of the sentence; omit an unsupported addition or state the limitation."
].join(" ");

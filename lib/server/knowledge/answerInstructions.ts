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

import type { NormalizedRunRequest } from "../providers/types";

export type KnowledgeAnswerInstructions = Readonly<{ system: string; responseReminder: string }>;

export function knowledgeAnswerInstructions(prompt: NormalizedRunRequest["prompt"]): KnowledgeAnswerInstructions {
  return { system: [prompt.system, prompt.personalInstructions, prompt.developer].filter(Boolean).join("\n\n"),
    responseReminder: prompt.responseReminder ?? "" };
}

export function validKnowledgeAnswerInstructions(value: unknown): value is KnowledgeAnswerInstructions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 2 && typeof row.system === "string" && row.system.length <= 128_000 &&
    typeof row.responseReminder === "string" && row.responseReminder.length <= 4_000 && !row.responseReminder.includes("\0");
}

export function knowledgeCompositionPrompt(systemPrompt: string, instructions?: KnowledgeAnswerInstructions) {
  return { systemPrompt: instructions?.system ? `${instructions.system}\n\n${systemPrompt}` : systemPrompt,
    ...(instructions?.responseReminder ? { responseReminder: instructions.responseReminder } : {}) };
}

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

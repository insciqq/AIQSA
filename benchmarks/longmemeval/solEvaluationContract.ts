import { z } from "zod";

export const SOL_EVALUATION_ACK = "DISPOSABLE_PAID_LONGMEMEVAL_SOL_JUDGE";
export const hypothesisSchema = z.object({
  question_id: z.string().min(1), hypothesis: z.string().min(1)
}).strict();
export function parseSolVerdict(value: string): boolean {
  const match = /^(yes|no)[.!]?$/iu.exec(value.trim());
  if (!match) throw new Error("longmemeval_sol_judge_verdict_invalid");
  return match[1]!.toLowerCase() === "yes";
}
export function validateHypotheses(values: unknown[], selected: readonly string[]) {
  const rows = values.map((value) => hypothesisSchema.parse(value));
  if (new Set(selected).size !== selected.length || !selected.length ||
    new Set(rows.map((row) => row.question_id)).size !== rows.length ||
    rows.some((row) => !selected.includes(row.question_id))) {
    throw new Error("longmemeval_sol_hypothesis_identity_invalid");
  }
  return rows;
}

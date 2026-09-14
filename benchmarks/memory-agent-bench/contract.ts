import { createHash } from "node:crypto";
import { z } from "zod";
import { selectQuestionIndices } from "./metric";

export const FACT_CONSOLIDATION_ACK = "DISPOSABLE_PAID_FACT_CONSOLIDATION";
export const MEMORY_TARGETS = Object.freeze({ overall: 0.8, perStratum: 0.65, matchedReaderSubset: 0.85 });
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const question = z.object({ id: z.string(), question: z.string().min(1), query: z.string().min(1), answers: z.array(z.string().min(1)).min(1) }).strict();
export const preparedSchema = z.object({
  version: z.literal(1), upstream: z.record(z.string(), z.unknown()),
  contexts: z.record(hash, z.object({ context: z.string().min(1), chunks: z.array(z.string().min(1)).min(1), chunkHashes: z.array(hash).min(1) }).strict()),
  strata: z.array(z.object({ source: z.string(), contextSha256: hash, questions: z.array(question).length(20) }).strict()).length(4),
  memorizeTemplate: z.string().min(1), tokenizerResources: z.record(z.string(), hash), queryTemplateSha256: hash
}).strict();
export type Prepared = z.infer<typeof preparedSchema>;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export function validatePrepared(value: unknown): Prepared {
  const prepared = preparedSchema.parse(value);
  if (new Set(prepared.strata.map((item) => item.source)).size !== 4) throw new Error("factconsolidation_strata_duplicate");
  const seen = new Set<string>();
  for (const [id, context] of Object.entries(prepared.contexts)) {
    if (digest(context.context) !== id || context.chunks.length !== context.chunkHashes.length ||
      context.chunks.some((chunk, index) => digest(chunk) !== context.chunkHashes[index]) ||
      context.context.trim().split(/\s+/u).join(" ") !== context.chunks.join(" ").trim().split(/\s+/u).join(" ")) {
      throw new Error("factconsolidation_source_integrity_failed");
    }
  }
  for (const stratum of prepared.strata) {
    if (!prepared.contexts[stratum.contextSha256]) throw new Error("factconsolidation_context_missing");
    for (const item of stratum.questions) {
      if (seen.has(item.id) || !item.query.includes(item.question)) throw new Error("factconsolidation_question_integrity_failed");
      seen.add(item.id);
    }
  }
  return prepared;
}

/** The reader control is selected by identity before observing any scores. */
export function readerControlQuestions(stratum: Prepared["strata"][number]) {
  const ids = stratum.questions.map(({ id }) => id);
  return selectQuestionIndices(ids, 5, "aiqsa-factconsolidation-reader-control-v1", digest)
    .map((index) => stratum.questions[index]!);
}

export type Result = { id: string; source: string; complete: boolean; healthy: boolean;
  exact: boolean; semantic: boolean; elapsedMs: number; code: string | null };

export function summarize(strata: Prepared["strata"], results: readonly Result[], control: boolean) {
  const expected = strata.flatMap((stratum) => (control ? readerControlQuestions(stratum) : stratum.questions)
    .map(({ id }) => ({ id, source: stratum.source })));
  const byId = new Map<string, Result>();
  for (const result of results) {
    if (byId.has(result.id) || !Number.isFinite(result.elapsedMs) || result.elapsedMs < 0 ||
      !expected.some((item) => item.id === result.id && item.source === result.source)) {
      throw new Error("factconsolidation_result_identity_invalid");
    }
    byId.set(result.id, result);
  }
  const count = (selected: typeof expected) => {
    const correct = selected.filter(({ id }) => {
      const item = byId.get(id);
      return item?.complete && item.healthy && item.exact && item.code === null;
    }).length;
    const semantic = selected.filter(({ id }) => {
      const item = byId.get(id);
      return item?.complete && item.healthy && item.semantic && item.code === null;
    }).length;
    return { total: selected.length, correct, semantic, accuracy: correct / selected.length, semanticAccuracy: semantic / selected.length };
  };
  const overall = count(expected);
  const answerOnly = {
    total: expected.length,
    completed: results.filter((item) => item.complete).length,
    exact: results.filter((item) => item.complete && item.exact).length,
    semantic: results.filter((item) => item.complete && item.semantic).length
  };
  const complete = results.length === expected.length && results.every((item) => item.complete);
  const healthy = results.length === expected.length && results.every((item) => item.healthy && item.code === null);
  const perStratum = Object.fromEntries(strata.map(({ source }) => [source, count(expected.filter((item) => item.source === source))]));
  const controlIds = new Set(strata.flatMap((stratum) => readerControlQuestions(stratum).map(({ id }) => id)));
  const matchedReaderSubset = count(expected.filter(({ id }) => controlIds.has(id)));
  const meets = (score: ReturnType<typeof count>, minimum: number) => score.accuracy >= minimum && score.semanticAccuracy >= minimum;
  return { mode: control ? "reader-control" : "memory", overall, answerOnly, complete, healthy, perStratum, matchedReaderSubset,
    targets: control ? null : MEMORY_TARGETS,
    qualityPassed: !control && complete && healthy && meets(overall, MEMORY_TARGETS.overall) &&
      Object.values(perStratum).every((score) => meets(score, MEMORY_TARGETS.perStratum)) &&
      meets(matchedReaderSubset, MEMORY_TARGETS.matchedReaderSubset) };
}

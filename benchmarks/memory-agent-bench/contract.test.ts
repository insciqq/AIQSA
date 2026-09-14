import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readerControlQuestions, summarize, validatePrepared, type Prepared, type Result } from "./contract";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture(): Prepared {
  const context = "\n0. A lives in York.\n1. A moved to Leeds.\n";
  const contextSha256 = hash(context);
  return { version: 1, upstream: {}, contexts: { [contextSha256]: { context,
    chunks: ["0. A lives in York.", "1. A moved to Leeds."], chunkHashes: [hash("0. A lives in York."), hash("1. A moved to Leeds.")] } },
    strata: ["sh_6k", "mh_6k", "sh_32k", "mh_32k"].map((source) => ({ source, contextSha256,
      questions: Array.from({ length: 20 }, (_, index) => ({ id: `${source}_${index}`, question: "Where is A?", query: "Question: Where is A?", answers: ["Leeds"] })) })),
    memorizeTemplate: "{context}", tokenizerResources: {}, queryTemplateSha256: hash("query") };
}

describe("FactConsolidation source/score integrity", () => {
  it("rejects loss, reordering, and alteration of ingested facts", () => {
    const original = fixture();
    expect(validatePrepared(original)).toEqual(original);
    const context = Object.values(original.contexts)[0]!;
    context.chunks.reverse();
    context.chunkHashes.reverse();
    expect(() => validatePrepared(original)).toThrow("source_integrity_failed");
    context.chunks = [context.chunks[0]!];
    context.chunkHashes = [context.chunkHashes[0]!];
    expect(() => validatePrepared(original)).toThrow("source_integrity_failed");
  });
  it("selects a fixed balanced control without consulting answers", () => {
    const original = fixture();
    const stratum = original.strata[0]!;
    const ids = readerControlQuestions(stratum).map(({ id }) => id);
    expect(ids).toHaveLength(5);
    stratum.questions.forEach((question) => { question.answers = ["changed oracle"]; });
    expect(readerControlQuestions(stratum).map(({ id }) => id)).toEqual(ids);
  });
  it("keeps failed, absent, and duplicated attempts from becoming successes", () => {
    const original = fixture();
    const results: Result[] = original.strata.flatMap((stratum) => stratum.questions.map(({ id }) => ({
      id, source: stratum.source, complete: true, healthy: true, exact: true, semantic: false, elapsedMs: 1, code: null
    })));
    expect(summarize(original.strata, results, false)).toMatchObject({ complete: true, healthy: true,
      overall: { accuracy: 1, semanticAccuracy: 0 } });
    expect(summarize(original.strata, results.slice(1), false)).toMatchObject({ complete: false, healthy: false });
    expect(() => summarize(original.strata, [...results, results[0]!], false)).toThrow("result_identity_invalid");
    results[0]!.code = "transport_error";
    expect(summarize(original.strata, results, false).overall.correct).toBe(79);
    expect(summarize(original.strata, results, false).answerOnly).toMatchObject({ completed: 80, exact: 80, semantic: 0 });
    expect(summarize(original.strata, results, false).healthy).toBe(false);
  });
  it("requires the matched reader subset as well as overall and stratum quality", () => {
    const original = fixture();
    const controls = new Set(original.strata.flatMap((stratum) => readerControlQuestions(stratum).map(({ id }) => id)));
    const results: Result[] = original.strata.flatMap((stratum) => stratum.questions.map(({ id }) => ({
      id, source: stratum.source, complete: true, healthy: true, exact: true, semantic: true, elapsedMs: 1, code: null
    })));
    expect(summarize(original.strata, results, false).qualityPassed).toBe(true);
    let removed = 0;
    for (const result of results) if (controls.has(result.id) && removed++ < 4) result.semantic = false;
    const score = summarize(original.strata, results, false);
    expect(score.overall.semanticAccuracy).toBe(0.95);
    expect(score.matchedReaderSubset.semanticAccuracy).toBe(0.8);
    expect(score.qualityPassed).toBe(false);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_CORPUS_SHA256, canonicalJson, corpusFingerprint, corpusSchema, decodeJudgement,
  expectedChecks, judgePayload, safeCode, scenarioSchema, summarizeLatency, summarizeResults,
  type ScenarioResult
} from "./contract";

const raw: unknown = JSON.parse(readFileSync(new URL("./corpus.json", import.meta.url), "utf8"));
const corpus = corpusSchema.parse(raw);
function passingResults(): ScenarioResult[] {
  return corpus.scenarios.map((scenario) => ({
    id: scenario.id, category: scenario.category, partition: scenario.partition,
    complete: true, healthy: true, failureCode: null,
    checks: expectedChecks(scenario).map((check) => ({
      ordinal: check.ordinal, surface: check.surface, passed: true,
      reason: "SUPPORTED", elapsedMs: 1, ...(check.critical ? { criticalPassed: true } : {})
    }))
  }));
}

describe("frozen personal-memory acceptance contract", () => {
  it("retains allowlisted transport causes without exposing private exception payloads", () => {
    expect(safeCode(new TypeError("fetch failed", { cause: { code: "ECONNRESET", detail: "private payload" } })))
      .toBe("memory_acceptance_transport:econnreset");
    expect(safeCode(new TypeError("fetch failed", { cause: { code: "private payload" } })))
      .toBe("memory_acceptance_transport:unknown");
    expect(safeCode(new DOMException("private payload", "TimeoutError")))
      .toBe("memory_acceptance_transport:timeout");
    expect(safeCode(new Error("private payload"))).toBe("memory_acceptance_internal_error");
  });

  it("keeps bilingual strata and reserved examples independent of runtime limits", () => {
    expect(corpus.scenarios).toHaveLength(60);
    expect(corpus.scenarios.filter((item) => item.partition === "acceptance")).toHaveLength(18);
    expect(corpusFingerprint(corpus)).toBe(corpusFingerprint(raw as typeof corpus));
    expect(corpusFingerprint(corpus)).toBe(ACCEPTANCE_CORPUS_SHA256);
    expect(canonicalJson({ z: [1, 2], a: true })).toBe(canonicalJson({ a: true, z: [1, 2] }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(corpusSchema.safeParse({ ...corpus, scenarios: [...corpus.scenarios.slice(1), corpus.scenarios[1]] }).success).toBe(false);
  });

  it("cannot capture an absent reference or test temporary reads through ordinary fact search", () => {
    const base = corpus.scenarios[0]!;
    expect(scenarioSchema.safeParse({ ...base, steps: [{ action: "check-reference", binding: "missing", expected: "missing" }] }).success).toBe(false);
    expect(scenarioSchema.safeParse({ ...base, steps: [{ action: "check", surface: "facts", temporary: true, question: "q", expectation: "e" }] }).success).toBe(false);
  });

  it("qualifies only complete suites, never smoke subsets or duplicated successful checks", () => {
    const results = passingResults();
    expect(summarizeResults(corpus.scenarios, results).qualityPassed).toBe(true);
    expect(summarizeResults(corpus.scenarios.slice(0, 1), results.slice(0, 1))).toMatchObject({ selectionPassed: true, qualityPassed: false });
    const first = results[0]!;
    expect(() => summarizeResults(corpus.scenarios, [{ ...first, checks: [first.checks[0]!, first.checks[0]!] }, ...results.slice(1)])).toThrow("result_shape_invalid");
    expect(summarizeResults(corpus.scenarios, results.slice(1))).toMatchObject({ complete: false, qualityPassed: false });
    expect(() => summarizeResults(corpus.scenarios, [first, ...results])).toThrow("identity_invalid");
  });

  it("requires actual evidence for every critical contract", () => {
    const results = passingResults().map((result) => ({ ...result,
      checks: result.checks.map(({ criticalPassed: _omitted, ...check }) => check)
    }));
    const summary = summarizeResults(corpus.scenarios, results);
    expect(summary.qualityPassed).toBe(false);
    expect(summary.criticalFailures).toBeGreaterThan(0);
  });

  it("does not hide a weak reserved partition behind development success", () => {
    let remaining = 2;
    const results = passingResults().map((result) => {
      if (result.partition !== "acceptance" || remaining-- <= 0) return result;
      return { ...result, checks: result.checks.map((check) => ({ ...check, passed: false })) };
    });
    const summary = summarizeResults(corpus.scenarios, results);
    expect(summary.overall.accuracy).toBeGreaterThan(0.9);
    expect(summary.qualityPassed).toBe(false);
  });

  it("treats degradation and unfinished runs as failed evidence", () => {
    const results = passingResults();
    results[0] = { ...results[0]!, healthy: false };
    expect(summarizeResults(corpus.scenarios, results)).toMatchObject({ healthy: false, qualityPassed: false });
    results[0] = { ...results[0]!, healthy: true, complete: false };
    expect(summarizeResults(corpus.scenarios, results)).toMatchObject({ complete: false, qualityPassed: false });
  });

  it("rejects malformed or contradictory judge output and out-of-bounds evidence", () => {
    expect(() => decodeJudgement({ passed: true, reason: "STALE", matchingIndices: [] }, 1)).toThrow();
    expect(() => decodeJudgement({ passed: true, reason: "SUPPORTED", matchingIndices: [1] }, 1)).toThrow("index_invalid");
    expect(() => decodeJudgement({ passed: true, reason: "SUPPORTED", matchingIndices: [0, 0] }, 1)).toThrow();
    expect(() => decodeJudgement({ passed: true, reason: "SUPPORTED", matchingIndices: [], extra: "accept" }, 1)).toThrow();
  });

  it("sends only the selected surface and rubric to the judge", () => {
    const payload = JSON.parse(judgePayload({ action: "check", surface: "both", question: "Where do I live?", expectation: "York.", distinct: true }, "facts", ["Lives in York"]));
    expect(payload).toEqual({ expectation: "York.", question: "Where do I live?", surface: "facts", absence: false, distinct: true, values: ["Lives in York"] });
    expect(payload).not.toHaveProperty("sourceMessages");
  });

  it("keeps latency tails and missing measurements from qualifying", () => {
    const timings = Array.from({ length: 100 }, (_, index) => ({ action: "search", elapsedMs: index < 95 ? 9_500 : 25_000 }));
    expect(summarizeLatency(timings).search).toMatchObject({ passed: true, p95: 9_500, maximum: 25_000 });
    expect(summarizeLatency(timings).answer?.passed).toBe(false);
    timings[94]!.elapsedMs = 25_000;
    expect(summarizeLatency(timings).search?.passed).toBe(false);
    timings[94]!.elapsedMs = 9_500;
    timings[99]!.elapsedMs = 26_001;
    expect(summarizeLatency(timings).search?.passed).toBe(false);
    timings[99]!.elapsedMs = Number.NaN;
    expect(() => summarizeLatency(timings)).toThrow("timing_invalid");
  });
});

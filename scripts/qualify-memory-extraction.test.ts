import { describe, expect, it } from "vitest";
import {
  EXTRACTION_QUALIFICATION_GROUPS,
  extractionQualificationDatabase,
  extractionQualificationOptions,
  extractionQualificationSpan,
  judgeExtractionScenario,
  MEMORY_EXTRACTION_QUALIFICATION_ACK,
  MEMORY_EXTRACTION_QUALIFICATION_SCENARIOS,
  sanitizeExtractionQualificationMessage,
  summarizeExtractionQualification,
  type ExtractionQualificationResult,
  type ExtractionQualificationScenario
} from "./memory-extraction-qualification-support";

const runId = "abcdef123456";
const databaseUrl =
  `postgresql://aiqsa:synthetic@127.0.0.1:55439/aiqsa_memory_qualification_${runId}?schema=public`;
const environment = {
  AIQSA_LOCAL_DEV_PROFILE_DISABLED: "1",
  AIQSA_MEMORY_EXTRACTION_DATABASE_URL: databaseUrl,
  AIQSA_TEST_MODE: "1"
};

function scenario(id: string): ExtractionQualificationScenario {
  const found = MEMORY_EXTRACTION_QUALIFICATION_SCENARIOS.find((item) => item.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

describe("long-term extraction qualification authority", () => {
  it("requires the paid acknowledgement, a run id and an absolute private output", () => {
    const args = ["--ack", MEMORY_EXTRACTION_QUALIFICATION_ACK, "--run-id", runId,
      "--output", "/private/report.json"];
    expect(extractionQualificationOptions(args)).toEqual({ output: "/private/report.json", runId });
    expect(() => extractionQualificationOptions(args.slice(2)))
      .toThrow("memory_extraction_disposable_ack_required");
    expect(() => extractionQualificationOptions(["--ack", "DISPOSABLE_PAID_MEMORY_CLEANUP",
      ...args.slice(2)])).toThrow("memory_extraction_disposable_ack_required");
    expect(() => extractionQualificationOptions([...args.slice(0, 5), "report.json"]))
      .toThrow("memory_extraction_arguments_invalid");
    expect(() => extractionQualificationOptions([...args, "--run-id", runId]))
      .toThrow("memory_extraction_arguments_invalid");
    expect(() => extractionQualificationOptions([...args, "--mode", "apply"]))
      .toThrow("memory_extraction_arguments_invalid");
  });

  it("admits only the acknowledged run-specific loopback disposable database", () => {
    expect(extractionQualificationDatabase(environment, runId).toString()).toBe(databaseUrl);
    expect(extractionQualificationDatabase({ ...environment, DATABASE_URL: databaseUrl }, runId)
      .toString()).toBe(databaseUrl);
    // The cleanup qualification variable never selects this script's target.
    expect(() => extractionQualificationDatabase({
      AIQSA_LOCAL_DEV_PROFILE_DISABLED: "1", AIQSA_MEMORY_CLEANUP_DATABASE_URL: databaseUrl,
      AIQSA_TEST_MODE: "1"
    }, runId)).toThrow("memory_extraction_database_invalid");
    for (const [patch, code] of [
      [{ AIQSA_TEST_MODE: "0" }, "memory_extraction_disposable_environment_required"],
      [{ NODE_ENV: "production" }, "memory_extraction_disposable_environment_required"],
      [{ AIQSA_MEMORY_EXTRACTION_DATABASE_URL: databaseUrl.replace("127.0.0.1", "db.example.test") },
        "memory_extraction_database_not_disposable"],
      [{ AIQSA_MEMORY_EXTRACTION_DATABASE_URL: databaseUrl.replace(runId, "000000000000") },
        "memory_extraction_database_not_disposable"],
      [{ DATABASE_URL: "postgresql://aiqsa:other@127.0.0.1:5432/aiqsa?schema=public" },
        "memory_extraction_database_authority_conflict"]
    ] as const) {
      expect(() => extractionQualificationDatabase({ ...environment, ...patch }, runId)).toThrow(code);
    }
  });
});

describe("long-term extraction qualification fixture and oracle", () => {
  it("covers every group in Russian and English with exact unique spans", () => {
    const ids = MEMORY_EXTRACTION_QUALIFICATION_SCENARIOS.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const group of EXTRACTION_QUALIFICATION_GROUPS) {
      const languages = MEMORY_EXTRACTION_QUALIFICATION_SCENARIOS
        .filter((item) => item.group === group).map(({ language }) => language);
      expect(new Set(languages)).toEqual(new Set(["ru", "en"]));
    }
    for (const item of MEMORY_EXTRACTION_QUALIFICATION_SCENARIOS) {
      expect(item.allowed.length).toBeGreaterThan(0);
      for (const span of item.allowed) {
        expect(span.start).toBeGreaterThanOrEqual(0);
        expect(span.end).toBeLessThanOrEqual(item.text.length);
        expect(span.end).toBeGreaterThan(span.start);
      }
      expect(item.prior !== null).toBe(item.expectation === "CHANGE");
    }
    expect(scenario("ru_doctor_on_call").allowed).toEqual([{ end: 6, start: 0 }]);
    expect(() => extractionQualificationSpan("a b a", "a")).toThrow("memory_extraction_fixture_span_invalid");
    expect(() => extractionQualificationSpan("a b", "c")).toThrow("memory_extraction_fixture_span_invalid");
  });

  it("judges saved evidence by offsets against the expected outcome", () => {
    const save = (start: number, end: number, explicitRemember = false) => ({ end, explicitRemember, start });
    const durable = scenario("en_vegetarian");
    expect(judgeExtractionScenario(durable, { saved: [save(0, durable.text.length)] }))
      .toMatchObject({ correctSaves: 1, falseSaves: 0, miss: false, passed: true });
    expect(judgeExtractionScenario(durable, { saved: [] }))
      .toMatchObject({ miss: true, passed: false, reason: "MISS" });

    const shortTerm = scenario("ru_parcel");
    expect(judgeExtractionScenario(shortTerm, { saved: [] })).toMatchObject({ passed: true });
    expect(judgeExtractionScenario(shortTerm, { saved: [save(0, 5)] }))
      .toMatchObject({ falseSaves: 1, miss: false, passed: false, reason: "FALSE_SAVE" });

    const mixed = scenario("ru_doctor_on_call");
    const onCall = mixed.text.indexOf("завтра");
    expect(judgeExtractionScenario(mixed, { saved: [save(0, 6)] })).toMatchObject({ passed: true });
    expect(judgeExtractionScenario(mixed, { saved: [save(0, 6), save(onCall, mixed.text.length)] }))
      .toMatchObject({ correctSaves: 1, falseSaves: 1, passed: false, reason: "FALSE_SAVE" });
    // An encompassing span may support only one fact of a mixed message.
    expect(judgeExtractionScenario(mixed, { saved: [save(0, mixed.text.length), save(0, mixed.text.length)] }))
      .toMatchObject({ correctSaves: 1, falseSaves: 1, passed: false });
    expect(judgeExtractionScenario(mixed, { saved: [save(onCall, mixed.text.length)] }))
      .toMatchObject({ miss: true, passed: false, reason: "FALSE_SAVE" });

    const protectedDebt = scenario("en_remember_debt");
    const debt = protectedDebt.allowed[0]!;
    expect(judgeExtractionScenario(protectedDebt, { saved: [save(debt.start, debt.end, true)] }))
      .toMatchObject({ passed: true });
    expect(judgeExtractionScenario(protectedDebt, { saved: [save(debt.start, debt.end)] }))
      .toMatchObject({ passed: false, reason: "NOT_PROTECTED" });

    const change = scenario("ru_gluten_change");
    expect(judgeExtractionScenario(change, { priorReplaced: true, priorSaved: true, saved: [save(0, 10)] }))
      .toMatchObject({ passed: true });
    expect(judgeExtractionScenario(change, { priorReplaced: false, priorSaved: true, saved: [save(0, 10)] }))
      .toMatchObject({ miss: true, passed: false, reason: "NOT_CHANGED" });
    expect(judgeExtractionScenario(change, { priorSaved: false, saved: [] }))
      .toMatchObject({ passed: false, reason: "PRIOR_MISSING" });
  });

  it("summarizes content-free aggregates and fails on false saves, misses and degradation", () => {
    const passing = MEMORY_EXTRACTION_QUALIFICATION_SCENARIOS.map((item): ExtractionQualificationResult => ({
      receipts: item.expectation === "NONE" ? ["REJECT_NOT_USEFUL"] : ["APPLIED"],
      scenario: item,
      verdict: judgeExtractionScenario(item, {
        saved: item.expectation === "NONE" ? [] : [{ ...item.allowed[0]!, explicitRemember: true }],
        ...(item.expectation === "CHANGE" ? { priorReplaced: true, priorSaved: true } : {})
      })
    }));
    const usage = [
      { estimatedCostMicros: 120, inputTokens: 1_000, outputTokens: 200, role: "MEMORY_FACT_EXTRACT",
        state: "SUCCEEDED", totalTokens: 1_200 },
      { estimatedCostMicros: null, inputTokens: null, outputTokens: null, role: "MEMORY_SEMANTIC_ADJUDICATE",
        state: "SUCCEEDED", totalTokens: null }
    ];
    const report = summarizeExtractionQualification({
      degradedCodes: [], jobStages: ["fact_observations_committed"], results: passing, usage
    });
    expect(report).toMatchObject({
      degraded: 0, estimatedCostMicros: 120, inputTokens: 1_000, outputTokens: 200,
      providerCalls: { "MEMORY_SEMANTIC_ADJUDICATE:SUCCEEDED": 1, "MEMORY_FACT_EXTRACT:SUCCEEDED": 1 },
      reportedCostCalls: 1, reportedTokenCalls: 1, sanitizedAggregatesOnly: true,
      scenarios: MEMORY_EXTRACTION_QUALIFICATION_SCENARIOS.length, status: "passed", totalTokens: 1_200
    });
    expect(report.groups.SHORT_TERM).toMatchObject({
      expectation: "NONE", falseSaves: 0, notSaved: 12, receipts: { REJECT_NOT_USEFUL: 12 }, saved: 0
    });
    expect(report.groups.DURABLE.byLanguage.ru).toEqual({ falseSaves: 0, misses: 0, passed: 7, scenarios: 7 });

    const withMiss = (ids: readonly string[]) => passing.map((result) => ids.includes(result.scenario.id)
      ? { ...result, verdict: judgeExtractionScenario(result.scenario, { saved: [] }) }
      : result);
    expect(summarizeExtractionQualification({
      degradedCodes: [], jobStages: [], results: withMiss(["ru_japanese"]), usage
    }).status).toBe("passed");
    expect(summarizeExtractionQualification({
      degradedCodes: [], jobStages: [], results: withMiss(["ru_japanese", "en_japanese"]), usage
    }).status).toBe("failed");
    expect(summarizeExtractionQualification({
      degradedCodes: [], jobStages: [], results: withMiss(["en_doctor_on_call"]), usage
    }).status).toBe("failed");
    const falseSave = passing.map((result) => result.scenario.id === "en_coffee_now"
      ? { ...result, verdict: judgeExtractionScenario(result.scenario, {
        saved: [{ end: 3, explicitRemember: false, start: 0 }]
      }) }
      : result);
    expect(summarizeExtractionQualification({ degradedCodes: [], jobStages: [], results: falseSave, usage }))
      .toMatchObject({ groups: { MOMENTARY: { falseSaves: 1, failures: { FALSE_SAVE: 1 } } }, status: "failed" });
    expect(summarizeExtractionQualification({
      degradedCodes: ["fact_output_rejected"], jobStages: [], results: passing, usage
    })).toMatchObject({ degraded: 1, degradedCodes: { fact_output_rejected: 1 }, status: "failed" });
    expect(summarizeExtractionQualification({
      degradedCodes: [], jobStages: [], results: passing,
      usage: [{ ...usage[0]!, state: "OUTCOME_UNKNOWN" }]
    })).toMatchObject({ degraded: 1, status: "failed" });
    expect(summarizeExtractionQualification({
      degradedCodes: [], jobStages: [], results: passing.slice(1), usage
    }).status).toBe("failed");
  });

  it("prints only bounded codes and counts from the worker message", () => {
    const report = summarizeExtractionQualification({
      degradedCodes: ["fact output with spaces"], jobStages: [], results: [], usage: []
    });
    const safe = sanitizeExtractionQualificationMessage({
      ...report,
      groups: { ...report.groups, DURABLE: { ...report.groups.DURABLE, statement: "private text" } },
      private: "I owe Ivan 38 rubles.",
      code: "Private failure text"
    });
    const text = JSON.stringify(safe);
    expect(text).not.toContain("private");
    expect(text).not.toContain("Ivan");
    expect(text).not.toContain("spaces");
    expect(safe).toMatchObject({
      code: "memory_extraction_qualification_failed",
      degradedCodes: { invalid_code: 1 }, sanitizedAggregatesOnly: true, status: "failed"
    });
    expect(sanitizeExtractionQualificationMessage({ status: "unknown" })).toBeNull();
    expect(sanitizeExtractionQualificationMessage(["passed"])).toBeNull();
  });
});

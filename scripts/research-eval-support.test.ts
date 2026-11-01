import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdminProviderModelConfiguration } from "../lib/contracts/adminProviders";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RESEARCH_EXTRACTION_PROMPT, RESEARCH_JUDGE_PROMPT, T_QUESTION_MS, comparePicks, compareResearchAnswers, configureResearchEvalRoles, conflictingFacts, createResearchArchive,
  criteriaOverlap, decodeResearchGrade, decodeStructuredResearchAnswer, emptyEval, evaluateResearch, redactResearchSecrets, researchEvalOptions,
  researchEffortConfiguration, researchEvaluationSummary, researchPlanWindow, researchPool, researchProxySetup, researchQuestionTimeout, researchRepeatability, researchRoleUsage, shortlistOverlap,
  type ResearchGrade, type ResearchUsageRow, type StructuredResearchAnswer
} from "./research-eval-support";
import { parseTestProxy, researchMetrics } from "./subagent-scenarios-support";

const answer: StructuredResearchAnswer = {
  candidates: ["Candidate A", "Candidate B"], criteria: [{ name: "Durability", reason: null }, { name: "Price", reason: "Budget is fixed" }],
  facts: [{ candidate: "Candidate A", attribute: "price", value: "40000 RUB", date: "2026-11-01", link: "https://example.test/a" },
    { candidate: "Candidate A", attribute: "height", value: "20 cm", date: null, link: "https://example.test/a" }], pick: "Candidate A", tie: null
};
const grade: ResearchGrade = { scores: { factualAccuracy: 0.8, citationAccuracy: 0.7, completeness: 1, sourceQuality: 0.6, toolEfficiency: 0.5 },
  limitations: ["Sources not independently fetched"] };
const response = (value: unknown) => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }],
  usage: { input_tokens: 100, output_tokens: 20 } });
const temporary: string[] = [];
const directory = () => { const path = mkdtempSync(join(tmpdir(), "research-eval-test-")); temporary.push(path); return path; };
afterEach(() => { vi.restoreAllMocks(); for (const path of temporary.splice(0)) rmSync(path, { force: true, recursive: true }); });

describe("research repeatability on handwritten answers", () => {
  it("compares identical answers without printing their labels or facts", () => {
    expect(shortlistOverlap(answer, answer)).toEqual({ shared: 2, union: 2, jaccard: 1, onlyLeft: 0, onlyRight: 0 });
    expect(compareResearchAnswers(answer, answer)).toMatchObject({ conflicts: 0, picks: { matches: true, consistent: true, tieStated: false },
      criteria: { shared: 2, jaccard: 1 } });
    expect(JSON.stringify(compareResearchAnswers(answer, answer))).not.toContain("Candidate");
  });

  it("detects a different pick even with identical criteria and shortlist", () => {
    const different = { ...answer, pick: "Candidate B" };
    expect(criteriaOverlap(answer, different).jaccard).toBe(1);
    expect(comparePicks(answer, different)).toEqual({ consistent: false, matches: false, tieStated: false });
    expect(researchRepeatability([answer, answer, answer, answer, different])).toMatchObject({ comparedRuns: 5, largestPickGroup: 4, ties: 0 });
    expect(researchRepeatability([answer, different]).pairs).toHaveLength(1);
  });

  it("recognizes an explicit tie and its deciding evidence", () => {
    const tie = { ...answer, pick: null, tie: { candidates: [...answer.candidates], reason: "Evidence does not separate them", decider: "Independent durability test" } };
    expect(comparePicks(answer, tie)).toEqual({ consistent: true, matches: null, tieStated: true });
    expect(decodeStructuredResearchAnswer(JSON.stringify(tie))).toEqual(tie);
    expect(decodeStructuredResearchAnswer(JSON.stringify({ ...tie, tie: { ...tie.tie, decider: "" } }))).toBeNull();
  });

  it("finds conflicts on the same candidate and attribute, including undated prices", () => {
    const other = { ...answer, facts: answer.facts.map((fact) => ({ ...fact, value: "different" })) };
    expect(conflictingFacts(answer, other).conflicts).toHaveLength(2);
    expect(conflictingFacts(answer, { ...other, facts: other.facts.map((fact) => ({ ...fact, candidate: "Candidate B" })) }).conflicts).toHaveLength(0);
    expect(conflictingFacts(answer, { ...other, facts: other.facts.map((fact) => ({ ...fact, date: null })) }).conflicts).toHaveLength(2);
  });

  it("allows a dated price change on the same page but never dates away a specification conflict", () => {
    const later = { ...answer, facts: answer.facts.map((fact) => ({ ...fact, date: "2026-11-02", value: "different" })) };
    expect(conflictingFacts(answer, later)).toMatchObject({ datedPriceChanges: 1, conflicts: [{ left: { attribute: "height" } }] });
    expect(conflictingFacts(answer, { ...later, facts: later.facts.map((fact) => ({ ...fact, link: "https://example.test/other" })) }).conflicts).toHaveLength(2);
    expect(conflictingFacts(answer, { ...later, facts: later.facts.map((fact) => ({ ...fact, date: "2026-02-30" })) }).conflicts).toHaveLength(2);
  });

  it("keeps absent evidence unknown and reports criterion deltas and their stated reasons", () => {
    const empty: StructuredResearchAnswer = { candidates: [], criteria: [], facts: [], pick: null, tie: null };
    expect(shortlistOverlap(empty, empty).jaccard).toBeNull();
    expect(comparePicks(empty, empty).consistent).toBeNull();
    expect(criteriaOverlap(answer, { ...answer, criteria: [{ name: "Durability", reason: null }] })).toMatchObject({ onlyLeft: 1, differencesWithReasons: 1 });
    expect(shortlistOverlap(answer, { ...answer, candidates: [" candidate   a ", "CANDIDATE B"] }).jaccard).toBe(1);
  });
});

describe("research setup and isolation", () => {
  const env = { AIQSA_SUBAGENTS_ANSWERS_DIR: "/private/research" };
  it("expands the fourteen acceptance runs and defaults to three concurrent chats", () => {
    const options = researchEvalOptions({ ...env, AIQSA_SUBAGENTS_T_REPEATS: "purchase=5,medical=3,technical=3,market=3" });
    expect(options.jobs).toHaveLength(14);
    expect(options.jobs.filter((job) => job.kind === "purchase").map((job) => job.repeat)).toEqual([1, 2, 3, 4, 5]);
    expect(options.concurrency).toBe(3);
    expect(researchEvalOptions({ ...env, AIQSA_SUBAGENTS_T_REPEATS: "2", AIQSA_SUBAGENTS_T_KINDS: "medical,technical" }).jobs).toHaveLength(4);
    expect(researchEvalOptions({ AIQSA_SUBAGENTS_ANSWERS_FILE: "/private/answers" }).answersDir).toBe("/private/answers.d");
  });

  it("validates options before setup without echoing bad values", () => {
    for (const raw of ["0", "21", "1.5", "purchase=0", "purchase=", "unknown=3", "purchase=3,purchase=4", "purchase=3=4"]) {
      expect(() => researchEvalOptions({ ...env, AIQSA_SUBAGENTS_T_REPEATS: raw })).toThrow("research_repeats_invalid");
    }
    expect(() => researchEvalOptions({ ...env, AIQSA_SUBAGENTS_T_CONCURRENCY: "0" })).toThrow("research_concurrency_invalid");
    expect(() => researchEvalOptions({ ...env, AIQSA_SUBAGENTS_T_KINDS: "purchase,purchase" })).toThrow("research_kinds_invalid");
    expect(() => researchEvalOptions({})).toThrow("research_answers_dir_required");
    expect(() => researchEvalOptions({ ...env, AIQSA_SUBAGENTS_RESEARCHER_EFFORT: "high" })).toThrow("research_role_model_required");
    expect(researchEvalOptions({ ...env, AIQSA_SUBAGENTS_RESEARCHER_MODEL: "synthetic-researcher", AIQSA_SUBAGENTS_RESEARCHER_EFFORT: "xhigh",
      AIQSA_SUBAGENTS_CHECKS_MODEL: "synthetic-checks" })).toMatchObject({ researcher: { model: "synthetic-researcher", effort: "xhigh" }, checks: { model: "synthetic-checks", effort: null } });
    expect(() => researchEvalOptions({ ...env, AIQSA_SUBAGENTS_CHECKS_MODEL: "synthetic", AIQSA_SUBAGENTS_VERIFIER_FAMILY: "native" })).toThrow("research_checks_role_ambiguous");
  });

  it("declares a requested effort outside the shared setup defaults for Admin's probes", () => {
    const configuration: AdminProviderModelConfiguration = { adapterKind: "openai_responses_compatible", upstreamModelId: "synthetic-worker", modelClass: "answer",
      answerSelectable: true, defaultParams: {}, capabilities: { nativePdfInput: false, nativeSearch: false, pdf: true, vision: false, contextWindow: 100_000, defaultMaxOutputTokens: 16_384, toolCalling: true, reasoning: true, reasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium" } };
    expect(researchEffortConfiguration(configuration, "xhigh")).toEqual({ ...configuration,
      capabilities: { ...configuration.capabilities, reasoningEfforts: ["xhigh"], defaultReasoningEffort: "xhigh" } });
    expect(configuration.capabilities.reasoningEfforts).toEqual(["low", "medium", "high"]);
  });

  it("binds explicit roles and efforts through the versioned Admin policy without substituting models", async () => {
    const ports = { ensureModel: vi.fn(async (_model: string, role: string) => `${role}-id`), policyVersion: vi.fn(async () => 7), patch: vi.fn(async () => {}) };
    const options = researchEvalOptions({ ...env, AIQSA_SUBAGENTS_RESEARCHER_MODEL: "synthetic-worker", AIQSA_SUBAGENTS_RESEARCHER_EFFORT: "xhigh",
      AIQSA_SUBAGENTS_CHECKS_MODEL: "synthetic-checker", AIQSA_SUBAGENTS_CHECKS_EFFORT: "high" });
    await configureResearchEvalRoles(options, ports);
    expect(ports.ensureModel.mock.calls).toEqual([["synthetic-worker", "researcher"], ["synthetic-checker", "checks"]]);
    expect(ports.patch).toHaveBeenCalledExactlyOnceWith({ expectedVersion: 7, researchResearcherProviderModelId: "researcher-id", researchResearcherReasoningEffort: "xhigh",
      researchVerifierProviderModelId: "checks-id", researchVerifierReasoningEffort: "high" });
    ports.patch.mockClear();
    await configureResearchEvalRoles(researchEvalOptions(env), ports);
    expect(ports.patch).not.toHaveBeenCalled();
    await expect(configureResearchEvalRoles(options, { ...ports, ensureModel: async () => { throw new Error("unavailable"); } })).rejects.toThrow("unavailable");
    expect(ports.patch).not.toHaveBeenCalled();
  });

  it("has a single deadline beyond ninety minutes, scoping, plan editing and the configured margin", () => {
    expect(T_QUESTION_MS).toBe(110 * 60_000);
    expect(researchQuestionTimeout(600)).toBe(T_QUESTION_MS);
    expect(researchQuestionTimeout(3600)).toBeGreaterThan((90 + 3 + 5 + 60) * 60_000);
  });

  it("bounds concurrency and retains other results after one question throws", async () => {
    let active = 0, peak = 0;
    const results = await researchPool([0, 1, 2, 3, 4], 2, async (item) => {
      active += 1; peak = Math.max(peak, active);
      await new Promise<void>((done) => setTimeout(done, 1)); active -= 1;
      if (item === 1) throw new Error("PRIVATE_PROXY_ADDRESS");
      return item;
    });
    expect(peak).toBe(2);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(4);
    expect(results[1]).toEqual({ status: "rejected", reason: "research_question_failed" });
    expect(JSON.stringify(results)).not.toContain("PRIVATE_PROXY_ADDRESS");
  });
});

describe("private durable answer files", () => {
  const job = { kind: "purchase", repeat: 1 } as const;
  it("saves immediately at 0700/0600, refuses overwrite and gives resumed runs fresh names", async () => {
    const root = directory(), legacy = join(root, "legacy.txt");
    writeFileSync(legacy, "older answer", { mode: 0o644 });
    const archive = createResearchArchive(root, [], legacy);
    const first = archive.write(job, "chat-one", "answer-run-one", { answer: "FIRST_SAVED_ANSWER" });
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, first)).mode & 0o777).toBe(0o600);
    expect(statSync(legacy).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(root, first), "utf8")).toContain("FIRST_SAVED_ANSWER");
    expect(() => archive.write(job, "chat-one", "answer-run-one", { answer: "OVERWRITE" })).toThrow("research_archive_write_failed");
    await researchPool([1, 2], 1, async (repeat) => { if (repeat === 2) throw new Error("later failure");
      return archive.write({ ...job, repeat }, "chat-two", "gate-one", { report: "REPORT" }); });
    const resumed = createResearchArchive(root).write(job, "chat-one", "answer-run-one", { answer: "RESUMED" });
    expect(resumed).not.toBe(first);
    expect(first).toContain("purchase-1-chat-one-");
    expect(readFileSync(join(root, first), "utf8")).toContain("FIRST_SAVED_ANSWER");
    expect(readdirSync(root).filter((name) => name.endsWith(".json"))).toHaveLength(3);
  });

  it("refuses symlinks and path traversal with code-only errors", () => {
    const root = directory(), target = join(root, "target"), linked = join(root, "linked");
    writeFileSync(target, "KEEP"); symlinkSync(target, linked);
    expect(() => createResearchArchive(linked)).toThrow("research_archive_unavailable");
    expect(() => createResearchArchive(root).write(job, "../escape", "answer", {})).toThrow("research_archive_key_invalid");
    expect(() => createResearchArchive(root, [], linked).write(job, "chat", "answer", {})).toThrow("research_archive_write_failed");
    expect(readFileSync(target, "utf8")).toBe("KEEP");
  });

  it("keeps JSON valid when a proxy password contains a quote", () => {
    const root = directory(), secret = '"';
    const name = createResearchArchive(root, [secret]).write(job, "chat", "answer", { answer: `before ${secret} after` });
    expect(JSON.parse(readFileSync(join(root, name), "utf8"))).toEqual({ answer: "before [redacted] after" });
  });

  it("removes proxy URL, address, login and password from answers and gates", () => {
    const root = directory();
    const proxy = parseTestProxy("http://synthetic-login:synthetic-pass%40word@198.51.100.7:43128")!;
    const secrets = [proxy.url, proxy.host, proxy.login, proxy.password];
    const raw = secrets.concat(encodeURIComponent(proxy.password)).join(" ");
    const archive = createResearchArchive(root, secrets);
    const name = archive.write(job, "chat", "answer", { answer: raw, gate: raw });
    const saved = readFileSync(join(root, name), "utf8");
    for (const secret of secrets) expect(saved).not.toContain(secret);
    expect(saved).not.toContain(encodeURIComponent(proxy.password));
    expect(redactResearchSecrets(raw, secrets)).toContain("[redacted]");
  });
});

describe("bounded judge and separate extraction", () => {
  it("discards proxy setup errors and malformed responses without preserving a URL or cause", async () => {
    const secret = "http://private-user:private-password@198.51.100.7:43128";
    for (const create of [async () => { throw new Error(secret); }, async () => ({ error: secret })]) {
      const error = await researchProxySetup(create).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toBe("Error: research_proxy_setup_failed");
      expect(JSON.stringify(error)).not.toContain(secret);
      expect((error as Error).cause).toBeUndefined();
    }
    expect(await researchProxySetup(async () => ({ proxy: { id: "synthetic-proxy" } }))).toBe("synthetic-proxy");
  });
  it("accepts strict results and rejects extra fields, invalid scores and oversized JSON", () => {
    expect(decodeResearchGrade(JSON.stringify(grade))).toEqual(grade);
    expect(decodeStructuredResearchAnswer(JSON.stringify(answer))).toEqual(answer);
    for (const bad of ["```json\n{}\n```", JSON.stringify({ ...grade, extra: true }), JSON.stringify({ ...grade, scores: { ...grade.scores, factualAccuracy: 1.1 } }),
      JSON.stringify({ ...grade, scores: { ...grade.scores, factualAccuracy: "0.5" } }), " ".repeat(128_001)]) expect(decodeResearchGrade(bad)).toBeNull();
    for (const bad of [{ ...answer, pick: "missing" }, { ...answer, candidates: Array(65).fill("A") }, { ...answer, facts: [{ ...answer.facts[0], date: "2026-02-30" }] },
      { ...answer, facts: [{ ...answer.facts[0], link: "file:///private" }] }, { ...answer, facts: Array(301).fill(answer.facts[0]) }]) {
      expect(decodeStructuredResearchAnswer(JSON.stringify(bad))).toBeNull();
    }
  });

  it("runs the rubric and extraction independently and records only reported tokens", async () => {
    const fake = vi.fn(async (instructions: string) => response(instructions === RESEARCH_JUDGE_PROMPT ? grade : answer));
    const judged = await evaluateResearch(fake, RESEARCH_JUDGE_PROMPT, { answer: "synthetic" }, decodeResearchGrade);
    const extracted = await evaluateResearch(fake, RESEARCH_EXTRACTION_PROMPT, { answer: "synthetic" }, decodeStructuredResearchAnswer);
    expect(fake).toHaveBeenCalledTimes(2);
    expect(judged).toMatchObject({ status: "ok", value: grade, tokens: { inputTokens: 100, outputTokens: 20, cachedInputTokens: null } });
    expect(extracted).toMatchObject({ status: "ok", value: answer });
    expect(RESEARCH_JUDGE_PROMPT).not.toBe(RESEARCH_EXTRACTION_PROMPT);
  });

  it("records failed/junk/incomplete calls without leaking errors or preventing extraction", async () => {
    const failed = await evaluateResearch(async () => { throw new Error("http://proxy:password@host"); }, RESEARCH_JUDGE_PROMPT, {}, decodeResearchGrade);
    expect(failed).toMatchObject({ status: "failed", value: null, tokens: { inputTokens: null, outputTokens: null } });
    expect(JSON.stringify(failed)).not.toContain("password");
    const junk = await evaluateResearch(async () => response("PRIVATE_MARKER"), RESEARCH_JUDGE_PROMPT, {}, decodeResearchGrade);
    expect(junk).toMatchObject({ status: "invalid", value: null, tokens: { inputTokens: 100 } });
    expect(JSON.stringify(junk)).not.toContain("PRIVATE_MARKER");
    expect((await evaluateResearch(async () => ({ ...response(grade), status: "incomplete" }), RESEARCH_JUDGE_PROMPT, {}, decodeResearchGrade)).status).toBe("invalid");
    expect((await evaluateResearch(async () => response(answer), RESEARCH_EXTRACTION_PROMPT, {}, decodeStructuredResearchAnswer)).status).toBe("ok");
    const unused = vi.fn();
    expect((await evaluateResearch(unused, RESEARCH_JUDGE_PROMPT, "a".repeat(800_001), decodeResearchGrade)).status).toBe("input_too_large");
    expect(unused).not.toHaveBeenCalled();
    expect((await evaluateResearch(unused, RESEARCH_JUDGE_PROMPT, undefined, decodeResearchGrade)).status).toBe("input_invalid");
    expect((await evaluateResearch(null, RESEARCH_JUDGE_PROMPT, {}, decodeResearchGrade)).status).toBe("not_configured");
  });
});

describe("content-free stdout, role accounting and plan window", () => {
  it("emits no answer text, quote, claim, source URL, model-chosen class or judge rationale", () => {
    const marker = "PRIVATE_ANSWER_MARKER";
    const marked = { ...answer, candidates: [marker], criteria: [{ name: marker, reason: marker }], facts: [{ candidate: marker, attribute: marker,
      value: marker, date: null, link: `https://example.test/${marker}` }], pick: marker };
    const metrics = researchMetrics({ started: true, researcherTurns: 1, sentBack: 0, drafts: [[{ claim: marker, quote: marker, sourceClass: marker,
      url: `https://example.test/${marker}` }]], opened: new Set([`https://example.test/${marker}`]) });
    const summary = researchEvaluationSummary({ job: { kind: "purchase", repeat: 1 }, answerCount: 1, gateReportCount: 1, failed: false, wallSeconds: 5,
      extraction: { ...emptyEval<StructuredResearchAnswer>("ok"), value: marked }, grade: { ...emptyEval<ResearchGrade>("ok"), value: { ...grade, limitations: [marker] } } });
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    process.stdout.write(`${JSON.stringify({ ...summary, metrics, comparisons: researchRepeatability([marked, marked]) })}\n`);
    expect(output).toHaveBeenCalledOnce();
    expect(output.mock.calls[0][0]).not.toContain(marker);
    expect(output.mock.calls[0][0]).not.toContain("https:");
    expect(metrics.openedByClass).toEqual({ other: 1 });
  });

  it("splits thread-bound usage and keeps pooled foreground and absent receipts unknown", () => {
    const names = new Map([["research-one", ["r"]], ["gap-judge-one", ["g"]], ["verifier-one", ["v"]], ["skeptic-one", ["s"]]]);
    const row = (runId: string, threadId: string | null, inputTokens: number | null, purpose = "subagent"): ResearchUsageRow =>
      ({ runId, threadId, inputTokens, outputTokens: 3, cachedInputTokens: null, purpose });
    const timings = [null, "r", "g", "v", "s"].map((threadId) => ({ runId: threadId === "g" ? null : threadId ?? "main", threadId,
      startedAt: "2026-11-01T00:00:00Z", endedAt: "2026-11-01T00:02:00Z" }));
    const result = researchRoleUsage([row("main", null, 10, "chat_answer"), row("r", "r", 20), row("v", "v", null), row("s", "s", 30), row("main", null, 40)], timings, names);
    expect(result.main).toMatchObject({ inputTokens: 10, minutes: 2, missingUsageTurns: 0 });
    expect(result.researchers).toMatchObject({ inputTokens: 20, minutes: 2 });
    expect(result.gap_judge).toMatchObject({ inputTokens: null, minutes: 2, missingUsageTurns: 1 });
    expect(result.verifier).toMatchObject({ inputTokens: null, outputTokens: 3, minutes: 2 });
    expect(result.skeptic).toMatchObject({ inputTokens: 30, minutes: 2 });
    expect(result.unattributed).toMatchObject({ inputTokens: 40, minutes: null });
    const pooled = researchRoleUsage([row("r", "r", 20), row("main", null, 30, "search")], [...timings,
      { ...timings[2], parentRunId: "r" }], names);
    expect(pooled.researchers).toMatchObject({ inputTokens: null, missingUsageTurns: 1 });
    expect(pooled.unattributed).toMatchObject({ inputTokens: 50 });
    expect(researchRoleUsage([], [], names).main).toMatchObject({ inputTokens: null, minutes: null });
    expect(researchRoleUsage([row("r", "r", 20)], [{ ...timings[1], endedAt: null }], names).researchers.minutes).toBeNull();
  });

  it("reports the plan wait and only a known release label, including a missing frame", () => {
    expect(researchPlanWindow(null)).toEqual({ present: false, seconds: null, releasedBy: null });
    expect(researchPlanWindow({ windowEndsAt: "2026-11-01T00:01:00Z", releasedAt: "2026-11-01T00:01:00Z", releasedBy: "timer" }))
      .toEqual({ present: true, seconds: 60, releasedBy: "timer" });
    expect(researchPlanWindow({ windowEndsAt: "2026-11-01T00:01:00Z", releasedAt: "2026-11-01T00:00:10Z", releasedBy: "start_button" }).seconds).toBe(10);
    expect(researchPlanWindow({ windowEndsAt: null, releasedAt: null, releasedBy: "PRIVATE_MARKER" }).releasedBy).toBeNull();
  });
});

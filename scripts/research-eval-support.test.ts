import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdminProviderModelConfiguration } from "../lib/contracts/adminProviders";
import { researchAnswerText, researchCounterEvidenceNote, researchNote, type ResearchNoteKey } from "../lib/server/research/notes";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RESEARCH_EXTRACTION_PROMPT, RESEARCH_JUDGE_PROMPT, T_QUESTION_MS, comparePicks, compareResearchAnswers, configureResearchEvalRoles, conflictingFacts, createResearchArchive,
  criteriaOverlap, decodeResearchGrade, decodeStructuredResearchAnswer, emptyEval, evaluateResearch, redactResearchSecrets, researchEvalOptions,
  researchEffortConfiguration, researchEvaluationSummary, researchPlanWindow, researchPool, researchProxySetup, researchQuestionTimeout, researchComparisonDetails, researchRepeatability, researchRoleUsage, researchStoreFacts, researchUsageByModel, shortlistOverlap,
  type ResearchGrade, type ResearchTranscriptRow, type ResearchUsageRow, type StructuredResearchAnswer,
  RESEARCH_PRODUCTION_SEARCH, parseResearchAdminProxy, readPrivateFile, researchAdminProxySecrets, researchAttributionCounts, researchCitationAttribution,
  researchCitedUrls, researchProxyCheckStatus, researchQuestionText, researchSearchSourceStatus
} from "./research-eval-support";
import { parseTestProxy, researchDraftFindings, researchMetrics, researchProcessFacts, researchServerNotes } from "./subagent-scenarios-support";

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
    expect(conflictingFacts(answer, { ...later, facts: later.facts.map((fact) => ({ ...fact, link: "https://example.test/other" })) }))
      .toMatchObject({ conflicts: [{ left: { attribute: "height" } }], datedPriceChanges: 0, differentSellerPrices: 1 });
    expect(conflictingFacts(answer, { ...later, facts: later.facts.map((fact) => ({ ...fact, date: "2026-02-30" })) }).conflicts).toHaveLength(2);
  });

  it.each([
    { name: "same seller and date", link: "https://example.test/a", date: "2026-11-01", conflicts: 1, datedPriceChanges: 0, differentSellerPrices: 0 },
    { name: "same seller without date", link: "https://example.test/a", date: null, conflicts: 1, datedPriceChanges: 0, differentSellerPrices: 0 },
    { name: "same seller on another date", link: "https://example.test/a", date: "2026-11-02", conflicts: 0, datedPriceChanges: 1, differentSellerPrices: 0 },
    { name: "different sellers on the same date", link: "https://example.test/b", date: "2026-11-01", conflicts: 0, datedPriceChanges: 0, differentSellerPrices: 1 },
    { name: "different sellers on different dates", link: "https://example.test/b", date: "2026-11-02", conflicts: 0, datedPriceChanges: 0, differentSellerPrices: 1 },
    { name: "different sellers without dates", link: "https://example.test/b", date: null, conflicts: 0, datedPriceChanges: 0, differentSellerPrices: 1 }
  ])("classifies a changed price: $name", ({ link, date, conflicts, datedPriceChanges, differentSellerPrices }) => {
    const first = { ...answer, facts: [answer.facts[0]] };
    const second = { ...answer, facts: [{ ...answer.facts[0], value: "41000 RUB", link, date }] };
    const result = conflictingFacts(first, second);
    expect(result.conflicts).toHaveLength(conflicts);
    expect(result).toMatchObject({ datedPriceChanges, differentSellerPrices });
  });

  it("does not invent a seller from an absent link, or relax non-price conflicts", () => {
    const unknown = { ...answer, facts: [{ ...answer.facts[0], link: null }] };
    expect(conflictingFacts(unknown, { ...unknown, facts: [{ ...unknown.facts[0], value: "41000 RUB", date: "2026-11-02" }] }).conflicts).toHaveLength(1);
    const spec = { ...answer, facts: [answer.facts[1]] };
    expect(conflictingFacts(spec, { ...spec, facts: [{ ...spec.facts[0], value: "30 cm", date: "2026-11-02", link: "https://example.test/b" }] }).conflicts).toHaveLength(1);
  });

  it("summarizes the acceptance table while retaining full comparisons only in the private entry", () => {
    const other = { ...answer, candidates: ["Candidate A", "Candidate C"], criteria: [answer.criteria[0]],
      facts: [{ ...answer.facts[1], value: "30 cm" }] };
    const summary = researchRepeatability([answer, other]);
    expect(summary).toMatchObject({ largestPickGroup: 2, comparedRuns: 2, ties: 0, minimumShortlistOverlap: 1 / 3,
      minimumCriteriaOverlap: 0.5, totalConflicts: 1 });
    expect(researchRepeatability([answer])).toMatchObject({ minimumShortlistOverlap: null, minimumCriteriaOverlap: null });
    const runs = [{ repeat: 1, chat: "chat-one", answer }, { repeat: 2, chat: "chat-two", answer: other }, { repeat: 3, chat: null, answer: null }];
    const details = researchComparisonDetails(runs);
    expect(details.runs).toEqual(runs);
    expect(details.pairs).toHaveLength(1);
    expect(details.pairs[0]).toMatchObject({ leftRepeat: 1, rightRepeat: 2, shortlist: { jaccard: 1 / 3 }, criteria: { jaccard: 0.5 },
      conflictingFacts: [{ left: { value: "20 cm", attribute: "height" }, right: { value: "30 cm" } }] });
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
    const other = { ...marked, facts: [{ ...marked.facts[0], value: `${marker} conflict` }] };
    const root = directory();
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const file = createResearchArchive(root).write({ kind: "purchase", repeat: 1 }, "chat-one", "comparisons", researchComparisonDetails([
      { repeat: 1, chat: "chat-one", answer: marked }, { repeat: 2, chat: "chat-two", answer: other }
    ]));
    const details = JSON.parse(readFileSync(join(root, file), "utf8"));
    expect(details.runs[0].answer.candidates).toEqual([marker]);
    expect(details.pairs[0].conflictingFacts[0].left.value).toBe(marker);
    expect(statSync(join(root, file)).mode & 0o777).toBe(0o600);
    const processFacts = researchProcessFacts({ drafts: [[{ claim: marker, quote: marker, url: `https://example.test/${marker}`, sourceClass: marker }]],
      calls: [{ toolName: "submit_research_draft", result: { message: `${marker} [Skeptic]`, status: "sent_back" } }],
      gates: [{ name: "skeptic-1", state: "done", reasonCode: null, report: marker }] });
    process.stdout.write(`${JSON.stringify({ ...summary, metrics, ...processFacts, serverNotes: researchServerNotes(marker), comparisons: researchRepeatability([marked, other]) })}\n`);
    expect(output).toHaveBeenCalledOnce();
    expect(output.mock.calls[0][0]).not.toContain(marker);
    expect(output.mock.calls[0][0]).not.toContain("https:");
    expect(metrics.openedByClass).toEqual({ other: 1 });
  });

  it("restores every draft decision, gate fact, fetch outcome and the existing server-note pattern", () => {
    const finding = { claim: "private claim", quote: "private quote", sourceClass: "primary_official", url: "https://example.test/a" };
    const calls = [
      { toolName: "submit_research_draft", result: { status: "accepted" } },
      ...["[Independent check]", "[Skeptic]", "Research questions still open", "Открытые вопросы исследования", "mechanical"].map((message) =>
        ({ toolName: "submit_research_draft", result: { status: "sent_back", message } })),
      { toolName: "fetch_url", result: { rawPreview: { fetchUrl: { outcome: "read", proxy: { name: "PRIVATE_PROXY" } } } } },
      { toolName: "fetch_url", result: { rawPreview: { fetchUrl: { outcome: "fetch_network_error", proxyCode: "proxy_inactive" } } } },
      { toolName: "fetch_url", result: { rawPreview: { fetchUrl: { outcome: "PRIVATE_PROXY" } } } }
    ];
    const facts = researchProcessFacts({ drafts: calls.slice(0, 6).map(() => [finding]), calls,
      gates: [{ name: "skeptic-2", state: "done", reasonCode: null, report: "private report" }] });
    expect(facts.timeline.map((entry) => entry.sentBackBy)).toEqual([null, "verifier", "skeptic", "gap_judge", "gap_judge", "gap_mechanical"]);
    expect(facts.timeline[0]).toMatchObject({ accepted: true, findings: 1, byClass: { primary_official: 1 } });
    expect(facts).toMatchObject({ gateTurns: 1, gateTurnFacts: [{ name: "skeptic-2", state: "done", reason: null, reportChars: 14 }],
      fetchOutcomes: { read: 1, proxy_inactive: 1, unknown: 1 }, fetchProxyReads: 1 });
    expect(JSON.stringify(facts)).not.toContain("PRIVATE_PROXY");
    const prefixes = ["Проверено", "Independently checked", "Checked by", "Проверил", "Проверка", "Одну из проверок", "The check", "Не удалось",
      "Source could", "Время вышло", "Time ran out", "Отчёт пришёл", "This report came", "Research ended", "Исследование завершилось"];
    expect(researchServerNotes(prefixes.map((prefix) => `*${prefix} note.*`).join("\n"))).toEqual(prefixes.map((prefix) => `${prefix} note.`));
    expect(researchServerNotes("ordinary private answer *Unrelated note*")).toEqual([]);
    // Every note the answer carries since 2026-11-02 reads as one, the checks' two of content included.
    const keys = { before_plan: true, composed_failed: true, composed_no_report: true, composed_timed_out: true, followup_not_applied: true, gate_failed: true, incomplete: true,
      no_findings: true, not_submitted: true, run_failed: true, stopped: true, time_out: true } satisfies Record<ResearchNoteKey, true>;
    const current = [...Object.keys(keys).map((key) => researchNote(key as ResearchNoteKey)), researchCounterEvidenceNote([{ claim: "It sags.", quote: null, url: "https://lab.example/x" }, { claim: "It smells.", quote: null, url: "https://lab.example/y" }])!,
      "The checks did not confirm these facts this report cites, so do not rely on them: Lonax — price."];
    expect(researchServerNotes(researchAnswerText("# Report", current))).toEqual(current);
  });

  it("reads what a person does on a kind's run", () => {
    const base = { AIQSA_SUBAGENTS_ANSWERS_DIR: "/tmp/a" };
    expect(researchEvalOptions(base).acts).toEqual({});
    expect(researchEvalOptions({ ...base, AIQSA_SUBAGENTS_T_ACTS: "technical=edit, medical=start,market=restart" }).acts).toEqual({ market: "restart", medical: "start", technical: "edit" });
    for (const bad of ["technical", "technical=dance", "nothing=edit", "technical=edit,technical=start", "technical=edit=start"]) {
      expect(() => researchEvalOptions({ ...base, AIQSA_SUBAGENTS_T_ACTS: bad })).toThrow("research_acts_invalid");
    }
  });

  it("reads a draft's findings from the records its ids name, and a stored draft's as typed", () => {
    const rows = [{ id: "r1", kind: "finding", claim: "A claim", quote: "a quote", url: "https://x/a", sourceClass: "owner_reviews", dataset: null },
      { id: "r2", kind: "dataset", claim: "A count", quote: null, url: null, sourceClass: "owner_reviews", dataset: { examples: [{ quote: "an example", url: "https://x/b" }] } },
      { id: "r3", kind: "not_found", claim: null, quote: null, url: null, sourceClass: null, dataset: null }];
    expect(researchDraftFindings({ record_ids: ["r1", "r2", "r3", "gone"] }, rows)).toEqual([
      { claim: "A claim", quote: "a quote", sourceClass: "owner_reviews", url: "https://x/a" }, { claim: "A count", quote: "an example", sourceClass: "owner_reviews", url: "https://x/b" }]);
    expect(researchDraftFindings({ findings: [{ claim: "Typed", quote: "q", source_class: "primary_official", url: "https://x/c" }] }, rows)).toEqual([
      { claim: "Typed", quote: "q", sourceClass: "primary_official", url: "https://x/c" }]);
    expect(researchDraftFindings(null, rows)).toEqual([]);
    const sent = { result: { content: [{ type: "json", value: { status: "sent_back", gate: "report_check", message: "Rows" } }] }, toolName: "submit_research_draft" };
    expect(researchProcessFacts({ calls: [sent], drafts: [[]], gates: [{ name: "verifier-2-1", state: "done", reasonCode: null, report: "r" }] })).toMatchObject({
      gateTurnFacts: [{ name: "verifier-2-1" }], timeline: [{ sentBackBy: "report_check" }] });
  });

  const names = new Map([["research-one", ["r"]], ["gap-judge-1", ["g"]], ["verifier-1", ["v"]], ["skeptic-1", ["s"]]]);
  const origin = { model: "synthetic-worker", provider: "synthetic-route" };
  const row = (id: string, threadId: string | null, sequence: number, kind: string, body: Record<string, unknown>, overrides: Partial<ResearchTranscriptRow> = {}): ResearchTranscriptRow =>
    ({ id, runId: "shared-main-run", threadId, turnId: threadId ? `${threadId}-turn` : null, sequence, kind, body,
      createdAt: "2026-11-01T00:00:00Z", ...overrides });
  const timing = (threadId: string | null) => ({ threadId, startedAt: "2026-11-01T00:00:00Z", endedAt: "2026-11-01T00:02:00Z" });
  const anchor = (inputTokens: number) => ({ attachmentIds: [], baseId: null, fixedTokens: 800, inputTokens });

  it("counts a handwritten text-plus-two-calls response once, with one anchor and three output shares", () => {
    const rows = [
      row("text", "r", 0, "assistant_text", { origin, text: "Reading both sources", requestAnchor: anchor(900), outputTokens: 12 }),
      row("call-a", "r", 1, "tool_call", { origin, name: "fetch_url", arguments: "{}", outputTokens: 10 }),
      row("call-b", "r", 2, "tool_call", { origin, name: "fetch_url", arguments: "{}", outputTokens: 8 }),
      row("result-a", "r", 3, "tool_result", { output: "source text" }),
      row("result-b", "r", 4, "tool_result", { output: "source text" }),
      row("main", null, 0, "assistant_text", { origin, text: "Answer", requestAnchor: anchor(1200), outputTokens: 50 }),
      ...["g", "v", "s"].map((threadId) => row(threadId, threadId, 0, "assistant_text", { origin, text: "Check", requestAnchor: anchor(100), outputTokens: 5 }))
    ];
    const result = researchRoleUsage(rows, [null, "r", "g", "v", "s"].map(timing), names);
    expect(result.researchers).toMatchObject({ inputTokens: 900, outputTokens: 30, responses: 1, missing: 0, minutes: 2 });
    expect(result.main).toMatchObject({ inputTokens: 1200, outputTokens: 50, responses: 1, missing: 0, minutes: 2 });
    for (const role of ["gap_judge", "verifier", "skeptic"]) expect(result[role]).toMatchObject({ inputTokens: 100, outputTokens: 5, responses: 1, missing: 0 });
    expect(researchRoleUsage([...rows, rows[0]], [], names).researchers.inputTokens).toBe(900);
  });

  it("counts a missing response once, including multi-item rounds and partially reported figures", () => {
    const rows = [
      row("known", "r", 0, "assistant_text", { origin, requestAnchor: anchor(10), outputTokens: 2 }),
      row("followup", "r", 1, "user", { text: "Continue" }),
      row("missing-text", "r", 2, "assistant_text", { origin, text: "No figures" }),
      row("missing-call-a", "r", 3, "tool_call", { origin }), row("missing-call-b", "r", 4, "tool_call", { origin }),
      row("result", "r", 5, "tool_result", {}),
      row("input-only", "r", 6, "assistant_text", { origin, requestAnchor: anchor(20) }),
      row("followup-two", "r", 7, "user", {}), row("output-only", "r", 8, "assistant_text", { origin, outputTokens: 3 })
    ];
    // The mean per response counts only the two responses whose input was reported.
    expect(researchRoleUsage(rows, [], names).researchers).toMatchObject({ responses: 4, inputTokens: 30, outputTokens: 5, missing: 3, missingInput: 2, missingOutput: 2,
      inputPerResponse: 15 });
    expect(researchRoleUsage(rows.slice(2, 5), [], names).researchers).toMatchObject({ responses: 1, missing: 1, inputTokens: null, outputTokens: null, inputPerResponse: null });
  });

  it("keeps response boundaries across runs, turns, anchors and write batches and ignores compaction/synthetic items", () => {
    const rows = [
      row("one", "r", 0, "assistant_text", { origin, requestAnchor: anchor(10), outputTokens: 2 }),
      row("two", "r", 1, "assistant_text", { origin, requestAnchor: anchor(10), outputTokens: 2 }),
      row("three", "r", 2, "assistant_text", { origin }, { createdAt: "2026-11-01T00:00:01Z" }),
      row("four", "r", 0, "assistant_text", { origin }, { runId: "another-run" }),
      row("five", "r", 3, "assistant_text", { origin }, { turnId: "another-turn" }),
      row("compact", "r", 4, "compaction", { origin, outputTokens: 1000 }),
      row("synthetic", "r", 5, "assistant_text", { text: "Server message" })
    ];
    expect(researchRoleUsage(rows, [], names).researchers).toMatchObject({ responses: 5, inputTokens: 20, outputTokens: 4, missing: 3 });
    expect(researchRoleUsage([row("zero", "s", 0, "assistant_text", { origin, requestAnchor: anchor(0), outputTokens: 0 })], [], names).skeptic)
      .toMatchObject({ inputTokens: 0, outputTokens: 0, missing: 0 });
    expect(researchRoleUsage([], [{ ...timing("r"), endedAt: null }], names).researchers).toMatchObject({ inputTokens: null, outputTokens: null, minutes: null });
  });

  it("splits the wider paid-call ledger by model without estimating missing fields", () => {
    const usage = (modelId: string, purpose: string, inputTokens: number | null, outputTokens: number | null): ResearchUsageRow =>
      ({ modelId, purpose, inputTokens, outputTokens, cachedInputTokens: null });
    expect(researchUsageByModel([usage("synthetic-main", "chat_answer", 100, 10), usage("synthetic-worker", "subagent", 20, 2),
      usage("synthetic-worker", "subagent", 30, 3), usage("synthetic-main", "compaction", 200, 20)]))
      .toEqual([{ modelId: "synthetic-main", rows: 2, inputTokens: 300, outputTokens: 30, cachedInputTokens: null, missing: 0 },
        { modelId: "synthetic-worker", rows: 2, inputTokens: 50, outputTokens: 5, cachedInputTokens: null, missing: 0 }]);
    expect(researchUsageByModel([usage("synthetic-worker", "subagent", null, 2), usage("synthetic-worker", "subagent", 20, 3)])[0])
      .toMatchObject({ inputTokens: null, outputTokens: 5, missing: 1 });
  });

  it("counts a run's records by kind, quote check and how each page was reached", () => {
    expect(researchStoreFacts({ frame: { criteria: 4, rows: 8, changes: 8 },
      evidence: [{ kind: "finding", quoteCheck: "found", count: 29 }, { kind: "finding", quoteCheck: "not_checked", count: 2 }, { kind: "dataset", quoteCheck: "found", count: 5 },
        { kind: "not_found", quoteCheck: null, count: 9 }],
      pages: [{ obtainedBy: "browser", count: 15 }, { obtainedBy: "tool", count: 1 }] })).toEqual({
      frame: { criteria: 4, rows: 8, changes: 8 }, records: { finding: 31, dataset: 5, not_found: 9 }, quoteChecks: { found: 34, not_checked: 2, none: 9 }, pages: { browser: 15, tool: 1 } });
    expect(researchStoreFacts({ frame: null, evidence: [], pages: [] })).toEqual({ frame: null, records: {}, quoteChecks: {}, pages: {} });
  });

  it("reports the plan wait and only a known release label, including a missing frame", () => {
    expect(researchPlanWindow(null)).toEqual({ present: false, seconds: null, releasedBy: null });
    expect(researchPlanWindow({ createdAt: "2026-11-01T00:00:00Z", releasedAt: "2026-11-01T00:01:00Z", releasedBy: "timer" }))
      .toEqual({ present: true, seconds: 60, releasedBy: "timer" });
    expect(researchPlanWindow({ createdAt: "2026-11-01T00:00:00Z", releasedAt: "2026-11-01T00:00:10Z", releasedBy: "start_button" }).seconds).toBe(10);
    expect(researchPlanWindow({ createdAt: null, releasedAt: null, releasedBy: "PRIVATE_MARKER" }).releasedBy).toBeNull();
  });

  it("includes time spent holding the plan after cancel_hold rewrites the countdown deadline", () => {
    const held = { createdAt: "2026-11-01T00:00:00Z", windowEndsAt: "2026-11-01T00:03:00Z", releasedAt: "2026-11-01T00:03:00Z", releasedBy: "timer" };
    expect(researchPlanWindow(held)).toEqual({ present: true, seconds: 180, releasedBy: "timer" });
  });
});

describe("acceptance options", () => {
  const env = { AIQSA_SUBAGENTS_ANSWERS_DIR: "/private/research" };
  const production = { ...env, AIQSA_SUBAGENTS_T_SEARCH: "production", AIQSA_SUBAGENTS_SEARCH_MODEL: "search-model-1", DEEPSEEK_API_KEY: "k" };
  let directory: string | null = null;
  const scratch = () => (directory ??= mkdtempSync(join(tmpdir(), "research-acceptance-")));
  afterEach(() => { if (directory) rmSync(directory, { force: true, recursive: true }); directory = null; });
  const file = (name: string, text: string, mode = 0o600) => {
    const path = join(scratch(), name);
    writeFileSync(path, text, { mode });
    chmodSync(path, mode);
    return path;
  };

  it("takes production Search only with its model and DeepSeek's key, and the question file only with a purchase question", () => {
    expect(researchEvalOptions(env)).toMatchObject({ search: null, questionFile: null, adminProxyFile: null });
    expect(researchEvalOptions(production).search).toEqual({ model: "search-model-1", plan: "production" });
    expect(() => researchEvalOptions({ ...production, AIQSA_SUBAGENTS_SEARCH_MODEL: "" })).toThrow("research_search_model_required");
    expect(() => researchEvalOptions({ ...production, DEEPSEEK_API_KEY: undefined })).toThrow("deepseek_key_required");
    expect(() => researchEvalOptions({ ...env, AIQSA_SUBAGENTS_T_SEARCH: "all" })).toThrow("research_search_invalid");
    expect(() => researchEvalOptions({ ...env, AIQSA_SUBAGENTS_SEARCH_MODEL: "search-model-1" })).toThrow("research_search_model_invalid");
    expect(() => researchEvalOptions({ ...production, AIQSA_SUBAGENTS_SEARCH_MODEL: "bad model" })).toThrow("research_search_model_invalid");
    expect(researchEvalOptions({ ...env, AIQSA_SUBAGENTS_T_QUESTION_FILE: "/private/q", AIQSA_SUBAGENTS_ADMIN_PROXY_FILE: "/private/p" }))
      .toMatchObject({ questionFile: "/private/q", adminProxyFile: "/private/p" });
    expect(() => researchEvalOptions({ ...env, AIQSA_SUBAGENTS_T_KINDS: "medical", AIQSA_SUBAGENTS_T_QUESTION_FILE: "/private/q" })).toThrow("research_question_file_unused");
  });

  it("reads only a private, regular, bounded, non-empty file and replaces only the purchase question", () => {
    const question = file("question", "  A synthetic purchase question.\n");
    expect(readPrivateFile(question, 100, "research_question_file")).toBe("  A synthetic purchase question.\n");
    expect(() => readPrivateFile(file("open", "text", 0o644), 100, "research_question_file")).toThrow("research_question_file_mode");
    expect(() => readPrivateFile(file("group", "text", 0o640), 100, "research_question_file")).toThrow("research_question_file_mode");
    expect(() => readPrivateFile(file("blank", " \n"), 100, "research_question_file")).toThrow("research_question_file_empty");
    expect(() => readPrivateFile(file("long", "x".repeat(101)), 100, "research_question_file")).toThrow("research_question_file_too_large");
    expect(() => readPrivateFile(join(scratch(), "absent"), 100, "research_question_file")).toThrow("research_question_file_invalid");
    expect(() => readPrivateFile(scratch(), 100, "research_question_file")).toThrow("research_question_file_invalid");
    const link = join(scratch(), "link");
    symlinkSync(question, link);
    expect(() => readPrivateFile(link, 100, "research_question_file")).toThrow("research_question_file_invalid");
    const exposed = file("other", "secret text", 0o644);
    expect(() => readPrivateFile(exposed, 100, "research_question_file")).toThrow(expect.objectContaining({ message: "research_question_file_mode" }));
    expect(researchQuestionText("purchase", "built-in", " operator question \n")).toBe("operator question");
    expect(researchQuestionText("medical", "built-in", "operator question")).toBe("built-in");
    expect(researchQuestionText("purchase", "built-in", null)).toBe("built-in");
  });

  it("parses the administrator proxy file exactly and keeps its values out of errors", () => {
    const valid = { url: "http://proxy.example.net:8080", username: "synthetic-user", password: "synthetic-pass", country: "RU", hints: [".ru", " .su "] };
    const proxy = parseResearchAdminProxy(JSON.stringify(valid));
    expect(proxy).toEqual({ country: "RU", domainHints: [".ru", ".su"], host: "proxy.example.net", login: "synthetic-user", password: "synthetic-pass",
      port: 8080, protocol: "http", url: "http://proxy.example.net:8080" });
    expect(parseResearchAdminProxy(JSON.stringify({ ...valid, url: "socks5://proxy.example.net:1080" })).protocol).toBe("socks5");
    expect(researchAdminProxySecrets(proxy)).toEqual(["http://proxy.example.net:8080", "proxy.example.net", "synthetic-user", "synthetic-pass"]);
    expect(researchAdminProxySecrets(null)).toEqual([]);
    for (const broken of [
      "not json", JSON.stringify([valid]), JSON.stringify({ ...valid, extra: true }), JSON.stringify({ ...valid, hints: undefined }),
      JSON.stringify({ ...valid, url: "http://a:b@proxy.example.net:8080" }), JSON.stringify({ ...valid, url: "http://proxy.example.net" }),
      JSON.stringify({ ...valid, url: "ftp://proxy.example.net:21" }), JSON.stringify({ ...valid, url: "http://proxy.example.net:8080/path" }),
      JSON.stringify({ ...valid, country: "ru" }), JSON.stringify({ ...valid, username: "" }), JSON.stringify({ ...valid, password: "a\nb" }),
      JSON.stringify({ ...valid, hints: [] }), JSON.stringify({ ...valid, hints: [1] })
    ]) {
      expect(() => parseResearchAdminProxy(broken)).toThrow(expect.objectContaining({ message: "research_admin_proxy_file_invalid" }));
    }
    expect(researchProxyCheckStatus({ check: { status: "ok", exitAddress: "203.0.113.1" } })).toBe("ok");
    expect(researchProxyCheckStatus({ check: { status: "proxy_auth_failed" } })).toBe("proxy_auth_failed");
    expect(researchProxyCheckStatus({ check: { status: "Bad Status" } })).toBe("invalid");
    expect(researchProxyCheckStatus(null)).toBe("invalid");
  });

  it("requires each production source live, published, on its client route and checked with sources", () => {
    const source = { archivedAt: null, enabled: true, ready: true, configurationActive: true, draftDirty: false,
      configuration: { adapterKind: "provider_model_client", protocol: "openai_responses_web_search", providerModelId: "model-1" },
      draftTestEvidence: { method: "provider_search", protocol: "openai_responses_web_search", status: "available", normalizedSourceCount: 4 } };
    const expected = { protocol: "openai_responses_web_search", providerModelId: "model-1" };
    expect(researchSearchSourceStatus(source, expected)).toBe("ok");
    expect(researchSearchSourceStatus(null, expected)).toBe("missing");
    expect(researchSearchSourceStatus({ ...source, archivedAt: "2026-11-01" }, expected)).toBe("archived");
    expect(researchSearchSourceStatus({ ...source, enabled: false }, expected)).toBe("disabled");
    expect(researchSearchSourceStatus({ ...source, ready: false }, expected)).toBe("not_ready");
    expect(researchSearchSourceStatus({ ...source, draftDirty: true }, expected)).toBe("not_published");
    expect(researchSearchSourceStatus(source, { ...expected, providerModelId: "model-2" })).toBe("configuration_mismatch");
    expect(researchSearchSourceStatus({ ...source, configuration: { ...source.configuration, adapterKind: "answer_provider_hosted" } }, expected)).toBe("configuration_mismatch");
    expect(researchSearchSourceStatus({ ...source, draftTestEvidence: null }, expected)).toBe("not_checked");
    expect(researchSearchSourceStatus({ ...source, draftTestEvidence: { ...source.draftTestEvidence, method: "configuration" } }, expected)).toBe("not_checked");
    expect(researchSearchSourceStatus({ ...source, draftTestEvidence: { ...source.draftTestEvidence, status: "unavailable" } }, expected)).toBe("check_unavailable");
    expect(researchSearchSourceStatus({ ...source, draftTestEvidence: { ...source.draftTestEvidence, normalizedSourceCount: 0 } }, expected)).toBe("check_empty");
    // DeepSeek's source borrows any DeepSeek model's key, so only its protocol is compared.
    expect(researchSearchSourceStatus({ ...source, configuration: { ...source.configuration, protocol: "deepseek_search_api", providerModelId: "other" },
      draftTestEvidence: { ...source.draftTestEvidence, protocol: "deepseek_search_api" } }, { protocol: "deepseek_search_api" })).toBe("ok");
    expect(RESEARCH_PRODUCTION_SEARCH.map((entry) => entry.protocol)).toEqual(["openai_responses_web_search", "openrouter_perplexity_chat", "deepseek_search_api"]);
  });

  it("attributes the cited records' links to the Search sources that returned them, in fetch_url's form", () => {
    const evidence = [
      { id: "r1", url: "https://Shop.Example.com:443/item#reviews", dataset: null },
      { id: "r2", url: "https://example.org/review", dataset: null },
      { id: "r3", url: null, dataset: { examples: [{ url: "https://example.net/a" }, { url: "not a url" }] } },
      { id: "r4", url: "https://example.com/linked-in-answer", dataset: null },
      { id: "r5", url: "https://example.com/uncited", dataset: null }
    ];
    const cited = researchCitedUrls({ evidence, answer: "See [the page](https://example.com/linked-in-answer).", lastDraft: { record_ids: ["r1", "r2", "r3", "missing", 7] } });
    expect(cited).toEqual({ records: 4, urls: ["https://example.com/linked-in-answer", "https://example.net/a", "https://example.org/review", "https://shop.example.com/item"] });
    expect(researchCitedUrls({ evidence: [], answer: "", lastDraft: { findings: [{ url: "https://EXAMPLE.com/x" }] } }))
      .toEqual({ records: 0, urls: ["https://example.com/x"] });
    expect(researchCitedUrls({ evidence, answer: "", lastDraft: null })).toEqual({ records: 0, urls: [] });
    const labels = new Map([["opt-openai", "openai"], ["opt-perplexity", "perplexity"], ["opt-deepseek", "deepseek"]]);
    const attribution = researchCitationAttribution(cited.urls, [
      { strategyId: "opt-openai", sources: [{ url: "https://shop.example.com/item" }, { url: "https://example.org/review" }] },
      { strategyId: "opt-deepseek", sources: [{ url: "https://example.org/review#top" }, { url: "https://example.net/a" }, { title: "no url" }] },
      { strategyId: "opt-perplexity", sources: null },
      { strategyId: "opt-retired", sources: [{ url: "https://example.com/linked-in-answer" }] }
    ], labels);
    expect(attribution.sources).toEqual({
      deepseek: { urls: ["https://example.net/a", "https://example.org/review"], only: 1 },
      openai: { urls: ["https://example.org/review", "https://shop.example.com/item"], only: 1 },
      other: { urls: ["https://example.com/linked-in-answer"], only: 1 },
      perplexity: { urls: [], only: 0 }
    });
    expect(attribution.unsurfaced).toEqual([]);
    const counts = researchAttributionCounts(attribution, cited.records);
    expect(counts).toEqual({ citedRecords: 4, citedUrls: 4, unsurfaced: 0, sources: { deepseek: { cited: 2, only: 1 }, openai: { cited: 2, only: 1 },
      other: { cited: 1, only: 1 }, perplexity: { cited: 0, only: 0 } } });
    expect(JSON.stringify(counts)).not.toContain("example");
    expect(researchCitationAttribution(["https://example.com/x"], [], labels).unsurfaced).toEqual(["https://example.com/x"]);
  });
});

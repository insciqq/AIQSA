import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RESEARCH_FRAME_LIMITS, RESEARCH_LIMITS, RESEARCH_ROUND_LIMITS, RESEARCH_SOURCE_CLASSES, START_RESEARCH_TOOL_NAME, SUBMIT_RESEARCH_DRAFT_TOOL_NAME,
  type ResearchCandidateNote, type ResearchDraft, type ResearchEvidenceRecord, type ResearchFinding, type ResearchFrame, type ResearchPlan, type ResearchSourceClass
} from "../../contracts/research";
import { RUN_FOLLOWUP_MAX_CHARS } from "../../contracts/runFollowups";
import { CALL_SUBAGENT_TOOL_NAME } from "../../contracts/subagents";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { createNativeRunExecutionResponse, type NativeEngineDeps, type NativeRunExecutionInput } from "../engine/execution";
import type { NativeRunStore } from "../engine/runStore";
import type { SubagentThreadStore } from "../engine/subagents/threadStore";
import type { ToolCallBeginResult, ToolCallRow, ToolCallStore } from "../engine/toolCallStore";
import type { TranscriptItem } from "../engine/transcript";
import type { TranscriptRepository } from "../engine/transcriptRepository";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import { activeRunControllerRegistry } from "../runs/activeRunControllerRegistry";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import type { RunRepository } from "../runs/runRepositoryContract";
import type { ResearchEngineDeps } from "./run";
import { namespacedWorkspaceToolName } from "../workspace/toolCatalog";
import { proposeCall } from "./planWindow.testFixtures";
import { gapCheckGate } from "./gapCheck";
import { runResearchGates, type ResearchAttempt, type ResearchGateContext, type ResearchOpenedSource, type ResearchSubagentOutcome } from "./gates";
import { researchMatrixCoverage } from "./matrix";
import { researchAnswerText, researchNote } from "./notes";
import { NOOP_RESEARCH_PORTS, type ResearchCoveragePort } from "./ports";
import { researchOpenCandidates } from "./candidates";
import { DRAFT as RECORD_DRAFT, finding as recordFinding, FRAME as RECORD_FRAME, matrixOf, notFound, RECORDS } from "./report.testFixtures";
import { researchDraftWithRecords } from "./reportAssembly";
import { REPORT_CHECK_GATE, reportCheckGate } from "./reportCheck";
import { createResearchSources } from "./sources";

const LABELS: Record<ResearchSourceClass, string> = {
  primary_official: "official sources", independent_tests: "independent tests", owner_reviews: "owner reviews", action_channel: "purchase options and terms"
};
const PLAN: ResearchPlan = {
  goal: "Choose a mattress.", questions: RESEARCH_SOURCE_CLASSES.map((sourceClass) => ({
    question: `What do ${LABELS[sourceClass]} say about durability?`, sites: [], sourceClasses: [sourceClass]
  })), skipped: []
};
const FINDINGS: ResearchFinding[] = RESEARCH_SOURCE_CLASSES.map((sourceClass) => ({
  claim: `${sourceClass} found the mattress durable.`, quote: `The ${sourceClass} durability result.`, sourceClass,
  standing: "confirmed", url: `https://example.test/${sourceClass}`
}));
const DRAFT: ResearchDraft = { findings: FINDINGS, origin: "reserved_call", report: "# Report\nThe mattress is durable.", unreachable: [] };
const SOURCES: ResearchOpenedSource[] = FINDINGS.map((finding) => ({ partial: false, text: finding.quote, toolName: "fetch_url", url: finding.url }));
const CLEAN = { gaps: [], limits: [] };
const gap = (issue: string, next_step = "Search for long-term owner reports for this mattress model.") => ({ issue, next_step });
const judged = (report = JSON.stringify(CLEAN)): ResearchSubagentOutcome => ({ kind: "ended", result: {
  approvals: [], files: [], kind: "ended", model: { effort: null, id: "main-model" }, name: "gap-judge", outcome: "done", report, state: "done", steps: []
} });

function context(overrides: Partial<ResearchGateContext> = {}): ResearchGateContext {
  return {
    attempt: 1, earlier: [], plan: structuredClone(PLAN), signal: new AbortController().signal,
    sources: { opened: vi.fn(async () => SOURCES) },
    subagents: { run: vi.fn(async (): Promise<ResearchSubagentOutcome> => judged()) },
    time: { remainingMs: vi.fn(() => 120_000), sendBackAllowed: vi.fn(() => true) },
    verifierModel: vi.fn(async () => ({ kind: "main_model" as const, label: "main-model" })), ...overrides
  } satisfies ResearchGateContext;
}

const without = (sourceClass: ResearchSourceClass) => ({ ...DRAFT, findings: FINDINGS.filter((finding) => finding.sourceClass !== sourceClass) });
const messageOf = (result: Awaited<ReturnType<typeof gapCheckGate.run>>) => result.kind === "send_back" ? result.message : "";

afterEach(() => vi.restoreAllMocks());

describe("mechanical research coverage", () => {
  it.each(RESEARCH_SOURCE_CLASSES)("sends back a missing %s finding with its question, without a model call", async (sourceClass) => {
    const ctx = context();
    const result = await gapCheckGate.run(without(sourceClass), ctx);
    expect(result.kind).toBe("send_back");
    expect(messageOf(result)).toContain(`What do ${LABELS[sourceClass]} say about durability?`);
    expect(messageOf(result)).toContain("Send researchers with call_subagent");
    for (const other of RESEARCH_SOURCE_CLASSES.filter((value) => value !== sourceClass)) expect(messageOf(result)).not.toContain(LABELS[other]);
    expect(ctx.subagents.run).not.toHaveBeenCalled();
  });

  it.each(RESEARCH_SOURCE_CLASSES)("does not accept a planted %s finding whose page was never opened", async (sourceClass) => {
    const ctx = context({ sources: { opened: vi.fn(async () => SOURCES.filter((source) => !source.url?.endsWith(sourceClass))) } });
    const result = await gapCheckGate.run(DRAFT, ctx);
    expect(result.kind).toBe("send_back");
    expect(messageOf(result)).toContain(LABELS[sourceClass]);
    expect(ctx.subagents.run).not.toHaveBeenCalled();
  });

  it("uses the page reader's URL normalization, including fragments, ports and percent escapes", async () => {
    const draft = { ...DRAFT, findings: [{ ...FINDINGS[0]!, url: "HTTPS://EXAMPLE.TEST:443/a%2fb#claim" }, ...FINDINGS.slice(1)] };
    const ctx = context({ sources: { opened: async () => [{ ...SOURCES[0]!, text: "different text", url: "https://example.test/a%2Fb#page" }, ...SOURCES.slice(1)] } });
    expect((await gapCheckGate.run(draft, ctx)).kind).toBe("pass");
    expect(ctx.subagents.run).toHaveBeenCalledTimes(1);
  });

  it("finds a browser quote in nested stringified saved results, decoding JSON escapes and folding whitespace", async () => {
    const quote = 'Owners said "still firm".\nAfter\ta year: C:\\notes.';
    const draft = { ...DRAFT, findings: FINDINGS.map((finding) => finding.sourceClass === "owner_reviews" ? { ...finding, quote } : finding) };
    const saved = JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ stdout: 'Owners said "still firm".\r\nAfter\u00a0a   year: C:\\notes.' }) }] });
    const ctx = context({ sources: { opened: async () => SOURCES.map((source) => source.url?.endsWith("owner_reviews")
      ? { browser: true as const, partial: false, text: saved, toolName: namespacedWorkspaceToolName("sandbox_exec"), url: null } : source) } });
    expect(await gapCheckGate.run(draft, ctx)).toMatchObject({ kind: "pass" });
    expect(ctx.subagents.run).toHaveBeenCalledTimes(1);
  });

  it.each([
    { text: 'The owner_reviews\\ndurability result.', toolName: namespacedWorkspaceToolName("sandbox_exec") },
    { text: JSON.stringify({ first: "The owner_reviews", second: "durability result." }), toolName: namespacedWorkspaceToolName("sandbox_exec") },
    { text: FINDINGS[2]!.quote, toolName: "search_selected_engines" },
    { text: FINDINGS[2]!.quote, toolName: CALL_SUBAGENT_TOOL_NAME }
  ])("does not manufacture a page quote from $toolName: $text", async (source) => {
    const ctx = context({ sources: { opened: async () => [...SOURCES.filter((entry) => !entry.url?.endsWith("owner_reviews")),
      { ...source, partial: false, url: null }] } });
    expect(messageOf(await gapCheckGate.run(DRAFT, ctx))).toContain("owner reviews");
    expect(ctx.subagents.run).not.toHaveBeenCalled();
  });

  it.each([namespacedWorkspaceToolName("sandbox_exec"), "mcp__notes__read"])("does not take a quote in %s output for an opened page: it stays unknown", async (toolName) => {
    const ctx = context({ sources: { opened: async () => SOURCES.map((source) => source.url?.endsWith("owner_reviews")
      ? { partial: false, text: `echo ${source.text}`, toolName, url: null } : source) } });
    // Neither covered nor missing: nothing goes back, and the reader is told nothing of it.
    expect(await gapCheckGate.run(DRAFT, ctx)).toEqual({ kind: "pass" });
  });

  it("takes a browser command's output for an opened page, with or without a step line", async () => {
    const steps = { partial: false, text: `[browser #1] open @ example.test/x\n${FINDINGS[2]!.quote}`, toolName: namespacedWorkspaceToolName("sandbox_exec"), url: null };
    for (const source of [steps, { ...steps, browser: true as const, text: FINDINGS[2]!.quote }]) {
      const ctx = context({ sources: { opened: async () => SOURCES.map((entry) => entry.url?.endsWith("owner_reviews") ? source : entry) } });
      expect(await gapCheckGate.run(DRAFT, ctx)).toEqual({ kind: "pass" });
    }
  });

  it.each([null, FINDINGS[2]!.url])("treats partial page text as unknown, never missing (URL %s)", async (url) => {
    const ctx = context({ sources: { opened: async () => SOURCES.map((source) => source.url?.endsWith("owner_reviews")
      ? { partial: true, text: "unrelated excerpt", toolName: namespacedWorkspaceToolName("sandbox_exec"), url } : source) } });
    expect(await gapCheckGate.run(DRAFT, ctx)).toEqual({ kind: "pass" });
  });

  it("does not let an unrelated partial page hide a missing source class", async () => {
    const ctx = context({ sources: { opened: async () => [{ partial: true, text: "excerpt", toolName: "fetch_url", url: "https://unrelated.test" }] } });
    expect((await gapCheckGate.run(DRAFT, ctx)).kind).toBe("send_back");
    expect((await gapCheckGate.run(without("owner_reviews"), ctx)).kind).toBe("send_back");
  });

  it("asks about all planned questions for the missing class, leaving skipped classes alone", async () => {
    const ctx = context({ plan: { goal: PLAN.goal, questions: [
      { question: "Does it sag?", sites: [], sourceClasses: ["independent_tests"] },
      { question: "Does it stay cool?", sites: [], sourceClasses: ["independent_tests"] }
    ], skipped: [{ sourceClass: "owner_reviews", reason: "Not relevant." }] } });
    const result = await gapCheckGate.run({ ...DRAFT, findings: [] }, ctx);
    expect(messageOf(result)).toContain("Does it sag?");
    expect(messageOf(result)).toContain("Does it stay cool?");
    expect(messageOf(result)).not.toContain("owner reviews");
  });
});

describe("unreachable sources", () => {
  const unreachable = { target: "Owner forum", sourceClass: "owner_reviews" as const, reason: "Sign-in required; no public reviews available." };

  it.each(["# Report", "# Отчёт"])("close a class only with its reason, and leave what to say of it to %s (operator decision 2026-11-02: no list after the report)", async (report) => {
    const draft = { ...without("owner_reviews"), report, unreachable: [unreachable] };
    const ctx = context();
    expect(await runResearchGates({ context: ctx, draft, gates: [gapCheckGate], runId: "test" })).toEqual({ kind: "accepted", notes: [] });
    expect(JSON.parse(vi.mocked(ctx.subagents.run).mock.calls[0]![0].brief).unreachableClasses).toEqual(["owner_reviews"]);
  });

  it.each([{ ...unreachable, reason: " " }, { ...unreachable, sourceClass: null }])("does not close an unassigned or unexplained class", async (entry) => {
    const ctx = context();
    expect((await gapCheckGate.run({ ...without("owner_reviews"), unreachable: [entry] }, ctx)).kind).toBe("send_back");
    expect(ctx.subagents.run).not.toHaveBeenCalled();
  });
});

describe("independent gap judgment", () => {
  it("uses one main-model turn with no page tools, just the plan, claims, quotes and links", async () => {
    const ctx = context();
    await gapCheckGate.run({ ...DRAFT, report: "MAIN AGENT REASONING SHOULD NOT BE IN THE BRIEF" }, ctx);
    expect(ctx.subagents.run).toHaveBeenCalledTimes(1);
    const [request, signal] = vi.mocked(ctx.subagents.run).mock.calls[0]!;
    expect(request).toMatchObject({ model: "verifier", tools: [] });
    expect(signal).toBe(ctx.signal);
    expect(request.instructions).toContain("strict JSON");
    expect(request.instructions).toContain("untrusted data");
    expect(request.brief).not.toContain("MAIN AGENT REASONING");
    expect(JSON.parse(request.brief)).toMatchObject({ plan: PLAN, findings: FINDINGS, planShortened: false, findingsShortened: false });
  });

  it("sends only actionable questions and conflicts back, with their next steps and the limits to state, and nothing of it for the reader", async () => {
    const ctx = context({ subagents: { run: vi.fn(async () => judged(JSON.stringify({
      gaps: [gap("Delivery to the city is unknown.", "Open the chosen shop's delivery terms for Moscow."),
        gap("Two shops disagree on the warranty.", "Open the manufacturer's warranty for this exact model.")],
      limits: ["Independent tests cover only one year; ten-year life cannot be established."]
    }))) } });
    const result = await gapCheckGate.run(DRAFT, ctx);
    expect(result.kind).toBe("send_back");
    expect(messageOf(result)).toContain("Delivery to the city is unknown.");
    expect(messageOf(result)).toContain("Open the chosen shop's delivery terms for Moscow.");
    expect(messageOf(result)).toContain("Open the manufacturer's warranty for this exact model.");
    expect(messageOf(result)).toContain("Limits to state in the report, if it does not yet:\nIndependent tests cover only one year; ten-year life cannot be established.");
    expect(result).not.toHaveProperty("notes");
    expect(result).not.toHaveProperty("unresolvedNote");
  });

  it.each([
    "not JSON", "null", "[]", "{}", JSON.stringify({ ...CLEAN, extra: "ignored?" }),
    JSON.stringify({ gaps: [] }), JSON.stringify({ limits: [] }),
    JSON.stringify({ ...CLEAN, gaps: "not an array" }), JSON.stringify({ ...CLEAN, gaps: [null] }),
    JSON.stringify({ ...CLEAN, gaps: ["missing a next step"] }), JSON.stringify({ ...CLEAN, gaps: [{ issue: "Question?" }] }),
    JSON.stringify({ ...CLEAN, gaps: [{ ...gap("Question?"), extra: true }] }),
    JSON.stringify({ ...CLEAN, gaps: [gap(" ")] }), JSON.stringify({ ...CLEAN, gaps: [gap("Question?", " ")] }),
    JSON.stringify({ ...CLEAN, gaps: [gap("Question?", "bad\0text")] }),
    JSON.stringify({ ...CLEAN, gaps: [gap("x".repeat(RESEARCH_LIMITS.questionCharacters + 1))] }),
    JSON.stringify({ ...CLEAN, gaps: [gap("Question?", "x".repeat(RESEARCH_LIMITS.questionCharacters + 1))] }),
    JSON.stringify({ ...CLEAN, gaps: Array.from({ length: RESEARCH_LIMITS.questions + 1 }, () => gap("Question?")) }),
    JSON.stringify({ ...CLEAN, limits: null }), JSON.stringify({ ...CLEAN, limits: [null] }),
    JSON.stringify({ ...CLEAN, limits: [" "] }), JSON.stringify({ ...CLEAN, limits: ["bad\0text"] }),
    JSON.stringify({ ...CLEAN, limits: ["x".repeat(RESEARCH_LIMITS.reasonCharacters + 1)] }),
    JSON.stringify({ ...CLEAN, limits: Array.from({ length: RESEARCH_LIMITS.questions + 1 }, () => "Limit") }),
    JSON.stringify({ open_questions: [], weak_answers: [], conflicts: [] }),
    `Outcome: done\n${JSON.stringify(CLEAN)}`, "x".repeat(RUN_FOLLOWUP_MAX_CHARS + 1)
  ])("passes an unreadable judgment, saying only that the report is not fully checked (%#)", async (report) => {
    const ctx = context({ subagents: { run: async () => judged(report) } });
    expect(await gapCheckGate.run(DRAFT, ctx)).toEqual({ kind: "pass", notes: [researchNote("gate_failed")] });
  });

  it("adds no note for a judge that found nothing, or one skipped because the draft added nothing new", async () => {
    expect(await gapCheckGate.run(DRAFT, context())).toEqual({ kind: "pass" });
    const ctx = context({ earlier: [{ draft: DRAFT, message: null }], subagents: { run: async () => { throw new Error("never called"); } } });
    expect(await gapCheckGate.run(DRAFT, ctx)).toEqual({ kind: "pass" });
  });

  it("keeps the word that the report is not fully checked when a later gate's send back changes no evidence, until a judgment completes", async () => {
    const run = vi.fn(async (): Promise<ResearchSubagentOutcome> => judged()).mockImplementationOnce(async () => { throw new Error("provider failed"); });
    const ctx = context({ subagents: { run } });
    const skeptic = { name: "skeptic", run: vi.fn(async (_draft: ResearchDraft, gateContext: ResearchGateContext) => gateContext.attempt === 1
      ? { kind: "send_back" as const, message: "[Skeptic] Weigh it." } : { kind: "pass" as const }) };
    const gates = [gapCheckGate, skeptic];
    const first = await runResearchGates({ context: ctx, draft: DRAFT, gates, runId: "run" });
    expect(first).toMatchObject({ gate: "skeptic", kind: "sent_back", notes: [researchNote("gate_failed")] });
    const earlier: ResearchAttempt[] = [{ draft: DRAFT, gate: "skeptic", message: "[Skeptic] Weigh it." }];
    const rewritten = { ...DRAFT, report: "# Report\nThe mattress is durable, though one lab disagrees." };
    expect(await runResearchGates({ context: { ...ctx, attempt: 2, earlier }, draft: rewritten, gates, runId: "run" })).toEqual({ kind: "accepted", notes: [researchNote("gate_failed")] });
    expect(run).toHaveBeenCalledOnce();
    // A new finding buys a judgment, and one that completes clears it.
    const added = { ...rewritten, findings: [...FINDINGS, { ...FINDINGS[0]!, claim: "Another result." }] };
    expect(await runResearchGates({ context: { ...ctx, attempt: 3, earlier: [...earlier, { draft: rewritten, message: null }] }, draft: added, gates, runId: "run" }))
      .toEqual({ kind: "accepted", notes: [] });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("says only that the report is not fully checked when a later judge fails, and names nothing the earlier one raised", async () => {
    const ctx = context({ subagents: { run: async () => { throw new Error("provider failed"); } } });
    expect(await runResearchGates({ context: ctx, draft: DRAFT, gates: [gapCheckGate], runId: "run" })).toEqual({ kind: "accepted", notes: [researchNote("gate_failed")] });
  });

  it("names nothing a judge raised before when a later one fails", async () => {
    const first = await gapCheckGate.run(DRAFT, context({ subagents: { run: async () => judged(JSON.stringify({ ...CLEAN, gaps: [gap("How durable is it after five years?")] })) } }));
    const ctx = context({ earlier: [{ draft: DRAFT, message: messageOf(first) }], subagents: { run: async () => { throw new Error("unavailable"); } } });
    expect(await gapCheckGate.run({ ...DRAFT, findings: [...FINDINGS, { ...FINDINGS[0]!, claim: "Another result." }] }, ctx)).toEqual({ kind: "pass", notes: [researchNote("gate_failed")] });
  });

  it.each(["throw", "refused", "failed", "partial", "truncated"])("passes a %s judge saying only that the report is not fully checked, and still runs the next gate", async (failure) => {
    const ctx = context({ subagents: { run: async () => {
      if (failure === "throw") throw new Error("unavailable");
      if (failure === "refused") return { kind: "refused", code: "subagent_limit_reached" };
      const outcome = judged();
      if (outcome.kind !== "ended") throw new Error("Expected ended");
      return { kind: "ended", result: { ...outcome.result,
        ...(failure === "failed" ? { state: "failed", outcome: undefined, reason: "provider_failed" } as const : {}),
        ...(failure === "partial" ? { outcome: "partial" } as const : {}),
        ...(failure === "truncated" ? { reportTruncated: true } as const : {}) } };
    } } });
    const verifier = vi.fn(async () => ({ kind: "pass" as const }));
    expect(await runResearchGates({ context: ctx, draft: DRAFT, gates: [gapCheckGate, { name: "verifier", run: verifier }], runId: "test" }))
      .toEqual({ kind: "accepted", notes: [researchNote("gate_failed")] });
    expect(verifier).toHaveBeenCalledOnce();
  });
});

describe("research stops on evidence or time, not a round count", () => {
  it("ends when claim and link add nothing after normalization, even if the quote changes", async () => {
    const draft = { ...DRAFT, findings: FINDINGS.map((finding) => ({ ...finding, claim: `  ${finding.claim.toUpperCase()}\n`, url: `${finding.url}#new`, quote: "A different quote." })) };
    const ctx = context({ attempt: 2, earlier: [{ draft: DRAFT, message: "Old feedback" }], sources: { opened: async () => [] } });
    expect(await gapCheckGate.run(draft, ctx)).toEqual({ kind: "pass" });
    expect(ctx.subagents.run).not.toHaveBeenCalled();
  });

  it("remembers findings across every earlier draft, not just the last draft", async () => {
    const ctx = context({ attempt: 3, earlier: [{ draft: DRAFT, message: null }, { draft: without("owner_reviews"), message: "Owners missing" }] });
    expect((await gapCheckGate.run(DRAFT, ctx)).kind).toBe("pass");
    expect(ctx.subagents.run).not.toHaveBeenCalled();
  });

  it("sends nothing back again when a round finds nothing new, and names nothing", async () => {
    const first = context({ subagents: { run: async () => judged(JSON.stringify({ ...CLEAN, gaps: [gap("How durable is it after five years?")] })) } });
    const sentBack = await gapCheckGate.run(DRAFT, first);
    const ctx = context({ attempt: 2, earlier: [{ draft: DRAFT, message: messageOf(sentBack) }] });
    expect(await gapCheckGate.run(DRAFT, ctx)).toEqual({ kind: "pass" });
    expect(ctx.subagents.run).not.toHaveBeenCalled();
  });

  it("drops a previous mechanical gap once its page was opened, even without a new claim", async () => {
    const first = await gapCheckGate.run(DRAFT, context({ sources: { opened: async () => [] } }));
    expect(await gapCheckGate.run(DRAFT, context({ attempt: 2, earlier: [{ draft: DRAFT, message: messageOf(first) }] })))
      .toEqual({ kind: "pass" });
  });

  it("continues after many rounds when the draft adds a finding and a gap remains", async () => {
    const ctx = context({ attempt: 41, earlier: Array.from({ length: 40 }, () => ({ draft: without("owner_reviews"), message: null })),
      sources: { opened: async () => SOURCES.filter((source) => !source.url?.endsWith("owner_reviews")) } });
    expect((await gapCheckGate.run(DRAFT, ctx)).kind).toBe("send_back");
  });

  it("passes with what stays open left to the report when the tool deadline closes", async () => {
    const ctx = context({ time: { remainingMs: () => 60_000, sendBackAllowed: () => false } });
    expect(await gapCheckGate.run({ ...without("owner_reviews"), report: "Отчёт о матрасах." }, ctx)).toEqual({ kind: "pass" });
    expect(ctx.subagents.run).not.toHaveBeenCalled();
  });

  it("adds nothing to the answer when the deadline races the gate's send back", async () => {
    const allowed = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const result = await runResearchGates({ context: context({ time: { remainingMs: () => 60_000, sendBackAllowed: allowed } }),
      draft: without("owner_reviews"), gates: [gapCheckGate], runId: "test" });
    expect(result).toEqual({ kind: "accepted", notes: [] });
  });

  it("does not start a judge without time for a turn, and says time is why the report is not fully checked", async () => {
    const ctx = context({ time: { remainingMs: () => 1, sendBackAllowed: () => true } });
    expect(await gapCheckGate.run(DRAFT, ctx)).toEqual({ kind: "pass", notes: [researchNote("time_out")] });
    expect(ctx.subagents.run).not.toHaveBeenCalled();
  });

  it("names nothing a judge raised when a new finding arrives too late to judge it, only that time left the report not fully checked", async () => {
    const first = await gapCheckGate.run(DRAFT, context({ subagents: { run: async () => judged(JSON.stringify({ ...CLEAN,
      gaps: [gap("How durable is it after five years?")] })) } }));
    const ctx = context({ earlier: [{ draft: DRAFT, message: messageOf(first) }],
      time: { remainingMs: () => 1, sendBackAllowed: () => true } });
    const result = await gapCheckGate.run({ ...DRAFT, findings: [...FINDINGS, { ...FINDINGS[0]!, claim: "Another short-term result." }] }, ctx);
    expect(result).toEqual({ kind: "pass", notes: [researchNote("time_out")] });
    expect(ctx.subagents.run).not.toHaveBeenCalled();
  });

  it("passes with nothing for the reader if time runs out during judgment", async () => {
    let allowed = true;
    const ctx = context({ time: { remainingMs: () => 60_000, sendBackAllowed: () => allowed }, subagents: { run: async () => {
      allowed = false;
      return judged(JSON.stringify({ ...CLEAN, gaps: [gap("The lab and owners disagree on durability.")] }));
    } } });
    expect(await gapCheckGate.run(DRAFT, ctx)).toEqual({ kind: "pass" });
  });

  it("asks for record ids from plain text once, leaving the no-findings report note to run.ts", async () => {
    const draft: ResearchDraft = { ...DRAFT, origin: "plain_text", findings: [] };
    const ctx = context();
    const first = await gapCheckGate.run(draft, ctx);
    expect(first.kind).toBe("send_back");
    expect(messageOf(first)).toContain("with record_ids, the ids of the records it rests on");
    expect(await gapCheckGate.run(draft, { ...ctx, attempt: 2, earlier: [{ draft, message: messageOf(first) }] })).toEqual({ kind: "pass" });
    expect(await gapCheckGate.run(draft, { ...ctx, time: { remainingMs: () => 0, sendBackAllowed: () => false } })).toEqual({ kind: "pass" });
    expect(ctx.subagents.run).not.toHaveBeenCalled();
  });

  it.each(["en", "ru"])("never asks a plain-text draft for findings, which the tool no longer takes and the report check sends back (%s)", async (language) => {
    const draft: ResearchDraft = { ...DRAFT, origin: "plain_text", findings: [] };
    const message = messageOf(await gapCheckGate.run(draft, context({ plan: { ...structuredClone(PLAN), goal: language === "ru" ? "Выбрать матрас." : PLAN.goal } })));
    expect(message).toContain("submit_research_draft");
    expect(message).toContain("record_ids");
    expect(message).not.toMatch(/finding|находк|цитат|quote/iu);
  });
});

describe("actionable gaps and page progress", () => {
  it("treats page progress as unknown after a rebuilt plan, which allows one more send back and then holds", async () => {
    const rebuilt = structuredClone(PLAN);
    const earlier = [{ draft: without("owner_reviews"), message: "Missing evidence from opened pages:" }];
    const ctx = context({ earlier, plan: rebuilt, sources: { opened: async () => SOURCES.filter((source) => !source.url?.endsWith("owner_reviews")) } });
    const rewritten = { ...without("owner_reviews"), findings: without("owner_reviews").findings.map((finding) => ({ ...finding, claim: `Rewritten: ${finding.claim}` })) };
    const first = await gapCheckGate.run(rewritten, ctx);
    expect(first.kind).toBe("send_back");
    const again = { ...rewritten, findings: rewritten.findings.map((finding) => ({ ...finding, claim: `Again: ${finding.claim}` })) };
    expect((await gapCheckGate.run(again, { ...ctx, earlier: [...earlier, { draft: rewritten, message: messageOf(first) }] })).kind).toBe("pass");
  });

  const issue = "Delivery to the buyer's city is still unknown.";
  const next = "Open the selected shop's delivery terms for Moscow.";
  const openGap = { gaps: [gap(issue, next)], limits: ["Ten-year durability cannot be established from these tests."] };
  const revised = { ...DRAFT, findings: FINDINGS.map((finding) => ({ ...finding, claim: `Rewritten: ${finding.claim}` })) };

  it.each([0, 3])("passes a draft shrunk from 15 to %s findings without new pages, skips the judge and reaches the verifier", async (count) => {
    const firstDraft = { ...DRAFT, findings: Array.from({ length: 15 }, (_, index) => ({ ...FINDINGS[index % 4]!, claim: `Finding ${index}.` })) };
    const judge = vi.fn(async () => judged(JSON.stringify(openGap)));
    const ctx = context({ subagents: { run: judge } });
    const verifier = vi.fn(async () => ({ kind: "pass" as const }));
    const gates = [gapCheckGate, { name: "verifier", run: verifier }];
    const first = await runResearchGates({ context: ctx, draft: firstDraft, gates, runId: "test" });
    expect(first.kind).toBe("sent_back");
    expect(verifier).not.toHaveBeenCalled();
    if (first.kind !== "sent_back") throw new Error("Expected a send-back");
    const rewritten = { ...revised, findings: revised.findings.slice(0, count) };
    const result = await runResearchGates({ context: { ...ctx, attempt: 2, earlier: [{ draft: firstDraft, message: first.message }] },
      draft: rewritten, gates, runId: "test" });
    expect(result).toEqual({ kind: "accepted", notes: [] });
    expect(judge).toHaveBeenCalledTimes(1);
    expect(verifier).toHaveBeenCalledTimes(1);
  });

  it.each(["search_selected_engines", "mcp__notes__read", namespacedWorkspaceToolName("sandbox_exec")])("does not count %s output as a new page", async (toolName) => {
    let opened = [...SOURCES];
    const judge = vi.fn(async () => judged(JSON.stringify(openGap)));
    const ctx = context({ subagents: { run: judge }, sources: { opened: async () => opened } });
    const first = await gapCheckGate.run(DRAFT, ctx);
    opened = [...opened, { partial: false, toolName, url: null, text: "Some new search snippets or rewritten text." }];
    const result = await gapCheckGate.run(revised, { ...ctx, attempt: 2, earlier: [{ draft: DRAFT, message: messageOf(first) }] });
    expect(result).toEqual({ kind: "pass" });
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it.each([
    { partial: false, toolName: "fetch_url", url: "https://shop.test/delivery", text: "Delivery terms" },
    { browser: true as const, partial: false, toolName: namespacedWorkspaceToolName("sandbox_exec"), url: null, text: "Delivery terms" },
    { partial: false, toolName: namespacedWorkspaceToolName("sandbox_exec"), url: null, text: "[browser #2] open @ shop.test/delivery" }
  ])("judges again after a page was opened through $toolName", async (page) => {
    let opened = [...SOURCES];
    const judge = vi.fn(async () => judged(JSON.stringify(openGap)));
    const ctx = context({ subagents: { run: judge }, sources: { opened: async () => opened } });
    const first = await gapCheckGate.run(DRAFT, ctx);
    opened = [...opened, page];
    expect((await gapCheckGate.run(revised, { ...ctx, attempt: 2, earlier: [{ draft: DRAFT, message: messageOf(first) }] })).kind).toBe("send_back");
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it("does not send back a mechanical gap again for rewritten claims with no new pages", async () => {
    const ctx = context({ sources: { opened: async () => SOURCES.filter((source) => !source.url?.endsWith("owner_reviews")) } });
    const first = await gapCheckGate.run(DRAFT, ctx);
    expect(first.kind).toBe("send_back");
    const result = await gapCheckGate.run(revised, { ...ctx, attempt: 2, earlier: [{ draft: DRAFT, message: messageOf(first) }] });
    expect(result).toEqual({ kind: "pass" });
    expect(ctx.subagents.run).not.toHaveBeenCalled();
  });

  it("keeps an attempted source closed when its reason is supplied without a new page", async () => {
    const ctx = context();
    const firstDraft = without("owner_reviews");
    const first = await gapCheckGate.run(firstDraft, ctx);
    const result = await gapCheckGate.run({ ...firstDraft,
      unreachable: [{ sourceClass: "owner_reviews", target: "Owner forum", reason: "Sign-in required." }] },
    { ...ctx, attempt: 2, earlier: [{ draft: firstDraft, message: messageOf(first) }] });
    expect(result).toEqual({ kind: "pass" });
    expect(ctx.subagents.run).not.toHaveBeenCalled();
  });

  it("tracks page progress when a clean gap check is followed by another gate's send-back", async () => {
    const ctx = context();
    expect((await gapCheckGate.run(DRAFT, ctx)).kind).toBe("pass");
    expect((await gapCheckGate.run(revised, { ...ctx, attempt: 2, earlier: [{ draft: DRAFT, message: "Correct the unsupported claim." }] })).kind).toBe("pass");
    expect(ctx.subagents.run).toHaveBeenCalledTimes(1);
  });

  it("checks the first draft of a different plan independently", async () => {
    const judge = vi.fn(async () => judged(JSON.stringify(openGap)));
    const first = context({ subagents: { run: judge } });
    await gapCheckGate.run(DRAFT, first);
    const other = context({ subagents: { run: judge } });
    expect((await gapCheckGate.run(DRAFT, other)).kind).toBe("send_back");
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it.each(["en", "ru"])("asks for the exact next steps and for keeping its records in English, whatever the plan's language (%s)", async (language) => {
    const ctx = context({ plan: { ...structuredClone(PLAN), goal: language === "ru" ? "Выбрать матрас." : PLAN.goal },
      subagents: { run: async () => judged(JSON.stringify(openGap)) } });
    const result = await gapCheckGate.run(DRAFT, ctx);
    expect(messageOf(result)).toContain(next);
    expect(messageOf(result)).toContain("exactly these next steps");
    expect(messageOf(result)).toContain("Keep in record_ids every record that still holds");
    expect(messageOf(result)).toContain("Never drop records or shorten the report");
    expect(messageOf(result)).toContain("state the limit in the report and submit it");
    expect(messageOf(result)).not.toMatch(/находк|keep every finding|remove findings/iu);
  });

  it("passes irreducible weaknesses as limits and instructs the judge with concrete examples", async () => {
    const limits = ["Tests concern other models, so they cannot show ten-year life for this mattress.",
      "No independent evidence for this exact model was found after searching."];
    const ctx = context({ subagents: { run: vi.fn(async () => judged(JSON.stringify({ gaps: [], limits }))) } });
    const result = await gapCheckGate.run(DRAFT, ctx);
    expect(result).toEqual({ kind: "pass" });
    const instructions = vi.mocked(ctx.subagents.run).mock.calls[0]![0].instructions;
    expect(instructions).toContain("no independent evidence for the exact model is a limit, not a gap");
    expect(instructions).toContain("two shops list different warranty terms");
    expect(instructions).toContain("ten-year lifespan");
    expect(instructions).toContain("unreachable are closed with a reason");
  });

  it("asks for another kind of site when a closed one leaves a plan question unanswered, never for a copy of it", async () => {
    const ctx = context();
    await gapCheckGate.run(DRAFT, ctx);
    const instructions = vi.mocked(ctx.subagents.run).mock.calls[0]![0].instructions;
    expect(instructions).toContain("never ask to open their sites again, nor a copy, cache or other reader of them");
    expect(instructions).toContain("A closed site does not close its question");
    expect(instructions).toContain("a reference database, a professional publisher or the news");
    expect(instructions).toContain("Once findings, or the reasons in nothingFound, show such sites were tried, what they leave open is a limit.");
    expect(instructions).not.toContain("never gaps");
  });

  it.each(["# Report", "# Отчёт"])("never turns limits or open gaps into a note, whichever way the judge's turn goes on, in %s", async (report) => {
    const limits = ["Ten-year durability cannot be established from these tests."];
    const clean = await gapCheckGate.run({ ...DRAFT, report }, context({ subagents: { run: async () => judged(JSON.stringify({ gaps: [], limits })) } }));
    expect(clean).toEqual({ kind: "pass" });
    const sentBack = await gapCheckGate.run({ ...DRAFT, report }, context({ subagents: { run: async () => judged(JSON.stringify({ gaps: [gap("Open?")], limits })) } }));
    expect(sentBack.kind).toBe("send_back");
    expect(sentBack).not.toHaveProperty("notes");
    // A later judge that cannot run names neither the open gaps nor the limits, only that the report is not fully checked.
    const earlier = [{ draft: DRAFT, message: messageOf(sentBack) }];
    const failing = context({ earlier, subagents: { run: async () => { throw new Error("unavailable"); } } });
    expect(await gapCheckGate.run({ ...DRAFT, report, findings: [...FINDINGS, { ...FINDINGS[0]!, claim: "Another result." }] }, failing)).toEqual({ kind: "pass", notes: [researchNote("gate_failed")] });
  });

  it("hands limits to the author within its bound, without internal names", async () => {
    const text = "primary_official independent_tests owner_reviews action_channel класс источников ";
    const limits = Array.from({ length: 12 }, (_, index) => `${index}. ${text.repeat(10)}`);
    const result = await gapCheckGate.run(DRAFT, context({ plan: { ...PLAN, goal: "Выбрать матрас." }, subagents: { run: async () => judged(JSON.stringify({ gaps: [gap("Вопрос?")], limits })) } }));
    expect(messageOf(result)).toContain("Limits to state in the report, if it does not yet:");
    expect(messageOf(result).length).toBeLessThanOrEqual(RUN_FOLLOWUP_MAX_CHARS);
    expect(messageOf(result)).not.toMatch(/primary_official|independent_tests|owner_reviews|action_channel|класс источников/u);
  });

  it("maps identifiers that leak into a judge's issue before the main agent reads it", async () => {
    const ctx = context({ subagents: { run: async () => judged(JSON.stringify({ ...CLEAN,
      gaps: [gap("action_channel conflicts with primary_official; класс источников owner_reviews.")] })) } });
    const result = await gapCheckGate.run({ ...DRAFT, report: "# Отчёт" }, ctx);
    expect(result.kind).toBe("send_back");
    if (result.kind !== "send_back") throw new Error("Expected send-back");
    expect(result.message.split("\n\n")[0]).not.toMatch(/primary_official|independent_tests|owner_reviews|action_channel|класс источников/u);
    expect(result.message).toContain("purchase options and terms");
    expect(result).not.toHaveProperty("unresolvedNote");
  });

  it("lists no unreachable source after the report: what was not reached is the report's to say where it matters", async () => {
    const unreachable = Array.from({ length: RESEARCH_LIMITS.unreachable }, (_, index) => ({ sourceClass: null,
      target: `${index} owner_reviews ` + "t".repeat(450), reason: "action_channel " + "r".repeat(950) }));
    expect(await gapCheckGate.run({ ...DRAFT, unreachable }, context())).toEqual({ kind: "pass" });
  });
});

describe("bounded messages", () => {
  const largePlan: ResearchPlan = { goal: "g".repeat(RESEARCH_LIMITS.goalCharacters), skipped: [], questions: Array.from({ length: RESEARCH_LIMITS.questions }, (_, index) => ({
    question: `${index}:` + "q".repeat(RESEARCH_LIMITS.questionCharacters - 3), sourceClasses: RESEARCH_SOURCE_CLASSES,
    sites: Array.from({ length: RESEARCH_LIMITS.sitesPerQuestion }, () => "s".repeat(RESEARCH_LIMITS.siteCharacters))
  })) };

  it("bounds mechanical feedback while naming every question and assigned class", async () => {
    const result = await gapCheckGate.run({ ...DRAFT, findings: [] }, context({ plan: largePlan }));
    expect(messageOf(result).length).toBeLessThanOrEqual(RUN_FOLLOWUP_MAX_CHARS);
    for (let index = 0; index < RESEARCH_LIMITS.questions; index += 1) expect(messageOf(result)).toContain(`${index}:qq`);
    for (const sourceClass of RESEARCH_SOURCE_CLASSES) expect(messageOf(result)).toContain(LABELS[sourceClass]);
  });

  it("bounds the judge's complete JSON brief with explicit shortening and omissions", async () => {
    const findings = Array.from({ length: RESEARCH_LIMITS.findings }, (_, index) => ({ ...FINDINGS[index % FINDINGS.length]!,
      claim: '"'.repeat(RESEARCH_LIMITS.claimCharacters), quote: '"'.repeat(RESEARCH_LIMITS.quoteCharacters) }));
    const ctx = context({ plan: largePlan });
    await gapCheckGate.run({ ...DRAFT, findings }, ctx);
    const request = vi.mocked(ctx.subagents.run).mock.calls[0]![0];
    expect(request.brief.length).toBeLessThanOrEqual(RUN_FOLLOWUP_MAX_CHARS);
    expect(request.instructions.length).toBeLessThanOrEqual(RUN_FOLLOWUP_MAX_CHARS);
    const brief = JSON.parse(request.brief);
    expect(brief.plan.questions).toHaveLength(RESEARCH_LIMITS.questions);
    expect(brief.planShortened).toBe(true);
    expect(brief.findings.length).toBeGreaterThan(0);
    expect(brief.findingsShortened).toBe(true);
    expect(brief.omittedFindings).toBeGreaterThan(0);
  });

  it("does not loop on an invalid escape-heavy link that cannot fit the brief", async () => {
    const findings = FINDINGS.map((finding) => ({ ...finding, url: "\0".repeat(RESEARCH_LIMITS.urlCharacters) }));
    const ctx = context({ plan: largePlan });
    await gapCheckGate.run({ ...DRAFT, findings }, ctx);
    const request = vi.mocked(ctx.subagents.run).mock.calls[0]![0];
    expect(request.brief.length).toBeLessThanOrEqual(RUN_FOLLOWUP_MAX_CHARS);
    expect(JSON.parse(request.brief).omittedFindings).toBe(findings.length);
  });

  it("rejects a judgment exceeding the total message bound", async () => {
    const issues = Array.from({ length: RESEARCH_LIMITS.questions }, (_, index) => `${index}:` + "x".repeat(RESEARCH_LIMITS.questionCharacters - 3));
    // The decoder's total bound is independent of the individual field bounds.
    const ctx = context({ subagents: { run: async () => judged(JSON.stringify({ gaps: issues.map((issue) => gap(issue, issue)), limits: issues })) } });
    expect(await gapCheckGate.run(DRAFT, ctx)).toEqual({ kind: "pass", notes: [researchNote("gate_failed")] });
  });
});

describe("what this gate ended on", () => {
  // As a real run left it: every cell is filled or recorded as not found, so only the judge could still ask anything.
  const RECORDED = [...RECORDS, notFound(6, "x2", "reviews")];
  const MATRIX = matrixOf(RECORD_FRAME, RECORDED);
  const READY = researchDraftWithRecords(RECORD_DRAFT, RECORDED);
  const WRONG = { ...READY, pickRowKey: "x9" };
  const OPEN = JSON.stringify({ ...CLEAN, gaps: [gap("Comfort was not found for any mattress.", "Open owners' reviews of comfort.")] });
  const gates = [reportCheckGate, gapCheckGate];
  const ofRecords = (overrides: Partial<ResearchGateContext> = {}) => context({ coverage: { change: vi.fn(), coverage: async () => MATRIX.coverage, frame: async () => MATRIX.frame },
    evidence: { page: vi.fn(), record: vi.fn(), records: async () => RECORDED }, ...overrides });
  const attemptOf = (draft: ResearchDraft, outcome: Awaited<ReturnType<typeof runResearchGates>>): ResearchAttempt =>
    outcome.kind === "sent_back" ? { draft, gate: outcome.gate, message: outcome.message } : { draft, message: null };

  it("is never a draft the report check sent back: the judge gets its turn on the next one, whose findings are the same", async () => {
    const run = vi.fn(async (): Promise<ResearchSubagentOutcome> => judged(OPEN));
    const ctx = ofRecords({ subagents: { run } });
    const first = await runResearchGates({ context: ctx, draft: WRONG, gates, runId: "run" });
    expect(first).toMatchObject({ gate: REPORT_CHECK_GATE, kind: "sent_back" });
    const second = await runResearchGates({ context: { ...ctx, attempt: 2, earlier: [attemptOf(WRONG, first)] }, draft: { ...WRONG }, gates, runId: "run" });
    expect(second).toMatchObject({ gate: REPORT_CHECK_GATE, kind: "sent_back" });
    expect(run).not.toHaveBeenCalled();
    const third = await runResearchGates({ context: { ...ctx, attempt: 3, earlier: [attemptOf(WRONG, first), attemptOf(WRONG, second)] }, draft: READY, gates, runId: "run" });
    expect(run).toHaveBeenCalledOnce();
    expect(third).toMatchObject({ gate: gapCheckGate.name, kind: "sent_back", message: expect.stringContaining("Comfort was not found") });
  });

  it("keeps its word over a report check's send back: no new page buys no second judge turn", async () => {
    const run = vi.fn(async (): Promise<ResearchSubagentOutcome> => judged(OPEN));
    const ctx = ofRecords({ subagents: { run } });
    const asked = await gapCheckGate.run(READY, ctx);
    const earlier = [{ draft: READY, gate: gapCheckGate.name, message: messageOf(asked) }, { draft: WRONG, gate: REPORT_CHECK_GATE, message: "Outside the matrix." }];
    expect(await gapCheckGate.run(READY, { ...ctx, attempt: 3, earlier })).toEqual({ kind: "pass" });
    expect(run).toHaveBeenCalledOnce();
  });

  it("pays for no second judge across a report check's send back, after an approval rebuilt the run", async () => {
    const asked = await gapCheckGate.run(READY, ofRecords({ subagents: { run: async () => judged(OPEN) } }));
    const earlier = [{ draft: READY, gate: gapCheckGate.name, message: messageOf(asked) }, { draft: WRONG, gate: REPORT_CHECK_GATE, message: "Outside the matrix." }];
    const rebuilt = ofRecords({ attempt: 3, earlier, subagents: { run: vi.fn(async () => judged()) } });
    expect(await gapCheckGate.run(READY, rebuilt)).toEqual({ kind: "pass" });
    expect(rebuilt.subagents.run).not.toHaveBeenCalled();
  });

  it("reads an accepted draft as the last it ended on, whatever the report check did since, so a changed draft is judged", async () => {
    const run = vi.fn(async (): Promise<ResearchSubagentOutcome> => judged());
    const ctx = ofRecords({ subagents: { run } });
    await gapCheckGate.run(READY, ctx);
    const changed = { ...READY, findings: [...READY.findings, { ...READY.findings[0]!, claim: "A new claim." }] };
    await gapCheckGate.run(changed, { ...ctx, attempt: 3, earlier: [{ draft: READY, message: null }, { draft: WRONG, gate: REPORT_CHECK_GATE, message: "Outside the matrix." }] });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("counts only researchers' pages as new: what a skeptic fetched opens no second judge turn", async () => {
    const fetched = (url: string): TranscriptItem[] => [{ arguments: JSON.stringify({ url }), callId: url, id: `${url}-call`, kind: "tool_call", name: "fetch_url" },
      { callId: url, id: `${url}-result`, kind: "tool_result", name: "fetch_url", outcome: "complete", output: "Page text." }];
    const threads = [{ items: fetched("https://lab.example/1"), name: "lab", threadId: "t1" }];
    const sources = createResearchSources({ chatId: "c", items: () => [], run: { branchRunIds: [], researchRunId: "r", runId: "r" }, savedResults: { read: async () => null },
      threads: { backgroundRunIds: async () => [], threadEffectItems: async () => threads }, userId: "u" });
    const run = vi.fn(async (): Promise<ResearchSubagentOutcome> => judged(OPEN));
    const ctx = ofRecords({ sources, subagents: { run } });
    const asked = await gapCheckGate.run(READY, ctx);
    threads.push({ items: fetched("https://refuted.example/1"), name: "skeptic-1", threadId: "t2" });
    const changed = { ...READY, findings: [...READY.findings, { ...READY.findings[0]!, claim: "A new claim." }] };
    const again = await gapCheckGate.run(changed, { ...ctx, attempt: 2, earlier: [{ draft: READY, gate: gapCheckGate.name, message: messageOf(asked) }] });
    expect(again.kind).toBe("pass");
    expect(run).toHaveBeenCalledOnce();
  });

  it("still counts a draft a later gate sent back, which it did read: the judge is paid for no second reading", async () => {
    const run = vi.fn(async (): Promise<ResearchSubagentOutcome> => judged());
    const ctx = ofRecords({ subagents: { run } });
    await gapCheckGate.run(READY, ctx);
    const result = await gapCheckGate.run({ ...READY }, { ...ctx, attempt: 2, earlier: [{ draft: READY, gate: "verifier", message: "[Independent check] One claim fell." }] });
    expect(result.kind).toBe("pass");
    expect(run).toHaveBeenCalledOnce();
  });
});

describe("where a frame exists", () => {
  const FRAME: ResearchFrame = { branches: [], changes: [], criteria: [{ criterion: "Durability", key: "durability", why: "It is bought for years." }, { criterion: "Firmness", key: "firmness", why: "It decides comfort." }],
    rows: [{ key: "x1", label: "Lonax X1" }, { key: "y2", label: "Dreamline Y2" }] };
  const record = (rowKey: string, criterionKey: string) => ({ claim: "c", criterionKey, id: `${rowKey}-${criterionKey}`, kind: "finding", quoteCheck: { reason: null, status: "found" }, rowKey }) as unknown as ResearchEvidenceRecord;
  const ALL = FRAME.rows.flatMap((row) => FRAME.criteria.map((criterion) => record(row.key, criterion.key)));
  const framed = (frame: ResearchFrame, records: readonly ResearchEvidenceRecord[]): ResearchCoveragePort =>
    ({ change: async () => ({ message: "No.", ok: false }), coverage: async () => researchMatrixCoverage(frame, records), frame: async () => frame });
  const withMatrix = (records: readonly ResearchEvidenceRecord[] = ALL, overrides: Partial<ResearchGateContext> = {}, frame = FRAME) => context({ coverage: framed(frame, records), ...overrides });
  const judge = (ctx: ResearchGateContext) => vi.mocked(ctx.subagents.run).mock.calls[0]![0];

  it("sends back the empty cells, row by row with their keys, and asks for not_found where nothing can be found", async () => {
    const ctx = withMatrix(ALL.slice(0, 1));
    const result = await gapCheckGate.run(DRAFT, ctx);
    expect(result.kind).toBe("send_back");
    expect(messageOf(result)).toContain("Lonax X1: Firmness");
    expect(messageOf(result)).toContain("Dreamline Y2: Durability, Firmness");
    expect(messageOf(result)).toContain("Fill the cells of row y2: durability, firmness. If nothing can be found, record not_found.");
    expect(ctx.subagents.run).not.toHaveBeenCalled();
  });

  it("writes the next step in English whatever the plan's language, and for a frame with no rows names the criteria alone", async () => {
    const rowless = { ...FRAME, rows: [] };
    const russian = await gapCheckGate.run(DRAFT, withMatrix([], { plan: { ...structuredClone(PLAN), goal: "Выбрать матрас." } }, rowless));
    expect(messageOf(russian)).toContain("Fill the cells: durability, firmness. If nothing can be found, record not_found.");
    expect(messageOf(await gapCheckGate.run(DRAFT, withMatrix([], {}, rowless)))).toContain("Fill the cells: durability, firmness.");
  });

  it("shows the judge what was tried and found nothing, bounded, so a question other sites were tried for is a limit", async () => {
    const nothing = (index: number, reason: string) => ({ criterionKey: "firmness", id: `nf${index}`, kind: "not_found", reason, rowKey: "x1", sourceClass: null }) as unknown as ResearchEvidenceRecord;
    const tried = "Register timed out; a legal database and news archives name no pending bill.";
    const ctx = withMatrix(ALL, { evidence: { ...NOOP_RESEARCH_PORTS.evidence, records: async () => [...ALL, nothing(0, tried)] } });
    await gapCheckGate.run(DRAFT, ctx);
    expect(JSON.parse(judge(ctx).brief).nothingFound).toEqual([{ cell: "x1/firmness", reason: tried }]);

    const many = Array.from({ length: 40 }, (_, index) => nothing(index + 1, `${index + 1} ${"r".repeat(1_000)}`));
    const bounded = withMatrix(ALL, { evidence: { ...NOOP_RESEARCH_PORTS.evidence, records: async () => many } });
    await gapCheckGate.run(DRAFT, bounded);
    const shown = JSON.parse(judge(bounded).brief).nothingFound as { cell: string; reason: string }[];
    expect(JSON.stringify(shown).length).toBeLessThanOrEqual(RUN_FOLLOWUP_MAX_CHARS / 8);
    expect(shown.at(-1)!.reason.startsWith("40 ")).toBe(true);
    expect(shown.every(({ reason }) => reason.length <= 200)).toBe(true);
    expect(judge(bounded).brief.length).toBeLessThanOrEqual(RUN_FOLLOWUP_MAX_CHARS);

    const down = withMatrix(ALL, { evidence: { ...NOOP_RESEARCH_PORTS.evidence, records: async () => { throw new Error("down"); } } });
    await gapCheckGate.run(DRAFT, down);
    expect(JSON.parse(judge(down).brief).nothingFound).toEqual([]);
  });

  it("gives way to coverage: a source class nobody opened is no gap once the matrix is full, and a full matrix reaches the judge", async () => {
    const ctx = withMatrix();
    expect((await gapCheckGate.run(without("owner_reviews"), ctx)).kind).toBe("pass");
    expect(ctx.subagents.run).toHaveBeenCalledOnce();
    const unopened = withMatrix(ALL, { sources: { opened: async () => [] } });
    expect(await gapCheckGate.run(DRAFT, unopened)).toEqual({ kind: "pass" });
  });

  it("narrows the judge to what the matrix cannot see, with the rule for actionable gaps, on the checks model and with no tools", async () => {
    const ctx = withMatrix();
    await gapCheckGate.run(DRAFT, ctx);
    const request = judge(ctx);
    expect(request).toMatchObject({ model: "verifier", name: "gap-judge", tools: [] });
    expect(request.instructions).toContain("Every gap needs a concrete next_step");
    expect(request.instructions).toContain("an empty cell is never your gap");
    expect(request.instructions).toContain("one more detail for a filled one");
    expect(request.instructions).toContain("contradict each other");
    expect(request.instructions).toContain("a plan question no finding answers while a site of another kind could, as above, also where its cell says nothing was found");
    expect(request.instructions).toContain("change_research_frame");
    expect(JSON.parse(request.brief)).toMatchObject({ matrix: { criteria: ["Durability", "Firmness"], emptyCells: 0, filledCells: 4, rows: ["Lonax X1", "Dreamline Y2"] }, plan: PLAN });
  });

  it("takes a purchase's narrow ladder for a gap to fill, not a limit, and asks an offer of each option the summary recommends", async () => {
    const ctx = withMatrix();
    await gapCheckGate.run({ ...DRAFT, summary: { rowKeys: ["y2", "x1", "gone"], text: "Take Y2; cheaper, X1." } }, ctx);
    const request = judge(ctx);
    expect(request.instructions).toContain("For a purchase whose prices spread, fewer than five options, or options of a single price tier, while the findings name more candidates within " +
      "the question's limits, is a gap to fill, not a limit: next_step names those candidates and says to find their current offers.");
    expect(request.instructions).toContain("A purchase's matrix with fewer than five options, or with options of a single price tier, while the findings name more candidates within the question's limits, lacks candidates the goal needs.");
    expect(request.instructions).toContain("matrix.recommended are the options the report's summary recommends, its pick first: for a purchase, one with no current offer among the findings, " +
      "giving its link, seller and price, is a gap whose next_step says to open that option's offers.");
    // Labels, in the summary's order, of the rows the matrix has.
    expect(JSON.parse(request.brief)).toMatchObject({ matrix: { recommended: ["Dreamline Y2", "Lonax X1"] } });
    const plain = withMatrix();
    await gapCheckGate.run(DRAFT, plain);
    expect(JSON.parse(judge(plain).brief)).toMatchObject({ matrix: { recommended: [] } });
  });

  it("keeps the judge's job and brief with no frame, as they always were", async () => {
    const ctx = context();
    await gapCheckGate.run(DRAFT, ctx);
    expect(judge(ctx).instructions).not.toContain("the matrix");
    expect(JSON.parse(judge(ctx).brief)).not.toHaveProperty("matrix");
  });

  it("sends a judged gap back, within the same rule", async () => {
    const ctx = withMatrix(ALL, { subagents: { run: vi.fn(async () => judged(JSON.stringify({ ...CLEAN, gaps: [gap("Two tests contradict each other on sagging.", "Open both tests.")] }))) } });
    const result = await gapCheckGate.run(DRAFT, ctx);
    expect(result.kind).toBe("send_back");
    expect(messageOf(result)).toContain("Two tests contradict");
  });

  it.each(["no_new_cell", "time"] as const)("sends nothing back for research once researchers are closed (%s), and names neither the empty cells nor why", async (closed) => {
    expect(await gapCheckGate.run(DRAFT, withMatrix(ALL.slice(0, 2), { researchersClosed: () => closed }))).toEqual({ kind: "pass" });
  });

  it("names no judged gap once researchers are closed", async () => {
    const ctx = withMatrix(ALL, { researchersClosed: () => "no_new_cell", subagents: { run: vi.fn(async () => judged(JSON.stringify({ ...CLEAN, gaps: [gap("Два теста расходятся.", "Откройте оба.")] }))) } });
    expect(await gapCheckGate.run({ ...DRAFT, report: "# Отчёт" }, ctx)).toEqual({ kind: "pass" });
    expect(ctx.subagents.run).toHaveBeenCalledOnce();
  });

  it("keeps today's send back with no frame, whatever closed researchers", async () => {
    expect((await gapCheckGate.run(without("owner_reviews"), context({ researchersClosed: () => "no_new_cell" }))).kind).toBe("send_back");
  });

  it("falls back to today's check when the matrix cannot be read: it costs the matrix, never the answer", async () => {
    const down = async () => { throw new Error("down"); };
    const coverage = { change: async () => ({ message: "No.", ok: false as const }), coverage: down, frame: down };
    const result = await gapCheckGate.run(without("owner_reviews"), context({ coverage }));
    expect(messageOf(result)).toContain("owner reviews");
  });

  it("stays within its bound on the largest matrix: every row named, and the judge's brief whole", async () => {
    const large: ResearchFrame = { branches: [], changes: [], criteria: Array.from({ length: RESEARCH_FRAME_LIMITS.criteria }, (_value, index) => ({ criterion: "c".repeat(RESEARCH_FRAME_LIMITS.labelCharacters), key: `c-${index}`, why: "W." })),
      rows: Array.from({ length: RESEARCH_FRAME_LIMITS.rows }, (_value, index) => ({ key: `r-${index}`, label: "r".repeat(RESEARCH_FRAME_LIMITS.labelCharacters) })) };
    const sentBack = await gapCheckGate.run(DRAFT, withMatrix([], {}, large));
    expect(messageOf(sentBack).length).toBeLessThanOrEqual(RUN_FOLLOWUP_MAX_CHARS);
    const everything = large.rows.flatMap((row) => large.criteria.map((criterion) => record(row.key, criterion.key)));
    const ctx = withMatrix(everything, {}, large);
    await gapCheckGate.run(DRAFT, ctx);
    const { brief } = judge(ctx);
    expect(brief.length).toBeLessThanOrEqual(RUN_FOLLOWUP_MAX_CHARS);
    expect(JSON.parse(brief)).toMatchObject({ matrix: { filledCells: everything.length } });
  });

  describe("the key specifications of the options the summary recommends", () => {
    const KEYED: ResearchFrame = { ...FRAME, criteria: [{ ...FRAME.criteria[0]!, decisive: true }, FRAME.criteria[1]!] };
    const at = (number: number, rowKey: string, criterionKey: string, site: string) => recordFinding(number, rowKey, criterionKey, { url: `https://${site}/${number}` });
    const ONE_SITE = [at(1, "x1", "durability", "maker.example"), at(2, "x1", "firmness", "maker.example"), at(3, "y2", "durability", "shop.example"), at(4, "y2", "firmness", "shop.example")];
    const keyed = (records: readonly ResearchEvidenceRecord[], overrides: Partial<ResearchGateContext> = {}) =>
      withMatrix(records, { evidence: { ...NOOP_RESEARCH_PORTS.evidence, records: vi.fn(async () => records) }, ...overrides }, KEYED);
    const leading: ResearchDraft = { ...DRAFT, pickRowKey: "x1", summary: { rowKeys: ["x1"], text: "Take Lonax X1." } };

    it("sends back a leading option's key specification on one site for a second one, with no model, and nothing of a non-leading option's filled cell", async () => {
      const ctx = keyed(ONE_SITE);
      const result = await gapCheckGate.run(leading, ctx);
      expect(result.kind).toBe("send_back");
      expect(messageOf(result)).toContain("Lonax X1: Durability (one site only)");
      expect(messageOf(result)).toContain("Confirm from a second site, the maker's or a seller's, whichever it lacks, the key specifications of row x1: durability. Record each as its own " +
        "record of that cell, also where it gives another figure; if no second site shows it, record not_found for that cell.");
      // Dreamline's durability is on one site too, and its firmness and Lonax's are filled: none of them is asked.
      expect(messageOf(result)).not.toContain("y2");
      expect(messageOf(result)).not.toContain("firmness");
      expect(ctx.subagents.run).not.toHaveBeenCalled();
    });

    it("asks nothing more once a second site or a not_found answers it, nor before a draft recommends an option, and the judge then runs", async () => {
      for (const [draft, records] of [[leading, [...ONE_SITE, at(5, "x1", "durability", "shop.example")]], [leading, [...ONE_SITE, notFound(5, "x1", "durability")]],
        [DRAFT, ONE_SITE]] as const) {
        const ctx = keyed(records);
        expect(await gapCheckGate.run(draft, ctx)).toEqual({ kind: "pass" });
        expect(ctx.subagents.run).toHaveBeenCalledOnce();
      }
    });

    it("tells the judge a second source is the server's to ask and a disagreement between sites the report's to name, never a gap", async () => {
      const ctx = keyed([...ONE_SITE, at(5, "x1", "durability", "shop.example")]);
      await gapCheckGate.run(leading, ctx);
      expect(judge(ctx).instructions).toContain("it asks a second site for each key specification of the options the summary recommends, so neither is a second source, nor one more detail for a filled one");
      expect(judge(ctx).instructions).toContain("except two sites' figures for one key specification, which the report names as they stand");
    });

    it("asks a newly recommended option's second site with no new page and the same findings, once, within the cap", async () => {
      const records = [...ONE_SITE, at(5, "x1", "durability", "shop.example")];
      const ctx = keyed(records);
      expect(await gapCheckGate.run(leading, ctx)).toEqual({ kind: "pass" });
      // A later gate sent the draft back, and the model now picks Dreamline, whose durability one site alone holds; nothing new was opened.
      const switched: ResearchDraft = { ...DRAFT, pickRowKey: "y2", summary: { rowKeys: ["y2"], text: "Take Dreamline Y2." } };
      const earlier: ResearchAttempt[] = [{ draft: leading, gate: "verifier", message: "[Independent check] A check did not support some of them." }];
      const result = await gapCheckGate.run(switched, { ...ctx, attempt: 2, earlier });
      expect(messageOf(result)).toContain("the key specifications of row y2: durability.");
      expect(messageOf(result)).not.toContain("row x1");
      // Asked once: the same obligation is not asked again, answered or not.
      const asked = [...earlier, { draft: switched, gate: gapCheckGate.name, message: messageOf(result) }];
      expect(await gapCheckGate.run(switched, { ...ctx, attempt: 3, earlier: asked })).toEqual({ kind: "pass" });
      // Past the cap nothing goes back.
      const capped = Array.from({ length: RESEARCH_ROUND_LIMITS.sendBacksPerCheck }, () => ({ draft: leading, gate: gapCheckGate.name, message: "Missing." }));
      expect(await runResearchGates({ context: { ...ctx, attempt: 4, earlier: [...capped, ...earlier] }, draft: switched, gates: [gapCheckGate], runId: "r" }))
        .toEqual({ kind: "accepted", notes: [] });
    });

    it("costs only the confirmations when the records cannot be read", async () => {
      const ctx = keyed(ONE_SITE, { evidence: { ...NOOP_RESEARCH_PORTS.evidence, records: async () => { throw new Error("down"); } } });
      expect(await gapCheckGate.run(leading, ctx)).toEqual({ kind: "pass" });
    });
  });

  describe("the candidates agents noted", () => {
    const note = (name: string, reason = "A ranking names it.", url?: string): ResearchCandidateNote =>
      ({ at: "2026-11-03T10:00:00.000Z", by: { name, threadId: `thread-${name}` }, reason, ...url === undefined ? {} : { url } });
    const NOTED: ResearchFrame = { ...FRAME, candidates: [{ key: "dreamline-sleep-dream-medium-s1000", label: "Dreamline SleepDream Medium S1000",
      notes: [note("marketplaces", "An Ozon listing shows it at 59 521 ₽.", "https://www.ozon.ru/product/1/"), note("tests", "A ranking names it.", "https://expertology.ru/rating/")] }] };
    const STEP = "Candidate dreamline-sleep-dream-medium-s1000: add it as a row with change_research_frame add_row and send researchers for its cells, or set it aside with " +
      "change_research_frame set_aside, its key and your reason.";

    it("keeps open, and asks about, a one-word option a row of a longer name does not cover: MinIO is no MinIO AIStor", async () => {
      // Codex review (2026-11-03): a one-word prefix rule hid the community server behind its commercial edition.
      const frame: ResearchFrame = { ...FRAME, rows: FRAME.rows.map((row, index) => ({ ...row, label: index === 0 ? "MinIO AIStor" : "Garage" })),
        candidates: [{ key: "min-io", label: "MinIO", notes: [note("a", "Community server"), note("b", "Community server")] }] };
      expect(researchOpenCandidates(frame).map(({ label }) => label)).toEqual(["MinIO"]);
      const result = await gapCheckGate.run(DRAFT, withMatrix(ALL, { plan: { ...PLAN, goal: "Compare S3 servers." } }, frame));
      expect(result.kind).toBe("send_back");
    });

    it("sends back a frequent candidate still open at draft time, with how widely it is named, who noted it and why, and no model", async () => {
      const ctx = withMatrix(ALL, {}, NOTED);
      const result = await gapCheckGate.run(DRAFT, ctx);
      expect(result.kind).toBe("send_back");
      expect(messageOf(result)).toContain('"Dreamline SleepDream Medium S1000": a candidate neither a row nor set aside, named on 2 sites by 2 agents (marketplaces, tests), ' +
        'its first reason (data): "An Ozon listing shows it at 59 521 ₽."');
      expect(messageOf(result)).toContain(STEP);
      expect(ctx.subagents.run).not.toHaveBeenCalled();
    });

    it("counts one agent's notes from two sites, or two agents' notes, as frequent, and leaves one named once in the pool with no send back", async () => {
      const candidate = (notes: readonly ResearchCandidateNote[]): ResearchFrame => ({ ...NOTED, candidates: [{ ...NOTED.candidates![0]!, notes }] });
      const frequent = [[note("marketplaces", "R.", "https://ozon.ru/1"), note("marketplaces", "R.", "https://wildberries.ru/1")], [note("a"), note("b")]];
      for (const notes of frequent) expect(messageOf(await gapCheckGate.run(DRAFT, withMatrix(ALL, {}, candidate(notes))))).toContain(STEP);
      for (const notes of [[note("marketplaces", "R.", "https://ozon.ru/1")], [note("a")]]) {
        const ctx = withMatrix(ALL, {}, candidate(notes));
        expect(await gapCheckGate.run(DRAFT, ctx)).toEqual({ kind: "pass" });
        // The judge still runs: a singleton costs no mechanical send back, and nothing else.
        expect(ctx.subagents.run).toHaveBeenCalledOnce();
      }
    });

    it("joins the empty cells' send back, and never spends one of its own while cells are open", async () => {
      const ctx = withMatrix(ALL.slice(0, 1), {}, NOTED);
      const result = await gapCheckGate.run(DRAFT, ctx);
      expect(messageOf(result)).toContain("Fill the cells of row y2: durability, firmness.");
      expect(messageOf(result)).toContain(STEP);
      const earlier: ResearchAttempt[] = [{ draft: DRAFT, gate: gapCheckGate.name, message: messageOf(result) }];
      // Asked once: no new page, and nothing goes back again.
      expect(await gapCheckGate.run(DRAFT, { ...ctx, attempt: 2, earlier })).toEqual({ kind: "pass" });
      // One noted since, with cells still open and no new page, does not go back alone.
      const later: ResearchFrame = { ...NOTED, candidates: [...NOTED.candidates!, { key: "sealy-hybrid", label: "Sealy Hybrid", notes: [note("brands"), note("tests")] }] };
      expect(await gapCheckGate.run(DRAFT, { ...withMatrix(ALL.slice(0, 1), { plan: ctx.plan }, later), attempt: 2, earlier })).toEqual({ kind: "pass" });
    });

    it("goes back with no new page once no cell is open, since deciding needs none, once and within the cap", async () => {
      const ctx = withMatrix();
      expect(await gapCheckGate.run(DRAFT, ctx)).toEqual({ kind: "pass" });
      // A later gate sent the draft back; since then a candidate was noted and no page opened.
      const earlier: ResearchAttempt[] = [{ draft: DRAFT, gate: "verifier", message: "[Independent check] A check did not support some of them." }];
      const noted = withMatrix(ALL, { plan: ctx.plan }, NOTED);
      const result = await gapCheckGate.run(DRAFT, { ...noted, attempt: 2, earlier });
      expect(messageOf(result)).toContain(STEP);
      expect(vi.mocked(noted.subagents.run)).not.toHaveBeenCalled();
      const asked = [...earlier, { draft: DRAFT, gate: gapCheckGate.name, message: messageOf(result) }];
      expect(await gapCheckGate.run(DRAFT, { ...noted, attempt: 3, earlier: asked })).toEqual({ kind: "pass" });
      const capped = Array.from({ length: RESEARCH_ROUND_LIMITS.sendBacksPerCheck }, () => ({ draft: DRAFT, gate: gapCheckGate.name, message: "Missing." }));
      expect(await runResearchGates({ context: { ...noted, attempt: 4, earlier: [...capped, ...earlier] }, draft: DRAFT, gates: [gapCheckGate], runId: "r" }))
        .toEqual({ kind: "accepted", notes: [] });
    });

    it("asks nothing of a frame with no rows, once researchers are closed, or of one a row covers or the main agent set aside", async () => {
      const covered: ResearchFrame = { ...NOTED, rows: [...FRAME.rows, { key: "sleepdream", label: "Dreamline SleepDream Medium S1000 180x200" }] };
      expect(messageOf(await gapCheckGate.run(DRAFT, withMatrix(ALL, {}, covered)))).toContain("Fill the cells of row sleepdream");
      expect(messageOf(await gapCheckGate.run(DRAFT, withMatrix(ALL, {}, covered)))).not.toContain("Candidate ");
      const aside: ResearchFrame = { ...NOTED, setAside: [{ at: "2026-11-03T10:05:00.000Z", key: "dreamline-sleep-dream-medium-s1000", reason: "Sold out." }] };
      for (const ctx of [withMatrix(ALL, {}, { ...NOTED, rows: [] }), withMatrix(ALL, { researchersClosed: () => "no_new_cell" }, NOTED), withMatrix(ALL, {}, aside)]) {
        expect(await gapCheckGate.run(DRAFT, ctx)).toEqual({ kind: "pass" });
        expect(ctx.subagents.run).toHaveBeenCalledOnce();
      }
    });

    it("stays within its bound with every row empty and every candidate open, each candidate named", async () => {
      const limits = RESEARCH_FRAME_LIMITS;
      const large: ResearchFrame = { branches: [], changes: [], criteria: [{ criterion: "c".repeat(limits.labelCharacters), key: "c", why: "W." }],
        rows: Array.from({ length: limits.rows }, (_value, index) => ({ key: `r-${index}`, label: `${"r".repeat(limits.labelCharacters - 4)}${index}` })),
        candidates: Array.from({ length: limits.candidates }, (_value, index) => ({ key: `model-${index}`, label: `Model ${index}`,
          notes: [note(`agent-${index}`, "x".repeat(1_000), `https://one-${index}.example/`), note(`agent-${index}`, "y".repeat(1_000), `https://two-${index}.example/`)] })) };
      const message = messageOf(await gapCheckGate.run(DRAFT, withMatrix([], {}, large)));
      expect(message.length).toBeLessThanOrEqual(RUN_FOLLOWUP_MAX_CHARS);
      expect(message).toContain("Candidate model-0: add");
    });
  });

  it("past the cap its gaps go nowhere: the answer is the report", async () => {
    const earlier = Array.from({ length: RESEARCH_ROUND_LIMITS.sendBacksPerCheck }, () => ({ draft: without("owner_reviews"), gate: gapCheckGate.name, message: "Missing." }));
    const ctx = withMatrix(ALL.slice(0, 2), { earlier, sources: { opened: async () => [...SOURCES, { partial: false, text: "New page.", toolName: "fetch_url", url: "https://example.test/new" }] } });
    const outcome = await runResearchGates({ context: ctx, draft: DRAFT, gates: [gapCheckGate], runId: "r" });
    expect(outcome).toEqual({ kind: "accepted", notes: [] });
  });
});

// The same in-memory ports as seam.test.ts, exercising the real engine below.
type Step = Readonly<{ calls?: ProviderRunResult["toolCalls"]; fail?: boolean; hang?: boolean; onCall?: () => void; text?: string }>;

function scripted(steps: readonly Step[]) {
  const requests: ProviderRunRequest[] = [];
  const adapter: ProviderAdapter = {
    buildRequestPreview: () => ({}),
    async *stream(request, options = {}): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
      requests.push(request);
      const step = steps[Math.min(requests.length - 1, steps.length - 1)]!;
      step.onCall?.();
      options.signal?.throwIfAborted();
      if (step.text) yield { data: { delta: step.text }, type: "token" };
      if (step.hang) {
        await new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(options.signal?.reason as Error), { once: true }));
      }
      if (step.fail) throw Object.assign(new Error("rejected"), { code: "provider_response_not_retryable" });
      return { finalProviderResponsePreview: {}, finalText: step.text ?? "", toolCalls: [...(step.calls ?? [])],
        usage: { inputTokens: 100, outputTokens: 10 } };
    }
  };
  return { adapter, requests };
}

function engineOf(research: ResearchEngineDeps | undefined, options: Readonly<{ now?: () => number; threadEffects?: Readonly<{ items: TranscriptItem[]; threadId: string }>[] }> = {}) {
  const rows = new Map<string, ToolCallRow>();
  const appended: TranscriptItem[] = [];
  let published: string | null = null;
  const row = (input: { arguments: Record<string, unknown>; ordinal: number; providerCallId: string; roundIndex: number; toolName: string }, state: ToolCallRow["state"]): ToolCallRow => {
    const made: ToolCallRow = { arguments: input.arguments as ToolCallRow["arguments"], id: `row-${rows.size}`, ordinal: input.ordinal, providerCallId: input.providerCallId,
      result: null, roundIndex: input.roundIndex, startedAt: "now", state, toolName: input.toolName };
    rows.set(made.id, made);
    return made;
  };
  const transcripts = {
    append: vi.fn(async (_scope, _from: number, items: readonly TranscriptItem[]) => { appended.push(...items); }),
    approvalContinuationTurns: vi.fn(async () => new Set<string>()),
    loadRuns: vi.fn(async (input: { runIds: readonly string[] }) => new Map(input.runIds.map((id) => [id, [] as TranscriptItem[]]))),
    nativeRunsForAnswers: vi.fn(async () => new Map()),
    nativeRunsBeforeTurns: vi.fn(async () => []),
    retiredRunEffects: vi.fn(async () => []),
    nextSequence: vi.fn(async () => 0),
    runLive: vi.fn(async () => true)
  } satisfies TranscriptRepository;
  const toolCalls = {
    begin: vi.fn(async (input): Promise<ToolCallBeginResult> => ({ kind: "running", row: row(input, "running") })),
    refuse: vi.fn(async (input) => row(input, "error")),
    settle: vi.fn(async () => true)
  } satisfies ToolCallStore;
  const runs = {
    applyUsageTotals: vi.fn(async () => undefined),
    complete: vi.fn(async () => true),
    publishAnswer: vi.fn(async (_scope, input: { text: string }) => { published = input.text; return true; }),
    recordDetachedCompaction: vi.fn(async () => true),
    saveStoppedText: vi.fn(async () => true),
    workDurationMs: vi.fn(async () => null as number | null),
    writeUsageRows: vi.fn(async () => undefined)
  } satisfies NativeRunStore;
  let turns = 0;
  const threads = {
    admitForeground: vi.fn(async (input: Parameters<SubagentThreadStore["admitForeground"]>[0]) => {
      turns += 1;
      return { continued: false, kind: "admitted" as const,
        thread: { anchorRunId: input.parentRunId, definitionId: null, id: `thread-${turns}`, name: input.name, parentThreadId: null, typeName: null },
        turn: { branchRunId: input.parentRunId, definitionRevisionId: null, effortSource: input.binding.effortSource, id: `turn-${turns}`, mode: "foreground" as const,
          modelId: input.binding.modelId, modelSource: input.binding.modelSource, parentRunId: input.parentRunId, provider: input.binding.provider,
          providerModelId: input.binding.providerModelId, reasoningEffort: input.binding.reasoningEffort, startedAt: new Date(), state: "running" as const, threadId: `thread-${turns}` } };
    }),
    ensureThread: vi.fn(),
    find: vi.fn(async () => null),
    result: vi.fn(async () => null),
    activeChildren: vi.fn(async () => 0),
    childResults: vi.fn(async () => []),
    endOrphanedTurns: vi.fn(async () => 0),
    setActiveState: vi.fn(async () => true),
    threadEffectItems: vi.fn(async () => options.threadEffects ?? []),
    backgroundRunIds: vi.fn(async () => []),
    threadRunIds: vi.fn(async (input: { parentRunIds: readonly string[] }) => [...input.parentRunIds]),
    settle: vi.fn(async () => true)
  } as unknown as SubagentThreadStore;
  const deps: NativeEngineDeps = {
    approvedCall: vi.fn(async () => null), mcpBindingRows: vi.fn(async () => []),
    observations: vi.fn(async () => ({ withReservation: vi.fn(async () => ({ handle: `tor1_${"0".repeat(32)}` })) }) as never),
    ...(options.now ? { now: options.now } : {}),
    ...(research ? { research } : {}),
    runs, savedResults: { read: vi.fn(async () => ({ arguments: {}, text: "whole page: held up after 10 years", toolName: "fetch_url" })) },
    subagentThreads: threads, toolCalls, transcripts
  };
  return { appended, deps, published: () => published, runs, threads, toolCalls };
}

function repository() {
  return {
    appendAssistantText: vi.fn(async () => undefined), appendRunOutputEvent: vi.fn(async (_runId: string, event: unknown) => event),
    failRun: vi.fn(async () => true), getChatUpdateForRun: vi.fn(async () => null),
    getRunControlForUser: vi.fn(async () => ({ status: "streaming" })), loadModelPricing: vi.fn(async () => null),
    loadProviderModelCostBasis: vi.fn(async () => null), loadRunMcpApprovalCards: vi.fn(async () => []),
    markRunAnswerStarted: vi.fn(async () => undefined)
  };
}

function prepared(options: Readonly<{ noSearch?: boolean }> = {}): MaterializedPreparedRunData {
  const text = "Проведи исследование матрасов.";
  const request = {
    // The user chose Deep research for the message (operator decision 2026-11-05).
    deepResearch: true,
    attachmentIds: [], attachments: [], chatId: "chat", content: { blocks: [{ text, type: "text" }] },
    context: { messages: [{ content: { blocks: [{ text, type: "text" }] }, id: "current-user-message", role: "user" as const }], mode: "branch_path" as const },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, toolCalling: true, vision: false },
    modelId: "fake-qsa", params: { temperature: 0.3 }, prompt: { developer: null, system: "Be brief." }, provider: "fake", reasoningEffort: null,
    // A hosted source: Search is available and no client route is built.
    searchPlan: { mode: "all_selected" as const, options: options.noSearch ? [] : [{ adapterKind: "openai_hosted", config: {}, credentialMode: "answer", executionModes: ["all_selected"],
      modelId: "fake-qsa", optionId: "hosted", protocol: "hosted", provider: "fake", providerModelId: "model-1", revisionId: "rev", searchStrategyRowId: "strategy" }] },
    toolMode: "auto" as const
  } as unknown as ProviderRunRequest;
  return {
    contextTruncation: null, defaults: null, expectedActiveLeafId: null, mcpBindings: [], normalizedRequest: request,
    providerAdmissionPlan: { answer: { modelConfiguration: { adapterKind: "fake", capabilities: request.modelCapabilities, defaultParams: {} },
      snapshot: { connection: { responseTimeoutMs: 300_000 }, connectionId: "connection-1", model: { adapterKind: "fake", upstreamModelId: "fake-qsa" },
        providerFamily: "fake", providerModelId: "model-1" } } } as never,
    providerRequest: request, providerRequestPreview: {}, sourceKind: "send"
  };
}

const created = { assistantMessageId: "answer-1", runId: "run-1", userMessageId: "question-1" };

function run(adapter: ProviderAdapter, memory: ReturnType<typeof engineOf>, extra: Partial<NativeRunExecutionInput> & { runId?: string } = {},
  repo = repository()) {
  const { runId, ...rest } = extra;
  return createNativeRunExecutionResponse({ adapter, created: { ...created, ...(runId ? { runId } : {}) }, engine: memory.deps, prepared: prepared(),
    repository: repo as unknown as RunRepository, services: {}, userId: "user", ...rest });
}

async function events(response: Response): Promise<ModelRunSseEvent[]> {
  const text = await response.text();
  return text.split("\n\n").flatMap((block) => {
    const type = /^event: (.+)$/mu.exec(block)?.[1];
    const data = /^data: (.+)$/mu.exec(block)?.[1];
    return type && data ? [{ data: JSON.parse(data), type } as ModelRunSseEvent] : [];
  });
}

const tokens = (seen: readonly ModelRunSseEvent[]) => seen.flatMap((event) => event.type === "token" ? [event.data.delta] : []);

function resultsOf(request: ProviderRunRequest | undefined, name: string): string[] {
  return (request?.history ?? []).flatMap((item) => item.type === "tool_result" && item.name === name ? [item.output] : []);
}

const begin = () => [{ arguments: { goal: PLAN.goal }, id: "start", name: START_RESEARCH_TOOL_NAME },
  proposeCall({ questions: PLAN.questions.map((question) => ({ question: question.question, sites: question.sites, source_classes: question.sourceClasses })) })];
const submit = (id: string, draft: ResearchDraft) => ({ id, name: SUBMIT_RESEARCH_DRAFT_TOOL_NAME, arguments: {
  report: draft.report, findings: draft.findings.map(({ sourceClass, ...finding }) => ({ ...finding, source_class: sourceClass })),
  unreachable: draft.unreachable.map(({ sourceClass, ...entry }) => ({ ...entry, source_class: sourceClass }))
} });
const pageItems = (sourceClass: ResearchSourceClass): TranscriptItem[] => {
  const finding = FINDINGS.find((entry) => entry.sourceClass === sourceClass)!;
  return [
    { arguments: JSON.stringify({ url: finding.url }), callId: `page-${sourceClass}`, id: `call-${sourceClass}`, kind: "tool_call", name: "fetch_url" },
    { callId: `page-${sourceClass}`, id: `result-${sourceClass}`, kind: "tool_result", name: "fetch_url", outcome: "complete", output: finding.quote }
  ];
};

describe("gap check through the real engine", () => {
  it("ends after a shrinking rewrite with no new pages and lets the verifier check that draft", async () => {
    const first = { ...DRAFT, findings: Array.from({ length: 15 }, (_, index) => ({ ...FINDINGS[index % 4]!, claim: `Finding ${index}.` })) };
    const rewritten = { ...DRAFT, report: "The recommendation with delivery still uncertain.",
      findings: FINDINGS.slice(0, 3).map((finding) => ({ ...finding, claim: `Rewritten: ${finding.claim}` })) };
    const issue = "Delivery to the buyer's city is still unknown.";
    const main = scripted([
      { calls: begin() }, { calls: [submit("draft-1", first)] },
      { text: JSON.stringify({ ...CLEAN, gaps: [gap(issue, "Open the selected shop's delivery terms for Moscow.")] }) },
      { calls: [submit("draft-2", rewritten)] }
    ]);
    const verifier = vi.fn(async () => ({ kind: "pass" as const }));
    const memory = engineOf({ gates: [gapCheckGate, { name: "verifier", run: verifier }] },
      { threadEffects: [{ items: RESEARCH_SOURCE_CLASSES.flatMap(pageItems), threadId: "researchers" }] });
    await run(main.adapter, memory).text();
    expect(resultsOf(main.requests[3], SUBMIT_RESEARCH_DRAFT_TOOL_NAME)[0]).toContain("sent_back");
    expect(main.requests).toHaveLength(4);
    expect(memory.threads.admitForeground).toHaveBeenCalledTimes(1);
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(verifier).toHaveBeenCalledWith(expect.objectContaining({ report: rewritten.report, findings: rewritten.findings }), expect.anything());
    // What the judge left open is the report's to state: the answer is the report.
    expect(memory.published()).toBe(rewritten.report);
  });

  it("forces a draft with a missing class back to researchers, then publishes the completed round", async () => {
    const first = without("owner_reviews");
    const second = { ...DRAFT, report: "The final report includes owner reviews." };
    const opened = RESEARCH_SOURCE_CLASSES.filter((value) => value !== "owner_reviews").flatMap(pageItems);
    const main = scripted([
      { calls: begin() },
      { calls: [submit("draft-1", first)], text: "HIDDEN premature report." },
      { calls: [{ arguments: { name: "owners", message: "Open owner reviews and report findings." }, id: "owners", name: CALL_SUBAGENT_TOOL_NAME }] },
      { text: "Outcome: done\nOwners report durability.", onCall: () => opened.push(...pageItems("owner_reviews")) },
      { calls: [submit("draft-2", second)] },
      { text: JSON.stringify(CLEAN) }
    ]);
    const memory = engineOf({ gates: [gapCheckGate] }, { threadEffects: [{ items: opened, threadId: "researchers" }] });
    const seen = await events(run(main.adapter, memory));
    expect(resultsOf(main.requests[2], SUBMIT_RESEARCH_DRAFT_TOOL_NAME)[0]).toContain("owner reviews");
    expect(resultsOf(main.requests[2], SUBMIT_RESEARCH_DRAFT_TOOL_NAME)[0]).toContain("sent_back");
    expect(main.requests).toHaveLength(6);
    expect(memory.threads.admitForeground).toHaveBeenCalledWith(expect.objectContaining({ name: "owners" }));
    expect(memory.threads.admitForeground).toHaveBeenCalledWith(expect.objectContaining({ name: "gap-judge-2" }));
    expect(main.requests[5]!.tools?.map((tool) => tool.name)).not.toContain("fetch_url");
    expect(main.requests[5]!.tools?.map((tool) => tool.name)).not.toContain(CALL_SUBAGENT_TOOL_NAME);
    expect(tokens(seen).join()).not.toContain("HIDDEN");
    expect(memory.published()).toBe(second.report);
    expect(memory.runs.complete).toHaveBeenCalledTimes(1);
  });

  it("publishes the report with no gap or unreachable list when the turn has no time for another round", async () => {
    let clock = 0;
    const draft: ResearchDraft = { ...without("owner_reviews"), findings: [],
      unreachable: [{ sourceClass: "primary_official", target: "Maker site", reason: "The site is unavailable." }] };
    const main = scripted([{ calls: begin() }, { calls: [submit("draft-1", draft)], onCall: () => { clock = 55 * 60_000; } }]);
    const memory = engineOf({ gates: [gapCheckGate] }, { now: () => clock });
    await run(main.adapter, memory).text();
    expect(main.requests).toHaveLength(2);
    expect(memory.published()).toBe(researchAnswerText(draft.report, [researchNote("no_findings")]));
    expect(memory.runs.complete).toHaveBeenCalledTimes(1);
  });

  it("says only that time ran out when it expires after a send-back but before a replacement draft", async () => {
    let clock = 0;
    const reason = "The maker site is unavailable.";
    const draft: ResearchDraft = { ...without("owner_reviews"), findings: FINDINGS.filter((finding) =>
      finding.sourceClass !== "owner_reviews" && finding.sourceClass !== "primary_official"),
      unreachable: [{ sourceClass: "primary_official", target: "Maker site", reason }] };
    const main = scripted([
      { calls: begin() },
      { calls: [submit("draft-1", draft)] },
      { calls: [{ arguments: { plan: [{ status: "pending", step: "Read owners" }] }, id: "slow", name: "update_plan" }],
        onCall: () => { clock = 55 * 60_000; } },
      { text: "Still looking for owner reviews." }
    ]);
    const memory = engineOf({ gates: [gapCheckGate] }, { now: () => clock, threadEffects: [
      { items: [...pageItems("independent_tests"), ...pageItems("action_channel")], threadId: "researchers" }
    ] });
    await run(main.adapter, memory).text();
    expect(main.requests).toHaveLength(4);
    expect(resultsOf(main.requests[2], SUBMIT_RESEARCH_DRAFT_TOOL_NAME)[0]).toContain("sent_back");
    // A later response ends the run without checking another draft: neither the gap nor the unreachable list reaches the reader.
    expect(memory.published()).toBe(researchAnswerText(draft.report, [researchNote("time_out")]));
  });

  it("keeps responseEnded's plain-text recovery finite when the model never supplies findings", async () => {
    const main = scripted([{ calls: begin() }, { text: "First report." }, { text: "Second report." }, { text: "Still no findings." }]);
    const memory = engineOf({ gates: [gapCheckGate] });
    await run(main.adapter, memory).text();
    expect(main.requests).toHaveLength(4);
    expect(JSON.stringify(main.requests[3]!.history)).toContain("with record_ids, the ids of the records it rests on");
    // run.ts keeps the standing draft after this one correction opportunity.
    expect(memory.published()).toBe("Second report.");
  });
});

describe("gate notes survive draft recovery", () => {
  const earlierNote = "The maker site was unavailable.";
  const ownNote = "Independent testing covered only one year.";
  const unresolvedNote = "Owner reviews remain unchecked.";
  const before = { name: "before", run: async () => ({ kind: "pass" as const, notes: [earlierNote] }) };
  const sendBack = { kind: "send_back" as const, message: "Find owner reviews.", notes: [earlierNote, ownNote], unresolvedNote };

  it.each(["tools_closed", "text_ended", "empty_ended", "failed", "stopped", "timed_out"] as const)("preserves each note once through %s", async (ending) => {
    if (ending === "timed_out") vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1 });
    try {
      let clock = 0;
      const runId = `notes-${ending}`;
      const endings: Record<typeof ending, readonly Step[]> = {
        tools_closed: [
          { calls: [{ arguments: { plan: [{ status: "pending", step: "Read owners" }] }, id: "slow", name: "update_plan" }], onCall: () => { clock = 55 * 60_000; } },
          { calls: [{ arguments: {}, id: "other", name: "update_plan" }] }
        ],
        text_ended: [{ text: "Still looking." }, { text: "Still looking again." }],
        empty_ended: [{}], failed: [{ fail: true }],
        stopped: [{ onCall: () => { activeRunControllerRegistry.abort(runId); } }], timed_out: [{ hang: true }]
      };
      const main = scripted([{ calls: begin() }, { calls: [submit("draft-1", DRAFT)] }, ...endings[ending]]);
      const memory = engineOf({ gates: [before, { name: "back", run: async () => sendBack }] },
        ending === "tools_closed" ? { now: () => clock } : {});
      const repo = repository();
      const finished = run(main.adapter, memory, { runId }, repo).text();
      if (ending === "timed_out") await vi.advanceTimersByTimeAsync(60 * 60_000 + 1_000);
      await finished;
      const saved = (repo.appendAssistantText.mock.calls.at(-1) as unknown[] | undefined)?.[1];
      const stopped = (vi.mocked(memory.runs.saveStoppedText).mock.calls.at(-1) as unknown[] | undefined)?.[1];
      const shown = memory.published() ?? stopped ?? saved;
      // Ending on a message adds nothing: the gates' own notes are what the reader is told.
      const generic = ending === "stopped" ? "stopped" : ending === "failed" ? "run_failed"
        : ending === "tools_closed" || ending === "timed_out" ? "time_out" : null;
      expect(shown).toBe(researchAnswerText(DRAFT.report, [earlierNote, ownNote, unresolvedNote, ...generic ? [researchNote(generic)] : []]));
      expect(main.requests).toHaveLength(ending === "tools_closed" || ending === "text_ended" ? 4 : 3);
    } finally {
      if (ending === "timed_out") vi.useRealTimers();
    }
  });

  it("replaces old remarks with the later accepted draft's own notes", async () => {
    const corrected = { ...DRAFT, report: "The corrected report." };
    const main = scripted([{ calls: begin() }, { calls: [submit("draft-1", DRAFT)] }, { calls: [submit("draft-2", corrected)] }]);
    const memory = engineOf({ gates: [before, { name: "back", run: async (_draft, ctx) => ctx.attempt === 1 ? sendBack
      : { kind: "pass", notes: ["Owner reviews were checked."] } }] });
    await run(main.adapter, memory).text();
    expect(memory.published()).toBe(researchAnswerText(corrected.report, [earlierNote, "Owner reviews were checked."]));
    expect(main.requests).toHaveLength(3);
  });

  it.each([false, true])("keeps a superseded draft's notes when the follow-up has no replacement (failure: %s)", async (failed) => {
    let checked = false;
    let handed = false;
    const main = scripted([{ calls: begin() }, { calls: [submit("draft-1", DRAFT)] }, { fail: failed }]);
    const memory = engineOf({ gates: [before, { name: "back", run: async () => { checked = true; return sendBack; } }] });
    const repo = repository();
    const followups = {
      close: vi.fn(async () => true), deliver: vi.fn(async () => true),
      load: vi.fn(async () => {
        const due = checked && !handed;
        if (due) handed = true;
        return { entries: due ? [{ delivery: "accepted" as const, id: "f1", origin: "user" as const, text: "Also check prices." }] : [], revision: 1 };
      })
    };
    await run(main.adapter, memory, { prepared: { ...prepared(), followupAdmission: {} as never } }, { ...repo, followups } as never).text();
    const shown = memory.published() ?? (repo.appendAssistantText.mock.calls.at(-1) as unknown[] | undefined)?.[1];
    expect(shown).toBe(researchAnswerText(DRAFT.report, [earlierNote, ownNote, unresolvedNote,
      ...failed ? [researchNote("run_failed")] : [], researchNote("followup_not_applied")]));
    expect(main.requests).toHaveLength(3);
  });
});

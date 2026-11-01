import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RESEARCH_LIMITS, RESEARCH_SOURCE_CLASSES, START_RESEARCH_TOOL_NAME, SUBMIT_RESEARCH_DRAFT_TOOL_NAME,
  type ResearchDraft, type ResearchFinding, type ResearchPlan, type ResearchSourceClass
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
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import type { RunRepository } from "../runs/runRepositoryContract";
import type { ResearchEngineDeps } from "./run";
import { namespacedWorkspaceToolName } from "../workspace/toolCatalog";
import { gapCheckGate } from "./gapCheck";
import { runResearchGates, type ResearchGateContext, type ResearchOpenedSource, type ResearchSubagentOutcome } from "./gates";
import { researchAnswerText, researchNote } from "./notes";

const PLAN: ResearchPlan = {
  goal: "Choose a mattress.", questions: RESEARCH_SOURCE_CLASSES.map((sourceClass) => ({
    question: `What does ${sourceClass} say about durability?`, sites: [], sourceClasses: [sourceClass]
  })), skipped: []
};
const FINDINGS: ResearchFinding[] = RESEARCH_SOURCE_CLASSES.map((sourceClass) => ({
  claim: `${sourceClass} found the mattress durable.`, quote: `The ${sourceClass} durability result.`, sourceClass,
  standing: "confirmed", url: `https://example.test/${sourceClass}`
}));
const DRAFT: ResearchDraft = { findings: FINDINGS, origin: "reserved_call", report: "# Report\nThe mattress is durable.", unreachable: [] };
const SOURCES: ResearchOpenedSource[] = FINDINGS.map((finding) => ({ partial: false, text: finding.quote, toolName: "fetch_url", url: finding.url }));
const CLEAN = { open_questions: [], weak_answers: [], conflicts: [] };
const judged = (report = JSON.stringify(CLEAN)): ResearchSubagentOutcome => ({ kind: "ended", result: {
  approvals: [], files: [], kind: "ended", model: { effort: null, id: "main-model" }, name: "gap-judge", outcome: "done", report, state: "done", steps: []
} });

function context(overrides: Partial<ResearchGateContext> = {}): ResearchGateContext {
  return {
    attempt: 1, earlier: [], plan: PLAN, signal: new AbortController().signal,
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
    expect(messageOf(result)).toContain(`[${sourceClass}] What does ${sourceClass} say about durability?`);
    expect(messageOf(result)).toContain("Send researchers with call_subagent");
    for (const other of RESEARCH_SOURCE_CLASSES.filter((value) => value !== sourceClass)) expect(messageOf(result)).not.toContain(other);
    expect(ctx.subagents.run).not.toHaveBeenCalled();
  });

  it.each(RESEARCH_SOURCE_CLASSES)("does not accept a planted %s finding whose page was never opened", async (sourceClass) => {
    const ctx = context({ sources: { opened: vi.fn(async () => SOURCES.filter((source) => !source.url?.endsWith(sourceClass))) } });
    const result = await gapCheckGate.run(DRAFT, ctx);
    expect(result.kind).toBe("send_back");
    expect(messageOf(result)).toContain(sourceClass);
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
      ? { partial: false, text: saved, toolName: namespacedWorkspaceToolName("sandbox_exec"), url: null } : source) } });
    expect(await gapCheckGate.run(draft, ctx)).toMatchObject({ kind: "pass", notes: [] });
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
    expect(messageOf(await gapCheckGate.run(DRAFT, ctx))).toContain("owner_reviews");
    expect(ctx.subagents.run).not.toHaveBeenCalled();
  });

  it.each([null, FINDINGS[2]!.url])("treats partial page text as unknown, never missing (URL %s)", async (url) => {
    const ctx = context({ sources: { opened: async () => SOURCES.map((source) => source.url?.endsWith("owner_reviews")
      ? { partial: true, text: "unrelated excerpt", toolName: namespacedWorkspaceToolName("sandbox_exec"), url } : source) } });
    const result = await gapCheckGate.run(DRAFT, ctx);
    expect(result.kind).toBe("pass");
    expect(result.notes?.join()).toContain("Source opening could not be checked:");
    expect(result.notes?.join()).toContain("owner_reviews");
    expect(result.notes?.join()).not.toContain("Missing");
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
    expect(messageOf(result)).not.toContain("owner_reviews");
  });
});

describe("unreachable sources reach the report", () => {
  const unreachable = { target: "Owner forum", sourceClass: "owner_reviews" as const, reason: "Sign-in required; no public reviews available." };

  it.each(["# Report", "# Отчёт"])("closes a class only with its reason and guarantees both target and reason in %s", async (report) => {
    const draft = { ...without("owner_reviews"), report, unreachable: [unreachable] };
    const ctx = context();
    const result = await runResearchGates({ context: ctx, draft, gates: [gapCheckGate], runId: "test" });
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") throw new Error("Expected acceptance");
    const answer = researchAnswerText(draft.report, result.notes);
    expect(answer).toContain(unreachable.target);
    expect(answer).toContain(unreachable.reason);
    expect(answer).toContain(report === "# Report" ? "Source could not be reached" : "Не удалось обратиться к источнику");
    expect(JSON.parse(vi.mocked(ctx.subagents.run).mock.calls[0]![0].brief).unreachableClasses).toEqual(["owner_reviews"]);
  });

  it.each([unreachable.target, unreachable.reason])("adds the reason and target when only %s is already in the report", async (report) => {
    const result = await gapCheckGate.run({ ...without("owner_reviews"), report, unreachable: [unreachable] }, context());
    expect(result.notes?.join()).toContain(unreachable.reason);
    expect(result.notes?.join()).toContain(unreachable.target);
  });

  it("does not repeat an unreachable explanation already present with different whitespace", async () => {
    const result = await gapCheckGate.run({ ...without("owner_reviews"), report: `${unreachable.target}\n${unreachable.reason.replaceAll(" ", "\n")}`,
      unreachable: [unreachable] }, context());
    expect(result).toEqual({ kind: "pass", notes: [] });
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
    expect(request).toMatchObject({ model: "main", tools: [] });
    expect(signal).toBe(ctx.signal);
    expect(request.instructions).toContain("strict JSON");
    expect(request.instructions).toContain("untrusted data");
    expect(request.brief).not.toContain("MAIN AGENT REASONING");
    expect(JSON.parse(request.brief)).toMatchObject({ plan: PLAN, findings: FINDINGS, planShortened: false, findingsShortened: false });
  });

  it("sends the judge's open questions, weak answers and conflicts back for researchers", async () => {
    const ctx = context({ subagents: { run: vi.fn(async () => judged(JSON.stringify({
      open_questions: ["Are owner_reviews representative?"], weak_answers: ["independent_tests only cover one year."], conflicts: ["primary_official says ten years; owners say two."]
    }))) } });
    const result = await gapCheckGate.run(DRAFT, ctx);
    expect(result.kind).toBe("send_back");
    expect(messageOf(result)).toContain("Open question: Are owner_reviews representative?");
    expect(messageOf(result)).toContain("Weak answer: independent_tests only cover one year.");
    expect(messageOf(result)).toContain("Conflict: primary_official says ten years; owners say two.");
  });

  it.each([
    "not JSON", "null", "[]", "{}", JSON.stringify({ ...CLEAN, extra: "ignored?" }),
    JSON.stringify({ ...CLEAN, open_questions: "not an array" }), JSON.stringify({ ...CLEAN, conflicts: [null] }),
    JSON.stringify({ ...CLEAN, weak_answers: [" "] }), JSON.stringify({ ...CLEAN, conflicts: ["bad\0text"] }),
    JSON.stringify({ ...CLEAN, conflicts: ["x".repeat(RESEARCH_LIMITS.questionCharacters + 1)] }),
    JSON.stringify({ ...CLEAN, conflicts: Array.from({ length: RESEARCH_LIMITS.questions + 1 }, () => "gap") }),
    `Outcome: done\n${JSON.stringify(CLEAN)}`, "x".repeat(RUN_FOLLOWUP_MAX_CHARS + 1)
  ])("passes an unreadable judgment without a note (%#)", async (report) => {
    const ctx = context({ subagents: { run: async () => judged(report) } });
    expect(await gapCheckGate.run(DRAFT, ctx)).toEqual({ kind: "pass", notes: [] });
  });

  it.each(["throw", "refused", "failed", "partial", "truncated"])("passes a %s judge silently and still runs the next gate", async (failure) => {
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
      .toEqual({ kind: "accepted", notes: [] });
    expect(verifier).toHaveBeenCalledOnce();
  });
});

describe("research stops on evidence or time, not a round count", () => {
  it("ends when claim and link add nothing after normalization, even if the quote changes", async () => {
    const draft = { ...DRAFT, findings: FINDINGS.map((finding) => ({ ...finding, claim: `  ${finding.claim.toUpperCase()}\n`, url: `${finding.url}#new`, quote: "A different quote." })) };
    const ctx = context({ attempt: 2, earlier: [{ draft: DRAFT, message: "Old feedback" }], sources: { opened: async () => [] } });
    const result = await gapCheckGate.run(draft, ctx);
    expect(result.kind).toBe("pass");
    expect(result.notes?.join()).toContain("independent_tests");
    expect(ctx.subagents.run).not.toHaveBeenCalled();
  });

  it("remembers findings across every earlier draft, not just the last draft", async () => {
    const ctx = context({ attempt: 3, earlier: [{ draft: DRAFT, message: null }, { draft: without("owner_reviews"), message: "Owners missing" }] });
    expect((await gapCheckGate.run(DRAFT, ctx)).kind).toBe("pass");
    expect(ctx.subagents.run).not.toHaveBeenCalled();
  });

  it("keeps the previous judge's named gaps when a round finds nothing new", async () => {
    const first = context({ subagents: { run: async () => judged(JSON.stringify({ ...CLEAN, open_questions: ["How durable is it after five years?"] })) } });
    const sentBack = await gapCheckGate.run(DRAFT, first);
    const ctx = context({ attempt: 2, earlier: [{ draft: DRAFT, message: messageOf(sentBack) }] });
    const result = await gapCheckGate.run(DRAFT, ctx);
    expect(result.kind).toBe("pass");
    expect(result.notes?.join()).toContain("How durable is it after five years?");
    expect(result.notes?.join()).not.toContain("Send researchers");
    expect(ctx.subagents.run).not.toHaveBeenCalled();
  });

  it("drops a previous mechanical gap once its page was opened, even without a new claim", async () => {
    const first = await gapCheckGate.run(DRAFT, context({ sources: { opened: async () => [] } }));
    expect(await gapCheckGate.run(DRAFT, context({ attempt: 2, earlier: [{ draft: DRAFT, message: messageOf(first) }] })))
      .toEqual({ kind: "pass", notes: [] });
  });

  it("continues after many rounds when the draft adds a finding and a gap remains", async () => {
    const ctx = context({ attempt: 41, earlier: Array.from({ length: 40 }, () => ({ draft: without("owner_reviews"), message: null })),
      sources: { opened: async () => SOURCES.filter((source) => !source.url?.endsWith("owner_reviews")) } });
    expect((await gapCheckGate.run(DRAFT, ctx)).kind).toBe("send_back");
  });

  it("names remaining gaps in Russian when the tool deadline closes", async () => {
    const ctx = context({ time: { remainingMs: () => 60_000, sendBackAllowed: () => false } });
    const result = await gapCheckGate.run({ ...without("owner_reviews"), report: "Отчёт о матрасах." }, ctx);
    expect(result.kind).toBe("pass");
    expect(result.notes?.join()).toContain("Не хватает находок");
    expect(result.notes?.join()).toContain("owner_reviews");
    expect(ctx.subagents.run).not.toHaveBeenCalled();
  });

  it("lets the seam turn a send-back into its named note when the deadline races the gate", async () => {
    const allowed = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const result = await runResearchGates({ context: context({ time: { remainingMs: () => 60_000, sendBackAllowed: allowed } }),
      draft: without("owner_reviews"), gates: [gapCheckGate], runId: "test" });
    expect(result).toMatchObject({ kind: "accepted", notes: [expect.stringContaining("owner_reviews")] });
  });

  it("does not start a judge without time for a turn", async () => {
    const ctx = context({ time: { remainingMs: () => 1, sendBackAllowed: () => true } });
    expect(await gapCheckGate.run(DRAFT, ctx)).toEqual({ kind: "pass", notes: [] });
    expect(ctx.subagents.run).not.toHaveBeenCalled();
  });

  it("keeps previously named issues when a new finding arrives too late to judge them", async () => {
    const first = await gapCheckGate.run(DRAFT, context({ subagents: { run: async () => judged(JSON.stringify({ ...CLEAN,
      open_questions: ["How durable is it after five years?"] })) } }));
    const ctx = context({ earlier: [{ draft: DRAFT, message: messageOf(first) }],
      time: { remainingMs: () => 1, sendBackAllowed: () => true } });
    const result = await gapCheckGate.run({ ...DRAFT, findings: [...FINDINGS, { ...FINDINGS[0]!, claim: "Another short-term result." }] }, ctx);
    expect(result).toMatchObject({ kind: "pass", notes: [expect.stringContaining("How durable is it after five years?")] });
    expect(ctx.subagents.run).not.toHaveBeenCalled();
  });

  it("turns the judge's send-back into a note if time runs out during judgment", async () => {
    let allowed = true;
    const ctx = context({ time: { remainingMs: () => 60_000, sendBackAllowed: () => allowed }, subagents: { run: async () => {
      allowed = false;
      return judged(JSON.stringify({ ...CLEAN, conflicts: ["The lab and owners disagree on durability."] }));
    } } });
    expect(await gapCheckGate.run(DRAFT, ctx)).toMatchObject({ kind: "pass", notes: [expect.stringContaining("lab and owners disagree")] });
  });

  it("asks for findings from plain text once, leaving the no-findings report note to run.ts", async () => {
    const draft: ResearchDraft = { ...DRAFT, origin: "plain_text", findings: [] };
    const ctx = context();
    const first = await gapCheckGate.run(draft, ctx);
    expect(first.kind).toBe("send_back");
    expect(messageOf(first)).toContain("findings: claim, link, verbatim quote and source class");
    expect(await gapCheckGate.run(draft, { ...ctx, attempt: 2, earlier: [{ draft, message: messageOf(first) }] })).toEqual({ kind: "pass", notes: [] });
    expect(await gapCheckGate.run(draft, { ...ctx, time: { remainingMs: () => 0, sendBackAllowed: () => false } })).toEqual({ kind: "pass", notes: [] });
    expect(ctx.sources.opened).not.toHaveBeenCalled();
    expect(ctx.subagents.run).not.toHaveBeenCalled();
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
    for (const sourceClass of RESEARCH_SOURCE_CLASSES) expect(messageOf(result)).toContain(sourceClass);
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
    const ctx = context({ subagents: { run: async () => judged(JSON.stringify({ open_questions: issues, weak_answers: issues, conflicts: issues })) } });
    expect(await gapCheckGate.run(DRAFT, ctx)).toEqual({ kind: "pass", notes: [] });
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

const start = () => ({ arguments: { goal: PLAN.goal,
  questions: PLAN.questions.map((question) => ({ question: question.question, sites: question.sites, source_classes: question.sourceClasses })),
  skipped_source_classes: [] }, id: "start", name: START_RESEARCH_TOOL_NAME });
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
  it("forces a draft with a missing class back to researchers, then publishes the completed round", async () => {
    const first = without("owner_reviews");
    const second = { ...DRAFT, report: "The final report includes owner reviews." };
    const opened = RESEARCH_SOURCE_CLASSES.filter((value) => value !== "owner_reviews").flatMap(pageItems);
    const main = scripted([
      { calls: [start()] },
      { calls: [submit("draft-1", first)], text: "HIDDEN premature report." },
      { calls: [{ arguments: { name: "owners", message: "Open owner reviews and report findings." }, id: "owners", name: CALL_SUBAGENT_TOOL_NAME }] },
      { text: "Outcome: done\nOwners report durability.", onCall: () => opened.push(...pageItems("owner_reviews")) },
      { calls: [submit("draft-2", second)] },
      { text: JSON.stringify(CLEAN) }
    ]);
    const memory = engineOf({ gates: [gapCheckGate] }, { threadEffects: [{ items: opened, threadId: "researchers" }] });
    const seen = await events(run(main.adapter, memory));
    expect(resultsOf(main.requests[2], SUBMIT_RESEARCH_DRAFT_TOOL_NAME)[0]).toContain("owner_reviews");
    expect(resultsOf(main.requests[2], SUBMIT_RESEARCH_DRAFT_TOOL_NAME)[0]).toContain("sent_back");
    expect(main.requests).toHaveLength(6);
    expect(memory.threads.admitForeground).toHaveBeenCalledWith(expect.objectContaining({ name: "owners" }));
    expect(memory.threads.admitForeground).toHaveBeenCalledWith(expect.objectContaining({ name: "gap-judge-run1-2" }));
    expect(main.requests[5]!.tools?.map((tool) => tool.name)).not.toContain("fetch_url");
    expect(main.requests[5]!.tools?.map((tool) => tool.name)).not.toContain(CALL_SUBAGENT_TOOL_NAME);
    expect(tokens(seen).join()).not.toContain("HIDDEN");
    expect(memory.published()).toBe(second.report);
    expect(memory.runs.complete).toHaveBeenCalledTimes(1);
  });

  it("publishes the named gap and unreachable reason when the turn has no time for another round", async () => {
    let clock = 0;
    const draft: ResearchDraft = { ...without("owner_reviews"), findings: [],
      unreachable: [{ sourceClass: "primary_official", target: "Maker site", reason: "The site is unavailable." }] };
    const main = scripted([{ calls: [start()] }, { calls: [submit("draft-1", draft)], onCall: () => { clock = 55 * 60_000; } }]);
    const memory = engineOf({ gates: [gapCheckGate] }, { now: () => clock });
    await run(main.adapter, memory).text();
    expect(main.requests).toHaveLength(2);
    expect(memory.published()).toContain("owner_reviews");
    expect(memory.published()).toContain("Maker site");
    expect(memory.published()).toContain("The site is unavailable.");
    expect(memory.runs.complete).toHaveBeenCalledTimes(1);
  });

  it("preserves gap notes when time expires after a send-back but before a replacement draft", async () => {
    let clock = 0;
    const reason = "The maker site is unavailable.";
    const draft: ResearchDraft = { ...without("owner_reviews"), findings: FINDINGS.filter((finding) =>
      finding.sourceClass !== "owner_reviews" && finding.sourceClass !== "primary_official"),
      unreachable: [{ sourceClass: "primary_official", target: "Maker site", reason }] };
    const main = scripted([
      { calls: [start()] },
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
    // The gate supplied both notes, but the seam currently drops them when a
    // later response ends the run without checking another draft.
    expect({ namedGap: memory.published()?.includes("owner_reviews"), unreachableReason: memory.published()?.includes(reason) })
      .toEqual({ namedGap: true, unreachableReason: true });
  });

  it("keeps responseEnded's plain-text recovery finite when the model never supplies findings", async () => {
    const main = scripted([{ calls: [start()] }, { text: "First report." }, { text: "Second report." }, { text: "Still no findings." }]);
    const memory = engineOf({ gates: [gapCheckGate] });
    await run(main.adapter, memory).text();
    expect(main.requests).toHaveLength(4);
    expect(JSON.stringify(main.requests[3]!.history)).toContain("findings: claim, link, verbatim quote and source class");
    // run.ts keeps the standing draft after this one correction opportunity.
    expect(memory.published()).toContain("Second report.");
    expect(memory.published()).toContain(researchNote("unresolved", "Second report."));
  });
});

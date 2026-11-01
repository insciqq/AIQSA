import { describe, expect, it, vi } from "vitest";
import { decodeResearchDraft, decodeResearchPlan, RESEARCH_LIMITS, RESEARCH_SOURCE_CLASSES, type ResearchDraft, type ResearchPlan } from "../../contracts/research";
import { RUN_FOLLOWUP_MAX_CHARS } from "../../contracts/runFollowups";
import { harnessPromptSection } from "../engine/prompts/harness";
import { startResearchTool, submitResearchDraftTool } from "../tools/research";
import { runResearchGates, type ResearchGateContext } from "./gates";
import { researcherBrief, researcherMethodFooter, researchMethodText, researchPlanUpdate } from "./method";
import { researchAnswerText, researchNote } from "./notes";
import { researchOffered } from "./run";
import { createResearchSources } from "./sources";
import { researchTurnName } from "./turns";

const question = { question: "Which one?", sites: [], source_classes: [...RESEARCH_SOURCE_CLASSES] };
const plan: ResearchPlan = { goal: "Choose.", questions: [{ question: "Which one?", sites: ["shop.example"], sourceClasses: [...RESEARCH_SOURCE_CLASSES] }], skipped: [] };
const draft: ResearchDraft = { findings: [], origin: "reserved_call", report: "Report.", unreachable: [] };

function context(overrides: Partial<ResearchGateContext> = {}): ResearchGateContext {
  return { attempt: 1, earlier: [], plan, signal: new AbortController().signal, sources: { opened: async () => [] },
    subagents: { run: async () => ({ code: "x", kind: "refused" }) }, time: { remainingMs: () => 60_000, sendBackAllowed: () => true },
    verifierModel: async () => ({ kind: "main_model", label: "m" }), ...overrides };
}

describe("the plan and the draft", () => {
  it("takes a plan whose every source class is assigned or skipped with a reason", () => {
    expect(decodeResearchPlan({ goal: "Choose.", questions: [question], skipped_source_classes: [] })).toMatchObject({ ok: true, value: { goal: "Choose." } });
    const skipping = decodeResearchPlan({ goal: "Choose.", questions: [{ ...question, source_classes: ["primary_official", "independent_tests", "owner_reviews"] }],
      skipped_source_classes: [{ reason: "Nothing to buy.", source_class: "action_channel" }] });
    expect(skipping).toMatchObject({ ok: true, value: { skipped: [{ reason: "Nothing to buy.", sourceClass: "action_channel" }] } });
  });

  it("refuses a plan with a field to correct, naming it", () => {
    expect(decodeResearchPlan(null)).toMatchObject({ ok: false });
    expect(decodeResearchPlan({ goal: "", questions: [question] })).toMatchObject({ message: expect.stringContaining("goal"), ok: false });
    expect(decodeResearchPlan({ goal: "g", questions: [] })).toMatchObject({ message: expect.stringContaining("questions"), ok: false });
    expect(decodeResearchPlan({ goal: "g", questions: [{ question: "q", source_classes: ["blog"] }] })).toMatchObject({ message: expect.stringContaining("questions[0].source_classes"), ok: false });
    expect(decodeResearchPlan({ goal: "g", questions: [{ question: "q", source_classes: ["primary_official"] }] }))
      .toMatchObject({ message: expect.stringContaining("independent_tests, owner_reviews, action_channel"), ok: false });
    expect(decodeResearchPlan({ goal: "g", questions: new Array(RESEARCH_LIMITS.questions + 1).fill(question) })).toMatchObject({ ok: false });
    expect(decodeResearchPlan({ goal: "g", questions: [question], skipped_source_classes: [{ source_class: "action_channel" }] })).toMatchObject({ ok: false });
  });

  it("takes a finding only as claim, link, quote, source class and standing", () => {
    const finding = { claim: "c", quote: "q", source_class: "owner_reviews", standing: "claimed", url: "https://a.example" };
    expect(decodeResearchDraft({ findings: [finding], report: "r", unreachable: [{ reason: "CAPTCHA", source_class: null, target: "shop.example" }] })).toEqual({ ok: true, value: {
      findings: [{ claim: "c", quote: "q", sourceClass: "owner_reviews", standing: "claimed", url: "https://a.example" }], origin: "reserved_call", report: "r",
      unreachable: [{ reason: "CAPTCHA", sourceClass: null, target: "shop.example" }] } });
    for (const key of ["claim", "quote", "source_class", "standing", "url"]) {
      expect(decodeResearchDraft({ findings: [{ ...finding, [key]: "" }], report: "r", unreachable: [] })).toMatchObject({ message: expect.stringContaining(`findings[0].${key}`), ok: false });
    }
    expect(decodeResearchDraft({ findings: [], report: " ", unreachable: [] })).toMatchObject({ message: expect.stringContaining("report"), ok: false });
    expect(decodeResearchDraft({ report: "r", unreachable: [] })).toMatchObject({ message: expect.stringContaining("findings"), ok: false });
    expect(decodeResearchDraft({ findings: [], report: "r", unreachable: [{ target: "t" }] })).toMatchObject({ message: expect.stringContaining("unreachable[0]"), ok: false });
  });

  it("writes its schemas so every provider takes them: no type list naming a container", () => {
    const schemas = JSON.stringify([startResearchTool.inputSchema, submitResearchDraftTool.inputSchema]);
    expect(schemas).not.toMatch(/"type":\[/u);
    expect(startResearchTool.capability).toBe("session");
  });
});

describe("the method", () => {
  it("tells the main agent how to run what it planned", () => {
    const text = researchMethodText(plan);
    expect(text).toContain("call_subagent");
    expect(text).toContain("submit_research_draft");
    expect(text).toContain("Which one? [primary_official, independent_tests, owner_reviews, action_channel]");
    expect(text).toContain("shop.example");
  });

  it("ends every brief with the source classes, the finding's form, and a named site's CAPTCHA going to the user", () => {
    const footer = researcherMethodFooter(plan);
    expect(footer).toContain("verbatim quote");
    expect(footer).toContain("browser_handoff");
    expect(footer).toContain("never skip");
    expect(footer).not.toMatch(/skip (?:it|the site) if/iu);
    expect(researcherBrief("Cover it.", plan)).toBe(`Cover it.\n\n${footer}`);
    expect(researcherBrief("x".repeat(RUN_FOLLOWUP_MAX_CHARS), plan)).toBeNull();
  });

  it("shows the questions as the plan", () => {
    expect(researchPlanUpdate({ ...plan, questions: [plan.questions[0]!, { ...plan.questions[0]!, question: "Next?" }] })).toEqual({ plan: [
      { status: "in_progress", step: "Which one?" }, { status: "pending", step: "Next?" }] });
  });

  it("offers research only with Search, sub-agents and an interactive web run", () => {
    const base = { monitoring: false, scheduled: false, searchOptions: 1, subagents: true, telegram: false };
    expect(researchOffered(base)).toBe(true);
    for (const off of [{ searchOptions: 0 }, { subagents: false }, { telegram: true }, { scheduled: true }, { monitoring: true }]) {
      expect(researchOffered({ ...base, ...off })).toBe(false);
    }
  });

  it("says in the system prompt when to start and when not to, with the operator's phrases", () => {
    const prompt = harnessPromptSection({ tools: ["start_research"], workspace: false });
    for (const phrase of ["поищи хорошо", "проведи исследование", "глубокий анализ", "проанализируй", "поищи, какие матрасы есть современные"]) {
      expect(prompt).toContain(phrase);
    }
    expect(harnessPromptSection({ tools: [], workspace: false })).not.toContain("# Research");
  });

  it("names a gate's thread for its attempt alone, with no piece of an internal id, within the sub-agent name rule", () => {
    expect(researchTurnName("Verifier!", 2)).toBe("verifier-2");
    expect(researchTurnName("!!!", 1)).toBe("check-1");
    expect(researchTurnName("v".repeat(80), 1).length).toBeLessThanOrEqual(48);
  });

  it("notes in the report's language and keeps the report as written", () => {
    expect(researchNote("time_out", "Отчёт")).toMatch(/^Время вышло/u);
    expect(researchNote("time_out", "Report")).toMatch(/^Time ran out/u);
    expect(researchAnswerText("Report.", [])).toBe("Report.");
    expect(researchAnswerText("Report.\n", ["A.", "A.", " "])).toBe("Report.\n\n---\n\n*A.*");
  });
});

describe("running the gates", () => {
  const passing = { name: "p", run: async () => ({ kind: "pass" as const, notes: ["Passed."] }) };

  it("stops at the first send back, so a draft goes back before anything checks it further", async () => {
    const later = vi.fn(async () => ({ kind: "pass" as const }));
    const outcome = await runResearchGates({ context: context(), draft, gates: [{ name: "a", run: async () => ({ kind: "send_back", message: "Again." }) }, { name: "b", run: later }], runId: "r" });
    expect(outcome).toEqual({ kind: "sent_back", message: "Again." });
    expect(later).not.toHaveBeenCalled();
  });

  it("collects the gates' notes", async () => {
    expect(await runResearchGates({ context: context(), draft, gates: [passing, passing], runId: "r" })).toEqual({ kind: "accepted", notes: ["Passed.", "Passed."] });
  });

  it("gives up on the rest with a note once no time is left", async () => {
    const run = vi.fn();
    expect(await runResearchGates({ context: context({ time: { remainingMs: () => 0, sendBackAllowed: () => false } }), draft, gates: [{ name: "a", run }], runId: "r" }))
      .toEqual({ kind: "accepted", notes: [researchNote("time_out", draft.report)] });
    expect(run).not.toHaveBeenCalled();
  });

  it("turns a send back no one can act on into its note, and runs the next gate", async () => {
    const outcome = await runResearchGates({ context: context({ time: { remainingMs: () => 1_000, sendBackAllowed: () => false } }), draft,
      gates: [{ name: "a", run: async () => ({ kind: "send_back", message: "Again.", unresolvedNote: "Left open." }) }, passing], runId: "r" });
    expect(outcome).toEqual({ kind: "accepted", notes: ["Left open.", "Passed."] });
  });

  it("gives a stopped run's abort back rather than swallowing it", async () => {
    const stop = new AbortController();
    stop.abort(new Error("stopped"));
    await expect(runResearchGates({ context: context({ signal: stop.signal }), draft, gates: [passing], runId: "r" })).rejects.toThrow();
    const during = new AbortController();
    const hung = { name: "a", run: () => { queueMicrotask(() => during.abort(new Error("stopped"))); return new Promise<never>(() => undefined); } };
    await expect(runResearchGates({ context: context({ signal: during.signal }), draft, gates: [hung], runId: "r" })).rejects.toThrow("stopped");
  });

  it("gives up on a gate past its own time and stops what it started", async () => {
    let aborted = false;
    const hung = { name: "a", run: (_draft: ResearchDraft, gateContext: ResearchGateContext) => new Promise<never>(() => {
      gateContext.signal.addEventListener("abort", () => { aborted = true; });
    }) };
    const outcome = await runResearchGates({ context: context({ time: { remainingMs: () => 5, sendBackAllowed: () => true } }), draft, gates: [hung], runId: "r" });
    expect(outcome).toEqual({ kind: "accepted", notes: [researchNote("time_out", draft.report)] });
    expect(aborted).toBe(true);
  });
});

describe("what was opened", () => {
  it("keeps the excerpt and says so when the saved whole cannot be read", async () => {
    const sources = createResearchSources({ chatId: "c", items: () => [
      { arguments: JSON.stringify({ url: "https://a.example" }), callId: "1", id: "i", kind: "tool_call", name: "fetch_url" },
      { callId: "1", handle: `tor1_${"a".repeat(32)}`, id: "r", kind: "tool_result", name: "fetch_url", outcome: "complete", output: "excerpt" }
    ], runId: "run", savedResults: { read: async () => { throw new Error("down"); } }, threads: { backgroundRunIds: async () => [], threadEffectItems: async () => [] }, userId: "u" });
    expect(await sources.opened(new AbortController().signal)).toEqual([{ partial: true, text: "excerpt", toolName: "fetch_url", url: "https://a.example" }]);
  });

  it("reads background researchers' runs too", async () => {
    const threadEffectItems = vi.fn(async () => []);
    const sources = createResearchSources({ chatId: "c", items: () => [], runId: "run", savedResults: { read: async () => null },
      threads: { backgroundRunIds: async () => ["bg-1"], threadEffectItems }, userId: "u" });
    await sources.opened(new AbortController().signal);
    expect(threadEffectItems).toHaveBeenCalledWith({ chatId: "c", runIds: ["run", "bg-1"], userId: "u" });
  });
});

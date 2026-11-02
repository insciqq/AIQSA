import { describe, expect, it, vi } from "vitest";
import { decodeResearchDraft, decodeResearchPlan, decodeResearchPlanProposal, RESEARCH_LIMITS, RESEARCH_ROUND_LIMITS, RESEARCH_SOURCE_CLASSES, type ResearchDraft, type ResearchFrame,
  type ResearchPlan } from "../../contracts/research";
import { RUN_FOLLOWUP_MAX_CHARS } from "../../contracts/runFollowups";
import { harnessPromptSection } from "../engine/prompts/harness";
import type { TranscriptItem } from "../engine/transcript";
import { proposeResearchPlanTool, researchScopingInstructions, startResearchTool, submitResearchDraftTool } from "../tools/research";
import { runResearchGates, type ResearchGateContext } from "./gates";
import { researchMatrixCoverage } from "./matrix";
import { researchCoverageLine, researcherBrief, researcherMatrixBrief, researcherMatrixFooter, researcherMethodFooter, researchMethodText, researchNoNewCellMessage, researchPlanUpdate } from "./method";
import { researchAnswerText, researchNote } from "./notes";
import { researchOffered } from "./run";
import { createResearchSources, researchRunsOnBranch } from "./sources";
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
    expect(decodeResearchDraft({ report: "r", unreachable: [] })).toMatchObject({ ok: true, value: { findings: [], recordIds: [] } });
    expect(decodeResearchDraft({ findings: [{ claim: "" }], report: "r", unreachable: [] })).toMatchObject({ message: expect.stringContaining("findings[0]"), ok: false });
    expect(decodeResearchDraft({ findings: [], report: "r", unreachable: [{ target: "t" }] })).toMatchObject({ message: expect.stringContaining("unreachable[0]"), ok: false });
  });

  it("writes its schemas so every provider takes them: no type list naming a container", () => {
    const schemas = JSON.stringify([startResearchTool.inputSchema, proposeResearchPlanTool.inputSchema, submitResearchDraftTool.inputSchema]);
    expect(schemas).not.toMatch(/"type":\[/u);
    expect(startResearchTool.capability).toBe("session");
    expect(proposeResearchPlanTool.capability).toBe("session");
  });

  it("requires every field of a draft, which takes record ids and never findings, and stays out of strict mode", () => {
    const schema = submitResearchDraftTool.inputSchema as { properties: Record<string, unknown>; required: readonly string[] };
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    expect(Object.keys(schema.properties).sort()).toEqual(["branch_picks", "does_not_separate", "pick_row_key", "record_ids", "report", "unreachable"]);
    expect(submitResearchDraftTool.strict).toBe(false);
    expect(schema.properties.does_not_separate).toMatchObject({ anyOf: [{ required: ["row_keys", "statement", "would_decide"], type: "object" }, { type: "null" }] });
    expect(schema.properties.pick_row_key).toMatchObject({ anyOf: [{ type: "string" }, { type: "null" }] });
  });

  it("decodes the arguments its own schema asks for", () => {
    const decoded = decodeResearchDraft({ branch_picks: [], does_not_separate: null, pick_row_key: null, record_ids: [], report: "r", unreachable: [] });
    expect(decoded).toMatchObject({ ok: true, value: { findings: [], recordIds: [] } });
  });

  it("requires every field of a proposal, which stays out of strict mode like its neighbours", () => {
    const schema = proposeResearchPlanTool.inputSchema as { properties: Record<string, unknown>; required: readonly string[] };
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    expect(proposeResearchPlanTool.strict).toBe(false);
    expect(startResearchTool.inputSchema).toMatchObject({ required: ["goal"] });
  });
});

describe("the method", () => {
  it("tells the main agent how to run what it planned", () => {
    const text = researchMethodText(plan);
    expect(text).toContain("call_subagent");
    expect(text).toContain("submit_research_draft");
    expect(text).toContain("the ids of the records it rests on");
    expect(text).toContain("comparison table");
    expect(text).not.toContain("every finding");
    expect(text).toContain("Which one? [primary_official, independent_tests, owner_reviews, action_channel]");
    expect(text).toContain("shop.example");
  });

  it("says a row is an option the user could choose, and a test, a source or a method is evidence", () => {
    // A real run's frame held rows for a lab's comparison and a testing method.
    for (const text of [researchMethodText(plan), researcherMethodFooter(plan)]) {
      expect(text).toContain("A row is an option the user could choose");
      expect(text).toContain("a test, a source or a method is evidence");
    }
    expect(researcherMatrixFooter({ coverage: { cells: [], empty: 0, filled: 0 }, frame: { branches: [], changes: [], criteria: [{ criterion: "Price", key: "price", why: "Budget." }], rows: [] } }, 3_000))
      .toContain("Add each option the user could choose");
  });

  it("gives rows a rule a second run would repeat, since five real runs of one question gave five different shortlists", () => {
    for (const text of [researchMethodText(plan), researcherMethodFooter(plan)]) {
      expect(text).toContain("Rows come from a rule you can state, never from what a search showed first");
      expect(text).toContain("first what independent tests and rankings name");
      expect(text).toContain("then the options within the question's limits with the most owners' reviews, taken in order from the top of the marketplace's own listing sorted by reviews with its filters set to those limits");
      expect(text).toContain("The report states that rule in one line, so a reader sees why these rows.");
    }
  });

  it("reaches the plan's first rows too, which are written before the method is read and never change", () => {
    const { rows } = proposeResearchPlanTool.inputSchema.properties as { rows: { description: string } };
    expect(rows.description).toContain("Chosen by a rule you can state, not by what a search showed first: leave it empty if you have not applied it yet, and researchers add them.");
  });

  it("words that rule so it reads sensibly with no marketplace", () => {
    expect(researchMethodText(plan)).toContain("where there is no marketplace, what authoritative sources list, in their order");
  });

  it("does not tell a researcher to add a row as it finds one, which is what the rule replaces", () => {
    const empty = researcherMatrixFooter({ coverage: { cells: [], empty: 0, filled: 0 }, frame: { branches: [], changes: [], criteria: [{ criterion: "Price", key: "price", why: "Budget." }], rows: [] } }, 3_000);
    expect(empty).not.toContain("as you find it");
  });

  it("asks every figure and named claim to link its page where it is stated, since a real report cited 30 records and carried two links", () => {
    expect(researchMethodText(plan)).toContain("Every figure, price, study and named claim in the report links the page it came from where it is stated, not in a list at the end only.");
  });

  it("asks for a default when evidence does not separate rows, marked as one, beside what would decide and without inventing a difference", () => {
    const text = researchMethodText(plan);
    expect(text).toContain("which of them it would take by default today and why, such as the cheapest among those with the same evidence");
    expect(text).toContain("marked plainly as a default and not as a finding");
    expect(text).toContain("what would decide");
    expect(text).toContain("instead of inventing a difference");
  });

  it("asks labels and reasons in the goal's language, for a reader, naming no tool", () => {
    // A real run's English label and a reason naming fetch_url reached a Russian answer.
    for (const text of [researchMethodText(plan), researcherMethodFooter(plan)]) {
      expect(text).toContain("in the language of the goal, for a reader, naming no tool and no error");
    }
    expect(researcherMethodFooter({ ...plan, goal: "Выбрать матрас на двоих." })).toContain("The goal: Выбрать матрас на двоих.");
    expect(researcherMethodFooter({ ...plan, goal: `Выбрать ${"матрас ".repeat(300)}` }).length).toBeLessThan(researcherMethodFooter(plan).length + 400);
  });

  it("ends every brief with the source classes, the finding's form, and one handoff before leaving an unreachable site", () => {
    const footer = researcherMethodFooter(plan);
    expect(footer).toContain("verbatim quote");
    expect(footer).toContain("CAPTCHA or asks to sign in and you have browser_handoff, call it once");
    // A Workspace-disabled installation has no such tool, and a custom researcher's groups can narrow it away.
    expect(footer).toContain("if you have no such tool or nobody comes, record it as unreachable with its reason and go on");
    expect(footer).not.toContain("never skip");
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

  it("never asks the model to question the user before research: a missing fact is a named assumption or a branch", () => {
    const section = harnessPromptSection({ tools: ["start_research"], workspace: false }).split("# Research")[1]!.split("\n# ")[0]!;
    expect(section).toContain("Never ask the user a clarifying question");
    expect(section).toContain("named assumption");
    expect(section).toContain("branch");
    expect(section).not.toMatch(/you may ask|ask for it once/iu);
    expect(section).toContain("propose_research_plan");
  });

  it("names a gate's thread for its attempt alone, with no piece of an internal id, within the sub-agent name rule", () => {
    expect(researchTurnName("Verifier!", 2)).toBe("verifier-2");
    expect(researchTurnName("!!!", 1)).toBe("check-1");
    expect(researchTurnName("v".repeat(80), 1).length).toBeLessThanOrEqual(48);
  });

  it("notes in English, as every word of the product's own is, and keeps the report as written", () => {
    expect(researchNote("time_out")).toMatch(/^Time ran out/u);
    expect(researchAnswerText("Report.", [])).toBe("Report.");
    expect(researchAnswerText("Report.\n", ["A.", "A.", " "])).toBe("Report.\n\n---\n\n*A.*");
  });
});

describe("scoping and the proposal", () => {
  const criterion = { criterion: "Who gets better", key: "who-gets-better", why: "It says whether this applies to the user." };
  const proposal = (criteria: unknown) => ({ assumptions: [], branches: [], criteria, questions: [question], rows: [], skipped_source_classes: [], steps: ["One", "Two", "Three", "Four"], understood: "The task." });

  it("holds criteria with reasons for a purchase and for a knowledge question alike, and refuses one without", () => {
    const purchase = decodeResearchPlanProposal(proposal([{ criterion: "Durability", key: "durability", why: "It is bought for years." }]));
    expect(purchase).toMatchObject({ ok: true, value: { criteria: [{ why: "It is bought for years." }] } });
    expect(decodeResearchPlanProposal({ ...proposal([criterion]), rows: [{ key: "trial-1", label: "The 2024 trial" }] })).toMatchObject({ ok: true, value: { criteria: [{ key: "who-gets-better" }] } });
    expect(decodeResearchPlanProposal(proposal([]))).toMatchObject({ message: expect.stringContaining("criteria"), ok: false });
    expect(decodeResearchPlanProposal(proposal([{ ...criterion, why: " " }]))).toMatchObject({ message: expect.stringContaining("why"), ok: false });
    expect(decodeResearchPlanProposal(proposal([{ criterion: "C", key: "c" }]))).toMatchObject({ message: expect.stringContaining("why"), ok: false });
  });

  it("tells the model where criteria come from, and carries the same in the tool it fills in", () => {
    const scoping = researchScopingInstructions();
    for (const phrase of ["guides or standards", "plain words", "why it matters", "outcomes or sub-questions", "branch"]) expect(scoping).toContain(phrase);
    const tool = JSON.stringify(proposeResearchPlanTool);
    for (const phrase of ["guides and standards", "plain words", "why it matters", "outcomes or sub-questions", "branches"]) expect(tool).toContain(phrase);
    expect(tool).toContain("70 kg");
  });

  it("opens the method for a plan that stands, and sends researchers for empty cells only", () => {
    const text = researchMethodText(plan);
    expect(text.startsWith("The plan stands.")).toBe(true);
    expect(text).not.toContain("Research started");
    expect(text).toContain("empty cells only");
    expect(text).toContain("change_research_frame");
  });
});

describe("the matrix in a brief", () => {
  const frame: ResearchFrame = { branches: [], changes: [], criteria: [{ criterion: "Durability", key: "durability", why: "W." }, { criterion: "Firmness", key: "firmness", why: "W." }],
    rows: [{ key: "x1", label: "Lonax X1" }, { key: "y2", label: "Dreamline\nY2" }] };
  const matrixOf = (from: ResearchFrame = frame) => ({ coverage: researchMatrixCoverage(from, []), frame: from });
  const large: ResearchFrame = { ...frame, criteria: Array.from({ length: 24 }, (_value, index) => ({ criterion: "A criterion in many words", key: `criterion-${index}`, why: "W." })),
    rows: Array.from({ length: 64 }, (_value, index) => ({ key: `row-${index}`, label: "A candidate with a long name" })) };

  it("names the keys with their words and the cells still empty, on one line each", () => {
    const footer = researcherMatrixFooter(matrixOf(), 10_000)!;
    expect(footer).toBe(["# The matrix (from the server)", "Rows: x1 (Lonax X1), y2 (Dreamline Y2).", "Criteria: durability (Durability), firmness (Firmness).",
      "4 of 4 cells are still empty. x1: durability, firmness; y2: durability, firmness"].join("\n"));
  });

  it("falls back to counts per row for a long matrix, then to keys alone, and to nothing when no room is left", () => {
    const footer = researcherMatrixFooter(matrixOf(large), 10_000);
    expect(footer).toContain("row-0: 24 of 24");
    expect(footer).toContain("criterion-23");
    expect(footer!.length).toBeLessThanOrEqual(3_000);
    expect(researcherMatrixFooter(matrixOf(), 120)).toBe("# The matrix (from the server)\nRows: x1, y2.\nCriteria: durability, firmness.\n4 of 4 cells are still empty.");
    expect(researcherMatrixFooter(matrixOf(), 80)).toBe("# The matrix (from the server)\n4 of 4 cells are still empty.");
    expect(researcherMatrixFooter(matrixOf(), 10)).toBeNull();
  });

  it("says what to do with no rows yet, and that nothing is empty when nothing is", () => {
    const rowless = { ...frame, rows: [] };
    expect(researcherMatrixFooter(matrixOf(rowless), 10_000)).toContain("Rows: none yet.");
    expect(researcherMatrixFooter(matrixOf(rowless), 10_000)).toContain("2 of 2 cells are still empty. durability, firmness");
  });

  it("stays within the bound on a brief, and a brief with no room for the matrix still goes", () => {
    const brief = researcherBrief("x".repeat(RUN_FOLLOWUP_MAX_CHARS - researcherMethodFooter(plan).length - 3), plan, matrixOf(large))!;
    expect(brief).not.toContain("# The matrix");
    expect(brief.length).toBeLessThanOrEqual(RUN_FOLLOWUP_MAX_CHARS);
    expect(researcherBrief("x".repeat(RUN_FOLLOWUP_MAX_CHARS), plan, matrixOf())).toBeNull();
    const roomy = researcherBrief("Cover it.", plan, matrixOf())!;
    expect(roomy).toContain("# Research method");
    expect(roomy.endsWith("x1: durability, firmness; y2: durability, firmness")).toBe(true);
    expect(researcherMatrixBrief("Go on.", null)).toBe("Go on.");
    expect(researcherMatrixBrief("x".repeat(RUN_FOLLOWUP_MAX_CHARS), matrixOf()).length).toBe(RUN_FOLLOWUP_MAX_CHARS);
  });

  it("keeps the line the main agent reads short, whatever the matrix", () => {
    expect(researchCoverageLine(matrixOf(), 1)).toBe("The matrix (from the server): 4 of 4 cells empty, 1 newly filled in this round so far. Empty: x1: durability, firmness; y2: durability, firmness. Send researchers for empty cells only.");
    expect(researchCoverageLine(matrixOf(), null)).toContain("4 of 4 cells empty. Empty:");
    const long = researchCoverageLine(matrixOf(large), 0);
    expect(long.length).toBeLessThanOrEqual(600);
    expect(long).toContain("Send researchers for empty cells only.");
  });

  it("says why no further researcher starts", () => {
    expect(researchNoNewCellMessage()).toContain("submit_research_draft");
    expect(researchNoNewCellMessage()).toContain(`${RESEARCH_ROUND_LIMITS.noNewCellRounds} rounds`);
  });
});

describe("running the gates", () => {
  const passing = { name: "p", run: async () => ({ kind: "pass" as const, notes: ["Passed."] }) };

  it("holds each gate to its send backs, counting only its own, and turns the next one into its note", async () => {
    const asked = { draft, gate: "a", message: "Again." };
    const gate = { name: "a", run: async () => ({ kind: "send_back" as const, message: "Again.", unresolvedNote: "Left open." }) };
    expect(await runResearchGates({ context: context({ earlier: [asked] }), draft, gates: [gate], runId: "r" })).toMatchObject({ gate: "a", kind: "sent_back" });
    const capped = new Array<typeof asked>(RESEARCH_ROUND_LIMITS.sendBacksPerCheck).fill(asked);
    expect(await runResearchGates({ context: context({ earlier: capped }), draft, gates: [gate, passing], runId: "r" })).toEqual({ kind: "accepted", notes: ["Left open.", "Passed."] });
    const others = capped.map((attempt) => ({ ...attempt, gate: "b" }));
    expect(await runResearchGates({ context: context({ earlier: others }), draft, gates: [gate], runId: "r" })).toMatchObject({ gate: "a", kind: "sent_back" });
    const older = capped.map(({ draft: stored, message }) => ({ draft: stored, message }));
    expect(await runResearchGates({ context: context({ earlier: older }), draft, gates: [gate], runId: "r" })).toMatchObject({ gate: "a", kind: "sent_back" });
  });

  it("says plainly that a gate with no note of its own left something open, never that time ran out", async () => {
    const asked = { draft, gate: "a", message: "Again." };
    const gate = { name: "a", run: async () => ({ kind: "send_back" as const, message: "Again." }) };
    const earlier = new Array<typeof asked>(RESEARCH_ROUND_LIMITS.sendBacksPerCheck).fill(asked);
    expect(await runResearchGates({ context: context({ earlier }), draft, gates: [gate], runId: "r" })).toEqual({ kind: "accepted", notes: [researchNote("unresolved")] });
  });

  it("stops at the first send back, so a draft goes back before anything checks it further", async () => {
    const later = vi.fn(async () => ({ kind: "pass" as const }));
    const outcome = await runResearchGates({ context: context(), draft, gates: [{ name: "a", run: async () => ({ kind: "send_back", message: "Again." }) }, { name: "b", run: later }], runId: "r" });
    expect(outcome).toEqual({ gate: "a", kind: "sent_back", message: "Again." });
    expect(later).not.toHaveBeenCalled();
  });

  it("collects the gates' notes", async () => {
    expect(await runResearchGates({ context: context(), draft, gates: [passing, passing], runId: "r" })).toEqual({ kind: "accepted", notes: ["Passed.", "Passed."] });
  });

  it("gives up on the rest with a note once no time is left", async () => {
    const run = vi.fn();
    expect(await runResearchGates({ context: context({ time: { remainingMs: () => 0, sendBackAllowed: () => false } }), draft, gates: [{ name: "a", run }], runId: "r" }))
      .toEqual({ kind: "accepted", notes: [researchNote("time_out")] });
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
    expect(outcome).toEqual({ kind: "accepted", notes: [researchNote("time_out")] });
    expect(aborted).toBe(true);
  });
});

describe("what was opened", () => {
  it("keeps the excerpt and says so when the saved whole cannot be read", async () => {
    const sources = createResearchSources({ chatId: "c", items: () => [
      { arguments: JSON.stringify({ url: "https://a.example" }), callId: "1", id: "i", kind: "tool_call", name: "fetch_url" },
      { callId: "1", handle: `tor1_${"a".repeat(32)}`, id: "r", kind: "tool_result", name: "fetch_url", outcome: "complete", output: "excerpt" }
    ], run: { branchRunIds: [], researchRunId: "run", runId: "run" }, savedResults: { read: async () => { throw new Error("down"); } },
    threads: { backgroundRunIds: async () => [], threadEffectItems: async () => [] }, userId: "u" });
    expect(await sources.opened(new AbortController().signal)).toEqual([{ partial: true, text: "excerpt", toolName: "fetch_url", url: "https://a.example" }]);
  });

  describe("by whose reading", () => {
    const signal = new AbortController().signal;
    const fetched = (url: string): TranscriptItem[] => [{ arguments: JSON.stringify({ url }), callId: url, id: `${url}-call`, kind: "tool_call", name: "fetch_url" },
      { callId: url, id: `${url}-result`, kind: "tool_result", name: "fetch_url", outcome: "complete", output: "Page text." }];
    const sourcesOf = (threads: readonly Readonly<{ items: TranscriptItem[]; name?: string; threadId: string }>[]) => createResearchSources({ chatId: "c",
      items: () => fetched("https://main.example"), run: { branchRunIds: [], researchRunId: "run", runId: "run" }, savedResults: { read: async () => null },
      threads: { backgroundRunIds: async () => [], threadEffectItems: async () => [...threads] }, userId: "u" });
    const urls = (sources: readonly Readonly<{ url: string | null }>[]) => sources.map(({ url }) => url);
    const GATES = [researchTurnName("gap-judge", 1), researchTurnName("verifier", 1), researchTurnName("verifier-2", 3), researchTurnName("verifier-10", 12), researchTurnName("skeptic", 2)];

    it("gives every agent's by default, which a skeptic's own quote check needs", async () => {
      const sources = sourcesOf([{ items: fetched("https://lab.example"), name: "lab", threadId: "t1" }, { items: fetched("https://refuted.example"), name: "skeptic-1", threadId: "t2" }]);
      expect(urls(await sources.opened(signal))).toEqual(["https://main.example", "https://lab.example", "https://refuted.example"]);
    });

    it.each(GATES)("leaves out what the gate turn %s read, for what counts researchers' reading", async (name) => {
      const sources = sourcesOf([{ items: fetched("https://lab.example"), name: "lab", threadId: "t1" }, { items: fetched("https://gate.example"), name, threadId: "t2" }]);
      expect(urls(await sources.opened(signal, "researchers"))).toEqual(["https://main.example", "https://lab.example"]);
    });

    it("keeps a researcher whose name merely starts like a gate's, and one a test's store gives no name", async () => {
      const sources = sourcesOf([{ items: fetched("https://a.example"), name: "verifier-of-prices", threadId: "t1" }, { items: fetched("https://b.example"), name: "skeptics", threadId: "t2" },
        { items: fetched("https://c.example"), threadId: "t3" }]);
      expect(urls(await sources.opened(signal, "researchers"))).toEqual(["https://main.example", "https://a.example", "https://b.example", "https://c.example"]);
    });
  });

  it("reads background researchers' runs too", async () => {
    const threadEffectItems = vi.fn(async () => []);
    const sources = createResearchSources({ chatId: "c", items: () => [], run: { branchRunIds: [], researchRunId: "run", runId: "run" }, savedResults: { read: async () => null },
      threads: { backgroundRunIds: async () => ["bg-1"], threadEffectItems }, userId: "u" });
    await sources.opened(new AbortController().signal);
    expect(threadEffectItems).toHaveBeenCalledWith({ chatId: "c", runIds: ["run", "bg-1"], userId: "u" });
  });

  it("reads every run of a research across its approvals, in order, and only those", () => {
    const place = { branchRunIds: ["answer", "started", "approved"], researchRunId: "started", runId: "continued" };
    expect(researchRunsOnBranch(place)).toEqual(["started", "approved", "continued"]);
    expect(researchRunsOnBranch({ ...place, researchRunId: "continued" })).toEqual(["continued"]);
    expect(researchRunsOnBranch({ ...place, researchRunId: "another-branch" })).toEqual(["continued"]);
    expect(researchRunsOnBranch({ branchRunIds: [], researchRunId: "run", runId: "run" })).toEqual(["run"]);
  });
});

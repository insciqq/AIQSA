import { describe, expect, it } from "vitest";
import { contextTokenEstimator } from "../../lib/domain/tokenEstimate";
import { normalizeTokenUsage } from "../../lib/domain/usage";
import { findCompactionCut } from "../../lib/server/engine/compaction";
import { APPROVAL_PENDING_TEXT } from "../../lib/server/engine/compaction/items";
import { TOOL_RESULT_LIMITS } from "../../lib/server/engine/toolResults";
import { SUMMARIZER_INSTRUCTIONS, SUMMARY_SECTIONS } from "../../lib/server/engine/compaction/summaryPrompt";
import { contextItemTokens } from "../../lib/server/engine/contextMeasure";
import { selectTranscript, type TranscriptItem, type TranscriptTarget } from "../../lib/server/engine/transcript";
import { buildCompatibleResponsesRequest } from "../../lib/server/providers/compatibleResponses";
import { responsesHistoryFromOutput } from "../../lib/server/providers/history";
import type { ProviderRunRequest, ProviderRunResult } from "../../lib/server/providers/types";
import {
  calledTools,
  dryRunModel,
  normalizeAnswer,
  parseEvalArguments,
  READ_TOOL_RESULT,
  recallQuestion,
  runCompactionEvaluation,
  scoreContinuation,
  scoreRecall,
  type EvalModel,
  type EvalOptions
} from "./compaction-quality";
import { evalHandle, SCENARIO_IDS, SCENARIOS, type BuiltScenario, type HandlePolicy, type ScenarioId } from "./compaction-quality-scenarios";

const target: TranscriptTarget = { model: "gpt-6.1-sol", nativeCompaction: true, provider: "codex-lb" };
const estimate = contextTokenEstimator({ modelId: "gpt-6.1-sol", provider: "openai_compatible" });
const weigh = (item: TranscriptItem) => contextItemTokens(item, target, estimate, "opaque");
const SIZE = 24_000;

function built(id: ScenarioId, seed = 1, size = SIZE, handles: HandlePolicy = "large"): BuiltScenario {
  return SCENARIOS[id].build({ handles, seed, targetTokens: size, weigh });
}

/** Everything the agent could ever see or read: transcript text and stored results. */
function corpus(build: BuiltScenario): string {
  return [...build.items.map((item) => JSON.stringify(item)), ...build.store.values()].join("\n");
}

function options(overrides: Partial<EvalOptions> = {}): EvalOptions {
  const parsed = parseEvalArguments(["--tokens", String(SIZE), "--concurrency", "3"], {});
  if ("help" in parsed) throw new Error("unexpected help");
  return { ...parsed, ...overrides };
}

describe("evaluation sessions", () => {
  it("are deterministic, every probe value is in the session, and corrections come after what they supersede", () => {
    for (const id of SCENARIO_IDS) {
      const build = built(id);
      expect(JSON.stringify(built(id).items), id).toBe(JSON.stringify(build.items));
      expect(JSON.stringify(built(id, 2).items), id).not.toBe(JSON.stringify(build.items));
      const text = corpus(build);
      for (const probe of SCENARIOS[id].probes) {
        for (const field of probe.fields) {
          if (field.expected === "no" || field.key === "remainingSection") continue;
          expect([field.expected, ...(field.accept ?? [])].some((value) => text.includes(value)), `${id}.${field.key}`).toBe(true);
          for (const old of field.superseded ?? []) {
            expect(text.indexOf(old), `${id}.${field.key} superseded`).toBeGreaterThanOrEqual(0);
            expect(text.indexOf(old), `${id}.${field.key} order`).toBeLessThan(text.lastIndexOf(field.expected));
          }
        }
      }
    }
  });

  it("plant every probe before the recent tail at a realistic size, in order", () => {
    for (const id of SCENARIO_IDS) {
      const positions = built(id, 1, 80_000).planted.map((entry) => entry.position);
      expect(positions.length, id).toBeGreaterThanOrEqual(5);
      expect(Math.max(...positions), id).toBeLessThan(0.88);
      expect([...positions].sort((left, right) => left - right), id).toEqual(positions);
    }
  });

  it("store results as the engine does: those over its save bound with a handle, long ones as head and tail, or every one", () => {
    let excerpts = 0;
    let savedWhole = 0;
    for (const id of SCENARIO_IDS) {
      for (const policy of ["large", "all"] as const) {
        const build = built(id, 1, 60_000, policy);
        for (const result of build.items) {
          if (result.kind !== "tool_result") continue;
          const handle = build.handles.get(result.callId);
          expect(result.handle, id).toBe(handle);
          if (!handle) {
            expect(policy).toBe("large");
            expect(result.output.length, id).toBeLessThanOrEqual(TOOL_RESULT_LIMITS.saveChars);
            continue;
          }
          expect(handle).toBe(evalHandle(id, result.callId));
          const full = build.store.get(handle)!;
          if (policy === "large") expect(full.length, id).toBeGreaterThan(TOOL_RESULT_LIMITS.saveChars);
          if (full.length > TOOL_RESULT_LIMITS.inlineChars) {
            excerpts += 1;
            expect(result.output).toContain(`call read_tool_result with handle "${handle}"`);
            expect(result.output.length).toBeLessThan(full.length);
          } else {
            if (policy === "large") savedWhole += 1;
            expect(result.output).toBe(full);
          }
        }
      }
    }
    expect(excerpts).toBeGreaterThan(0);
    expect(savedWhole).toBeGreaterThan(0);
  });

  it("end with a call waiting for approval that every cut keeps verbatim, and give sequential three phases", () => {
    for (const id of SCENARIO_IDS) {
      const build = built(id);
      const last = build.items[build.items.length - 1]!;
      expect(last, id).toMatchObject({ kind: "tool_result", outcome: "error", output: APPROVAL_PENDING_TEXT });
      const cut = findCompactionCut({ estimate, items: build.items, recentTokens: 1, target })!;
      const window = selectTranscript(build.items, target).window;
      expect(window.findIndex((item) => item.id === cut.keepFromId), id).toBeLessThanOrEqual(window.length - 2);
    }
    const phases = built("sequential", 1, 60_000).phaseEnds;
    expect(phases).toHaveLength(3);
    expect([...phases].sort((left, right) => left - right)).toEqual(phases);
  });
});

describe("scoring", () => {
  const probes = SCENARIOS.analysis.probes;
  const perfect = Object.fromEntries(probes.flatMap((probe) => probe.fields.map((field) => [field.key, field.expected])));

  it("normalizes formatting but not values", () => {
    expect(normalizeAnswer(" «48 213.75». ")).toBe("48213.75");
    expect(normalizeAnswer("18,240.50")).toBe("18240.50");
    expect(normalizeAnswer("0 9 * * 1")).toBe("0 9 * * 1");
    expect(normalizeAnswer(false)).toBe("no");
    expect(normalizeAnswer(37.4)).toBe("37.4");
    expect(normalizeAnswer(null)).toBeNull();
  });

  it("scores exact recall per probe and category, and names superseded answers", () => {
    const all = scoreRecall(JSON.stringify(perfect), probes);
    expect(all.parsed).toBe(true);
    expect(Object.values(all.probes).every(Boolean)).toBe(true);
    expect(all.categories).toEqual({ constraint: { hit: 1, total: 1 }, correction: { hit: 1, total: 1 }, fact: { hit: 5, total: 5 },
      pending: { hit: 1, total: 1 } });
    const stale = scoreRecall(`Here: ${JSON.stringify({ ...perfect, archiveBucket: "aiqsa-archive-blue", fxGapPercent: "0.83 %" })}`, probes);
    expect(stale.probes.correction).toBe(false);
    expect(stale.superseded).toEqual(["archiveBucket"]);
    expect(stale.fields.fxGapPercent).toBe(true);
    expect(scoreRecall("I do not know.", probes)).toMatchObject({ parsed: false, probes: { constraint: false } });
    const question = recallQuestion(probes);
    expect(question).toContain("\"w17NetMargin\": the exact net_margin of warehouse W-17");
    expect(question).not.toContain("48213.75");
  });

  it("scores the continuation's next step, forbidden values, repeated work and a re-issued pending call", () => {
    const continuation = SCENARIOS.analysis.continuation;
    const pending = { arguments: "{\"entry\":\"JE-2026-0412\"}", name: "mcp_finance_post_journal_entry_0123456789" };
    const good = scoreContinuation(continuation, [{ arguments: JSON.stringify({ bucket: "aiqsa-archive-teal-07", month: "2026-03",
      report_timezone: "Asia/Yekaterinburg" }), name: "archive_batches" }], "Done at 18:20 +05:00.", pending);
    expect(good).toEqual({ next: { archiveWithCorrectBucket: true }, nextStep: true, repeated: [], repeatedPending: false, toolCalls: 1,
      violations: [] });
    // Spaced arguments as models send them match the same patterns.
    const bad = scoreContinuation(continuation, [
      { arguments: "{\"bucket\": \"aiqsa-archive-blue\", \"month\": \"2026-03\", \"report_timezone\": \"UTC\"}", name: "archive_batches" },
      { arguments: "{ \"month\": \"2026-03\", \"stage\": \"export\" }", name: "run_pipeline" },
      { arguments: "{ \"entry\": \"JE-2026-0412\" }", name: pending.name }
    ], "", pending);
    expect(bad).toEqual({ next: { archiveWithCorrectBucket: false }, nextStep: false, repeated: ["rerunMarchStage"], repeatedPending: true,
      toolCalls: 3, violations: ["supersededBucket", "reportTimezone"] });
  });

  it("counts the next step named in the answer or a call's name, in any date form, and Cyrillic sent escaped", () => {
    const sequential = scoreContinuation(SCENARIOS.sequential.continuation, [], "Next: send the dunning letters for the 12 overdue " +
      "invoices; I need their numbers first.", null);
    expect(sequential.next).toEqual({ dunningLetters: true });
    expect(scoreContinuation(SCENARIOS.sequential.continuation, [{ arguments: "{}", name: "send_dunning_letters" }], "", null).nextStep)
      .toBe(true);
    expect(scoreContinuation(SCENARIOS.sequential.continuation, [], "Waiting for your approval.", null).nextStep).toBe(false);
    const escaped = "{\"to\":\"\\u043a\\u0435\\u0439\\u0442\\u0435\\u0440\\u0438\\u043d\\u0433 \\u00ab\\u0421\\u0435\\u0437\\u043e\\u043d\\u044b\\u00bb\"," +
      "\"subject\":\"\\u041a\\u043e\\u043d\\u0444\\u0435\\u0440\\u0435\\u043d\\u0446\\u0438\\u044f\",\"body\":\"28.03.2026, 145 \\u0433\\u043e\\u0441\\u0442\\u0435\\u0439\"}";
    expect(scoreContinuation(SCENARIOS.requirements.continuation, [{ arguments: escaped, name: "draft_email" }], "", null))
      .toMatchObject({ next: { currentDate: true, draftToCaterer: true }, nextStep: true, violations: [] });
    expect(scoreContinuation(SCENARIOS.research.continuation, [], "## 4. Recommendations for procurement leads\n…", null).nextStep).toBe(true);
    expect(calledTools(SCENARIOS.research, [{ arguments: "{}", name: "write_file" }, { arguments: "{}", name: "made_up_tool" }]))
      .toEqual(["write_file", "other"]);
  });
});

describe("evaluation runs", () => {
  it("parses flags with Codex LB defaults and refuses a native path where no route compacts natively", () => {
    const parsed = parseEvalArguments([], {});
    expect(parsed).toMatchObject({ dryRun: false, mode: "background", model: "gpt-6.1-sol", paths: ["native", "summary"], provider: "codex-lb",
      root: "https://codex-lb.psaux.info", scenarios: [...SCENARIO_IDS], summaryMaxOutputTokens: null, tokens: 160_000, window: null });
    expect(parseEvalArguments(["--window", "272000", "--paths", "summary", "--provider", "gemini"], {}))
      .toMatchObject({ paths: ["summary"], provider: "gemini", window: 272_000 });
    expect(() => parseEvalArguments(["--provider", "gemini"], {})).toThrow("eval_argument_invalid:--paths");
    expect(() => parseEvalArguments(["--root", "https://lb.example/v1"], {})).toThrow("eval_argument_invalid:--root");
    expect(() => parseEvalArguments(["--unknown", "1"], {})).toThrow("eval_argument_invalid:--unknown");
    expect(parseEvalArguments(["--help"], {})).toEqual({ help: true });
  });

  it("dry-runs every scenario and path without a network and prints nothing from the sessions", async () => {
    const lines: Record<string, unknown>[] = [];
    let clock = 0;
    const summary = await runCompactionEvaluation(options({ dryRun: true }), {
      emit: (line) => lines.push({ ...line }), model: () => dryRunModel(), now: () => (clock += 5)
    });
    const events = (name: string) => lines.filter((line) => line.event === name);
    expect(events("error")).toEqual([]);
    expect(events("transcript")).toHaveLength(11);
    expect(events("compaction").filter((line) => line.scenario === "sequential")).toHaveLength(6);
    expect(events("compaction").filter((line) => line.scenario === "switch").map((line) => [line.kind, line.model]))
      .toEqual([["native", "gpt-6.1-sol"], ["summary", "gpt-6-astra"]]);
    expect(events("compaction").every((line) => line.outcome === "compacted")).toBe(true);
    expect(events("recall")).toHaveLength(13);
    expect(events("continuation")).toHaveLength(11);
    expect(summary).toMatchObject({ event: "summary" });
    const printed = JSON.stringify(lines);
    for (const id of SCENARIO_IDS) {
      for (const probe of SCENARIOS[id].probes) {
        for (const field of probe.fields) if (field.expected.length > 3) expect(printed, field.key).not.toContain(field.expected);
      }
    }
  });

  it("drives a model through recall reads and continuation tools to a perfect score", async () => {
    const requests: ProviderRunRequest[] = [];
    const nativeRequests: ProviderRunRequest[] = [];
    const answer = (request: ProviderRunRequest): ProviderRunResult => {
      if (request.compactionTrigger) {
        nativeRequests.push(request);
        return { finalProviderResponsePreview: {}, finalText: "",
          history: responsesHistoryFromOutput([{ encrypted_content: "ENC", id: "cmp_1", type: "compaction" }]),
          usage: normalizeTokenUsage({ inputTokens: 20_000, outputTokens: 900 }) };
      }
      requests.push(request);
      const usage = normalizeTokenUsage({ inputTokens: 1_000, outputTokens: 50 });
      const reply = (text: string): ProviderRunResult => ({ finalProviderResponsePreview: {}, finalText: text, history: [{ text, type: "assistant_text" }], usage });
      if (request.prompt.system === SUMMARIZER_INSTRUCTIONS) return reply(SUMMARY_SECTIONS.map((section) => `## ${section}\n- x`).join("\n"));
      const history = request.history ?? [];
      const last = history[history.length - 1]!;
      const asked = [...history].reverse().find((item) => item.type === "user");
      if (asked?.type === "user" && asked.text.startsWith("Pause the work")) {
        if (last.type === "user") {
          return { ...reply(""), finalText: "", history: [{ arguments: JSON.stringify({ handle: evalHandle("analysis", "call_analysis_1") }),
            callId: "read_1", name: READ_TOOL_RESULT.name, type: "tool_call" }] };
        }
        return reply(JSON.stringify(Object.fromEntries(SCENARIOS.analysis.probes.flatMap((probe) =>
          probe.fields.map((field) => [field.key, field.expected])))));
      }
      if (last.type === "user") {
        return { ...reply(""), finalText: "", history: [{ arguments: JSON.stringify({ bucket: "aiqsa-archive-teal-07", month: "2026-03",
          report_timezone: "Asia/Yekaterinburg" }), callId: "work_1", name: "archive_batches", type: "tool_call" }] };
      }
      return reply("Archived; finished at 18:20 Asia/Yekaterinburg.");
    };
    const model: EvalModel = { nativeCompaction: true, run: async (request) => answer(request) };
    const lines: Record<string, unknown>[] = [];
    const summary = await runCompactionEvaluation(options({ handles: "all", paths: ["native"], scenarios: ["analysis"] }), {
      emit: (line) => lines.push({ ...line }), model: () => model, now: () => 0
    });
    // The native call is the session's own request with the trigger last, as the engine sends it.
    expect(nativeRequests).toHaveLength(1);
    const body = buildCompatibleResponsesRequest(nativeRequests[0]!);
    const input = body.input as Record<string, unknown>[];
    expect(input[input.length - 1]).toEqual({ type: "compaction_trigger" });
    expect(body).toMatchObject({ instructions: SCENARIOS.analysis.instructions, store: false, stream: true, tool_choice: "none" });
    const recall = lines.find((line) => line.event === "recall")!;
    expect(recall).toMatchObject({ parsed: true, reads: 1, rounds: 2 });
    expect(lines.find((line) => line.event === "continuation")).toMatchObject({ nextStep: true, repeated: [], violations: [] });
    expect(summary).toEqual({ event: "summary", paths: { native: expect.objectContaining({ continuations: "1/1", factsMeetTarget: true,
      strictTargetsMet: true }) } });
    // The compacted request replays the opaque item, then the retained record, then the kept tail.
    const replay = requests.find((request) => request.prompt.system !== SUMMARIZER_INSTRUCTIONS)!.history!;
    expect(replay[0]).toMatchObject({ type: "compaction" });
    expect(replay[1]).toMatchObject({ type: "user" });
    const retained = replay[1];
    expect(retained?.type === "user" ? retained.text : "").toContain("## Recorded state");
  });
});

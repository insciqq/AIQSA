import { afterEach, describe, expect, it, vi } from "vitest";
import { RESEARCH_TIME_MS } from "../../contracts/research";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import type { TranscriptItem, TranscriptToolResultItem } from "../engine/transcript";
import { ARTIFACT_TOOL_NAME } from "../tools/artifact";
import type { ModelToolCall } from "../tools/types";
import { researchPageArtifact, writeResearchPage, type ResearchPageCallResult, type ResearchPageResponse, type ResearchPageStepInput } from "./page";
import { RESEARCH_PAGE_GUIDE, researchPageInstruction } from "./pageGuide";
import { NOOP_RESEARCH_PORTS, type ResearchPageVerdict } from "./ports";

/** The page step on its own ports: what it does with a scripted model, tool path and check, and how each failure leaves no page. */
const REPORT = "Возьмите X1 за 300 ₽.\n\n# Отчёт\n\n| Модель | Цена |\n| X1 | 300 ₽ |\n\nИсточник: https://shop.example/x1";
const START = 1_000_000;

const pageCall = (id = "call-page", intent = "create"): ModelToolCall => ({ arguments: { intent, kind: "html" }, id, name: ARTIFACT_TOOL_NAME });
const card = (version: string): ModelRunSseEvent => ({ data: { artifactType: "generated_artifact", payload: { artifact_id: "artifact-1", byte_size: 10, entrypoint: "index.html",
  kind: "html", title: "Матрасы", version_id: version, version_number: 1 } }, type: "artifact" });
const result = (call: ModelToolCall, outcome: TranscriptToolResultItem["outcome"] = "complete"): TranscriptToolResultItem => ({ callId: call.id, id: `result-${call.id}`,
  kind: "tool_result", name: call.name, outcome, output: outcome === "complete" ? "{\"artifact_id\":\"artifact-1\"}" : "{\"error\":\"artifact_markup_invalid\"}" });
const reply = (calls: readonly ModelToolCall[]): ResearchPageResponse => ({ calls, items: calls.map((call): TranscriptItem => ({ arguments: JSON.stringify(call.arguments),
  callId: call.id, id: `item-${call.id}`, kind: "tool_call", name: call.name })) });

function step(overrides: Partial<ResearchPageStepInput> & Readonly<{ calls?: readonly (readonly ModelToolCall[])[]; made?: readonly ResearchPageCallResult[];
  verdicts?: readonly ResearchPageVerdict[] }> = {}) {
  const { calls = [[pageCall()]], made, verdicts = [{ kind: "pass" }], ...rest } = overrides;
  const seen: (readonly TranscriptItem[])[] = [];
  let responses = 0;
  const respond = vi.fn(async (items: readonly TranscriptItem[]) => {
    seen.push([...items]);
    return reply(calls[Math.min(responses++, calls.length - 1)]!);
  });
  let runs = 0;
  const runCall = vi.fn(async (call: ModelToolCall) => {
    runs += 1;
    return made?.[Math.min(runs - 1, made.length - 1)] ?? { cards: [card(`version-${runs}`)], result: result(call) };
  });
  let checks = 0;
  const check = vi.fn(async () => verdicts[Math.min(checks++, verdicts.length - 1)]!);
  const input: ResearchPageStepInput = { check, goal: "Выбрать матрас.", latestEnd: START + RESEARCH_TIME_MS.page, now: () => START, report: REPORT, respond, runCall,
    runId: "run-1", signal: new AbortController().signal, ...rest };
  return { check, input, respond, runCall, seen };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("the page guide", () => {
  it("covers what the operator asked of a page", () => {
    for (const rule of ["answers the reader's question", "comparison table", "order of recommendation", "timeline", "inline SVG",
      "<script type=\"application/json\">", "No pictures", "exactly as it writes them", "Do not round, convert or recompute", "\"not checked\"", "report's language",
      "prefers-color-scheme", "@media print", "viewport meta", "no other tool and no message"]) expect(RESEARCH_PAGE_GUIDE).toContain(rule);
  });

  it("hands the model the guide, what was researched and the report whole, as the page's only source", () => {
    const text = researchPageInstruction({ goal: " Выбрать матрас. ", report: REPORT });
    expect(text.startsWith(RESEARCH_PAGE_GUIDE)).toBe(true);
    expect(text).toContain("## What was researched\nВыбрать матрас.");
    expect(text).toContain(`<report>\n${REPORT}\n</report>`);
  });
});

describe("the page step", () => {
  it("writes the page with one create_artifact call, checks it against the report and gives its card", async () => {
    const { check, input, respond, runCall, seen } = step();
    const page = await writeResearchPage(input);
    expect(page).toEqual({ artifact: { artifactId: "artifact-1", entrypoint: "index.html", title: "Матрасы", versionId: "version-1" }, card: card("version-1") });
    expect(respond).toHaveBeenCalledOnce();
    expect(seen[0]).toEqual([expect.objectContaining({ kind: "user", text: researchPageInstruction({ goal: "Выбрать матрас.", report: REPORT }) })]);
    expect(runCall).toHaveBeenCalledWith(pageCall(), 1, expect.any(AbortSignal));
    // The seam `research-page-check` fills: called with the version the call made and the report the page was written from.
    expect(check).toHaveBeenCalledExactlyOnceWith({ page: page!.artifact, report: REPORT, signal: expect.any(AbortSignal) });
  });

  it("passes every page by default, so the step works before any check is wired", async () => {
    const { input } = step();
    expect(await writeResearchPage({ ...input, check: NOOP_RESEARCH_PORTS.page.check })).not.toBeNull();
  });

  it("runs only the page call of a response, and none at all without one", async () => {
    const other = { arguments: { query: "x" }, id: "call-search", name: "web_search" };
    const both = step({ calls: [[other, pageCall()]] });
    expect(await writeResearchPage(both.input)).not.toBeNull();
    expect(both.runCall).toHaveBeenCalledExactlyOnceWith(pageCall(), 1, expect.any(AbortSignal));
    const none = step({ calls: [[other]] });
    expect(await writeResearchPage(none.input)).toBeNull();
    expect(none.runCall).not.toHaveBeenCalled();
    expect(none.check).not.toHaveBeenCalled();
  });

  it("gives no page for a failed call, or one that made no version", async () => {
    const failed = step({ made: [{ cards: [], result: result(pageCall(), "error") }] });
    expect(await writeResearchPage(failed.input)).toBeNull();
    expect(failed.check).not.toHaveBeenCalled();
    expect(failed.respond).toHaveBeenCalledOnce();
    const cardless = step({ made: [{ cards: [], result: result(pageCall()) }] });
    expect(await writeResearchPage(cardless.input)).toBeNull();
  });

  it("sends a page that does not match back once, naming the version to correct, and gives the corrected one", async () => {
    const { check, input, respond, seen } = step({ calls: [[pageCall()], [pageCall("call-fix", "update")]], verdicts: [{ kind: "mismatch", message: "The X1's price is 300 ₽ in the report." }, { kind: "pass" }] });
    const page = await writeResearchPage(input);
    expect(page?.artifact.versionId).toBe("version-2");
    expect(respond).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenCalledTimes(2);
    const again = seen[1]!;
    expect(again.map((item) => item.kind)).toEqual(["user", "tool_call", "tool_result", "user"]);
    expect(again[2]).toMatchObject({ callId: "call-page", outcome: "complete" });
    const sendBack = again.at(-1) as Extract<TranscriptItem, { kind: "user" }>;
    expect(sendBack.text).toContain("The X1's price is 300 ₽ in the report.");
    expect(sendBack.text).toContain("base_version_id \"version-1\"");
  });

  it("answers every call of a sent-back response, so its conversation has no call without a result", async () => {
    const other = { arguments: {}, id: "call-extra", name: "update_plan" };
    const { input, seen } = step({ calls: [[pageCall(), other], [pageCall("call-fix", "update")]], verdicts: [{ kind: "mismatch", message: "Wrong link." }, { kind: "pass" }] });
    await writeResearchPage(input);
    expect(seen[1]!.filter((item) => item.kind === "tool_result").map((item) => item.kind === "tool_result" && item.callId)).toEqual(["call-page", "call-extra"]);
  });

  it("keeps the page out after a second mismatch, or when the check throws", async () => {
    const twice = step({ calls: [[pageCall()], [pageCall("call-fix", "update")]], verdicts: [{ kind: "mismatch", message: "Wrong price." }] });
    expect(await writeResearchPage(twice.input)).toBeNull();
    expect(twice.respond).toHaveBeenCalledTimes(2);
    const broken = step();
    broken.check.mockRejectedValue(new Error("down"));
    expect(await writeResearchPage(broken.input)).toBeNull();
  });

  it("does not start when the hard end leaves less than its bound, and starts when it leaves exactly that", async () => {
    const late = step({ latestEnd: START + RESEARCH_TIME_MS.page - 1 });
    expect(await writeResearchPage(late.input)).toBeNull();
    expect(late.respond).not.toHaveBeenCalled();
    const exact = step({ latestEnd: START + RESEARCH_TIME_MS.page });
    expect(await writeResearchPage(exact.input)).not.toBeNull();
  });

  it("ends at its own bound with no page, whatever its model or check does, and the run goes on", async () => {
    vi.useFakeTimers();
    const run = new AbortController();
    const { input } = step({ signal: run.signal });
    const hanging = { ...input, respond: vi.fn(() => new Promise<ResearchPageResponse>(() => undefined)) };
    const ended = writeResearchPage(hanging);
    await vi.advanceTimersByTimeAsync(RESEARCH_TIME_MS.page - 1);
    let settled = false;
    void ended.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await ended).toBeNull();
    expect(run.signal.aborted).toBe(false);
    // The step's own signal ends what it started.
    expect((hanging.respond.mock.calls[0] as unknown as [unknown, AbortSignal])[1].aborted).toBe(true);
  });

  it("throws on Stop, so the run's ending keeps the answer, and never starts once stopped", async () => {
    const run = new AbortController();
    const { input } = step({ signal: run.signal });
    const stopped = writeResearchPage({ ...input, respond: vi.fn(() => { run.abort(new Error("stopped")); return new Promise<ResearchPageResponse>(() => undefined); }) });
    await expect(stopped).rejects.toThrow("stopped");
    const after = step({ signal: run.signal });
    await expect(writeResearchPage(after.input)).rejects.toThrow("stopped");
    expect(after.respond).not.toHaveBeenCalled();
  });
});

describe("a page's card", () => {
  it("names the version the call made, and nothing else is one", () => {
    expect(researchPageArtifact(card("version-9"))).toEqual({ artifactId: "artifact-1", entrypoint: "index.html", title: "Матрасы", versionId: "version-9" });
    expect(researchPageArtifact({ data: { artifactType: "image", payload: { artifact_id: "a", title: "t", version_id: "v" } }, type: "artifact" })).toBeNull();
    expect(researchPageArtifact({ data: { artifactType: "generated_artifact", payload: { title: "t" } }, type: "artifact" })).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { responsesHistoryFromOutput } from "../../providers/history";
import { COMPACTION_SUMMARY_HEADING, projectTranscript, type TranscriptItem } from "../transcript";
import {
  compact,
  COMPACTION_DEFAULTS,
  type CompactInput,
  type CompactionModelCall,
  type CompactionModelRequest,
  type CompactionModelResult
} from "./compact";
import { CODEX, GEMINI, charTokens, handleFor, transcriptBuilder } from "./compaction.testFixtures";
import type { CompactionCut } from "./policy";
import { RETAINED_PREAMBLE } from "./retained";
import { SUMMARIZER_INSTRUCTIONS, SUMMARY_SECTIONS } from "./summaryPrompt";

const SUMMARY = SUMMARY_SECTIONS.map((section) => `## ${section}\n- ${section} facts`).join("\n\n");
const NATIVE = { encrypted_content: "ENC-COMPACTED", id: "cmp_9", type: "compaction" };

type Reply = (request: CompactionModelRequest) => CompactionModelResult | Promise<CompactionModelResult>;

function fakeCall(...replies: Reply[]) {
  const requests: CompactionModelRequest[] = [];
  const call: CompactionModelCall = async (request) => {
    requests.push(request);
    return (replies[requests.length - 1] ?? replies[replies.length - 1]!)(request);
  };
  return { call, requests };
}

const summaryReply = (text = SUMMARY): Reply => () => ({ text, usage: { inputTokens: 1_000, outputTokens: 200 } });

/** The one user message a summary request carries. */
function requestText(request: CompactionModelRequest): string {
  const first = request.history[0];
  return first?.type === "user" ? first.text : "";
}
const nativeReply: Reply = () => ({ history: responsesHistoryFromOutput([NATIVE]), text: "", usage: { inputTokens: 5_000, outputTokens: 1_400 } });

/** Two earlier turns with a constraint, a correction and a large result, then the turn kept verbatim. */
function workChat() {
  const chat = transcriptBuilder();
  chat.user("Constraint: every report uses Asia/Yekaterinburg time.");
  chat.reasoning();
  chat.answer("Noted: Asia/Yekaterinburg.");
  chat.user("Pull the northern margins.");
  chat.reasoning();
  chat.tool("run_sql", { query: "SELECT warehouse, net_margin FROM settlements" },
    `| W-17 | 48213.75 |\n${"| W-1 | 1.00 |\n".repeat(400)}handle ${handleFor("margins")}`);
  chat.answer("Margins pulled.");
  chat.user("Correction: archive to aiqsa-archive-teal-07, not aiqsa-archive-blue.");
  chat.answer("Archive switched to aiqsa-archive-teal-07.");
  const keep = chat.user("Now export March.");
  chat.reasoning();
  chat.tool("run_pipeline", { month: "2026-03", stage: "export" }, "exported 1200 rows");
  chat.answer("Exported.");
  return { chat, keep };
}

const cutAt = (keepFromId: string, baseId: string | null = null): CompactionCut =>
  ({ baseId, compactedItems: 0, compactedTokens: 0, keepFromId, keptItems: 0, keptTokens: 0 });

function input(chat: ReturnType<typeof transcriptBuilder>, keep: string, call: CompactionModelCall,
  overrides: Partial<CompactInput> = {}): CompactInput {
  let clock = 1_000;
  return {
    call, cut: cutAt(keep), estimate: charTokens, items: [...chat.items], mode: "foreground", nextId: chat.nextId,
    now: () => (clock += 250), target: CODEX, usable: 200_000, ...overrides
  };
}

describe("summary compaction", () => {
  it("summarizes the span as data and keeps the tail verbatim after the summary and the retained text", async () => {
    const { chat, keep } = workChat();
    const { call, requests } = fakeCall(summaryReply());
    const outcome = await compact(input(chat, keep, call, { path: "summary" }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const { item, metadata } = outcome;
    expect(item).toMatchObject({ id: "i16", keepFromId: keep, kind: "compaction", origin: { model: CODEX.model, provider: CODEX.provider },
      summary: SUMMARY });
    expect(item.native).toBeUndefined();
    expect(item.retained?.startsWith(RETAINED_PREAMBLE)).toBe(true);
    expect(item.retained).toContain(`- ${handleFor("margins")}: run_sql query=`);
    expect(item.retained).toContain("[3] Correction: archive to aiqsa-archive-teal-07, not aiqsa-archive-blue.");
    expect(item.retained).not.toContain("Now export March.");

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request).toMatchObject({ instructions: SUMMARIZER_INSTRUCTIONS, kind: "summary",
      maxOutputTokens: COMPACTION_DEFAULTS.summaryOutputTokens.foreground, reasoningEffort: "low" });
    expect(request.history).toHaveLength(1);
    const text = requestText(request);
    expect(text.startsWith("<conversation>\n[User]\nConstraint: every report uses Asia/Yekaterinburg time.")).toBe(true);
    expect(text).toContain(`full result: read_tool_result handle ${handleFor("margins")}`);
    expect(text).toContain("| W-17 | 48213.75 |");
    expect(text).not.toMatch(/ENC-|Now export March|<previous-summary>/u);

    const after = [...chat.items, item];
    chat.user("Then publish.");
    after.push(chat.items[chat.items.length - 1]!);
    const replayed = projectTranscript(after, GEMINI);
    expect(replayed[0]).toEqual({ text: `${COMPACTION_SUMMARY_HEADING}\n\n${SUMMARY}\n\n${item.retained}`, type: "user" });
    expect(replayed.slice(1).map((entry) => entry.type === "user" || entry.type === "assistant_text" ? entry.text : entry.type))
      .toEqual(["Now export March.", "tool_call", "tool_result", "Exported.", "Then publish."]);

    expect(metadata).toMatchObject({ calls: 1, chunks: 1, code: null, compactedItems: 10, durationMs: 250, fallback: false,
      inputTokens: 1_000, keptItems: 5, kind: "summary", mode: "foreground", outcome: "compacted", outputTokens: 200,
      summaryChars: SUMMARY.length });
    expect(metadata.tokensAfter).toBeLessThan(metadata.tokensBefore + metadata.retainedTokens);
    expect(JSON.stringify(metadata)).not.toMatch(/Yekaterinburg|W-17|teal|export/iu);
  });

  it("updates the previous summary with what followed it instead of summarizing the summary", async () => {
    const { chat, keep } = workChat();
    chat.compaction({ keepFromId: keep, retained: "OLD RETAINED", summary: "## Goal\nOLD SUMMARY" });
    chat.user("Validate the schema.");
    chat.tool("run_pipeline", { stage: "validate" }, "ERR_SCHEMA_DRIFT_0x3F2", "error");
    chat.answer("Fixed by casting settled_at to TIMESTAMPTZ.");
    const next = chat.user("Publish the report.");
    const { call, requests } = fakeCall(summaryReply());
    const outcome = await compact(input(chat, next, call, { cut: cutAt(next, "i16"), path: "summary" }));
    expect(outcome).toMatchObject({ ok: true });
    const text = requestText(requests[0]!);
    expect(text).toContain("<previous-summary>\n## Goal\nOLD SUMMARY\n</previous-summary>");
    expect(text).toContain("[User]\nNow export March.");
    expect(text).toContain("[Tool result #2 run_pipeline, error]\nERR_SCHEMA_DRIFT_0x3F2");
    expect(text).not.toMatch(/Pull the northern margins|OLD RETAINED/u);
    if (outcome.ok) {
      expect(outcome.item.retained).toContain("[1] Constraint: every report uses Asia/Yekaterinburg time.");
      expect(outcome.item.retained).toContain("[5] Validate the schema.");
    }
  });

  it("retries a failed summary once with tighter excerpts and a shorter target, then gives up", async () => {
    const { chat, keep } = workChat();
    const retried = fakeCall(summaryReply("I will continue the export now."), summaryReply());
    const outcome = await compact(input(chat, keep, retried.call, { path: "summary" }));
    expect(outcome).toMatchObject({ metadata: { calls: 2 }, ok: true });
    const texts = retried.requests.map(requestText);
    expect(texts[0]).toContain("about 1,800 words");
    expect(texts[1]).toContain("about 900 words");
    expect(texts[1]!.length).toBeLessThan(texts[0]!.length);

    const incomplete = fakeCall(() => ({ status: "incomplete", text: SUMMARY }), summaryReply());
    expect(await compact(input(chat, keep, incomplete.call, { path: "summary" }))).toMatchObject({ metadata: { calls: 2 }, ok: true });

    const failing = fakeCall(() => { throw new Error("upstream"); });
    expect(await compact(input(chat, keep, failing.call, { path: "summary" }))).toMatchObject({
      code: "compaction_summary_failed", metadata: { calls: 2, outcome: "failed", tokensAfter: null }, ok: false
    });
  });

  it("folds a span larger than one call may carry through chunks, each updating the last summary", async () => {
    const { chat, keep } = workChat();
    const { call, requests } = fakeCall(...Array.from({ length: 12 }, (_, index) => summaryReply(`${SUMMARY}\nchunk ${index + 1}`)));
    const outcome = await compact(input(chat, keep, call, { path: "summary", usable: 12_000 }));
    expect(outcome.ok).toBe(true);
    expect(requests.length).toBeGreaterThan(1);
    if (outcome.ok) {
      expect(outcome.metadata.chunks).toBe(requests.length);
      expect(outcome.item.summary).toBe(`${SUMMARY}\nchunk ${requests.length}`);
    }
    const texts = requests.map(requestText);
    expect(texts[0]).not.toContain("<previous-summary>");
    texts.slice(1).forEach((text, index) => expect(text).toContain(`<previous-summary>\n${SUMMARY}\nchunk ${index + 1}\n</previous-summary>`));
  });
});

describe("native compaction", () => {
  it("compacts the replayed span on its own route and replays the item, the retained text and the tail there only", async () => {
    const { chat, keep } = workChat();
    const { call, requests } = fakeCall(nativeReply);
    const outcome = await compact(input(chat, keep, call));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(requests).toEqual([expect.objectContaining({ kind: "native" })]);
    expect(requests[0]!.instructions).toBeUndefined();
    expect(requests[0]!.history).toEqual(projectTranscript(chat.items.slice(0, 10), CODEX));
    expect(JSON.stringify(requests[0]!.history)).toContain("ENC-i2");
    expect(outcome.item).toMatchObject({ keepFromId: keep, kind: "compaction", outputTokens: 1_400 });
    expect(outcome.item.native).toEqual({ fields: NATIVE, format: "openai_responses" });
    expect(outcome.item.summary).toBeUndefined();
    expect(outcome.metadata).toMatchObject({ calls: 1, fallback: false, kind: "native", outputTokens: 1_400, summaryChars: null });

    const after: TranscriptItem[] = [...chat.items, outcome.item];
    const own = projectTranscript(after, CODEX);
    expect(own.slice(0, 3)).toEqual([
      { native: { fields: NATIVE, format: "openai_responses" }, type: "compaction" },
      { text: outcome.item.retained, type: "user" },
      { text: "Now export March.", type: "user" }
    ]);
    // Another model cannot read the opaque item: it replays the stored transcript.
    expect(projectTranscript(after, GEMINI)).toEqual(projectTranscript(chat.items, GEMINI));
  });

  it("falls back to a summary when the native call returns no compaction item or fails", async () => {
    const { chat, keep } = workChat();
    const empty = fakeCall(() => ({ history: [{ text: "Sure, compacting.", type: "assistant_text" }], text: "Sure" }), summaryReply());
    const outcome = await compact(input(chat, keep, empty.call));
    expect(outcome).toMatchObject({ item: { summary: SUMMARY }, metadata: { calls: 2, fallback: true, kind: "summary" }, ok: true });
    expect(empty.requests.map((request) => request.kind)).toEqual(["native", "summary"]);

    const refused = fakeCall(() => { throw new Error("400"); });
    expect(await compact(input(chat, keep, refused.call, { options: { nativeFallback: false } }))).toMatchObject({
      code: "compaction_native_failed", metadata: { calls: 1, kind: "native" }, ok: false
    });
  });
});

describe("compaction guards", () => {
  it("refuses a cut that no longer applies, without calling the model", async () => {
    const { chat, keep } = workChat();
    chat.compaction({ keepFromId: keep, summary: "## Goal\nx" });
    const { call, requests } = fakeCall(summaryReply());
    expect(await compact(input(chat, keep, call))).toMatchObject({ code: "compaction_cut_stale", ok: false });
    expect(await compact(input(chat, "i4", call, { cut: cutAt("i4", "i16") }))).toMatchObject({ code: "compaction_cut_stale", ok: false });
    expect(requests).toHaveLength(0);
  });

  it("stops when the run stops, and gives up an attempt at its deadline", async () => {
    const { chat, keep } = workChat();
    const controller = new AbortController();
    const hanging: Reply = (request) => new Promise((_, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    const stopped = compact(input(chat, keep, fakeCall(hanging).call, { signal: controller.signal }));
    controller.abort();
    expect(await stopped).toMatchObject({ code: "compaction_aborted", ok: false });

    const timed = fakeCall(hanging);
    const outcome = await compact(input(chat, keep, timed.call, { options: { attemptDeadlineMs: 20 }, path: "summary" }));
    expect(outcome).toMatchObject({ code: "compaction_summary_failed", metadata: { calls: 2 }, ok: false });
    expect(timed.requests.every((request) => request.signal.aborted)).toBe(true);
  });
});

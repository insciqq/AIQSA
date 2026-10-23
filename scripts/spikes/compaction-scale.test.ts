import { describe, expect, it } from "vitest";
import {
  buildTranscript,
  type CallDeps,
  chars4,
  estimateItemTokens,
  estimateTokens,
  type InputItem,
  itemText,
  parseArgs,
  PROBES,
  recallFields,
  type RunConfig,
  runPath,
  scoreRecall,
  splitTail,
  streamResponses,
  SUMMARY_PREFIX,
  trimHeadTail
} from "./compaction-scale";

const KEY = "sk-spike-test-secret";
const ROOT = "https://lb.example.test";
const TARGET = 60_000;
const TAIL = 6_000;

const config: RunConfig = {
  inlineThreshold: 30_000,
  model: "gpt-6.1-sol",
  nativeInput: "head",
  summaryEffort: "low",
  summaryMaxOutputTokens: 4_096,
  tailTokens: TAIL
};

type Recorded = Readonly<{ body: Record<string, unknown>; headers: Record<string, string>; url: string }>;
type Reply = (request: Recorded, signal: AbortSignal) => Response;

const encoder = new TextEncoder();

function sse(events: readonly Record<string, unknown>[]): Response {
  const text = events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(new ReadableStream({
    start(controller) {
      // Split mid-event to exercise buffering across chunks.
      const bytes = encoder.encode(text);
      const middle = Math.floor(bytes.length / 2);
      controller.enqueue(bytes.slice(0, middle));
      controller.enqueue(bytes.slice(middle));
      controller.close();
    }
  }), { headers: { "content-type": "text/event-stream" }, status: 200 });
}

function answerText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...Object.fromEntries(recallFields().map((field) => [field.key, field.expected])), ...overrides });
}

function streamedAnswer(text: string, extra: readonly Record<string, unknown>[] = []): Response {
  return sse([
    { response: { id: "resp_1", status: "in_progress" }, type: "response.created" },
    ...extra,
    { delta: text.slice(0, 20), type: "response.output_text.delta" },
    { delta: text.slice(20), type: "response.output_text.delta" },
    {
      item: { content: [{ text, type: "output_text" }], role: "assistant", type: "message" },
      type: "response.output_item.done"
    },
    {
      response: {
        id: "resp_1",
        output: [...extra.filter((event) => event.type === "response.output_item.done").map((event) => event.item), { role: "assistant", type: "message" }],
        status: "completed",
        usage: { input_tokens: 4321, output_tokens: 210, output_tokens_details: { reasoning_tokens: 64 } }
      },
      type: "response.completed"
    }
  ]);
}

function fakeDeps(replies: readonly Reply[]): { deps: CallDeps; requests: Recorded[] } {
  const requests: Recorded[] = [];
  let clock = 0;
  const deps: CallDeps = {
    apiKey: KEY,
    fetch: async (url, init) => {
      const request: Recorded = {
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
        headers: init.headers as Record<string, string>,
        url
      };
      requests.push(request);
      const reply = replies[requests.length - 1];
      if (!reply) throw new Error("unexpected_request");
      return reply(request, init.signal!);
    },
    idleTimeoutMs: 120_000,
    now: () => (clock += 5),
    overallTimeoutMs: 600_000,
    root: ROOT
  };
  return { deps, requests };
}

const transcript = buildTranscript({ seed: 7, targetTokens: TARGET });
const { head, tail } = splitTail(transcript.items, TAIL);

function inputOf(request: Recorded): InputItem[] {
  return request.body.input as InputItem[];
}

describe("synthetic transcript", () => {
  it("is deterministic and reaches the requested estimated size", () => {
    expect(JSON.stringify(buildTranscript({ seed: 7, targetTokens: TARGET }))).toBe(JSON.stringify(transcript));
    expect(JSON.stringify(buildTranscript({ seed: 8, targetTokens: TARGET }).items)).not.toBe(JSON.stringify(transcript.items));
    expect(transcript.estimatedTokens).toBe(estimateTokens(transcript.items));
    expect(transcript.estimatedTokens).toBeGreaterThanOrEqual(TARGET);
    expect(transcript.estimatedTokens).toBeLessThan(TARGET * 1.1);
  });

  it("sizes with the counter it is given", () => {
    const doubled = buildTranscript({ count: (text) => chars4(text) * 2, seed: 7, targetTokens: TARGET });
    expect(estimateTokens(doubled.items)).toBeLessThan(TARGET * 0.6);
    expect(doubled.estimatedTokens).toBeGreaterThanOrEqual(TARGET);
  });

  it("mixes Russian and English messages with tool pairs", () => {
    const texts = transcript.items.filter((item) => item.type === "message").map(itemText);
    expect(texts.some((text) => /[а-яё]{4}/u.test(text))).toBe(true);
    expect(texts.some((text) => /\b(?:the|and)\b/u.test(text))).toBe(true);
    expect(transcript.items.some((item) => item.type === "function_call_output" && /\| net_margin \|/u.test(String(item.output)))).toBe(true);
  });

  it("plants every probe once, in order, within the first 80 percent and in its region", () => {
    expect(transcript.probes.map((probe) => probe.id)).toEqual(PROBES.map((probe) => probe.id));
    for (const planted of transcript.probes) {
      const definition = PROBES.find((probe) => probe.id === planted.id)!;
      expect(planted.position).toBeGreaterThanOrEqual(definition.at);
      expect(planted.position).toBeLessThan(0.8);
      expect(planted.region).toBe(definition.region);
    }
    const positions = transcript.probes.map((probe) => probe.position);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
  });

  it("puts each expected value only in the head, first in the probe's region", () => {
    const kindOf = (item: InputItem) => item.type === "message" ? String(item.role) : "tool";
    for (const probe of PROBES) {
      for (const field of Object.values(probe.fields)) {
        if (field.expected.length < 6) continue;
        const holders = transcript.items.flatMap((item, index) => itemText(item).includes(field.expected) ? [index] : []);
        expect(holders.length, field.expected).toBeGreaterThan(0);
        expect(Math.max(...holders)).toBeLessThan(head.length);
        expect(kindOf(transcript.items[holders[0]!]!)).toBe(probe.region);
      }
    }
    const texts = transcript.items.map(itemText);
    expect(texts.filter((text) => text.includes("| W-17 |"))).toHaveLength(1);
    expect(texts.filter((text) => /W-17\b/u.test(text))).toHaveLength(1);
    const superseded = texts.findIndex((text) => text.includes("aiqsa-archive-blue"));
    const corrected = texts.findIndex((text) => text.includes("aiqsa-archive-teal-07"));
    expect(superseded).toBeGreaterThan(-1);
    expect(superseded).toBeLessThan(corrected);
  });

  it("keeps every function_call directly followed by its output, with unique call ids", () => {
    const ids = new Set<string>();
    transcript.items.forEach((item, index) => {
      if (item.type === "function_call") {
        const next = transcript.items[index + 1]!;
        expect(next.type).toBe("function_call_output");
        expect(next.call_id).toBe(item.call_id);
        expect(ids.has(String(item.call_id))).toBe(false);
        ids.add(String(item.call_id));
        expect(() => JSON.parse(String(item.arguments)) as unknown).not.toThrow();
      }
      if (item.type === "function_call_output") expect(transcript.items[index - 1]!.type).toBe("function_call");
    });
    expect(ids.size).toBeGreaterThan(10);
  });

  it("splits the tail at a message without separating a call from its output", () => {
    expect([...head, ...tail]).toEqual(transcript.items);
    expect(tail[0]!.type).toBe("message");
    expect(estimateTokens(tail)).toBeGreaterThanOrEqual(TAIL);
    expect(estimateTokens(tail) - estimateItemTokens(tail[0]!)).toBeLessThan(TAIL + 20_000);
    expect(transcript.items.length - head.length).toBe(tail.length);
  });

  it("trims long text head and tail and leaves short text alone", () => {
    expect(trimHeadTail("short")).toBe("short");
    const long = `${"a".repeat(3_000)}MIDDLE${"z".repeat(3_000)}`;
    const trimmed = trimHeadTail(long);
    expect(trimmed.length).toBeLessThanOrEqual(2_060);
    expect(trimmed.startsWith("a".repeat(1_000))).toBe(true);
    expect(trimmed.endsWith("z".repeat(1_000))).toBe(true);
    expect(trimmed).not.toContain("MIDDLE");
  });
});

describe("request shapes", () => {
  it("native: compacts the head, then recalls over compacted output, the verbatim tail and the question", async () => {
    const compacted = [
      { content: [{ text: "u", type: "input_text" }], role: "user", type: "message" },
      { encrypted_content: "e".repeat(300), id: "cmp_1", type: "compaction" }
    ];
    const { deps, requests } = fakeDeps([
      () => Response.json({ object: "response.compaction", output: compacted, usage: { input_tokens: 51_000, output_tokens: 900 } }),
      () => streamedAnswer(answerText())
    ]);
    const record = await runPath("native", deps, config, transcript);

    expect(requests[0]!.url).toBe(`${ROOT}/v1/responses/compact`);
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(Object.keys(requests[0]!.body).sort()).toEqual(["input", "instructions", "model"]);
    expect(requests[0]!.body.model).toBe("gpt-6.1-sol");
    expect(inputOf(requests[0]!)).toEqual(head);

    expect(requests[1]!.url).toBe(`${ROOT}/v1/responses`);
    expect(requests[1]!.body).toMatchObject({ store: false, stream: true, tool_choice: "none" });
    expect(requests[1]!.body.reasoning).toBeUndefined();
    const recallInput = inputOf(requests[1]!);
    expect(recallInput.slice(0, 2)).toEqual(compacted);
    expect(recallInput.slice(2, 2 + tail.length)).toEqual(tail);
    expect(recallInput).toHaveLength(compacted.length + tail.length + 1);
    expect(itemText(recallInput.at(-1)!)).toContain("\"pendingPartition\"");

    expect(record).toMatchObject({
      compaction: { compactedItemCount: 2, compactionItemCount: 1, encryptedContentChars: 300, httpStatus: 200, itemKinds: { compaction: 1, "message:user": 1 } },
      ok: true,
      recall: { completed: true, parsed: true, recalled: PROBES.length, total: PROBES.length, usage: { inputTokens: 4321, outputTokens: 210, reasoningTokens: 64 } },
      transcriptTokensReported: 51_000
    });
    expect((record.recall as { firstTokenMs: number }).firstTokenMs).toBeGreaterThan(0);
  });

  it("native full: compacts everything and recalls without a tail", async () => {
    const compacted = [{ encrypted_content: "e", type: "compaction" }];
    const { deps, requests } = fakeDeps([() => Response.json({ output: compacted }), () => streamedAnswer(answerText())]);
    await runPath("native", deps, { ...config, nativeInput: "full" }, transcript);
    expect(inputOf(requests[0]!)).toEqual(transcript.items);
    expect(inputOf(requests[1]!)).toHaveLength(2);
  });

  it("native: a response without a compaction item fails visibly and skips recall", async () => {
    const { deps, requests } = fakeDeps([() => Response.json({ output: [{ role: "user", type: "message" }] })]);
    const record = await runPath("native", deps, config, transcript);
    expect(requests).toHaveLength(1);
    expect(record).toMatchObject({ compaction: { errorCode: "no_compaction_item" }, ok: false });
  });

  it("summary: streams a bounded handoff summary over the trimmed head, then recalls over summary and tail", async () => {
    const summary = "## Goal\nReconcile.\n## Critical data\nvalues";
    const { deps, requests } = fakeDeps([() => streamedAnswer(summary), () => streamedAnswer(answerText())]);
    const record = await runPath("summary", deps, config, transcript);

    const body = requests[0]!.body;
    expect(requests[0]!.url).toBe(`${ROOT}/v1/responses`);
    expect(body).toMatchObject({ max_output_tokens: 4_096, reasoning: { effort: "low" }, store: false, stream: true, tool_choice: "none" });
    const input = inputOf(requests[0]!);
    expect(input).toHaveLength(head.length + 1);
    for (const [index, item] of input.slice(0, -1).entries()) {
      expect(item.type).toBe(head[index]!.type);
      if (item.type === "function_call_output") expect(String(item.output).length).toBeLessThanOrEqual(2_060);
      if (item.type === "function_call") expect(String(item.arguments).length).toBeLessThanOrEqual(2_060);
    }
    const prompt = itemText(input.at(-1)!);
    for (const section of ["## Goal", "## User constraints, preferences and corrections", "## Done and key decisions", "## Current state", "## Open items and next steps", "## Critical data"]) {
      expect(prompt).toContain(section);
    }

    const recallInput = inputOf(requests[1]!);
    expect(itemText(recallInput[0]!)).toBe(`${SUMMARY_PREFIX}${summary}`);
    expect(recallInput.slice(1, 1 + tail.length)).toEqual(tail);
    expect(recallInput).toHaveLength(tail.length + 2);
    expect(record).toMatchObject({ ok: true, recall: { recalled: PROBES.length }, summary: { status: "completed", summaryChars: summary.length } });
  });

  it("summary: an omitted --summary-effort sends no reasoning field", async () => {
    const { deps, requests } = fakeDeps([() => streamedAnswer("s"), () => streamedAnswer(answerText())]);
    await runPath("summary", deps, { ...config, summaryEffort: "default" }, transcript);
    expect(requests[0]!.body.reasoning).toBeUndefined();
  });

  it("inline: asks the server to compact past the threshold and scores the answer of the same call", async () => {
    const compactionDone = { item: { encrypted_content: "c".repeat(50), type: "compaction" }, type: "response.output_item.done" };
    const { deps, requests } = fakeDeps([() => streamedAnswer(answerText(), [compactionDone])]);
    const record = await runPath("inline", deps, config, transcript);
    expect(requests[0]!.body.context_management).toEqual([{ compact_threshold: 30_000, type: "compaction" }]);
    expect(inputOf(requests[0]!).slice(0, -1)).toEqual(transcript.items);
    expect(record).toMatchObject({ inline: { compactionItemCount: 1, errorCode: null }, ok: true, recall: { recalled: PROBES.length } });
    expect((record.inline as { compactionAtMs: number }).compactionAtMs).toBeGreaterThan(0);
  });

  it("inline: no compaction item fails visibly", async () => {
    const { deps } = fakeDeps([() => streamedAnswer(answerText())]);
    const record = await runPath("inline", deps, config, transcript);
    expect(record).toMatchObject({ inline: { errorCode: "no_compaction_item" }, ok: false });
  });

  it("trigger: ends the head with a compaction_trigger item and replays its output without reasoning", async () => {
    const compactionDone = { item: { encrypted_content: "c", type: "compaction" }, type: "response.output_item.done" };
    const reasoningDone = { item: { summary: [], type: "reasoning" }, type: "response.output_item.done" };
    const { deps, requests } = fakeDeps([() => streamedAnswer("", [reasoningDone, compactionDone]), () => streamedAnswer(answerText())]);
    const record = await runPath("trigger", deps, config, transcript);
    const input = inputOf(requests[0]!);
    expect(input.at(-1)).toEqual({ type: "compaction_trigger" });
    expect(input.slice(0, -1)).toEqual(head);
    const recallInput = inputOf(requests[1]!);
    expect(recallInput.some((item) => item.type === "reasoning")).toBe(false);
    expect(recallInput[0]).toEqual(compactionDone.item);
    expect(record).toMatchObject({ ok: true, recall: { recalled: PROBES.length } });
  });
});

describe("transport failures", () => {
  it("reports an HTTP error by its code only", async () => {
    const { deps } = fakeDeps([() => Response.json({ error: { code: "rate_limit_exceeded", message: "secret detail" } }, { status: 429 })]);
    const record = await runPath("native", deps, config, transcript);
    expect(record).toMatchObject({ compaction: { errorCode: "rate_limit_exceeded", httpStatus: 429 }, ok: false });
    expect(JSON.stringify(record)).not.toContain("secret detail");
  });

  it("ends a silent stream on the idle timeout", async () => {
    const { deps } = fakeDeps([() => new Response(new ReadableStream({ start() {} }), { status: 200 })]);
    const result = await streamResponses({ ...deps, idleTimeoutMs: 30 }, {});
    expect(result.errorCode).toBe("stream_idle_timeout");
  });

  it("flags a stream that ends without a terminal event", async () => {
    const { deps } = fakeDeps([() => sse([{ delta: "x", type: "response.output_text.delta" }])]);
    const result = await streamResponses(deps, {});
    expect(result.errorCode).toBe("stream_ended_without_terminal");
  });

  it("keeps incomplete status and reason", async () => {
    const { deps } = fakeDeps([() => sse([{ response: { incomplete_details: { reason: "max_output_tokens" }, status: "incomplete", usage: { output_tokens: 4096 } }, type: "response.incomplete" }])]);
    const result = await streamResponses(deps, {});
    expect(result).toMatchObject({ incompleteReason: "max_output_tokens", status: "incomplete", usage: { outputTokens: 4096 } });
  });
});

describe("recall scoring", () => {
  it("scores exact values, tolerating case, quotes, fences and numbers", () => {
    const score = scoreRecall(`\`\`\`json\n${answerText({ failedJobId: "job-7q4m-2291", rejectedStrategyOomGb: 14, reportTimezone: "`Asia/Yekaterinburg`" })}\n\`\`\``);
    expect(score).toMatchObject({ parsed: true, recalled: PROBES.length, total: PROBES.length });
  });

  it("needs every field of a probe, and keeps a loose score for decorated values", () => {
    const score = scoreRecall(answerText({ archiveBucket: "aiqsa-archive-blue", pendingPartition: null, rejectedStrategyOomGb: "14 GB" }));
    expect(score.probes).toMatchObject({ correction: false, decision: false, pending: false, toolNumber: true });
    expect(score.probesLoose).toMatchObject({ correction: false, decision: true, pending: false });
    expect(score.recalled).toBe(PROBES.length - 3);
  });

  it("scores unparsable answers as nothing recalled", () => {
    expect(scoreRecall("I do not remember")).toMatchObject({ parsed: false, recalled: 0 });
    expect(scoreRecall("{not json}")).toMatchObject({ parsed: false, recalled: 0 });
  });
});

describe("records and arguments", () => {
  it("never carries the key, transcript text or answers", async () => {
    const { deps } = fakeDeps([
      () => Response.json({ output: [{ encrypted_content: "opaque-blob", type: "compaction" }] }),
      () => streamedAnswer(answerText())
    ]);
    const serialized = JSON.stringify(await runPath("native", deps, config, transcript));
    for (const forbidden of [KEY, "opaque-blob", "Asia/Yekaterinburg", "JOB-7Q4M-2291", "aiqsa-archive-teal-07", "ERR_SCHEMA_DRIFT_0x3F2", "net_margin"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("parses defaults and rejects unsafe roots and unknown flags", () => {
    expect(parseArgs([], {})).toMatchObject({
      dryRun: false, estimator: "o200k", idleTimeoutMs: 120_000, inlineThreshold: 200_000, model: "gpt-6.1-sol", nativeInput: "head",
      overallTimeoutMs: 600_000, paths: ["native", "summary"], repeat: 1, root: "https://codex-lb.psaux.info",
      summaryEffort: "low", summaryMaxOutputTokens: 4_096, tailTokens: 20_000, tokens: 400_000
    });
    expect(parseArgs(["--paths", "native,summary,inline,trigger", "--repeat", "3", "--dry-run"], { CODEX_LB_ROOT: "https://lb.example.test/" }))
      .toMatchObject({ dryRun: true, paths: ["native", "summary", "inline", "trigger"], repeat: 3, root: "https://lb.example.test" });
    expect(() => parseArgs(["--root", "https://lb.example.test/v1"], {})).toThrow("root_must_not_include_v1");
    expect(() => parseArgs(["--root", "http://lb.example.test"], {})).toThrow("invalid_root");
    expect(() => parseArgs(["--paths", "native,magic"], {})).toThrow("invalid_paths");
    expect(() => parseArgs(["--bogus", "1"], {})).toThrow("unknown_flag:bogus");
    expect(() => parseArgs(["--tokens", "12.5"], {})).toThrow("invalid_tokens");
  });
});

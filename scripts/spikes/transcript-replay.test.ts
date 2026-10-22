import { describe, expect, it, vi } from "vitest";
import { normalizeProviderConnectionConfiguration } from "../../lib/server/providers/providerConfiguration";
import {
  createSpikeConnection,
  parseSpikeArguments,
  runTranscriptReplaySpike,
  SPIKE_PROVIDER_PROFILES,
  SPIKE_PROVIDERS,
  type SpikeOptions,
  type SpikeProvider
} from "./transcript-replay-support";

type Item = Record<string, unknown>;

const ETA: Readonly<Record<string, number>> = { "A-17": 3, "B-42": 1, "C-5": 4, "D-8": 2, "E-3": 5, "F-9": 6 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

function rejected(param: string): Response {
  return json({ error: { code: "fake_invariant", message: `PRIVATE-MESSAGE ${param}`, param, type: "invalid_request_error" } }, 400);
}

/** The fake model: a tool call for a named order, a recall answer from the replayed results, or a short answer. */
function decide(lastUser: string, afterResult: boolean, outputs: readonly string[]): Readonly<{ order?: string; text?: string }> {
  if (afterResult) return { text: "Done." };
  if (/without calling any tool/iu.test(lastUser)) {
    const seen = outputs.flatMap((output) => {
      try {
        const id = (JSON.parse(output) as { order_id?: unknown }).order_id;
        return typeof id === "string" ? [id] : [];
      } catch {
        return [];
      }
    });
    return { text: `${[...seen].sort((left, right) => (ETA[left] ?? 99) - (ETA[right] ?? 99))[0] ?? "none"} arrives first.` };
  }
  const match = /order ([A-Z]-\d+)/u.exec(lastUser);
  return match ? { order: match[1] } : { text: "OK." };
}

const firstText = (content: unknown) => Array.isArray(content) && typeof (content[0] as Item | undefined)?.text === "string"
  ? String((content[0] as Item).text) : typeof content === "string" ? content : "";

/** A Responses provider that rejects foreign reasoning, foreign item ids and unpaired calls. */
function responsesFake(tag: string, reasoning: "encrypted" | "text") {
  let count = 0;
  return vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { input: Item[]; model: string };
    const calls = new Set<string>();
    const answered = new Set<string>();
    const outputs: string[] = [];
    let lastUser = "";
    let afterResult = false;
    for (const [index, item] of body.input.entries()) {
      if (item.type === "reasoning") {
        const blob = reasoning === "encrypted" ? item.encrypted_content : firstText(item.content);
        if (typeof blob !== "string" || !blob.startsWith(`R:${tag}:`)) return rejected(`input[${index}]`);
      }
      if (item.type === "function_call") {
        if (item.id !== undefined && !String(item.id).startsWith(`fc_${tag}_`)) return rejected(`input[${index}].id`);
        calls.add(String(item.call_id));
      }
      if (item.type === "function_call_output") {
        if (!calls.has(String(item.call_id))) return rejected(`input[${index}].call_id`);
        answered.add(String(item.call_id));
        outputs.push(String(item.output));
      }
      if (item.role === "user") lastUser = firstText(item.content);
      afterResult = item.type === "function_call_output";
    }
    if ([...calls].some((id) => !answered.has(id))) return rejected("input");
    count += 1;
    const decision = decide(lastUser, afterResult, outputs);
    const reasoningItem = reasoning === "encrypted"
      ? { encrypted_content: `R:${tag}:${count}`, id: `rs_${tag}_${count}`, summary: [], type: "reasoning" }
      : { content: [{ text: `R:${tag}:${count}`, type: "reasoning_text" }], id: `rs_${tag}_${count}`, summary: [], type: "reasoning" };
    const answer = decision.order
      ? { arguments: JSON.stringify({ order_id: decision.order }), call_id: `call_${tag}_${count}`, id: `fc_${tag}_${count}`,
          name: "lookup_order", status: "completed", type: "function_call" }
      : { content: [{ text: decision.text, type: "output_text" }], id: `msg_${tag}_${count}`, role: "assistant", status: "completed", type: "message" };
    const input = Math.ceil(String(init?.body).length / 4);
    // Like Codex LB: input tokens per replayed item id, nothing for reasoning.
    const attribution = tag === "codex-lb" ? { attribution: { items: Object.fromEntries(body.input
      .filter((item) => typeof item.id === "string").map((item) => [item.id, item.type === "reasoning" ? 0 : 7])) } } : {};
    return json({ id: `resp_${tag}_${count}`, model: body.model, output: [reasoningItem, answer], status: "completed",
      usage: { ...attribution, input_tokens: input, output_tokens: 20, output_tokens_details: { reasoning_tokens: 8 }, total_tokens: input + 20 } });
  });
}

/** An OpenRouter Chat provider that rejects foreign reasoning details and tool messages away from their calls. */
function chatFake() {
  let count = 0;
  return vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Item[]; model: string };
    const messages = body.messages;
    const outputs: string[] = [];
    for (const [index, message] of messages.entries()) {
      if (message.role === "assistant") {
        const details = Array.isArray(message.reasoning_details) ? message.reasoning_details as Item[] : [];
        if (details.some((detail) => !String(detail.data).startsWith("R:openrouter:"))) return rejected(`messages[${index}]`);
        const ids = (Array.isArray(message.tool_calls) ? message.tool_calls as Item[] : []).map((call) => String(call.id));
        const following = messages.slice(index + 1, index + 1 + ids.length);
        if (following.length < ids.length || following.some((next) => next.role !== "tool" || !ids.includes(String(next.tool_call_id)))) {
          return rejected(`messages[${index}].tool_calls`);
        }
      }
      if (message.role === "tool") outputs.push(String(message.content));
    }
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    count += 1;
    const decision = decide(firstText(lastUser?.content), messages.at(-1)?.role === "tool", outputs);
    const input = Math.ceil(String(init?.body).length / 4);
    return json({ choices: [{ finish_reason: decision.order ? "tool_calls" : "stop", index: 0, message: {
      content: decision.order ? null : decision.text,
      reasoning_details: [{ data: `R:openrouter:${count}`, format: "google-gemini-v1", index: 0, type: "reasoning.encrypted" }],
      role: "assistant",
      ...(decision.order ? { tool_calls: [{ function: { arguments: JSON.stringify({ order_id: decision.order }), name: "lookup_order" },
        id: `tool_${count}`, type: "function" }] } : {})
    } }], id: `gen_${count}`, model: body.model, object: "chat.completion",
    usage: { completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 8 }, prompt_tokens: input, total_tokens: input + 20 } });
  });
}

/** A Gemini Interactions provider that rejects foreign signatures and calls without their results. */
function geminiFake() {
  let count = 0;
  return vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { input: Item[]; model: string };
    const open = new Set<string>();
    const outputs: string[] = [];
    let lastUser = "";
    for (const [index, step] of body.input.entries()) {
      if (step.type === "thought" && !String(step.signature).startsWith("S:gemini:")) return rejected(`input[${index}]`);
      if (step.type === "function_call") {
        if (step.signature !== undefined && !String(step.signature).startsWith("S:gemini:")) return rejected(`input[${index}]`);
        open.add(String(step.id));
      }
      if (step.type === "function_result") {
        if (!open.delete(String(step.call_id))) return rejected(`input[${index}]`);
        outputs.push(firstText(step.result));
      }
      if (step.type === "user_input") {
        if (open.size > 0) return rejected(`input[${index}]`);
        lastUser = firstText(step.content);
      }
    }
    if (open.size > 0) return rejected("input");
    count += 1;
    const decision = decide(lastUser, body.input.at(-1)?.type === "function_result", outputs);
    const input = Math.ceil(String(init?.body).length / 4);
    return json({ id: `int_${count}`, model: body.model, status: decision.order ? "requires_action" : "completed",
      steps: [{ signature: `S:gemini:${count}`, type: "thought" }, decision.order
        ? { arguments: { order_id: decision.order }, id: `gcall_${count}`, name: "lookup_order", type: "function_call" }
        : { content: [{ text: decision.text, type: "text" }], type: "model_output" }],
      usage: { total_input_tokens: input, total_output_tokens: 12, total_thought_tokens: 8, total_tokens: input + 20 } });
  });
}

const BASE_URLS: Readonly<Record<SpikeProvider, string>> = {
  "codex-lb": "https://codex.example.test/backend-api/codex",
  deepseek: "https://deepseek.example.test",
  gemini: "https://gemini.example.test/v1",
  openai: "https://openai.example.test/v1",
  openrouter: "https://openrouter.example.test/api/v1"
};

function options(argv: readonly string[]): SpikeOptions {
  const parsed = parseSpikeArguments(["--stream", "false", "--retries", "0", "--sequential", ...argv]);
  if ("help" in parsed) throw new Error("unexpected help");
  return parsed;
}

async function run(argv: readonly string[], overrides: Partial<Record<SpikeProvider, typeof fetch | null>> = {}) {
  const fakes: Record<SpikeProvider, typeof fetch | null> = {
    "codex-lb": responsesFake("codex-lb", "encrypted"),
    deepseek: responsesFake("deepseek", "text"),
    gemini: geminiFake(),
    openai: responsesFake("openai", "encrypted"),
    openrouter: chatFake(),
    ...overrides
  };
  const parsed = options(argv);
  const lines: Record<string, unknown>[] = [];
  const connect = vi.fn((provider: SpikeProvider) => {
    const fetchFn = fakes[provider];
    return fetchFn ? createSpikeConnection(provider, { apiKey: "synthetic-key", baseUrl: BASE_URLS[provider],
      errorDetail: parsed.errorDetail, fetchFn, timeoutMs: 30_000 }) : null;
  });
  const summary = await runTranscriptReplaySpike(parsed, { connect, emit: (line) => lines.push({ ...line }), now: () => 0,
    sleep: async () => undefined });
  return { connect, lines, summary };
}

describe("transcript replay spike", () => {
  it("replays every scenario to every provider through the real adapters without a rejected request", async () => {
    const { connect, lines, summary } = await run([]);
    expect(summary).toEqual({ failedTurns: 0, http4xx: 0, pass: true, skipped: 0 });
    const calls = lines.filter((line) => line.kind === "call");
    expect(calls).toHaveLength(70);
    expect(calls.every((line) => line.ok === true && line.status === 200)).toBe(true);
    const serving = (provider: SpikeProvider) => calls.filter((line) => line.provider === provider).length;
    expect(Object.fromEntries(SPIKE_PROVIDERS.map((provider) => [provider, serving(provider)]))).toEqual({
      "codex-lb": 16, deepseek: 14, gemini: 14, openai: 12, openrouter: 14
    });
    const checks = calls.map((line) => line.checks as Record<string, boolean>);
    expect(checks.filter((check) => "recall" in check)).toEqual(Array(10).fill({ recall: true }));
    expect(checks.filter((check) => "toolArgs" in check).every((check) => check.toolArgs)).toBe(true);
    expect(lines.filter((line) => line.kind === "restart")).toHaveLength(10);
    // A fresh adapter instance for every restart, beside the scenario's own connections.
    expect(connect.mock.calls.length).toBeGreaterThanOrEqual(5 * 4 + 10);
    // Only each chat's first call to a route and model has no anchor; a restart keeps its anchors.
    const estimates = calls.map((line) => line.estimate as Record<string, unknown>);
    expect(estimates.filter((estimate) => estimate.anchored === false)).toHaveLength(20);
    expect(estimates.every((estimate) => typeof estimate.tokens === "number" && typeof estimate.naive === "number")).toBe(true);
    // A model switch drops the other model's reasoning.
    expect(calls.some((line) => line.scenario === "switch" && (line.foreignReasoningDropped as number) > 0)).toBe(true);
    // Per-item attribution sums what the provider counted for replayed reasoning.
    const attributed = calls.filter((line) => line.provider === "codex-lb" && (line.sent as Record<string, number>).reasoning > 0);
    expect(attributed.length).toBeGreaterThan(0);
    expect(attributed.map((line) => line.attribution)).toEqual(attributed.map((line) => expect.objectContaining({
      reasoningItems: (line.sent as Record<string, number>).reasoning, reasoningTokens: 0 })));
    expect(calls.filter((line) => line.provider !== "codex-lb").every((line) => !("attribution" in line))).toBe(true);
    expect(estimates.filter((estimate) => estimate.anchored === true).every((estimate) =>
      typeof estimate.anchorInputTokens === "number")).toBe(true);
    expect(lines.filter((line) => line.kind === "summary")).toHaveLength(5);
    expect(lines.at(-1)).toMatchObject({ calls: 70, kind: "total", pass: true });
    // Content-free output.
    expect(JSON.stringify(lines)).not.toMatch(/Look up|arrives first|shipped|synthetic-key|R:codex|S:gemini|order_id/u);
  });

  it("reports a rejected replay with its status and structural error fields, the message only on request", async () => {
    const rejecting = vi.fn<typeof fetch>(async () => rejected("input[3]"));
    const quiet = await run(["--providers", "deepseek", "--scenarios", "tools"], { deepseek: rejecting });
    expect(quiet.summary).toEqual({ failedTurns: 1, http4xx: 1, pass: false, skipped: 0 });
    const failure = quiet.lines.find((line) => line.kind === "call");
    expect(failure).toMatchObject({ ok: false, provider: "deepseek", status: 400, step: "t1.r1", transient: false,
      providerError: { code: "fake_invariant", param: "input[3]", type: "invalid_request_error" } });
    expect(JSON.stringify(quiet.lines)).not.toContain("PRIVATE-MESSAGE");
    const detailed = await run(["--providers", "deepseek", "--scenarios", "tools", "--error-detail"], { deepseek: rejecting });
    expect(detailed.lines.find((line) => line.kind === "call")).toMatchObject({
      providerError: { message: "PRIVATE-MESSAGE input[3]" } });
  });

  it("retries a transient failure and skips scenarios without credentials", async () => {
    let calls = 0;
    const flaky = responsesFake("codex-lb", "encrypted");
    const once = vi.fn<typeof fetch>(async (url, init) => ++calls === 1 ? json({ error: { type: "server_error" } }, 502) : flaky(url, init));
    const parsed = await run(["--providers", "codex-lb", "--scenarios", "tools,switch", "--retries", "1"], { "codex-lb": once, openrouter: null });
    expect(parsed.lines.filter((line) => line.kind === "call" && line.ok === false)).toMatchObject([{ status: 502, transient: true }]);
    expect(parsed.lines).toContainEqual({ kind: "skipped", partner: "openrouter", provider: "codex-lb",
      reason: "partner_missing_credentials", scenario: "switch" });
    expect(parsed.summary).toEqual({ failedTurns: 0, http4xx: 0, pass: false, skipped: 1 });
  });

  it("parses flags with cheap defaults and refuses unknown ones", () => {
    const defaults = parseSpikeArguments([]);
    expect(defaults).toMatchObject({ maxOutputTokens: 2_048, providers: SPIKE_PROVIDERS, scenarios: ["tools", "switch", "resume"],
      stream: true, targets: { "codex-lb": { effort: "low", model: "gpt-6-astra" }, openai: { model: "gpt-6-luna" } } });
    expect(parseSpikeArguments(["--providers", "gemini,deepseek", "--model", "gemini=gemini-3.8-flash", "--partner", "gemini=openai",
      "--reasoning-scope", "deepseek=current_turn", "--stream", "false"])).toMatchObject({
      partners: { gemini: "openai" }, providers: ["gemini", "deepseek"], stream: false,
      targets: { deepseek: { reasoningScope: "current_turn" }, gemini: { model: "gemini-3.8-flash" } } });
    expect(parseSpikeArguments(["--help"])).toEqual({ help: true });
    for (const argv of [["--providers", "anthropic"], ["--model", "gemini"], ["--partner", "gemini=gemini"], ["--stream", "yes"],
      ["--max-rounds", "0"], ["--unknown"]]) {
      expect(() => parseSpikeArguments(argv)).toThrow(/^spike_argument_invalid:/u);
    }
  });

  it("builds an accepted safe-fetch configuration for every default endpoint", () => {
    for (const provider of SPIKE_PROVIDERS) {
      const apiRoot = SPIKE_PROVIDER_PROFILES[provider].defaultBaseUrl ?? BASE_URLS["codex-lb"];
      expect(() => normalizeProviderConnectionConfiguration({ allowPrivateNetwork: false, apiRoot, authenticationMode: "bearer",
        responseTimeoutMs: 180_000 })).not.toThrow();
    }
  });
});

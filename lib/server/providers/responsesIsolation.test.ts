import { describe, expect, it } from "vitest";
import {
  createProviderRuntimeBinding,
  normalizeProviderExecutionSnapshot,
  type ProviderExecutionSnapshot,
  type ProviderRuntimeBinding
} from "./runtimeFactory";
import type { ProviderConnectionConfiguration } from "./providerConfiguration";
import type { ProviderRunRequest } from "./types";

type Seed = { kind: "tool" | "json"; name: string; nonce: string };
const schema = { type: "object", additionalProperties: false, required: ["functionName", "nonce"],
  properties: { functionName: { type: "string" }, nonce: { type: "string" } } };
const capabilities = { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false,
  streaming: true, toolCalling: true, vision: false };

function snapshot(
  connection: Partial<ProviderConnectionConfiguration> = {},
  adapterKind: "openai_responses_compatible" | "openai_responses_native" | "openai_chat_completions_compatible" = "openai_responses_compatible"
): ProviderExecutionSnapshot {
  return {
    connection: { allowPrivateNetwork: false, apiRoot: "https://gateway.example.test/v1",
      authenticationMode: "bearer", responseTimeoutMs: 30_000, ...connection },
    connectionDisplayName: "Synthetic gateway", connectionId: "synthetic-connection",
    credentialId: "synthetic-credential", credentialVersionId: "synthetic-credential-version",
    modelDisplayName: "Synthetic model", providerModelId: "synthetic-model", version: 1,
    providerFamily: adapterKind === "openai_responses_native" ? "openai" : "openai_compatible",
    model: { adapterKind, answerSelectable: true, capabilities, defaultParams: {}, modelClass: "answer",
      upstreamModelId: "synthetic-model" }
  };
}

function request(seed: Seed, provider = "openai_compatible", streaming = true): ProviderRunRequest {
  return {
    attachmentIds: [], attachments: [], chatId: "same-synthetic-chat",
    content: { blocks: [{ type: "text", text: JSON.stringify(seed) }] },
    forceNonStreaming: !streaming, knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: capabilities, modelId: "synthetic-model", params: { background: false, store: false, stream: streaming },
    prompt: { developer: null, system: null }, provider, searchPlan: { mode: "all_selected", options: [] },
    toolChoice: "required", toolMode: "auto", tools: [{ capability: "mcp", name: seed.name, strict: true,
      description: "Return this request's synthetic nonce.", inputSchema: { type: "object", additionalProperties: false,
        properties: { nonce: { type: "string" } }, required: ["nonce"] } }]
  };
}

function terminal(seed: Seed) {
  return {
    id: `response-${seed.nonce}`, status: "completed", model: "synthetic-model",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text",
      text: JSON.stringify({ functionName: seed.name, nonce: seed.nonce }) }] },
    ...(seed.kind === "tool" ? [{ type: "function_call", call_id: `call-${seed.nonce}`,
      name: seed.name, arguments: JSON.stringify({ nonce: seed.nonce }) }] : [])],
    usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 }
  };
}

/** A barrier makes the gateway bug deterministic: concurrent requests sharing
 * affinity all read the last request's response slot, without timers or I/O. */
function mixingGateway(width = 4) {
  const calls: Array<{ body: Record<string, unknown>; headers: Headers; url: string }> = [];
  let pending: Array<{ body: Record<string, unknown>; seed: Seed; resolve(response: Response): void }> = [];
  const fetchFn: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const messages = body.input as Array<{ content: Array<{ text: string }> }>;
    const seed = JSON.parse(messages.at(-1)!.content[0]!.text) as Seed;
    if (seed.kind === "tool") {
      expect(body.tools).toMatchObject([{ type: "function", name: seed.name, strict: true }]);
      expect(body.tool_choice).toBe("required");
    } else expect(body.text).toMatchObject({ format: { name: seed.name, type: "json_schema", strict: true } });
    calls.push({ body, headers: new Headers(init?.headers), url: String(url) });
    return new Promise<Response>((resolve) => {
      pending.push({ body, seed, resolve });
      if (pending.length !== width) return;
      const batch = pending;
      pending = [];
      const affinity = (value: Record<string, unknown>) => String(value.prompt_cache_key ?? "shared-affinity");
      const slots = new Map(batch.map((item) => [affinity(item.body), item.seed]));
      for (const item of batch) {
        const winner = slots.get(affinity(item.body))!;
        const response = terminal(winner);
        if (item.body.stream !== true) { item.resolve(Response.json(response)); continue; }
        const events = [
          { type: "response.created", response: { id: response.id, status: "in_progress" } },
          { type: "response.output_text.delta", response_id: response.id,
            delta: JSON.stringify({ functionName: winner.name, nonce: winner.nonce }) },
          { type: "response.completed", response }
        ];
        item.resolve(new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } }));
      }
    });
  };
  return { calls, fetchFn };
}

function bind(value: ProviderExecutionSnapshot, fetchFn: typeof fetch): ProviderRuntimeBinding {
  return createProviderRuntimeBinding({ options: { allowFake: false, disableRequestRetries: true, fetchFn },
    secret: value.connection.authenticationMode === "none" ? null : "synthetic-secret", snapshot: value });
}

async function batch(runtime: ProviderRuntimeBinding, round: number) {
  const seeds = Array.from({ length: 4 }, (_, index): Seed => ({ kind: index % 2 === 0 ? "tool" : "json",
    name: `synthetic_function_${round}_${index}`, nonce: `synthetic_nonce_${round}_${index}` }));
  return Promise.all(seeds.map(async (seed) => {
    if (seed.kind === "json") {
      const result = await runtime.structuredOutputAdapter!.execute({ name: seed.name, schema,
        systemPrompt: "Return the supplied synthetic function name and nonce.", userPrompt: JSON.stringify(seed) });
      return result.functionName === seed.name && result.nonce === seed.nonce;
    }
    const stream = runtime.adapter.stream(request(seed));
    let tokens = "";
    let next = await stream.next();
    while (!next.done) {
      if (next.value.type === "token") tokens += next.value.data.delta;
      next = await stream.next();
    }
    const tool = next.value.toolCalls?.[0];
    return next.value.toolCalls?.length === 1 && tool?.name === seed.name && tool.arguments.nonce === seed.nonce &&
      tokens === JSON.stringify({ functionName: seed.name, nonce: seed.nonce });
  }));
}

describe("compatible Responses request isolation", () => {
  it.each([
    { mode: "auto", detected: true, noAuth: false, isolated: true },
    { mode: "auto", detected: false, noAuth: false, isolated: false },
    { mode: "on", detected: false, noAuth: false, isolated: true },
    { mode: "off", detected: true, noAuth: false, isolated: false },
    { mode: undefined, detected: undefined, noAuth: false, isolated: false },
    { mode: "auto", detected: true, noAuth: true, isolated: true },
    { mode: "off", detected: true, noAuth: true, isolated: false }
  ] as const)("keeps concurrent streaming/JSON identities for mode=$mode detected=$detected noAuth=$noAuth", async (scenario) => {
    const gateway = mixingGateway();
    const configured = snapshot({ responsesRequestIsolation: scenario.mode,
      responsesRequestIsolationDetected: scenario.detected,
      ...(scenario.noAuth ? { allowPrivateNetwork: true, apiRoot: "http://127.0.0.1:11434/v1", authenticationMode: "none" } : {}) });
    const runtime = bind(configured, gateway.fetchFn);
    for (let round = 0; round < 3; round += 1) {
      const matches = await batch(runtime, round);
      if (scenario.isolated) expect(matches).toEqual([true, true, true, true]);
      else expect(matches.filter(Boolean)).toHaveLength(1);
    }
    expect(gateway.calls).toHaveLength(12);
    expect(gateway.calls.filter(({ body }) => body.stream === true)).toHaveLength(6);
    expect(gateway.calls.filter(({ body }) => body.text !== undefined)).toHaveLength(6);
    const keys = gateway.calls.map(({ body }) => body.prompt_cache_key);
    if (scenario.isolated) {
      expect(new Set(keys).size).toBe(12);
      expect(keys.every((key) => typeof key === "string" && key.length > 0 && !key.includes("synthetic"))).toBe(true);
    } else expect(keys).toEqual(Array(12).fill(undefined));
    for (const { body, headers, url } of gateway.calls) {
      expect(url).toBe(`${configured.connection.apiRoot}/responses`);
      expect(headers.get("authorization")).toBe(scenario.noAuth ? null : "Bearer synthetic-secret");
      expect(body.store).toBe(false);
      expect(body).not.toHaveProperty("responsesRequestIsolation");
      expect(body).not.toHaveProperty("responsesRequestIsolationDetected");
    }
  });

  it("retains admitted isolation across configuration changes and restored snapshots", async () => {
    const source = snapshot({ responsesRequestIsolation: "auto", responsesRequestIsolationDetected: true });
    const admitted = normalizeProviderExecutionSnapshot(source);
    const serialized = JSON.stringify(admitted);
    source.connection.responsesRequestIsolation = "off";
    source.connection.responsesRequestIsolationDetected = false;
    const gateway = mixingGateway();
    const runtime = bind(admitted, gateway.fetchFn);
    expect(await batch(runtime, 0)).toEqual([true, true, true, true]);
    const recovered = bind(normalizeProviderExecutionSnapshot(JSON.parse(serialized)), gateway.fetchFn);
    expect(await batch(recovered, 1)).toEqual([true, true, true, true]);
    expect(JSON.stringify(admitted)).toBe(serialized);
    expect(new Set(gateway.calls.map(({ body }) => body.prompt_cache_key)).size).toBe(8);
  });

  it.each(["openai_responses_native", "openai_chat_completions_compatible"] as const)(
    "leaves %s requests unchanged when compatible isolation is enabled", async (adapterKind) => {
      const bodies: Record<string, unknown>[] = [];
      const fetchFn: typeof fetch = async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ ...terminal({ kind: "json", name: "synthetic", nonce: "synthetic" }),
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "synthetic" } }] });
      };
      for (const mode of ["off", "on"] as const) {
        const configured = snapshot({ responsesRequestIsolation: mode, responsesRequestIsolationDetected: true }, adapterKind);
        const stream = bind(configured, fetchFn).adapter.stream({
          ...request({ kind: "json", name: "synthetic", nonce: "synthetic" }, configured.providerFamily, false),
          toolChoice: "none", toolMode: "none", tools: []
        });
        let next = await stream.next();
        while (!next.done) next = await stream.next();
        expect(next.value.finalText).toBeTruthy();
      }
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toEqual(bodies[0]);
      if (adapterKind === "openai_chat_completions_compatible") expect(bodies[1]).not.toHaveProperty("prompt_cache_key");
      else expect(typeof bodies[1]!.prompt_cache_key).toBe("string");
    }
  );
});

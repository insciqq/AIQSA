import { agentFailureCode, agentFailureMessage } from "./failures";
import { transportFailureFacts } from "../providers/providerObservability";
import { effectiveProviderResponseTimeoutMs } from "../providers/providerConfiguration";
import type { ModelRunUsage } from "@/lib/domain/modelRunEvents";
import { readBoundedRequestBody } from "../http/requestBody";
import { extractOpenAIUsage } from "../providers/openaiResponsesResponse";
import { parseSseStream } from "../providers/sse";
import { supportsAgentNativeWebSearch, type AgentResponsesTransport } from "../providers/agentResponses";
import { AGENT_REQUEST_MAX_BYTES, type NormalizedRunAgent } from "./config";
import type { createAgentRunStore } from "./store";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function modelFailureCode(error: unknown) {
  return agentFailureCode(error) ?? (transportFailureFacts(error).category === "dns"
    ? "agent_provider_dns_failed" : "agent_provider_failed");
}

function admitLocalTools(value: unknown, budget: { remaining: number }, webSearch = false, depth = 0): void {
  if (!Array.isArray(value) || depth > 4) throw new Error("agent_model_tools_invalid");
  for (const tool of value) {
    if (--budget.remaining < 0 || !record(tool)) throw new Error("agent_model_tools_invalid");
    if (tool.type === "web_search" && webSearch && depth === 0) {
      if (Object.keys(tool).some((key) => !["type", "external_web_access", "search_content_types", "search_context_size"].includes(key)) ||
        (tool.external_web_access !== undefined && typeof tool.external_web_access !== "boolean") ||
        (tool.search_content_types !== undefined && (!Array.isArray(tool.search_content_types) ||
          tool.search_content_types.length > 2 || tool.search_content_types.some((kind) => !["text", "image"].includes(String(kind))))) ||
        (tool.search_context_size !== undefined && !["low", "medium", "high"].includes(String(tool.search_context_size)))) {
        throw new Error("agent_model_tools_invalid");
      }
      continue;
    }
    if (typeof tool.name !== "string" || !tool.name || tool.name.length > 256) throw new Error("agent_model_tools_invalid");
    if (tool.type === "namespace") admitLocalTools(tool.tools, budget, false, depth + 1);
    else if (tool.type !== "function" && tool.type !== "custom") throw new Error("agent_model_tools_invalid");
  }
}

/** Only verified native search may join local tools; no hosted MCP or file access. */
export function admittedAgentRequest(value: unknown, modelId: string, maxOutputTokens: number, nativeWebSearch = false): Record<string, unknown> {
  if (!record(value) || value.model !== modelId || value.stream !== true || !Array.isArray(value.input) ||
    value.input.length > 20_000 || value.previous_response_id !== undefined || value.background === true) {
    throw new Error("agent_model_request_invalid");
  }
  const toolBudget = { remaining: 256 };
  if (value.tools !== undefined) admitLocalTools(value.tools, toolBudget, nativeWebSearch);
  for (const item of value.input) {
    if (!record(item) || !["message", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "reasoning", "compaction", "additional_tools", ...(nativeWebSearch ? ["web_search_call"] : []), undefined].includes(item.type as string | undefined)) {
      throw new Error("agent_model_input_invalid");
    }
    if (item.type === "web_search_call" && (!record(item.action) ||
      !["search", "open_page", "find_in_page"].includes(String(item.action.type)))) throw new Error("agent_model_input_invalid");
    // Native Codex model profiles can declare namespaced local tools in the
    // input instead of the top-level tools array. The same hosted-tool fence applies.
    if (item.type === "additional_tools") admitLocalTools(item.tools, toolBudget);
    // Tool results can also carry multimodal content. Apply the same source
    // restrictions there so an output cannot introduce a provider file ID.
    const parts = [item.content, item.output].filter(Array.isArray).flat();
    // Native reasoning models replay their provider-issued reasoning items on
    // subsequent tool steps. Keep these opaque to AIQSA while admitting the
    // Responses text format used by DeepSeek and OpenAI.
    const contentTypes = item.type === "reasoning" ? ["reasoning_text"] : ["input_text", "output_text", "input_image"];
    for (const content of parts) {
      if (!record(content) || !contentTypes.includes(String(content.type)) ||
        content.file_id !== undefined || (content.type === "input_image" &&
          (typeof content.image_url !== "string" || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/u.test(content.image_url)))) {
        throw new Error("agent_model_input_invalid");
      }
    }
  }
  const allowed = new Set(["input", "instructions", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "text", "include", "prompt_cache_key"]);
  return { ...Object.fromEntries(Object.entries(value).filter(([key]) => allowed.has(key))),
    model: modelId, stream: true, store: false, max_output_tokens: maxOutputTokens };
}

export function createAgentModelGateway(input: Readonly<{
  configuration: NormalizedRunAgent;
  transport: AgentResponsesTransport;
  store: Pick<ReturnType<typeof createAgentRunStore>, "assertActive" | "reserveProvider" | "settleProvider">;
  signal: AbortSignal;
  onFailure(code: string): Promise<void>;
  onUsage(): Promise<void>;
}>) {
  return async (request: Request): Promise<Response> => {
    const requestTimeoutMs = effectiveProviderResponseTimeoutMs(input.transport.snapshot.connection,
      input.transport.snapshot.model.adapterKind === "fake" ? null : input.transport.snapshot.model);
    const signal = AbortSignal.any([input.signal, request.signal, AbortSignal.timeout(requestTimeoutMs)]);
    let attemptId: string | null = null;
    let usage: ModelRunUsage | null = null;
    let settled = false;
    const settle = async (state: "COMPLETE" | "ERROR" | "UNKNOWN") => {
      if (settled || !attemptId) return;
      await input.store.settleProvider(attemptId, state, usage);
      settled = true;
      await input.onUsage();
    };
    try {
      await input.store.assertActive();
      const bytes = await readBoundedRequestBody(request, { maxBytes: AGENT_REQUEST_MAX_BYTES, signal });
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      const body = admittedAgentRequest(value, input.transport.snapshot.model.upstreamModelId, input.configuration.maxOutputTokens,
        supportsAgentNativeWebSearch(input.transport.snapshot));
      if (input.configuration.limitsEnabled && supportsAgentNativeWebSearch(input.transport.snapshot) && input.transport.snapshot.model.adapterKind === "openai_responses_native") {
        body.max_tool_calls = input.configuration.maxToolCalls;
      }
      // Conservative pre-dispatch reservation; only actual provider usage is billed.
      attemptId = await input.store.reserveProvider(Buffer.byteLength(JSON.stringify(body)) + input.configuration.maxOutputTokens);
      await input.store.assertActive();
      const response = await input.transport.request(body, signal);
      if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
        await response.body?.cancel().catch(() => undefined);
        await settle("ERROR");
        throw new Error("agent_provider_failed");
      }
      const events = parseSseStream(response.body, { signal, maxBytes: 64 * 1024 * 1024,
        maxEventBytes: 2 * 1024 * 1024, maxDurationMs: requestTimeoutMs });
      const encoder = new TextEncoder();
      let terminal = false;
      let completed = false;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await events.next();
            if (next.done) {
              if (!terminal) throw new Error("agent_provider_incomplete");
              controller.close();
              return;
            }
            const event = next.value;
            if (event.data === "[DONE]") {
              if (!terminal) throw new Error("agent_provider_incomplete");
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              return;
            }
            const payload: unknown = JSON.parse(event.data);
            if (!record(payload)) throw new Error("agent_provider_invalid");
            if (payload.type === "error") throw new Error("agent_provider_failed");
            if (["response.completed", "response.failed", "response.incomplete"].includes(String(payload.type))) {
              if (terminal || !record(payload.response)) throw new Error("agent_provider_invalid");
              terminal = true;
              usage = extractOpenAIUsage(payload.response);
              await settle(payload.type === "response.completed" ? "COMPLETE" : "ERROR");
              if (payload.type !== "response.completed") throw new Error(payload.type === "response.incomplete" &&
                record(payload.response.incomplete_details) && payload.response.incomplete_details.reason === "max_output_tokens"
                ? "agent_generation_output_limit" : "agent_provider_failed");
              completed = true;
            }
            controller.enqueue(encoder.encode(`event: ${event.event}\ndata: ${event.data}\n\n`));
            if (completed) {
              controller.close();
              await events.return(undefined).catch(() => undefined);
            }
          } catch (error) {
            // Codex can close immediately after the terminal receipt. Do not
            // let a pending stream read/cancel revoke a successfully settled turn.
            if (completed) return;
            await settle("UNKNOWN").catch(() => undefined);
            await events.return(undefined).catch(() => undefined);
            const code = modelFailureCode(error);
            await input.onFailure(code).catch(() => undefined);
            controller.error(new Error(code));
          }
        },
        async cancel() {
          await events.return(undefined).catch(() => undefined);
          if (!terminal) {
            await settle("UNKNOWN").catch(() => undefined);
            await input.onFailure("agent_provider_interrupted").catch(() => undefined);
          }
        }
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
    } catch (error) {
      await settle("UNKNOWN").catch(() => undefined);
      const code = modelFailureCode(error);
      await input.onFailure(code).catch(() => undefined);
      return Response.json({ error: { code, message: agentFailureMessage(code) } }, { status: 502 });
    }
  };
}

import { agentFailureCode, agentFailureMessage, type AgentFailureCode } from "./failures";
import { transportFailureFacts } from "../providers/providerObservability";
import { effectiveProviderResponseTimeoutMs } from "../providers/providerConfiguration";
import type { ModelRunUsage } from "@/lib/domain/modelRunEvents";
import { readBoundedRequestBody } from "../http/requestBody";
import { extractOpenAIUsage } from "../providers/openaiResponsesResponse";
import { parseSseStream } from "../providers/sse";
import { supportsAgentNativeWebSearch, type AgentResponsesTransport } from "../providers/agentResponses";
import { AGENT_REQUEST_MAX_BYTES, type NormalizedRunAgent } from "./config";
import type { createAgentRunStore } from "./store";
import { setTimeout as sleep } from "node:timers/promises";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function modelFailureCode(error: unknown) {
  const existing = agentFailureCode(error);
  if (existing) return existing;
  const transport = transportFailureFacts(error);
  if (transport.category === "dns") return "agent_provider_dns_failed";
  if (["ECONNRESET", "EPIPE"].includes(transport.code ?? "")) return "agent_provider_connection_lost";
  return "agent_provider_failed";
}

class RetryableProviderError extends Error {
  constructor(code: AgentFailureCode) { super(code); }
}

function retryableProviderFailure(error: unknown): boolean {
  if (error instanceof RetryableProviderError) return true;
  const facts = transportFailureFacts(error);
  return facts.category === "dns" || facts.category === "connect" ||
    ["provider_http_request_failed", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ETIMEDOUT"].includes(facts.code ?? "");
}

function providerEventFailure(value: unknown): Error {
  return record(value) && ["server_error", "rate_limit_exceeded"].includes(String(value.code))
    ? new RetryableProviderError("agent_provider_failed") : new Error("agent_provider_failed");
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
  store: Pick<ReturnType<typeof createAgentRunStore>, "assertActive" | "reserveProvider" | "settleProvider" | "canRetryProvider"
    | "closeProvider" | "releaseModelTools" | "expectedFollowupInterruption">;
  signal: AbortSignal;
  onFailure(code: string): Promise<void>;
  onUsage(): Promise<void>;
}>) {
  return async (request: Request): Promise<Response> => {
    const requestTimeoutMs = effectiveProviderResponseTimeoutMs(input.transport.snapshot.connection,
      input.transport.snapshot.model.adapterKind === "fake" ? null : input.transport.snapshot.model);
    const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
    const parentSignal = AbortSignal.any([input.signal, request.signal, timeoutSignal]);
    const transportController = new AbortController();
    const signal = AbortSignal.any([parentSignal, transportController.signal]);
    let attemptId: string | null = null;
    let usage: ModelRunUsage | null = null;
    let settled = false;
    let events: ReturnType<typeof parseSseStream> | null = null;
    let closing: Promise<void> | null = null;
    const closeTransport = () => closing ??= (async () => {
      transportController.abort();
      await events?.return(undefined);
      if (attemptId) await input.store.closeProvider(attemptId);
    })();
    const settle = async (state: "COMPLETE" | "ERROR" | "UNKNOWN") => {
      if (settled || !attemptId) return;
      await input.store.settleProvider(attemptId, state, usage);
      settled = true;
      await input.onUsage();
    };
    const failure = async (error: unknown) => {
      // Only an owned cancellation is steering. A real EOF/provider error
      // still fails even when an interrupt request happens concurrently.
      if (!timeoutSignal.aborted && (parentSignal.aborted || error instanceof Error && error.message === "agent_followup_interrupt") &&
        await input.store.expectedFollowupInterruption()) return "agent_provider_interrupted" as const;
      let code = modelFailureCode(error);
      if (attemptId && settled && !parentSignal.aborted && retryableProviderFailure(error)) {
        try {
          if (await input.store.canRetryProvider(attemptId)) return code;
        } catch (authorityError) {
          code = agentFailureCode(authorityError) ?? code;
        }
      }
      await input.onFailure(code).catch(() => undefined);
      return code;
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
      // Hosted tools can have effects before their first streamed event.
      if (supportsAgentNativeWebSearch(input.transport.snapshot)) await input.store.releaseModelTools(attemptId);
      await input.store.assertActive();
      const response = await input.transport.request(body, signal);
      if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
        await response.body?.cancel().catch(() => undefined);
        await settle("ERROR");
        if ([408, 429, 500, 502, 503, 504].includes(response.status)) throw new RetryableProviderError("agent_provider_failed");
        throw new Error("agent_provider_failed");
      }
      events = parseSseStream(response.body, { signal, maxBytes: 64 * 1024 * 1024,
        maxEventBytes: 2 * 1024 * 1024, maxDurationMs: requestTimeoutMs });
      const encoder = new TextEncoder();
      let terminal = false;
      let completed = false;
      let toolsReleased = false;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await events!.next();
            if (next.done) {
              if (!terminal) throw new RetryableProviderError("agent_provider_connection_lost");
              controller.close();
              return;
            }
            const event = next.value;
            if (event.data === "[DONE]") {
              if (!terminal) throw new RetryableProviderError("agent_provider_connection_lost");
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              return;
            }
            const payload: unknown = JSON.parse(event.data);
            if (!record(payload)) throw new Error("agent_provider_invalid");
            if (payload.type === "error") throw providerEventFailure(payload.error ?? payload);
            // Codex may act on an item before response.completed. Commit this
            // fence BEFORE forwarding any executable (or unknown) item.
            const item = record(payload.item) ? payload.item : null;
            const output = record(payload.response) && Array.isArray(payload.response.output) ? payload.response.output : [];
            if (!toolsReleased && (item && !["message", "reasoning", "compaction"].includes(String(item.type)) ||
              output.some(entry => !record(entry) || !["message", "reasoning", "compaction"].includes(String(entry.type))) ||
              /(?:function_call|custom_tool_call|web_search_call)/u.test(String(payload.type)))) {
              await input.store.releaseModelTools(attemptId!);
              toolsReleased = true;
            }
            if (["response.completed", "response.failed", "response.incomplete"].includes(String(payload.type))) {
              if (terminal || !record(payload.response)) throw new Error("agent_provider_invalid");
              terminal = true;
              usage = extractOpenAIUsage(payload.response);
              await settle(payload.type === "response.completed" ? "COMPLETE" : "ERROR");
              if (payload.type === "response.failed") throw providerEventFailure(payload.response.error);
              if (payload.type === "response.incomplete") throw new Error(
                record(payload.response.incomplete_details) && payload.response.incomplete_details.reason === "max_output_tokens"
                  ? "agent_generation_output_limit" : "agent_provider_failed");
              completed = true;
            }
            controller.enqueue(encoder.encode(`event: ${event.event}\ndata: ${event.data}\n\n`));
            if (completed) {
              controller.close();
              await closeTransport();
            }
          } catch (error) {
            // Codex can close immediately after the terminal receipt. Do not
            // let a pending stream read/cancel revoke a successfully settled turn.
            if (completed) return;
            if (error instanceof Error && error.message === "agent_followup_interrupt" &&
              await input.store.expectedFollowupInterruption()) {
              // Keep the old native request parked until its owned SIGINT,
              // instead of letting a fenced tool proposal become a failure.
              await sleep(5_000, undefined, { signal }).catch(() => undefined);
            }
            await settle("UNKNOWN").catch(() => undefined);
            await closeTransport().catch(() => undefined);
            // Codex owns reconnection and already-executed tool history. A
            // recoverable physical failure settles its receipt without
            // revoking the live executor; exhausted/permanent failures do.
            const code = await failure(error);
            controller.error(new Error(code));
          }
        },
        async cancel() {
          await closeTransport().catch(() => undefined);
          if (!terminal) {
            await settle("UNKNOWN").catch(() => undefined);
            if (timeoutSignal.aborted || !(await input.store.expectedFollowupInterruption())) {
              await input.onFailure("agent_provider_interrupted").catch(() => undefined);
            }
          }
        }
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
    } catch (error) {
      await settle("UNKNOWN").catch(() => undefined);
      if (error instanceof Error && error.message === "agent_followup_interrupt" &&
        await input.store.expectedFollowupInterruption()) {
        await sleep(5_000, undefined, { signal: parentSignal }).catch(() => undefined);
      }
      await closeTransport().catch(() => undefined);
      const code = await failure(error);
      return Response.json({ error: { code, message: agentFailureMessage(code) } }, { status: 502 });
    }
  };
}

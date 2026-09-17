import { agentFailureCode, agentFailureMessage } from "./failures";
import { effectiveProviderResponseTimeoutMs } from "../providers/providerConfiguration";
import { readBoundedRequestBody } from "../http/requestBody";
import { readCodexWebSearchResponse } from "../providers/codexWebSearch";
import { extractOpenAIUsage } from "../providers/openaiResponsesResponse";
import { supportsAgentStandaloneWebSearch, type AgentResponsesTransport } from "../providers/agentResponses";
import type { createAgentRunStore } from "./store";
import type { NormalizedRunAgent } from "./config";
import { AGENT_REQUEST_MAX_BYTES } from "./config";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function admittedAgentSearchRequest(value: unknown, model: string, maxOutputTokens: number): Record<string, unknown> {
  if (!record(value) || value.model !== model || typeof value.id !== "string" ||
    !/^[a-f0-9-]{36}$/iu.test(value.id) || !Array.isArray(value.input) || value.input.length > 20_000 ||
    !record(value.commands) || !record(value.settings) ||
    Object.keys(value).some((key) => !["id", "model", "input", "commands", "settings", "max_output_tokens"].includes(key)) ||
    !Number.isSafeInteger(value.max_output_tokens) || Number(value.max_output_tokens) < 1) throw new Error("agent_search_request_invalid");
  const commandNames = ["search_query", "open", "find", "click", "image_query", "screenshot", "finance", "weather", "sports", "time"];
  let calls = 0;
  for (const [name, command] of Object.entries(value.commands)) {
    if (name === "response_length" && ["short", "medium", "long"].includes(String(command))) continue;
    if (!commandNames.includes(name) || !Array.isArray(command) || command.some((item) => !record(item))) throw new Error("agent_search_request_invalid");
    calls += command.length;
  }
  if (calls < 1 || calls > 32) throw new Error("agent_search_request_invalid");
  return { id: value.id, model, input: value.input, commands: value.commands,
    settings: { allowed_callers: ["direct"], external_web_access: true },
    max_output_tokens: Math.min(Number(value.max_output_tokens), maxOutputTokens, 10_000) };
}

/** A native Codex tool transport, using the same frozen model, lease and budget as generation. */
export function createAgentSearchGateway(input: Readonly<{
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
    let settled = false;
    try {
      await input.store.assertActive();
      if (!supportsAgentStandaloneWebSearch(input.transport.snapshot) || !input.transport.search) throw new Error("agent_search_not_admitted");
      const bytes = await readBoundedRequestBody(request, { maxBytes: AGENT_REQUEST_MAX_BYTES, signal });
      const body = admittedAgentSearchRequest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        input.transport.snapshot.model.upstreamModelId, input.configuration.maxOutputTokens);
      attemptId = await input.store.reserveProvider(Buffer.byteLength(JSON.stringify(body)) + Number(body.max_output_tokens), { kind: "native_search" });
      await input.store.assertActive();
      const result = await readCodexWebSearchResponse(await input.transport.search(body, signal), signal);
      // Codex alpha/search may omit usage. Persist the physical operation with
      // unknown accounting; never infer free search from that omission.
      await input.store.settleProvider(attemptId, "COMPLETE", extractOpenAIUsage(result));
      settled = true;
      await input.onUsage();
      return Response.json(result, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (attemptId && !settled) {
        await input.store.settleProvider(attemptId, "UNKNOWN", null).catch(() => undefined);
        await input.onUsage().catch(() => undefined);
      }
      const code = agentFailureCode(error) ?? "agent_search_failed";
      await input.onFailure(code).catch(() => undefined);
      return Response.json({ error: { code, message: agentFailureMessage(code) } }, { status: 502 });
    }
  };
}

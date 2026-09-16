import type { ProviderExecutionSnapshot } from "./runtimeFactory";
import { effectiveProviderResponseTimeoutMs, providerAuthenticationMode } from "./providerConfiguration";
import { resolveProviderCredentialSource, type ProviderCredentialSource } from "./providerCredentialSource";
import { normalizeOpenRouterParams } from "../../domain/providerParams";
import { buildProviderRouting } from "./openRouterChatRequest";

export type AgentResponsesTransport = Readonly<{
  snapshot: ProviderExecutionSnapshot;
  request(body: Record<string, unknown>, signal: AbortSignal): Promise<Response>;
  search?(body: Record<string, unknown>, signal: AbortSignal): Promise<Response>;
}>;

/** Explicit native Responses lane; ordinary OpenRouter chat stays unchanged. */
export function supportsAgentResponses(snapshot: ProviderExecutionSnapshot): boolean {
  return supportsAgentAdapter(snapshot.model.adapterKind);
}

export function supportsAgentAdapter(adapterKind: string): boolean {
  return ["openai_responses_native", "openai_responses_compatible", "deepseek_responses_native",
    "openrouter_chat_completions"].includes(adapterKind);
}

/** Use the admitted capability, not a model-name guess or a guest request. */
export function supportsAgentNativeWebSearch(snapshot: ProviderExecutionSnapshot): boolean {
  return snapshot.model.capabilities?.nativeSearch === true &&
    ["openai_responses_native", "openai_responses_compatible"].includes(snapshot.model.adapterKind);
}

export function supportsAgentStandaloneWebSearch(snapshot: ProviderExecutionSnapshot): boolean {
  return snapshot.model.adapterKind === "openai_responses_compatible" && snapshot.model.capabilities?.codexStandaloneWebSearch === true;
}

export function createAgentResponsesTransport(input: Readonly<{
  snapshot: ProviderExecutionSnapshot;
  secret: ProviderCredentialSource | null;
  fetch: typeof fetch;
}>): AgentResponsesTransport | undefined {
  if (!supportsAgentResponses(input.snapshot)) return undefined;
  const root = input.snapshot.connection.apiRoot.replace(/\/+$/u, "");
  const dispatch = async (path: "responses" | "alpha/search", body: Record<string, unknown>, signal: AbortSignal) => {
    const headers = new Headers({ "content-type": "application/json", accept: path === "responses" ? "text/event-stream" : "application/json" });
    if (providerAuthenticationMode(input.snapshot.connection) !== "none") {
      if (input.secret === null) throw new Error("credential_revoked");
      headers.set("authorization", `Bearer ${await resolveProviderCredentialSource(input.secret, "credential_revoked")}`);
    }
    // No provider SDK retries: every physical request has one durable receipt.
    const admitted = input.snapshot.model.adapterKind === "openrouter_chat_completions"
      ? { ...body, provider: buildProviderRouting(normalizeOpenRouterParams(input.snapshot.model.defaultParams)) } : body;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(effectiveProviderResponseTimeoutMs(
      input.snapshot.connection, input.snapshot.model.adapterKind === "fake" ? null : input.snapshot.model
    ))]);
    return input.fetch(`${root}/${path}`, { method: "POST", headers, body: JSON.stringify(admitted), signal: deadline, redirect: "error" });
  };
  return {
    snapshot: input.snapshot,
    request: (body, signal) => dispatch("responses", body, signal),
    ...(supportsAgentStandaloneWebSearch(input.snapshot) ? { search: (body: Record<string, unknown>, signal: AbortSignal) => dispatch("alpha/search", body, signal) } : {})
  };
}

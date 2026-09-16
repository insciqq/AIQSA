import type { ProviderModelConfiguration, ProviderConnectionConfiguration } from "./providerConfiguration";
import type { AdminProviderTestEvidence } from "../../contracts/adminProviders";
import { readBoundedResponseText } from "./network";

type Evidence = NonNullable<AdminProviderTestEvidence["codexWebSearch"]>;

/** The explicit Codex root selects a probe, never grants capability or rewrites a destination. */
export function shouldProbeCodexWebSearch(model: ProviderModelConfiguration, connection?: Pick<ProviderConnectionConfiguration, "apiRoot">): boolean {
  return model.modelClass === "answer" && model.adapterKind === "openai_responses_compatible" &&
    (model.capabilities.codexStandaloneWebSearch === true || Boolean(connection &&
      new URL(connection.apiRoot).pathname.replace(/\/+$/u, "").endsWith("/backend-api/codex")));
}

export function decodeCodexWebSearchEvidence(value: unknown): Evidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.adapterKind !== "openai_responses_compatible" || item.probeVersion !== 1 || item.verified !== true ||
    typeof item.upstreamModelId !== "string" || !item.upstreamModelId.trim() ||
    item.upstreamModelId !== item.upstreamModelId.trim() || item.upstreamModelId.length > 512 ||
    !Number.isSafeInteger(item.sourceCount) || Number(item.sourceCount) < 1 || Number(item.sourceCount) > 1000) return null;
  return { adapterKind: item.adapterKind, probeVersion: 1, verified: true,
    upstreamModelId: item.upstreamModelId, sourceCount: Number(item.sourceCount) };
}

export function hasVerifiedCodexWebSearch(evidence: unknown, model: { adapterKind: string; upstreamModelId: string }): boolean {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return false;
  const proof = decodeCodexWebSearchEvidence((evidence as Record<string, unknown>).codexWebSearch);
  return proof?.adapterKind === model.adapterKind && proof.upstreamModelId === model.upstreamModelId;
}

/** Preserve the native encrypted continuation and sources; raw bodies are never receipts. */
export async function readCodexWebSearchResponse(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
    await response.body?.cancel().catch(() => undefined);
    throw Object.assign(new Error([404, 405].includes(response.status) ? "provider_capability_unsupported" : "agent_search_failed"),
      { httpStatus: response.status, unsupportedCapability: "codexWebSearch" });
  }
  const body: unknown = JSON.parse(await readBoundedResponseText(response, { signal, maxBytes: 8 * 1024 * 1024 }));
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("agent_search_response_invalid");
  const value = body as Record<string, unknown>;
  if (typeof value.output !== "string" || typeof value.encrypted_output !== "string" ||
    !Array.isArray(value.results) || value.results.length > 1000) throw new Error("agent_search_response_invalid");
  return value;
}

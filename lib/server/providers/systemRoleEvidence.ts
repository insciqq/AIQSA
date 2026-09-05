import type { ProviderModelConfiguration } from "./providerConfiguration";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exact connection/model/credential versions are selected by admission first.
 * These receipts prove the dedicated protocols, independently of generation. */
export function hasVerifiedDedicatedProtocol(
  evidence: unknown, model: ProviderModelConfiguration
): boolean {
  if (!record(evidence) || evidence.upstreamModelId !== model.upstreamModelId ||
    !["tiny_generation", "openrouter_account_catalog"].includes(String(evidence.method)) ||
    JSON.stringify(evidence.selectedProviders) !== JSON.stringify(model.openRouterRouting?.providers ?? [])) return false;
  if (model.modelClass === "embedding") {
    const proof = evidence.embedding;
    return record(proof) && proof.probeVersion === 1 && proof.document === true && proof.query === true &&
      Number.isSafeInteger(proof.dimensions) && proof.dimensions === model.embedding?.targetDimension;
  }
  if (model.modelClass === "reranker") {
    return record(evidence.reranking) && evidence.reranking.probeVersion === 1 &&
      evidence.reranking.completeScores === true;
  }
  return false;
}

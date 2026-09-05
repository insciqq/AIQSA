import { describe, expect, it } from "vitest";
import type { ProviderModelConfiguration } from "./providerConfiguration";
import { hasVerifiedDedicatedProtocol } from "./systemRoleEvidence";

const model = {
  adapterKind: "openai_embeddings_compatible", answerSelectable: false, modelClass: "embedding",
  capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
  defaultParams: {}, upstreamModelId: "embedding", openRouterRouting: { mode: "only_selected", providers: ["A", "B"] },
  embedding: { nativeDimension: 1024, targetDimension: 1024, supportsMrl: false, providerFamily: "openrouter", queryInstructionTemplate: null }
} as const satisfies ProviderModelConfiguration;
const evidence = { method: "tiny_generation", upstreamModelId: "embedding", selectedProviders: ["A", "B"],
  embedding: { probeVersion: 1, document: true, query: true, dimensions: 1024 } };

describe("dedicated System Model protocol receipts", () => {
  it("requires both embedding modes at the exact finite dimension and provider route", () => {
    expect(hasVerifiedDedicatedProtocol(evidence, model)).toBe(true);
    for (const value of [
      { ...evidence, embedding: undefined },
      { ...evidence, embedding: { ...evidence.embedding, query: false } },
      { ...evidence, embedding: { ...evidence.embedding, dimensions: Infinity } },
      { ...evidence, embedding: { ...evidence.embedding, dimensions: 512 } },
      { ...evidence, selectedProviders: ["B", "A"] },
      { ...evidence, upstreamModelId: "substitute" }
    ]) expect(hasVerifiedDedicatedProtocol(value, model)).toBe(false);
  });
  it("keeps embedding, reranking and generation protocols independent", () => {
    const reranker: ProviderModelConfiguration = { ...model, modelClass: "reranker", adapterKind: "openrouter_rerank" };
    const proof = { ...evidence, embedding: undefined, reranking: { probeVersion: 1, completeScores: true } };
    expect(hasVerifiedDedicatedProtocol(proof, reranker)).toBe(true);
    expect(hasVerifiedDedicatedProtocol(evidence, reranker)).toBe(false);
    expect(hasVerifiedDedicatedProtocol(proof, model)).toBe(false);
    expect(hasVerifiedDedicatedProtocol(proof, { ...reranker, modelClass: "answer" })).toBe(false);
    expect(hasVerifiedDedicatedProtocol({ ...proof, reranking: { probeVersion: 1, completeScores: false } }, reranker)).toBe(false);
  });
});

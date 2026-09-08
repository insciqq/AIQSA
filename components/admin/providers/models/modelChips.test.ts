import { describe, expect, it } from "vitest";
import type { AdminProviderCheckRun, AdminProviderTestEvidence } from "@/lib/contracts/adminProviders";
import { fixtureCheck } from "@/components/admin/providers/providerFixtures";
import { modelChipsFromEvidence, modelUsageMissing, modelWorksWith } from "./modelChips";

const answer = { adapterKind: "openai_responses_native" as const, modelClass: "answer" as const, upstreamModelId: "gpt-5.6-sol" };

function evidence(overrides: Partial<AdminProviderTestEvidence> = {}): AdminProviderTestEvidence {
  return {
    compatibility: {
      directPdf: "verified",
      forcedToolCall: "verified",
      toolCalling: "verified",
      modelAccess: "verified",
      probeVersion: 1,
      streaming: "verified",
      structuredOutput: "verified",
      usage: "verified",
      vision: "verified"
    },
    detail: "ok",
    method: "tiny_generation",
    selectedProviders: [],
    upstreamModelId: "gpt-5.6-sol",
    ...overrides
  };
}

function run(overrides: Partial<AdminProviderCheckRun> = {}): AdminProviderCheckRun {
  return {
    credentialId: "cred-primary",
    current: null,
    done: 0,
    failed: [],
    finishedAt: null,
    id: "run-1",
    inFlight: [],
    reason: "credential",
    startedAt: "2026-09-07T12:51:00.000Z",
    state: "running",
    total: 1,
    ...overrides
  };
}

describe("modelChipsFromEvidence", () => {
  it("keeps ordinary Tools and JSON green when strict Memory calls are unsupported", () => {
    const check = fixtureCheck({ credentialId: "cred-primary", providerModelId: "m", evidence: evidence({
      compatibility: { ...evidence().compatibility!, probeVersion: 2, forcedToolCall: "not_supported" }
    }) });
    expect(modelChipsFromEvidence({ ...answer, adapterKind: "openrouter_chat_completions" }, check).slice(0, 2))
      .toEqual([{ key: "tools", label: "Tools", tone: "ok" }, { key: "json", label: "JSON", tone: "ok" }]);
  });

  it.each(["not_supported", "verified"] as const)("does not relabel old %s strict-call results as ordinary Tools or native JSON", (status) => {
    const check = fixtureCheck({ credentialId: "cred-primary", providerModelId: "m", evidence: evidence({
      compatibility: { ...evidence().compatibility!, probeVersion: 1, toolCalling: undefined,
        forcedToolCall: status, structuredOutput: status }
    }) });
    const chips = modelChipsFromEvidence({ ...answer, adapterKind: "openrouter_chat_completions" }, check);
    expect(chips.some(({ key }) => key === "tools" || key === "json")).toBe(false);
    expect(chips.some(({ key, tone }) => key === "images" && tone === "ok")).toBe(true);
  });

  it("maps verified results to green chips, not_supported to muted ones and PDF to a yellow No PDF", () => {
    const check = fixtureCheck({
      credentialId: "cred-primary",
      evidence: evidence({ compatibility: { ...evidence().compatibility!, directPdf: "not_supported", toolCalling: "not_supported" } }),
      providerModelId: "m"
    });
    expect(modelChipsFromEvidence(answer, check)).toEqual([
      { key: "tools", label: "Tools", tone: "muted" },
      { key: "json", label: "JSON", tone: "ok" },
      { key: "pdf", label: "No PDF", tone: "warn" },
      { key: "images", label: "Images", tone: "ok" },
      { key: "stream", label: "Stream", tone: "ok" }
    ]);
  });

  it("omits chips without a result and ignores evidence made for another upstream id", () => {
    const partial = fixtureCheck({
      credentialId: "cred-primary",
      evidence: evidence({ compatibility: { directPdf: "verified", modelAccess: "verified", probeVersion: 1, streaming: "verified", structuredOutput: "not_supported", usage: "not_supported" } }),
      providerModelId: "m"
    });
    expect(modelChipsFromEvidence(answer, partial).map(({ key }) => key)).toEqual(["json", "pdf", "stream"]);
    expect(modelUsageMissing(answer, partial)).toBe(true);
    const foreign = fixtureCheck({ credentialId: "cred-primary", evidence: evidence({ upstreamModelId: "other" }), providerModelId: "m" });
    expect(modelChipsFromEvidence(answer, foreign)).toEqual([]);
    expect(modelChipsFromEvidence(answer, null)).toEqual([]);
  });

  it("reads older evidence blocks, embedding and reranking results, and an unavailable model", () => {
    const legacy = fixtureCheck({
      credentialId: "cred-primary",
      evidence: evidence({
        compatibility: undefined,
        pdfInput: { adapterKind: "openai_responses_native", probeVersion: 1, upstreamModelId: "gpt-5.6-sol", verified: true }
      }),
      providerModelId: "m"
    });
    expect(modelChipsFromEvidence(answer, legacy)).toEqual([{ key: "pdf", label: "PDF", tone: "ok" }]);
    const embedding = fixtureCheck({
      credentialId: "cred-primary",
      evidence: evidence({ embedding: { dimensions: 1_536, document: true, probeVersion: 1, query: true } }),
      providerModelId: "e"
    });
    expect(modelChipsFromEvidence({ adapterKind: "openai_embeddings_compatible", modelClass: "embedding", upstreamModelId: "gpt-5.6-sol" }, embedding))
      .toEqual([{ key: "embeddings", label: "Embeddings", tone: "ok" }]);
    const reranker = fixtureCheck({
      credentialId: "cred-primary",
      evidence: evidence({ reranking: { completeScores: true, probeVersion: 1 } }),
      providerModelId: "r"
    });
    expect(modelChipsFromEvidence({ adapterKind: "openrouter_rerank", modelClass: "reranker", upstreamModelId: "gpt-5.6-sol" }, reranker))
      .toEqual([{ key: "reranking", label: "Reranking", tone: "ok" }]);
    const unavailable = fixtureCheck({
      credentialId: "cred-primary",
      evidence: evidence({ detail: "model_missing" }),
      providerModelId: "m",
      status: "unavailable"
    });
    expect(modelChipsFromEvidence(answer, unavailable)).toEqual([{ key: "unavailable", label: "Not available", tone: "warn" }]);
  });
});

describe("modelWorksWith", () => {
  const check = fixtureCheck({ credentialId: "cred-primary", evidence: evidence(), providerModelId: "m" });

  it("shows a check in progress, then a temporary failure with the chips it kept, then the chips", () => {
    expect(modelWorksWith({ check, checkRun: run({ inFlight: ["m"] }), configuration: answer, defaultCredentialId: "cred-primary", modelId: "m" }))
      .toEqual({ kind: "checking", label: "Checking tools, JSON, PDF, images and streaming…" });
    expect(modelWorksWith({
      check: { ...check, latestRefreshError: { code: "provider_refresh_failed", version: 1 }, refreshFailedAt: "2026-09-07T13:00:00.000Z" },
      checkRun: null,
      configuration: answer,
      defaultCredentialId: "cred-primary",
      modelId: "m"
    })).toMatchObject({ chips: expect.arrayContaining([{ key: "tools", label: "Tools", tone: "ok" }]), kind: "failed", usageMissing: false });
    expect(modelWorksWith({ check, checkRun: run({ done: 1, state: "completed" }), configuration: answer, defaultCredentialId: "cred-primary", modelId: "m" }))
      .toMatchObject({ kind: "checked" });
  });

  it("uses the run's failure list only for the default key and reads no result as not checked", () => {
    const failedRun = run({ done: 1, failed: ["m"], state: "completed" });
    expect(modelWorksWith({ check: null, checkRun: failedRun, configuration: answer, defaultCredentialId: "cred-primary", modelId: "m" }))
      .toEqual({ chips: [], kind: "failed", usageMissing: false });
    expect(modelWorksWith({ check: null, checkRun: { ...failedRun, credentialId: "cred-other" }, configuration: answer, defaultCredentialId: "cred-primary", modelId: "m" }))
      .toEqual({ kind: "not_checked" });
    expect(modelWorksWith({ check: null, checkRun: undefined, configuration: { adapterKind: "openrouter_rerank", modelClass: "reranker", upstreamModelId: "x" }, defaultCredentialId: null, modelId: "m" }))
      .toEqual({ kind: "not_checked" });
  });
});

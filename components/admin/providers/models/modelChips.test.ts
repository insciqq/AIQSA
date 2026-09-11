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
  it.each(["incomplete", "rejected", "unsupported"] as const)("makes %s Memory actions visible independently of Tools", (status) => {
    const check = fixtureCheck({ credentialId: "cred-primary", providerModelId: "m", evidence: evidence({
      compatibility: { ...evidence().compatibility!, forcedToolCall: "not_supported" },
      capabilitySetup: { policyVersion: 2, checks: { forcedToolCall: status }, attempts: {
        forcedToolCall: { attempts: 1, status: status === "rejected" ? "incomplete" : status, reason: status === "unsupported" ? "route_unsupported" : "invalid_input", httpStatus: 400 }
      } }
    }) });
    const chips = modelChipsFromEvidence(answer, check);
    expect(chips).toContainEqual(expect.objectContaining({ key: "tools", tone: "ok" }));
    expect(chips).toContainEqual(expect.objectContaining({ key: "memoryActions",
      label: status === "unsupported" ? "Memory actions: unsupported" : "Memory actions: check incomplete",
      help: expect.stringContaining("HTTP 400") }));
  });
  it.each([
    ["incomplete", "Inconclusive: this check did not prove support."],
    ["unsupported", "Unsupported on this route."],
    ["not_checked", "Not checked with this key."]
  ] as const)("keeps %s PDF results muted with a distinct explanation", (status, help) => {
    const check = fixtureCheck({ credentialId: "cred-primary", providerModelId: "m", evidence: evidence({
      compatibility: { ...evidence().compatibility!, directPdf: "not_supported" },
      capabilitySetup: { policyVersion: 1, checks: { modelAccess: "verified", directPdf: status } }
    }) });
    const chips = modelChipsFromEvidence(answer, check);
    expect(chips).toContainEqual({ key: "pdf", label: "PDF", tone: "muted", help });
    expect(chips).not.toContainEqual(expect.objectContaining({ label: "No PDF" }));
    expect(chips).toContainEqual({ key: "json", label: "JSON", tone: "ok" });
  });

  it("keeps ordinary Tools and JSON green when strict Memory calls are unsupported", () => {
    const check = fixtureCheck({ credentialId: "cred-primary", providerModelId: "m", evidence: evidence({
      compatibility: { ...evidence().compatibility!, probeVersion: 2, forcedToolCall: "not_supported", parallelToolCalls: "not_supported" },
      capabilitySetup: { policyVersion: 2, checks: { forcedToolCall: "unsupported", parallelToolCalls: "incomplete" },
        attempts: { parallelToolCalls: { attempts: 3, status: "incomplete", reason: "malformed_tool_output" } } }
    }) });
    expect(modelChipsFromEvidence({ ...answer, adapterKind: "openrouter_chat_completions" }, check).slice(0, 2))
      .toEqual([expect.objectContaining({ key: "tools", label: "Tools", tone: "ok",
        help: "Ordinary function calling verified with this key. Strict Memory calls: Unsupported on this route. Parallel tool calls: Inconclusive: this check did not prove support. the model returned an invalid tool call · 3 attempts." }),
      { key: "json", label: "JSON", tone: "ok" }]);
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

  it("does not treat legacy absence of proof as verified incompatibility", () => {
    const check = fixtureCheck({
      credentialId: "cred-primary",
      evidence: evidence({ compatibility: { ...evidence().compatibility!, directPdf: "not_supported", toolCalling: "not_supported" } }),
      providerModelId: "m"
    });
    expect(modelChipsFromEvidence(answer, check)).toEqual([
      expect.objectContaining({ key: "tools", label: "Tools", tone: "muted", help: expect.stringContaining("Not verified with this key. This does not establish that the capability is unsupported.") }),
      { key: "json", label: "JSON", tone: "ok" },
      { key: "pdf", label: "PDF", tone: "muted", help: "Not verified with this key. This does not establish that the capability is unsupported." },
      { key: "images", label: "Images", tone: "ok" },
      { key: "stream", label: "Stream", tone: "ok" }
    ]);
  });

  it("keeps retained positive proof green and explains the latest inconclusive attempt", () => {
    const check = fixtureCheck({ credentialId: "cred-primary", providerModelId: "m", evidence: evidence({
      capabilitySetup: { policyVersion: 2, checks: { directPdf: "verified" },
        attempts: { directPdf: { attempts: 2, status: "incomplete", reason: "http_error", httpStatus: 503 } } }
    }) });
    expect(modelChipsFromEvidence(answer, check)).toContainEqual({ key: "pdf", label: "PDF", tone: "ok",
      help: "Previously verified. Latest check inconclusive: provider request failed · HTTP 503 · 2 attempts." });
  });

  it.each(["embedding", "reranker"] as const)("explains an unverified %s result without a critical chip", (modelClass) => {
    const key = modelClass === "embedding" ? "embedding" : "reranking";
    const check = fixtureCheck({ credentialId: "cred-primary", providerModelId: "m", evidence: evidence({
      capabilitySetup: { policyVersion: 2, checks: { [key]: "incomplete" },
        attempts: { [key]: { attempts: 1, status: "incomplete", reason: "timeout" } } }
    }) });
    expect(modelChipsFromEvidence({ ...answer, modelClass }, check)).toEqual([expect.objectContaining({
      tone: "muted", help: "Inconclusive: this check did not prove support. check timed out · 1 attempt."
    })]);
  });

  it("explains image limitations while retaining independently verified editing", () => {
    const configuration = { ...answer, adapterKind: "openai_images_native" as const, modelClass: "image" as const };
    const check = fixtureCheck({ credentialId: "cred-primary", providerModelId: "m", evidence: evidence({
      imageEditing: { adapterKind: "openai_images_native", upstreamModelId: answer.upstreamModelId, verified: true, probeVersion: 1 },
      capabilitySetup: { policyVersion: 2, checks: { imageGeneration: "incomplete", imageEditing: "verified" },
        attempts: { imageGeneration: { attempts: 1, status: "incomplete", reason: "semantic_inconclusive" } } }
    }) });
    expect(modelChipsFromEvidence(configuration, check)).toEqual([
      { key: "imageGeneration", label: "Generate images", tone: "muted", help: "Inconclusive: this check did not prove support. response did not prove the capability · 1 attempt. Retry the check to verify this capability." },
      { key: "imageEditing", label: "Edit images", tone: "ok" }
    ]);
    const unavailable = { ...check, status: "unavailable" as const, evidence: evidence({
      capabilitySetup: { policyVersion: 2, checks: { modelAccess: "unsupported", imageGeneration: "unsupported" },
        attempts: { imageGeneration: { attempts: 1, status: "unsupported", reason: "route_unsupported", httpStatus: 404 } } }
    }) };
    expect(modelChipsFromEvidence(configuration, unavailable)).toEqual([expect.objectContaining({ tone: "critical",
      help: expect.stringContaining("Image generation: no supporting endpoint on this route · HTTP 404 · 1 attempt.") })]);
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
    expect(modelChipsFromEvidence(answer, unavailable)).toEqual([{ key: "unavailable", label: "Not available", tone: "critical" }]);
  });
});

describe("modelWorksWith", () => {
  const check = fixtureCheck({ credentialId: "cred-primary", evidence: evidence(), providerModelId: "m" });

  it("shows progress and keeps prior chips with a quiet explanation after refresh failure", () => {
    expect(modelWorksWith({ check, checkRun: run({ inFlight: ["m"] }), configuration: answer, defaultCredentialId: "cred-primary", modelId: "m" }))
      .toEqual({ kind: "checking", label: "Checking tools, JSON, PDF, images and streaming…" });
    expect(modelWorksWith({
      check: { ...check, latestRefreshError: { code: "provider_refresh_failed", version: 1 }, refreshFailedAt: "2026-09-07T13:00:00.000Z" },
      checkRun: null,
      configuration: answer,
      defaultCredentialId: "cred-primary",
      modelId: "m"
    })).toMatchObject({ chips: expect.arrayContaining([expect.objectContaining({ key: "tools", label: "Tools", tone: "ok",
      help: expect.stringContaining("The latest model check could not finish. Earlier saved results are kept.") })]), kind: "checked", usageMissing: false });
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

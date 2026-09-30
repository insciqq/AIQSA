import { describe, expect, it } from "vitest";
import { activationEvidenceHash, activationReceiptHash, projectActivationAccounting, requireActivationAccountingBoundary,
  requireActivationBackgroundProfile, requireActivationSettledWork, summarizeActivationUsage, type ActivationUsageReceipt } from "./workspace-activation-accounting";

const receipt: ActivationUsageReceipt = { usageCompleteness: "COMPLETE", inputTokens: 10, outputTokens: 2,
  totalTokens: 12, estimatedCostMicros: 4, operationCount: 1 };

describe("experiment receipt accounting", () => {
  it("retains a numeric partial subtotal without reporting it as a complete total", () => {
    const result = summarizeActivationUsage([receipt, { ...receipt, usageCompleteness: "PARTIAL" }]);
    expect(result.inputTokens).toEqual({ total: null, knownSum: 20, reported: 2, missing: 0 });
    expect(result.totalTokens.total).toBeNull();
    expect(result.incompleteRecordCount).toBe(1);
    expect(result.paidRequests).toBe(2);
  });
  it("keeps missing receipts and operation counts unknown, independently of known zero", () => {
    const result = summarizeActivationUsage([receipt, { ...receipt, inputTokens: null, totalTokens: null,
      estimatedCostMicros: null, operationCount: null, usageCompleteness: "UNAVAILABLE" }]);
    expect(result.estimatedCostMicros).toEqual({ total: null, knownSum: 4, reported: 1, missing: 1 });
    expect(result.paidRequests).toBeNull();
    expect(result.paidRequestCounts).toEqual({ knownSum: 1, reported: 1, missing: 1 });
    expect(summarizeActivationUsage([{ ...receipt, estimatedCostMicros: 0 }]).estimatedCostMicros.total).toBe(0);
    expect(summarizeActivationUsage([]).totalTokens.total).toBeNull();
  });
  it("projects accounting only and rejects impossible complete totals", () => {
    const accounting = summarizeActivationUsage([receipt]);
    expect(projectActivationAccounting({ ...accounting, privatePayload: "private" } as typeof accounting)).toEqual(accounting);
    expect(() => projectActivationAccounting({ ...accounting, incompleteRecordCount: 1 })).toThrow("accounting_total_invalid");
    expect(() => projectActivationAccounting({ ...accounting, recordCount: -1 })).toThrow("accounting_count_invalid");
  });
});

describe("experiment cleanup accounting fence", () => {
  it("retains late auxiliary accounting even when its parent answer is terminal", () => {
    expect(() => requireActivationSettledWork({ activeToolCalls: 0, dispatchedVisionAttempts: 0 })).not.toThrow();
    expect(() => requireActivationSettledWork({ activeToolCalls: 1, dispatchedVisionAttempts: 0 })).toThrow("provider_accounting_pending");
    expect(() => requireActivationSettledWork({ activeToolCalls: 0, dispatchedVisionAttempts: 1 })).toThrow("provider_accounting_pending");
  });
  const owned = { ...receipt, id: "synthetic-receipt", memoryExecutionBindingId: null };
  const proof = { [owned.id]: activationReceiptHash(owned) };
  const boundary = { receipts: [owned], bindings: [], recordedReceipts: proof, recordedMemoryBindings: [] };
  it("accepts unchanged recorded receipts and an already cleaned row on resume", () => {
    expect(() => requireActivationAccountingBoundary(boundary)).not.toThrow();
    expect(() => requireActivationAccountingBoundary({ ...boundary, receipts: [] })).not.toThrow();
  });
  it("refuses late/unattributed or changed usage before destructive cleanup", () => {
    expect(() => requireActivationAccountingBoundary({ ...boundary,
      receipts: [...boundary.receipts, { ...owned, id: "late-background-receipt" }] })).toThrow("unattributed_provider_accounting");
    expect(() => requireActivationAccountingBoundary({ ...boundary,
      receipts: [{ ...owned, estimatedCostMicros: 100 }] })).toThrow("provider_accounting_changed");
    expect(() => requireActivationAccountingBoundary({ ...boundary, recordedReceipts: {} })).toThrow("unattributed_provider_accounting");
  });
  it("retains pending bindings and started bindings without a recorded receipt", () => {
    for (const state of ["PENDING", "RUNNING"]) expect(() => requireActivationAccountingBoundary({ ...boundary,
      bindings: [{ id: "binding", state, startedAt: null }] })).toThrow("provider_accounting_pending");
    expect(() => requireActivationAccountingBoundary({ ...boundary,
      bindings: [{ id: "binding", state: "OUTCOME_UNKNOWN", startedAt: new Date() }] })).toThrow("provider_accounting_receipt_missing");
    expect(() => requireActivationAccountingBoundary({ ...boundary, recordedMemoryBindings: ["binding"],
      bindings: [{ id: "binding", state: "OUTCOME_UNKNOWN", startedAt: new Date() }] })).not.toThrow();
  });
  it("hashes only receipt accounting and binding identity, never incidental payloads", () => {
    expect(activationReceiptHash({ ...owned, privateContent: "do not retain" } as typeof owned)).toBe(proof[owned.id]);
    expect(activationReceiptHash({ ...owned, operationCount: 2 })).not.toBe(proof[owned.id]);
  });
});

describe("frozen experiment provider profile", () => {
  const profile = { system: { providerModelId: null, chatTitleProviderModelId: null,
    decisionProviderModelId: null, rerankerProviderModelId: null }, memory: { providerModelId: null }, memoryEmbeddingDefault: null };
  it("requires the explicitly unassigned background destinations without changing user defaults", () => {
    expect(() => requireActivationBackgroundProfile(profile)).not.toThrow();
    expect(() => requireActivationBackgroundProfile({ ...profile, system: null })).toThrow("background_provider_profile_required");
    expect(() => requireActivationBackgroundProfile({ ...profile, memory: { providerModelId: "utility" } })).toThrow("background_provider_profile_required");
    expect(() => requireActivationBackgroundProfile({ ...profile, memoryEmbeddingDefault: "embedding" })).toThrow("background_provider_profile_required");
    for (const field of Object.keys(profile.system)) expect(() => requireActivationBackgroundProfile({ ...profile,
      system: { ...profile.system, [field]: "enabled" } })).toThrow("background_provider_profile_required");
  });
  it("distinguishes Vision, Memory and exact Search configuration while ignoring JSON object ordering", () => {
    const environment = { system: { ...profile.system, visionProviderModelId: "vision-a" }, memory: profile.memory,
      searches: [{ optionId: "search", providerModelId: "search-model-a", revisionId: "revision-a" }] };
    const hash = activationEvidenceHash(environment);
    expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(activationEvidenceHash({ searches: environment.searches, memory: environment.memory, system: environment.system })).toBe(hash);
    expect(activationEvidenceHash({ ...environment, system: { ...environment.system, visionProviderModelId: "vision-b" } })).not.toBe(hash);
    expect(activationEvidenceHash({ ...environment, memory: { providerModelId: "memory" } })).not.toBe(hash);
    expect(activationEvidenceHash({ ...environment, searches: [{ ...environment.searches[0], revisionId: "revision-b" }] })).not.toBe(hash);
  });
});

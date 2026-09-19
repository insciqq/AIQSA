import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { jevModelConfiguration, JEV_SERVED_MODEL_ID } from "../../domain/decisionModels";
import { encryptProviderCredentialSecret } from "../providers/credentialSecrets";
import { createPrismaDecisionRuntime, createAcceptedDecisionRuntime } from "./decisionRuntime";
import { ProviderAdmissionError } from "./admission";
import { createDecisionModelRoleResolver } from "./decisionModelRole";

const KEY = Buffer.alloc(32, 19);
const model = jevModelConfiguration();
const connection = { allowPrivateNetwork: false, apiRoot: "https://openrouter.ai/api/v1", authenticationMode: "bearer", responseTimeoutMs: 30_000 };
const proof = { method: "tiny_generation", detail: "ok", upstreamModelId: model.upstreamModelId, selectedProviders: ["typesafe"],
  decisions: { probeVersion: 1, adapterKind: "openrouter_decisions", upstreamModelId: model.upstreamModelId,
    servedModelId: JEV_SERVED_MODEL_ID, provider: "TypeSafe", noul: true, choice: true } };
const request = { state: "Synthetic example", questions: { relevant: { type: "noul" as const, instructions: "Is this an example?" } } };
function fixture() {
  const secretEnvelope = encryptProviderCredentialSecret({ credentialId: "credential", valueId: "version", key: KEY, secret: "exact-decision-key" });
  const version = { credentialId: "credential", id: "version", revokedAt: null as Date | null, secretEnvelope };
  const db = {
    providerCredential: { findMany: vi.fn(async () => [{ id: "credential", enabled: true, activeVersion: version }]) },
    providerCredentialVersion: { findFirst: vi.fn(async () => version) },
    providerGroupCredentialAssignment: { findMany: vi.fn(async () => []) },
    providerUserCredentialAssignment: { findUnique: vi.fn(async () => null) },
    providerModel: {
      findUnique: vi.fn(async () => ({ connectionId: "connection" })),
      findFirst: vi.fn(async () => ({ id: "decision", displayName: "Jev", provider: "openrouter", connectionId: "connection",
        activeConfig: model, activeVersion: 4, enabled: true, connection: {
          activeConfig: connection, activeVersion: 3, id: "connection", displayName: "OpenRouter", family: "openrouter",
          enabled: true, defaultCredentialId: "credential", unassignedPolicy: "use_default"
        } }))
    },
    providerModelCredentialCheck: { findFirst: vi.fn(async () => ({ id: "check", evidence: proof })) }
  };
  const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ model: JEV_SERVED_MODEL_ID, provider: "TypeSafe",
    answers: { relevant: { type: "noul", noul: 0.7 } }, usage: { input_tokens: 10, output_tokens: 21, cost: 0.00000042 } }));
  const runtime = createPrismaDecisionRuntime(db as unknown as PrismaClient, { createFetch: () => fetchFn, encryptionKey: () => KEY });
  return { db, version, fetchFn, runtime };
}

describe("independent Decisions authority", () => {
  it("admits only the exact checked installation-default model/key tuple", async () => {
    const { runtime, db, fetchFn } = fixture();
    const binding = await runtime.resolveForInstallation({ providerModelId: "decision" });
    expect(db.providerModel.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ modelClass: "decision", id: "decision" }) }));
    expect(db.providerModelCredentialCheck.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
      connectionId: "connection", connectionVersion: 3, credentialId: "credential", credentialVersionId: "version",
      modelVersion: 4, providerModelId: "decision", status: "available"
    } }));
    expect(db.providerGroupCredentialAssignment.findMany).not.toHaveBeenCalled();
    expect(db.providerUserCredentialAssignment.findUnique).not.toHaveBeenCalled();
    expect(binding.executionSnapshot.decisionVerification).toEqual(proof.decisions);
    expect(JSON.stringify(binding.executionSnapshot)).not.toContain("exact-decision-key");
    await binding.adapter.decide(request);
    expect(new Headers(fetchFn.mock.calls[0]![1]!.headers).get("authorization")).toBe("Bearer exact-decision-key");
  });

  it.each([
    { method: "models_catalog" }, { decisions: undefined },
    { decisions: { ...proof.decisions, servedModelId: "typesafe/jev-1.13-new" } },
    { decisions: { ...proof.decisions, provider: "other" } }, { selectedProviders: ["other"] },
    { decisions: { ...proof.decisions, choice: false } }
  ])("rejects catalog-only, incomplete and mismatched capability proof (%#)", async (change) => {
    const { runtime, db, fetchFn } = fixture();
    db.providerModelCredentialCheck.findFirst.mockResolvedValue({ id: "check", evidence: { ...proof, ...change } } as never);
    await expect(runtime.resolveForInstallation({ providerModelId: "decision" })).rejects.toMatchObject({ code: "model_not_available" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("restores accepted authority without consulting mutable model or role state", async () => {
    const { runtime, db, fetchFn } = fixture();
    const admitted = await runtime.resolveForInstallation({ providerModelId: "decision" });
    db.providerModel.findFirst.mockClear(); db.providerModel.findUnique.mockClear();
    const accepted = await createAcceptedDecisionRuntime({ providerCredentialVersion: db.providerCredentialVersion } as never,
      { createFetch: () => fetchFn, encryptionKey: () => KEY }).resolve(admitted);
    await accepted.adapter.decide(request);
    expect(db.providerModel.findFirst).not.toHaveBeenCalled(); expect(db.providerModel.findUnique).not.toHaveBeenCalled();
    expect(db.providerCredentialVersion.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { credentialId: "credential", id: "version" } }));
  });

  it("revokes an accepted key before dispatch without relabelling the security error", async () => {
    const { runtime, version, fetchFn } = fixture();
    const binding = await runtime.resolveForInstallation({ providerModelId: "decision" });
    version.revokedAt = new Date();
    await expect(binding.adapter.decide(request)).rejects.toBeInstanceOf(ProviderAdmissionError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("pins the actually checked served identity through recovery", async () => {
    const { runtime, fetchFn } = fixture();
    const binding = await runtime.resolveForInstallation({ providerModelId: "decision" });
    fetchFn.mockResolvedValue(Response.json({ model: model.upstreamModelId, provider: "TypeSafe",
      answers: { relevant: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 2, output_tokens: 21 } }));
    await expect(binding.adapter.decide(request)).rejects.toMatchObject({ code: "decision_response_model_mismatch", receipt: { usage: { inputTokens: 2 } } });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("rejects swapped accepted bindings before any secret lookup", async () => {
    const { runtime, db, fetchFn } = fixture();
    const binding = await runtime.resolveForInstallation({ providerModelId: "decision" });
    await expect(createAcceptedDecisionRuntime(db as never).resolve({ ...binding, credentialVersionId: "different" }))
      .rejects.toMatchObject({ code: "model_not_available" });
    expect(db.providerCredentialVersion.findFirst).not.toHaveBeenCalled(); expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("optional Decisions model role", () => {
  it("enables qualified consumers by default while preserving per-feature opt-outs", async () => {
    const policy = { decisionProviderModelId: "chosen", decisionFeaturesJson: {} as Record<string, boolean>, version: 1 };
    const db = { systemModelPolicy: { findUnique: vi.fn(async () => policy) } };
    const loadRole = vi.fn(async () => { throw new ProviderAdmissionError("model_not_available"); });
    const role = createDecisionModelRoleResolver(db as never, { loadRole });
    for (const feature of ["memoryRelevance", "knowledgeRelevance", "toolDiscovery", "skillSuggestions"] as const) {
      expect(await role.resolve(feature)).toMatchObject({ code: "decision_model_unavailable" });
      policy.decisionFeaturesJson[feature] = false;
      expect(await role.resolve(feature)).toMatchObject({ code: "decision_feature_disabled" });
    }
    expect(loadRole).toHaveBeenCalledTimes(4);
  });

  it.each([null, { decisionProviderModelId: null, decisionFeaturesJson: {}, version: 1 },
    { decisionProviderModelId: "decision", decisionFeaturesJson: { memoryRelevance: false }, version: 2 }])
  ("does no admission work when absent or explicitly disabled (%#)", async (policy) => {
    const loadRole = vi.fn();
    const db = { systemModelPolicy: { findUnique: vi.fn(async () => policy) } };
    expect((await createDecisionModelRoleResolver(db as never, { loadRole }).resolve("memoryRelevance")).ok).toBe(false);
    expect(loadRole).not.toHaveBeenCalled();
  });

  it("resolves only the selected role and preserves unexpected database failures", async () => {
    const db = { systemModelPolicy: { findUnique: vi.fn(async () => ({ decisionProviderModelId: "chosen", decisionFeaturesJson: { memoryRelevance: true }, version: 3 })) } };
    const loadRole = vi.fn(async () => { throw new ProviderAdmissionError("model_not_available"); });
    const role = createDecisionModelRoleResolver(db as never, { loadRole });
    expect(await role.resolve("memoryRelevance")).toEqual({ ok: false, code: "decision_model_unavailable", selectedProviderModelId: "chosen" });
    expect(loadRole).toHaveBeenCalledExactlyOnceWith(db, { providerModelId: "chosen" });
    const failure = new Error("synthetic database error"); loadRole.mockRejectedValue(failure);
    await expect(role.resolve("memoryRelevance")).rejects.toBe(failure);
  });
});

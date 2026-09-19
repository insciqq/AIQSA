import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { jevModelConfiguration, JEV_MODEL_ID, JEV_SERVED_MODEL_ID } from "../../../domain/decisionModels";
import { ProviderAdmissionError } from "../../providerRuntime/admission";
import { createAdminSystemModelPolicyService } from "./systemModelPolicyService";

// Exercise adoption after consumer qualification, independently of which
// consumers are enabled in a particular product release.
vi.mock("../../../domain/decisionModels", async (original) => ({
  ...await original<typeof import("../../../domain/decisionModels")>(), DEFAULT_DECISION_FEATURES: ["memoryRelevance"]
}));

function fixture() {
  const policy = { version: 4, decisionConfiguredAt: null as Date | null, decisionProviderModelId: null as string | null };
  const update = vi.fn(async () => {});
  const tx = { $queryRaw: vi.fn(async () => [policy]), user: { findFirst: vi.fn(async () => ({ id: "admin" })) },
    systemModelPolicy: { update, findUnique: vi.fn(async () => ({ decisionFeaturesJson: { memoryRelevance: false } })) } };
  const db = { $transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<void>) => callback(tx)) };
  const loadDecisionRole = vi.fn(async () => ({ configuration: jevModelConfiguration(),
    snapshot: { decisionVerification: { servedModelId: JEV_SERVED_MODEL_ID, provider: "TypeSafe" } } }));
  const service = createAdminSystemModelPolicyService(db as unknown as PrismaClient, { loadDecisionRole: loadDecisionRole as never });
  return { service, update, policy, tx, loadDecisionRole };
}

describe("optional decision role policy", () => {
  it.each([null, "selected"])("saves an explicit choice and preserves independent roles (%s)", async (id) => {
    const f = fixture();
    await f.service.update({ expectedVersion: 4, userId: "admin", decisionProviderModelId: id });
    expect(f.update).toHaveBeenCalledExactlyOnceWith({ where: { id: "installation" }, data: {
      decisionProviderModelId: id, decisionConfiguredAt: expect.any(Date), updatedByUserId: "admin", version: { increment: 1 }
    } });
    expect(f.loadDecisionRole).toHaveBeenCalledTimes(id ? 1 : 0);
  });

  it("merges an independent feature choice without erasing existing opt-outs", async () => {
    const f = fixture();
    await f.service.update({ expectedVersion: 4, userId: "admin", decisionFeatures: { knowledgeRelevance: true } });
    expect(f.update).toHaveBeenCalledWith({ where: { id: "installation" }, data: {
      decisionFeaturesJson: { memoryRelevance: false, knowledgeRelevance: true }, updatedByUserId: "admin", version: { increment: 1 }
    } });
    expect(f.loadDecisionRole).not.toHaveBeenCalled();
  });

  it.each(["cleared", "selected"])("preserves an earlier administrator choice during bootstrap (%s)", async (state) => {
    const f = fixture();
    if (state === "cleared") f.policy.decisionConfiguredAt = new Date();
    else f.policy.decisionProviderModelId = "another";
    expect(await f.service.adoptDecisionModel({ expectedVersion: 4, userId: "admin", providerModelId: "recommended" })).toBe(false);
    expect(f.update).not.toHaveBeenCalled(); expect(f.loadDecisionRole).not.toHaveBeenCalled();
  });

  it("adopts the verified recommended deployment under the policy lock", async () => {
    const f = fixture();
    expect(await f.service.adoptDecisionModel({ expectedVersion: 4, userId: "admin", providerModelId: "recommended" })).toBe(true);
    expect(f.tx.$queryRaw).toHaveBeenCalledOnce();
    expect(f.loadDecisionRole).toHaveBeenCalledExactlyOnceWith(f.tx, { providerModelId: "recommended" });
    expect(f.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ decisionProviderModelId: "recommended" }) }));
  });

  it.each([
    { servedModelId: JEV_MODEL_ID, provider: "TypeSafe" },
    { servedModelId: "typesafe/jev-1.13-20990101", provider: "TypeSafe" },
    { servedModelId: JEV_SERVED_MODEL_ID, provider: "another" }
  ])("does not automatically adopt an unqualified served identity (%j)", async (proof) => {
    const f = fixture();
    f.loadDecisionRole.mockResolvedValue({ configuration: jevModelConfiguration(), snapshot: { decisionVerification: proof } });
    await expect(f.service.adoptDecisionModel({ expectedVersion: 4, userId: "admin", providerModelId: "recommended" }))
      .rejects.toMatchObject({ code: "system_model_policy_target_unavailable" });
    expect(f.update).not.toHaveBeenCalled();
  });

  it.each(["stale", "non-admin", "unverified"])("does not mutate policy when authority is invalid (%s)", async (state) => {
    const f = fixture();
    if (state === "stale") f.policy.version = 5;
    if (state === "non-admin") f.tx.user.findFirst.mockResolvedValue(null as never);
    if (state === "unverified") f.loadDecisionRole.mockRejectedValue(new ProviderAdmissionError("model_not_available"));
    await expect(f.service.update({ expectedVersion: 4, userId: "admin", decisionProviderModelId: "selected" }))
      .rejects.toMatchObject({ code: state === "stale" ? "system_model_policy_stale" : "system_model_policy_target_unavailable" });
    expect(f.update).not.toHaveBeenCalled();
  });
});

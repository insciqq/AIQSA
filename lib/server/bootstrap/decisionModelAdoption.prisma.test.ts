import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../prisma";
import { adoptDecisionModelOnUpgrade } from "./decisionModelAdoption";
import { DEFAULT_DECISION_FEATURES, JEV_MODEL_ID, JEV_SERVED_MODEL_ID, jevModelConfiguration } from "../../domain/decisionModels";
import { encryptProviderCredentialSecret } from "../providers/credentialSecrets";
import { createDecisionModelRoleResolver } from "../providerRuntime/decisionModelRole";
import type { AdminProviderDraftTester } from "../admin/providers/tester";
import type { AdminProviderTestEvidence } from "../../contracts/adminProviders";

const encryptionKey = Buffer.alloc(32, 47);
afterAll(() => prisma.$disconnect());
const proof: AdminProviderTestEvidence = {
  method: "tiny_generation", detail: "ok", selectedProviders: ["typesafe"], upstreamModelId: JEV_MODEL_ID,
  decisions: { probeVersion: 1, adapterKind: "openrouter_decisions", noul: true, choice: true,
    upstreamModelId: JEV_MODEL_ID, servedModelId: JEV_SERVED_MODEL_ID, provider: "TypeSafe" },
  compatibility: { probeVersion: 1, modelAccess: "verified", directPdf: "not_supported", streaming: "not_supported",
    structuredOutput: "not_supported", usage: "verified" }
};

async function fixture(run: (context: {
  connectionId: string; credentialId: string; versionId: string;
  test: ReturnType<typeof vi.fn<AdminProviderDraftTester["test"]>>;
  adopt(): ReturnType<typeof adoptDecisionModelOnUpgrade>;
  resetClaim(): Promise<void>;
}) => Promise<void>) {
  const original = await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  const connectionId = randomUUID(), credentialId = randomUUID(), versionId = randomUUID();
  const configuration = { apiRoot: "https://provider.example.test/v1", authenticationMode: "bearer", allowPrivateNetwork: false, responseTimeoutMs: 300_000 };
  const resetClaim = async () => {
    await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: {
      decisionProviderModelId: null, decisionConfiguredAt: null, decisionFeaturesJson: {}, decisionAdoptionVersion: 0, decisionAdoptionReason: null
    } });
  };
  try {
    await resetClaim();
    await prisma.providerConnection.create({ data: { id: connectionId, family: "openrouter", displayName: "Upgrade fixture",
      enabled: true, draftConfig: configuration, activeConfig: configuration, activeVersion: 1, draftVersion: 1, activatedAt: new Date() } });
    await prisma.providerCredential.create({ data: { id: credentialId, connectionId, label: "Synthetic key", enabled: true } });
    await prisma.providerCredentialVersion.create({ data: { id: versionId, credentialId, version: 1,
      testedAt: new Date(), activatedAt: new Date(), testEvidence: { authenticationMode: "bearer" },
      secretEnvelope: encryptProviderCredentialSecret({ credentialId, valueId: versionId, secret: "synthetic-upgrade-key", key: encryptionKey }) } });
    await prisma.providerCredential.update({ where: { id: credentialId }, data: { activeVersionId: versionId, activatedAt: new Date() } });
    await prisma.providerConnection.update({ where: { id: connectionId }, data: { defaultCredentialId: credentialId } });
    // Limit only the startup scan. All publication, admission, claims and
    // transaction races still use real PostgreSQL and the production owners.
    const db = new Proxy(prisma, { get(target, key) {
      if (key === "providerConnection") return new Proxy(target.providerConnection, { get(delegate, method) {
        if (method === "findMany") return (args: Prisma.ProviderConnectionFindManyArgs) => delegate.findMany({
          ...args, where: { AND: [args.where ?? {}, { id: connectionId }] }
        });
        return Reflect.get(delegate, method);
      } });
      return Reflect.get(target, key);
    } }) as PrismaClient;
    const test = vi.fn<AdminProviderDraftTester["test"]>(async input => {
      expect(input.model.openRouterRouting).toEqual({ mode: "only_selected", providers: ["typesafe"] });
      expect(typeof input.secret).toBe("function");
      expect(await (input.secret as () => Promise<string>)()).toBe("synthetic-upgrade-key");
      return { status: "available", evidence: proof };
    });
    await run({ connectionId, credentialId, versionId, test, resetClaim,
      adopt: () => adoptDecisionModelOnUpgrade({ db, tester: { test }, encryptionKey: () => encryptionKey }) });
  } finally {
    await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: {
      decisionProviderModelId: original.decisionProviderModelId, decisionConfiguredAt: original.decisionConfiguredAt,
      decisionFeaturesJson: original.decisionFeaturesJson as Prisma.InputJsonValue,
      decisionAdoptionVersion: original.decisionAdoptionVersion, decisionAdoptionReason: original.decisionAdoptionReason,
      version: original.version, updatedByUserId: original.updatedByUserId, updatedAt: original.updatedAt
    } });
    await prisma.accessGrant.deleteMany({ where: { providerModel: { connectionId } } });
    await prisma.providerModelCredentialCheck.deleteMany({ where: { connectionId } });
    await prisma.providerDraftCheck.deleteMany({ where: { connectionId } });
    await prisma.providerModel.deleteMany({ where: { connectionId } });
    await prisma.providerConnection.updateMany({ where: { id: connectionId }, data: { defaultCredentialId: null } });
    await prisma.providerCredential.updateMany({ where: { connectionId }, data: { activeVersionId: null } });
    await prisma.providerCredentialVersion.deleteMany({ where: { credentialId } });
    await prisma.providerCredential.deleteMany({ where: { connectionId } });
    await prisma.accessGrant.deleteMany({ where: { providerConnectionId: connectionId } });
    await prisma.providerConnection.deleteMany({ where: { id: connectionId } });
  }
}

describe("existing-installation Jev upgrade", () => {
  it("verifies, enables all qualified consumers and preserves unrelated roles; the next start does no work", async () => {
    await fixture(async ({ adopt, test, connectionId }) => {
      const before = await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
      expect(await adopt()).toBe("applied");
      expect(test).toHaveBeenCalledOnce();
      const model = await prisma.providerModel.findFirstOrThrow({ where: { connectionId, modelId: JEV_MODEL_ID } });
      expect(model).toMatchObject({ enabled: true, modelClass: "decision", activeVersion: 1,
        activeConfig: { answerSelectable: false, openRouterRouting: { mode: "only_selected", providers: ["typesafe"] } } });
      const after = await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
      expect(after).toEqual({ ...before, decisionAdoptionVersion: 1, decisionAdoptionReason: "applied",
        decisionProviderModelId: model.id, decisionConfiguredAt: expect.any(Date), updatedAt: expect.any(Date),
        version: before.version + 1, updatedByUserId: null });
      for (const feature of DEFAULT_DECISION_FEATURES) {
        expect(await createDecisionModelRoleResolver(prisma).resolve(feature)).toMatchObject({ ok: true, providerModelId: model.id });
      }
      expect(await adopt()).toBe("already_attempted");
      expect(test).toHaveBeenCalledOnce();
      expect(await prisma.providerModel.count({ where: { connectionId } })).toBe(1);
    });
  });

  it.each(["explicit_off", "all_features_off", "already_attempted"])("preserves %s without creating a model or calling a provider", async state => {
    await fixture(async ({ adopt, test, connectionId }) => {
      await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: {
        ...(state === "explicit_off" ? { decisionConfiguredAt: new Date() } : {}),
        ...(state === "all_features_off" ? { decisionFeaturesJson: Object.fromEntries(DEFAULT_DECISION_FEATURES.map(f => [f, false])) } : {}),
        ...(state === "already_attempted" ? { decisionAdoptionVersion: 1, decisionAdoptionReason: "verification_required" } : {})
      } });
      expect(await adopt()).toBe(state === "already_attempted" ? "already_attempted" : "preserved");
      expect(test).not.toHaveBeenCalled();
      expect(await prisma.providerModel.count({ where: { connectionId } })).toBe(0);
    });
  });

  it.each(["disabled_connection", "no_key", "disabled_key", "revoked_key", "skipped_model", "edited_connection"])("does not use %s", async state => {
    await fixture(async ({ adopt, test, connectionId, credentialId, versionId }) => {
      if (state === "disabled_connection") await prisma.providerConnection.update({ where: { id: connectionId }, data: { enabled: false } });
      if (state === "no_key") await prisma.providerConnection.update({ where: { id: connectionId }, data: { defaultCredentialId: null } });
      if (state === "disabled_key") await prisma.providerCredential.update({ where: { id: credentialId }, data: { enabled: false } });
      if (state === "revoked_key") await prisma.providerCredentialVersion.update({ where: { id: versionId }, data: { revokedAt: new Date() } });
      if (state === "skipped_model") await prisma.providerConnection.update({ where: { id: connectionId }, data: { catalogSkippedIds: [JEV_MODEL_ID] } });
      if (state === "edited_connection") await prisma.providerConnection.update({ where: { id: connectionId }, data: { draftVersion: 2 } });
      expect(await adopt()).toBe("unavailable");
      expect(test).not.toHaveBeenCalled();
      expect(await prisma.providerModel.count({ where: { connectionId } })).toBe(0);
    });
  });

  it("keeps per-feature opt-outs while assigning the other qualified consumers", async () => {
    await fixture(async ({ adopt }) => {
      await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: { decisionFeaturesJson: { memoryRelevance: false } } });
      expect(await adopt()).toBe("applied");
      const roles = createDecisionModelRoleResolver(prisma);
      expect(await roles.resolve("memoryRelevance")).toMatchObject({ ok: false, code: "decision_feature_disabled" });
      expect(await roles.resolve("knowledgeRelevance")).toMatchObject({ ok: true });
    });
  });

  it("reuses current verified evidence without a second probe or duplicate deployment", async () => {
    await fixture(async ({ adopt, resetClaim, test, connectionId }) => {
      expect(await adopt()).toBe("applied");
      const model = await prisma.providerModel.findFirstOrThrow({ where: { connectionId } });
      await resetClaim();
      expect(await adopt()).toBe("applied");
      expect(test).toHaveBeenCalledOnce();
      expect(await prisma.providerModel.count({ where: { connectionId } })).toBe(1);
      expect(await prisma.systemModelPolicy.findUnique({ where: { id: "installation" } })).toMatchObject({ decisionProviderModelId: model.id });
    });
  });

  it.each(["disabled", "unverified", "draft"])("does not replace an existing %s Jev deployment", async state => {
    await fixture(async ({ adopt, test, connectionId }) => {
      const configuration = jevModelConfiguration();
      await prisma.providerModel.create({ data: { connectionId, provider: "openrouter", modelId: JEV_MODEL_ID, modelClass: "decision",
        displayName: "Operator Jev", draftConfig: configuration, activeConfig: state === "draft" ? Prisma.DbNull : configuration,
        draftVersion: 1, activeVersion: state === "draft" ? 0 : 1, capabilities: configuration.capabilities,
        activatedAt: state === "draft" ? null : new Date(), defaultParams: {}, enabled: state !== "disabled" } });
      expect(await adopt()).toBe("preserved");
      expect(test).not.toHaveBeenCalled();
      expect(await prisma.providerModel.count({ where: { connectionId } })).toBe(1);
    });
  });

  it.each(["failure", "unqualified_revision"])("never enables or replays an unsuccessful %s check", async state => {
    await fixture(async ({ adopt, test }) => {
      test.mockImplementation(async () => {
        if (state === "failure") throw new Error("synthetic_provider_outage");
        return { status: "available", evidence: { ...proof, decisions: { ...proof.decisions!, servedModelId: JEV_MODEL_ID } } };
      });
      expect(await adopt()).toBe("verification_required");
      expect(await prisma.systemModelPolicy.findUnique({ where: { id: "installation" } })).toMatchObject({ decisionProviderModelId: null });
      expect(await adopt()).toBe("already_attempted");
      expect(test).toHaveBeenCalledOnce();
    });
  });

  it.each(["clear_role", "revoke_key", "change_default_key"])("fences %s during a check before final assignment", async state => {
    await fixture(async ({ adopt, test, connectionId, versionId }) => {
      test.mockImplementation(async () => {
        if (state === "clear_role") await prisma.systemModelPolicy.update({ where: { id: "installation" }, data: { decisionConfiguredAt: new Date() } });
        if (state === "revoke_key") await prisma.providerCredentialVersion.update({ where: { id: versionId }, data: { revokedAt: new Date() } });
        if (state === "change_default_key") await prisma.providerConnection.update({ where: { id: connectionId }, data: { defaultCredentialId: null } });
        return { status: "available", evidence: proof };
      });
      expect(await adopt()).not.toBe("applied");
      expect(await prisma.systemModelPolicy.findUnique({ where: { id: "installation" } })).toMatchObject({ decisionProviderModelId: null });
    });
  });

  it("rechecks authority when the adapter resolves the credential before I/O", async () => {
    await fixture(async ({ adopt, test, connectionId }) => {
      test.mockImplementation(async input => {
        await prisma.providerConnection.update({ where: { id: connectionId }, data: { enabled: false } });
        await expect((input.secret as () => Promise<string>)()).rejects.toThrow("decision_adoption_authority_changed");
        throw new Error("synthetic_authority_revoked");
      });
      expect(await adopt()).toBe("verification_required");
      expect(await prisma.systemModelPolicy.findUnique({ where: { id: "installation" } })).toMatchObject({ decisionProviderModelId: null });
    });
  });

  it("claims concurrent starts once", async () => {
    await fixture(async ({ adopt, test, connectionId }) => {
      const results = await Promise.all([adopt(), adopt()]);
      expect(results.sort()).toEqual(["already_attempted", "applied"]);
      expect(test).toHaveBeenCalledOnce();
      expect(await prisma.providerModel.count({ where: { connectionId } })).toBe(1);
    });
  });
});

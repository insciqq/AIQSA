import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../../prisma";
import { createPrismaAdminProviderRepository } from "./prismaRepository";
import { createAdminProviderService } from "./service";
import { adminProviderModelConfiguration } from "./adminConfiguration";
import { EMPTY_ADMIN_MODEL_PRICES, type AdminModelPriceChange } from "../../../contracts/adminProviderModelPrices";
import { createPrismaRunRepository } from "../../runs/prismaRepository";
import { usageWithEstimatedCost } from "../../runs/runFinalization";

afterAll(() => prisma.$disconnect());
const NOW = new Date("2026-09-30T01:00:00.000Z");
const configuration = { adapterKind: "openai_responses_compatible", answerSelectable: true, modelClass: "answer",
  upstreamModelId: "fixture/model", defaultParams: { temperature: 0.5 },
  capabilities: { toolCalling: true, nativePdfInput: false, nativeSearch: false, pdf: true, reasoning: false, vision: false } };
const prices = { ...EMPTY_ADMIN_MODEL_PRICES, inputTokenPriceUsdPerMillion: "0.25", cachedInputTokenPriceUsdPerMillion: "0.025", outputTokenPriceUsdPerMillion: "2" };
const manual: AdminModelPriceChange = { mode: "manual", prices };
async function fixture(check: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<void>, catalog = false) {
  const f = await createFixture(catalog);
  try { await check(f); } finally {
    await prisma.providerModel.deleteMany({ where: { connectionId: f.connectionId } });
    await prisma.providerCredentialVersion.deleteMany({ where: { credentialId: f.credentialId } });
    await prisma.providerCredential.deleteMany({ where: { connectionId: f.connectionId } });
    await prisma.providerConnection.delete({ where: { id: f.connectionId } });
  }
}
/** `catalog` shapes the row as release 0.2.31 wrote codex-lb: no template key, a generated id, an OpenAI upstream model. */
async function createFixture(catalog: boolean) {
  const connectionId = randomUUID(), modelId = randomUUID(), credentialId = randomUUID(), versionId = randomUUID();
  const upstreamModelId = catalog ? "gpt-6-sol" : "fixture/model";
  const model = { ...configuration, upstreamModelId };
  await prisma.$transaction(async tx => {
    const config = { allowPrivateNetwork: false, apiRoot: catalog ? "https://unreachable.example.test/backend-api/codex" : "https://unreachable.example.test/v1",
      authenticationMode: "bearer", responseTimeoutMs: 5000 };
    await tx.providerConnection.create({ data: { id: connectionId, displayName: "Price metadata fixture", family: "openai_compatible",
      activeConfig: config, draftConfig: config, activeVersion: 2, draftVersion: 2, activatedAt: NOW, enabled: true } });
    await tx.providerModel.create({ data: { id: modelId, connectionId, provider: "openai_compatible", modelId: upstreamModelId, templateKey: null,
      displayName: "Original", activeConfig: model, draftConfig: model, activeVersion: 3, draftVersion: 4,
      capabilities: model.capabilities, defaultParams: model.defaultParams, activatedAt: NOW, enabled: false, updatedAt: NOW } });
    await tx.providerCredential.create({ data: { id: credentialId, connectionId, label: "Inactive fixture key", enabled: false } });
    await tx.providerCredentialVersion.create({ data: { id: versionId, credentialId, version: 1, secretEnvelope: null,
      testEvidence: {}, testedAt: NOW, activatedAt: NOW, revokedAt: NOW } });
    await tx.providerModelCredentialCheck.create({ data: { connectionId, providerModelId: modelId, credentialId, credentialVersionId: versionId,
      connectionVersion: 2, modelVersion: 3, status: "available", checkedAt: NOW,
      evidence: { detail: "ok", method: "tiny_generation", selectedProviders: [], upstreamModelId } } });
    await tx.providerDraftCheck.create({ data: { connectionId, providerModelId: modelId, credentialId, credentialVersionId: versionId,
      connectionDraftVersion: 2, modelDraftVersion: 4, fingerprint: randomUUID(), status: "available", checkedAt: NOW,
      evidence: { detail: "ok", method: "tiny_generation", selectedProviders: [], upstreamModelId } } });
  });
  const repository = createPrismaAdminProviderRepository(prisma);
  const probe = vi.fn(async (): Promise<never> => { throw Error("Price metadata cannot contact a provider"); });
  const service = createAdminProviderService({ repository, tester: { test: probe }, credentialTester: { test: probe }, now: () => NOW });
  const current = () => prisma.providerModel.findUniqueOrThrow({ where: { id: modelId } });
  const guard = async () => { const row = await current(); return { expectedActiveVersion: row.activeVersion, expectedDraftVersion: row.draftVersion,
    expectedDisplayName: row.displayName, expectedUpdatedAt: row.updatedAt.toISOString() }; };
  const save = async (pricing: AdminModelPriceChange = manual) => service.updateModelMetadata({ ...await guard(), connectionId, modelId, displayName: "Edited", pricing });
  return { connectionId, modelId, credentialId, versionId, upstreamModelId, repository, service, probe, current, guard, save };
}

describe("Prisma admin model prices", () => {
  it("round-trips fractional, boundary and null prices without changing activation or checks", async () => fixture(async f => {
    const before = await f.current();
    const active = await prisma.providerModelCredentialCheck.findMany({ where: { providerModelId: f.modelId } });
    const draft = await prisma.providerDraftCheck.findMany({ where: { providerModelId: f.modelId } });
    const projected = async () => (await f.service.listConnections()).find(row => row.id === f.connectionId)!.models.find(row => row.id === f.modelId)!.pricing;
    // The upgrade's column default on a row without catalog identity: the sheet claims no source for it.
    expect(await projected()).toEqual({ prices: EMPTY_ADMIN_MODEL_PRICES, source: "catalog", catalogPrices: null });
    await f.save();
    const saved = await f.current();
    expect(saved).toEqual({ ...before, displayName: "Edited", priceSource: "admin", updatedAt: new Date(NOW.getTime() + 1),
      inputTokenPriceUsdPerMillion: expect.objectContaining({}), cachedInputTokenPriceUsdPerMillion: expect.objectContaining({}),
      outputTokenPriceUsdPerMillion: expect.objectContaining({}) });
    expect(await projected()).toEqual({ prices, source: "admin", catalogPrices: null });
    expect(await prisma.providerModelCredentialCheck.findMany({ where: { providerModelId: f.modelId } })).toEqual(active);
    expect(await prisma.providerDraftCheck.findMany({ where: { providerModelId: f.modelId } })).toEqual(draft);
    await f.save({ mode: "manual", prices: { ...EMPTY_ADMIN_MODEL_PRICES, inputTokenPriceUsdPerMillion: "9999999999.99999999", outputTokenPriceUsdPerMillion: "0.00000001" } });
    expect((await f.current()).inputTokenPriceUsdPerMillion?.toFixed(8)).toBe("9999999999.99999999");
    expect((await f.current()).outputTokenPriceUsdPerMillion?.toFixed(8)).toBe("0.00000001");
    expect(f.probe).not.toHaveBeenCalled();
  }));
  it("permits one simultaneous metadata writer and fences stale configuration writes in both orders", async () => fixture(async f => {
    const guard = await f.guard();
    const request = { ...guard, connectionId: f.connectionId, modelId: f.modelId, pricing: manual };
    const results = await Promise.allSettled(["First", "Second"].map(displayName => f.service.updateModelMetadata({ ...request, displayName })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "provider_draft_stale" } });
    await expect(f.service.updateModelDraft({ ...guard, modelId: f.modelId, displayName: "Stale", configuration: adminProviderModelConfiguration(configuration), pricing: manual }))
      .rejects.toMatchObject({ code: "provider_draft_stale" });
    const next = await f.guard();
    await f.service.updateModelDraft({ ...next, modelId: f.modelId, displayName: "Configuration", configuration: adminProviderModelConfiguration(configuration), pricing: manual });
    await expect(f.service.updateModelMetadata({ ...request, ...next, displayName: "Stale" })).rejects.toMatchObject({ code: "provider_draft_stale" });
    expect((await f.current()).draftVersion).toBe(5); expect((await f.current()).activeVersion).toBe(3);
  }));
  it("restores catalog values and changes eligibility for the documented catalog-only migration predicate", async () => fixture(async f => {
    await f.save();
    const before = await f.current();
    const projected = async () => (await f.service.listConnections()).find(row => row.id === f.connectionId)!.models.find(row => row.id === f.modelId)!.pricing;
    expect(await projected()).toMatchObject({ source: "admin", catalogPrices: { inputTokenPriceUsdPerMillion: "2",
      cachedInputTokenPriceUsdPerMillion: "0.2", cacheWriteInputTokenPriceUsdPerMillion: "2.5", outputTokenPriceUsdPerMillion: "10" } });
    // The forward catalog-update predicate for the codex-lb identity (PROVIDERS.md); the
    // fixture's exact id keeps the assertion isolated from every pre-existing deployment.
    const update = () => prisma.$executeRaw`UPDATE "ProviderModel" model SET "inputTokenPriceUsdPerMillion"=7.25
      FROM "ProviderConnection" connection
      WHERE model."id"=${f.modelId} AND connection.id = model."connectionId" AND model."priceSource"='catalog'
        AND model."modelClass"='answer' AND model."templateKey" IS NULL AND model."modelId"='gpt-6-sol'
        AND connection.family='openai_compatible' AND right(connection."activeConfig"->>'apiRoot', 18)='/backend-api/codex'`;
    expect(await update()).toBe(0); expect(await f.current()).toEqual(before);
    const restored = await f.save({ mode: "restore_catalog" });
    expect(restored.pricing.source).toBe("catalog"); expect(restored.pricing.prices).toEqual(restored.pricing.catalogPrices);
    expect((await f.current()).inputTokenPriceUsdPerMillion?.toNumber()).toBe(2);
    expect(await update()).toBe(1); expect((await f.current()).inputTokenPriceUsdPerMillion?.toNumber()).toBe(7.25);
  }, true));
  it("prices a codex-lb model created without explicit prices from its OpenAI tariff", async () => fixture(async f => {
    const created = await f.service.createModelDraft({ connectionId: f.connectionId, displayName: "Created Luna",
      configuration: adminProviderModelConfiguration({ ...configuration, upstreamModelId: "gpt-6-luna" }) });
    expect(created.pricing).toMatchObject({ source: "catalog", prices: { inputTokenPriceUsdPerMillion: "0.1", outputTokenPriceUsdPerMillion: "0.5" } });
    const row = await prisma.providerModel.findUniqueOrThrow({ where: { id: created.id } });
    expect(row).toMatchObject({ templateKey: null, priceSource: "catalog" });
    expect([row.inputTokenPriceUsdPerMillion, row.cachedInputTokenPriceUsdPerMillion, row.cacheWriteInputTokenPriceUsdPerMillion,
      row.outputTokenPriceUsdPerMillion].map(price => price?.toNumber())).toEqual([0.1, 0.01, 0.125, 0.5]);
    const custom = await f.service.createModelDraft({ connectionId: f.connectionId, displayName: "Created custom",
      configuration: adminProviderModelConfiguration({ ...configuration, upstreamModelId: "vendor/unlisted" }) });
    expect(await prisma.providerModel.findUniqueOrThrow({ where: { id: custom.id } })).toMatchObject({
      priceSource: "admin", inputTokenPriceUsdPerMillion: null, outputTokenPriceUsdPerMillion: null });
    expect(f.probe).not.toHaveBeenCalled();
  }, true));
  it("refuses token prices for a decision row and projects no catalog prices for it", async () => fixture(async f => {
    await prisma.providerModel.update({ where: { id: f.modelId }, data: { modelClass: "decision" } });
    const before = await f.current();
    await expect(f.save()).rejects.toMatchObject({ code: "provider_model_pricing_unavailable" });
    await expect(f.save({ mode: "restore_catalog" })).rejects.toMatchObject({ code: "provider_model_pricing_unavailable" });
    expect(await f.current()).toEqual(before);
    const projection = (await f.service.listConnections()).find(row => row.id === f.connectionId)!.models.find(row => row.id === f.modelId)!;
    expect(projection.pricing.catalogPrices).toBeNull();
    expect(f.probe).not.toHaveBeenCalled();
  }, true));
  it("rejects a foreign connection and preserves every field on stale metadata", async () => fixture(async f => {
    const before = await f.current();
    const request = { ...await f.guard(), connectionId: f.connectionId, modelId: f.modelId, displayName: "Updated", pricing: manual };
    await expect(f.service.updateModelMetadata({ ...request, connectionId: randomUUID() })).rejects.toMatchObject({ code: "provider_model_not_found" });
    await expect(f.service.updateModelMetadata({ ...request, expectedDraftVersion: 0 })).rejects.toMatchObject({ code: "provider_draft_stale" });
    expect(await f.current()).toEqual(before);
  }));
  it("clearing input/output makes subsequent finalization unknown while a stored earlier cost stays unchanged", async () => fixture(async f => {
    await f.save();
    const userId = randomUUID();
    await prisma.user.create({ data: { id: userId, displayName: "Price cost fixture", status: "active" } });
    try {
      const repository = createPrismaRunRepository(prisma);
      const input = { providerModelId: f.modelId, modelId: "fixture/model", provider: "openai_compatible",
        usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 } };
      const earlier = await usageWithEstimatedCost(repository, input);
      expect(earlier.estimatedCostMicros).toBe(450);
      const receipt = await prisma.usageEvent.create({ data: { userId, purpose: "chat_answer", provider: input.provider, modelId: input.modelId,
        inputTokens: 1000, outputTokens: 100, totalTokens: 1100, usageCompleteness: "COMPLETE", estimatedCostMicros: earlier.estimatedCostMicros } });
      for (const field of ["inputTokenPriceUsdPerMillion", "outputTokenPriceUsdPerMillion"] as const) {
        await f.save({ mode: "manual", prices: { ...prices, [field]: null } });
        expect((await usageWithEstimatedCost(repository, input)).estimatedCostMicros).toBeNull();
        expect((await prisma.usageEvent.findUniqueOrThrow({ where: { id: receipt.id } })).estimatedCostMicros).toBe(450);
      }
    } finally { await prisma.user.delete({ where: { id: userId } }); }
  }));
});

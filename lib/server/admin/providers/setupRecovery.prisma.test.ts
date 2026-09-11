import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { prisma } from "../../prisma";
import { encryptProviderCredentialSecret } from "../../providers/credentialSecrets";
import type { ProviderModelConfiguration } from "../../providers/providerConfiguration";
import { unsupportedAdminProviderCompatibilityEvidence } from "./compatibilityEvidence";
import { createPrismaAdminProviderRepository } from "./prismaRepository";
import { createAdminProviderService } from "./service";
import { createAdminProviderDraftTester } from "./tester";
import { providerSetupModels } from "./setupModels";
import { initialModelConfiguration, pendingInitialCapabilityEvidence } from "./initialCapabilitySetup";
import { createImageModelRoleResolver } from "../../providerRuntime/imageModelRole";

const KEY = Buffer.alloc(32, 23);
afterAll(() => prisma.$disconnect());

async function fixture(family: "anthropic" | "gemini" | "openrouter", run: (context: {
  db: PrismaClient; connectionId: string; credentialId: string; credentialVersionId: string; userId: string;
  addModel(configuration: ProviderModelConfiguration, enabled?: boolean): Promise<string>;
}) => Promise<void>) {
  const rollback = new Error("fixture_rollback");
  try {
    await prisma.$transaction(async (tx) => {
      const db = new Proxy(tx, { get(target, key) {
        if (key === "$transaction") return (operation: (client: Prisma.TransactionClient) => Promise<unknown>) => operation(tx);
        return Reflect.get(target, key);
      } }) as unknown as PrismaClient;
      const connectionId = randomUUID(), credentialId = randomUUID(), credentialVersionId = randomUUID(), userId = randomUUID();
      const connectionConfig = { allowPrivateNetwork: false, apiRoot: `https://${family}.example.test/v1`,
        authenticationMode: "bearer", responseTimeoutMs: 300_000 };
      await db.user.create({ data: { id: userId, displayName: "Synthetic setup owner", status: "active" } });
      await db.providerConnection.create({ data: { id: connectionId, displayName: "Synthetic provider", family,
        enabled: true, activeVersion: 1, draftVersion: 1, activatedAt: new Date(), activeConfig: connectionConfig, draftConfig: connectionConfig } });
      await db.providerCredential.create({ data: { id: credentialId, connectionId, label: "Synthetic key", enabled: true } });
      await db.providerCredentialVersion.create({ data: { id: credentialVersionId, credentialId, version: 1,
        secretEnvelope: encryptProviderCredentialSecret({ credentialId, valueId: credentialVersionId, secret: "synthetic-key", key: KEY }),
        testedAt: new Date(), activatedAt: new Date(), testEvidence: { authenticationMode: "bearer" } } });
      await db.providerCredential.update({ where: { id: credentialId }, data: { activeVersionId: credentialVersionId, activatedAt: new Date() } });
      await db.providerConnection.update({ where: { id: connectionId }, data: { defaultCredentialId: credentialId } });
      const addModel = async (configuration: ProviderModelConfiguration, enabled = true) => {
        const id = randomUUID();
        await db.providerModel.create({ data: { id, connectionId, displayName: "Synthetic model", provider: family,
          modelId: configuration.upstreamModelId, modelClass: configuration.modelClass, enabled,
          capabilities: configuration.capabilities as Prisma.InputJsonValue, defaultParams: configuration.defaultParams as Prisma.InputJsonValue,
          activeConfig: configuration as Prisma.InputJsonValue, draftConfig: configuration as Prisma.InputJsonValue,
          activeVersion: 1, draftVersion: 1, activatedAt: new Date() } });
        return id;
      };
      await run({ db, connectionId, credentialId, credentialVersionId, userId, addModel });
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
      throw rollback;
    }, { timeout: 30_000 });
  } catch (error) { if (error !== rollback) throw error; }
}

describe("persisted provider setup recovery", () => {
  it("persists an OpenRouter 400, admits editing only, and admits generation after Retry without repeating editing", async () => {
    await fixture("openrouter", async ({ db, addModel, connectionId, credentialId, credentialVersionId }) => {
      const preset = providerSetupModels("openrouter").find((preset) => preset.configuration.modelClass === "image")!;
      const configuration = initialModelConfiguration({ ...preset.configuration, image: { profile: "openrouter",
        parameters: { resolution: { type: "enum", values: ["1K", "2K", "4K"] } } } });
      const modelId = await addModel(configuration);
      await db.providerModelCredentialCheck.create({ data: { connectionId, credentialId, credentialVersionId,
        providerModelId: modelId, connectionVersion: 1, modelVersion: 1, status: "available", checkedAt: new Date(),
        evidence: pendingInitialCapabilityEvidence(configuration) as Prisma.InputJsonValue } });
      await db.systemModelPolicy.upsert({ where: { id: "installation" },
        create: { id: "installation", imageProviderModelId: modelId, imageParamsJson: {} },
        update: { imageProviderModelId: modelId, imageParamsJson: {} } });
      expect(await createImageModelRoleResolver(db).resolve()).toBeNull();
      const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: "blue" } }).png().toBuffer();
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: {
        code: "invalid_parameter", param: "resolution", message: "private upstream detail" } }, { status: 400 }))
        .mockImplementation(async () => Response.json({ data: [{ b64_json: png.toString("base64") }] }));
      const service = createAdminProviderService({ repository: createPrismaAdminProviderRepository(db),
        credentialTester: { test: async () => { throw new Error("unexpected_catalog_check"); } },
        tester: createAdminProviderDraftTester({ createFetch: () => fetchFn }), encryptionKey: () => KEY });
      const check = async () => {
        const run = await service.startCheckRun({ connectionId, credentialId, modelIds: [modelId], reason: "requested", retryUnresolved: true });
        await vi.waitFor(() => expect(service.checkRun({ connectionId, runId: run.id }).state).toBe("completed"));
        return service.checkRun({ connectionId, runId: run.id });
      };
      expect((await check()).failed).toEqual([modelId]);
      const partialModel = await db.providerModel.findUniqueOrThrow({ where: { id: modelId } });
      const partial = await db.providerModelCredentialCheck.findFirstOrThrow({ where: { providerModelId: modelId, modelVersion: partialModel.activeVersion } });
      expect(partial).toMatchObject({ credentialId, credentialVersionId, evidence: { capabilitySetup: {
        checks: { imageGeneration: "incomplete", imageEditing: "verified" }, attempts: { imageGeneration: {
          reason: "invalid_input", httpStatus: 400, imageFailure: { category: "invalid_parameter", parameter: "resolution" } } } } } });
      expect((await createImageModelRoleResolver(db).resolve())?.snapshot.model.capabilities).toMatchObject({ imageGeneration: false, imageEditing: true });
      expect((await check()).failed).toEqual([]);
      expect(fetchFn).toHaveBeenCalledTimes(3);
      expect((await createImageModelRoleResolver(db).resolve())?.snapshot.model.capabilities).toMatchObject({ imageGeneration: true, imageEditing: true });
      const currentModel = await db.providerModel.findUniqueOrThrow({ where: { id: modelId } });
      const current = await db.providerModelCredentialCheck.findFirstOrThrow({ where: { providerModelId: modelId, modelVersion: currentModel.activeVersion } });
      expect(current.evidence).toMatchObject({ imageEditing: (partial.evidence as Record<string, unknown>).imageEditing,
        capabilitySetup: { attempts: { imageGeneration: { reason: "verified", status: "verified" } } } });
      expect(JSON.stringify(current.evidence)).not.toContain("private");
      expect(await db.providerCredentialVersion.count({ where: { credentialId } })).toBe(1);
    });
  });

  it("upgrades a saved Anthropic adapter_unsupported receipt through Check without replacing its model or key", async () => {
    await fixture("anthropic", async ({ db, addModel, connectionId, credentialId, credentialVersionId }) => {
      const configuration: ProviderModelConfiguration = { adapterKind: "anthropic_messages", answerSelectable: true,
        modelClass: "answer", upstreamModelId: "claude-synthetic", defaultParams: {}, capabilities: {
          nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false, streaming: true, toolCalling: false
        } };
      const modelId = await addModel(configuration);
      const legacy = { detail: "ok", method: "tiny_generation", selectedProviders: [], upstreamModelId: "claude-synthetic",
        compatibility: { ...unsupportedAdminProviderCompatibilityEvidence(), modelAccess: "verified", streaming: "verified" },
        capabilitySetup: { policyVersion: 2, activation: "preserve", checks: { modelAccess: "verified", streaming: "verified",
          structuredOutput: "unsupported", toolCalling: "unsupported", forcedToolCall: "unsupported", parallelToolCalls: "unsupported",
          directPdf: "unsupported", vision: "unsupported" },
        attempts: { structuredOutput: { attempts: 0, status: "unsupported", reason: "adapter_unsupported" } } } };
      await db.providerModelCredentialCheck.create({ data: { connectionId, credentialId, credentialVersionId,
        providerModelId: modelId, connectionVersion: 1, modelVersion: 1, status: "available", checkedAt: new Date(), evidence: legacy } });
      const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({ model: "claude-synthetic", output_config: { format: { type: "json_schema" } } });
        return Response.json({ type: "message", role: "assistant", stop_reason: "end_turn", id: "msg-synthetic",
          content: [{ type: "text", text: '{"ready":true,"count":2,"label":"ok","tool_ids":["alpha","beta"]}' }] });
      });
      const service = createAdminProviderService({ repository: createPrismaAdminProviderRepository(db),
        credentialTester: { test: async () => { throw new Error("unexpected_catalog_check"); } },
        tester: createAdminProviderDraftTester({ createFetch: () => fetchFn }), encryptionKey: () => KEY });
      const check = async () => {
        const run = await service.startCheckRun({ connectionId, credentialId, modelIds: [modelId], reason: "requested", retryUnresolved: true });
        await vi.waitFor(() => expect(service.checkRun({ connectionId, runId: run.id }).state).toBe("completed"));
        expect(service.checkRun({ connectionId, runId: run.id }).failed).toEqual([]);
      };
      await check();
      const evidence = (await db.providerModelCredentialCheck.findFirstOrThrow({ where: { providerModelId: modelId } })).evidence;
      expect(evidence).toMatchObject({ structuredOutput: { adapterKind: "anthropic_messages", probeVersion: 2, verified: true },
        capabilitySetup: { activation: "preserve", checks: { structuredOutput: "verified", streaming: "verified", toolCalling: "unsupported" } } });
      expect(await db.providerModel.findUniqueOrThrow({ where: { id: modelId } })).toMatchObject({ activeVersion: 1,
        draftVersion: 1, activeConfig: configuration, draftConfig: configuration });
      await check();
      expect(fetchFn).toHaveBeenCalledOnce();
      expect(await db.providerCredentialVersion.count({ where: { credentialId } })).toBe(1);
      expect(await db.providerCredential.findUniqueOrThrow({ where: { id: credentialId } })).toMatchObject({ activeVersionId: credentialVersionId });
    });
  });

  it.each([
    { family: "gemini", existing: false, listed: 4 }, { family: "gemini", existing: true, listed: 4 }, { family: "gemini", existing: false, listed: 3 },
    { family: "openrouter", existing: false, listed: 6 }, { family: "openrouter", existing: true, listed: 6 }, { family: "openrouter", existing: false, listed: 5 }
  ] as const)("checks only catalog-listed $family image additions and preserves existing settings/grants ($existing/$listed)", async ({ family, existing, listed }) => {
    await fixture(family, async ({ db, addModel, connectionId, credentialId, credentialVersionId, userId }) => {
      const presets = providerSetupModels(family).filter((model) => model.configuration.modelClass === "image");
      const savedConfiguration = { ...presets[0]!.configuration, defaultParams: family === "gemini" ? { image_size: "2K" } : { resolution: "2K" },
        ...(family === "openrouter" ? { image: { profile: "openrouter" as const, parameters: { resolution: { type: "enum" as const, values: ["1K", "2K"] } } },
          openRouterRouting: { mode: "only_selected" as const, providers: ["synthetic-route"] } } : {}) };
      const savedId = existing ? await addModel(savedConfiguration, false) : null;
      const grant = savedId ? await db.accessGrant.create({ data: { userId, providerModelId: savedId, enabled: true } }) : null;
      const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: "blue" } }).png().toBuffer();
      const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
        expect(new Headers(init?.headers).get(family === "gemini" ? "x-goog-api-key" : "authorization"))
          .toBe(family === "gemini" ? "synthetic-key" : "Bearer synthetic-key");
        const body = JSON.parse(String(init?.body));
        expect(presets.slice(existing ? 1 : 0, listed).map((preset) => preset.configuration.upstreamModelId)).toContain(body.model);
        return Response.json(family === "openrouter" ? { data: [{ b64_json: png.toString("base64") }] } : { status: "completed", steps: [{ type: "model_output",
          content: [{ type: "image", data: png.toString("base64"), mime_type: "image/png" }] }] });
      });
      const service = createAdminProviderService({ repository: createPrismaAdminProviderRepository(db),
        tester: createAdminProviderDraftTester({ createFetch: () => fetchFn }), encryptionKey: () => KEY,
        credentialTester: { test: async () => ({ method: "models_catalog", modelIds: [],
          modelIdsByClass: { image: presets.slice(0, listed).map((preset) => preset.configuration.upstreamModelId) } }) } });
      const check = async () => {
        await service.addCatalogModels({ connectionId, credentialId, expectedConnectionVersion: 1, expectedCredentialVersionId: credentialVersionId,
          modelIds: presets.map((preset) => preset.modelId) });
        const run = (await service.listConnections()).find(({ id }) => id === connectionId)!.checkRun!;
        await vi.waitFor(() => expect(service.checkRun({ connectionId, runId: run.id }).state).toBe("completed"), { timeout: 10_000 });
        expect(service.checkRun({ connectionId, runId: run.id }).failed).toEqual([]);
      };
      await check();
      const models = await db.providerModel.findMany({ where: { connectionId }, include: { activeCredentialChecks: true } });
      expect(models).toHaveLength(listed);
      for (const model of models.filter((model) => model.id !== savedId)) {
        expect(model.activeConfig).toMatchObject({ capabilities: { imageGeneration: true, imageEditing: true } });
        expect(model.activeCredentialChecks.find((check) => check.modelVersion === model.activeVersion)).toMatchObject({
          credentialId, credentialVersionId, connectionVersion: 1, status: "available", evidence: {
            imageGeneration: { adapterKind: family === "gemini" ? "gemini_images_native" : "openrouter_images", upstreamModelId: model.modelId, verified: true },
            imageEditing: { adapterKind: family === "gemini" ? "gemini_images_native" : "openrouter_images", upstreamModelId: model.modelId, verified: true }
          } });
      }
      await check();
      expect(fetchFn).toHaveBeenCalledTimes((listed - Number(existing)) * 2);
      expect(await db.providerModel.count({ where: { connectionId } })).toBe(listed);
      expect(await db.providerCredentialVersion.count({ where: { credentialId } })).toBe(1);
      if (savedId) {
        expect(await db.providerModel.findUniqueOrThrow({ where: { id: savedId } })).toMatchObject({ enabled: false,
          activeVersion: 1, draftVersion: 1, activeConfig: savedConfiguration, draftConfig: savedConfiguration });
        expect(await db.accessGrant.findUniqueOrThrow({ where: { id: grant!.id } })).toEqual(grant);
      }
    });
  });
});

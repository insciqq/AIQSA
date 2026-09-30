import { readdirSync, readFileSync } from "node:fs";
import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { fixtureConnection, fixtureModel } from "@/components/admin/providers/providerFixtures";
import { EMPTY_ADMIN_MODEL_PRICES, type AdminModelPriceChange } from "../../../contracts/adminProviderModelPrices";
import { decodeAdminProviderModelSaveReceipt } from "../../../contracts/adminProviderModelSave";
import { createAdminProviderCatalogHandler, createAdminProviderModelCreateHandler, createAdminProviderModelUpdateHandler } from "./handlers";
import { createPrismaAdminProviderRepository } from "./prismaRepository";
import { AdminProviderServiceError, createAdminProviderService } from "./service";
import { ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS } from "../../../contracts/adminProviderQuickSetup";
import { catalogModelPrices } from "../../../domain/modelPrices";
import { initialAdminModelPricing, projectAdminModelPricing, providerModelCatalogKey, resolveAdminModelPricingChange } from "./providerModelPricing";

const prices = { ...EMPTY_ADMIN_MODEL_PRICES, inputTokenPriceUsdPerMillion: "0.25", cachedInputTokenPriceUsdPerMillion: "0.025", outputTokenPriceUsdPerMillion: "2" };
const manual: AdminModelPriceChange = { mode: "manual", prices };
const CODEX = { apiRoot: "https://codex.example.test/backend-api/codex" };
const GENERIC = { apiRoot: "https://llm.example.test/v1" };
const OPENAI_PRICES = { inputTokenPriceUsdPerMillion: "2", cachedInputTokenPriceUsdPerMillion: "0.2", cacheWriteInputTokenPriceUsdPerMillion: "2.5", outputTokenPriceUsdPerMillion: "10" };
function harness(options: { count?: number; exists?: boolean; modelClass?: string; templateKey?: string | null; role?: string;
  family?: string; endpoint?: object; upstreamModelId?: string } = {}) {
  const model = fixtureModel({ id: "model", connectionId: "provider", displayName: "Original", enabled: false });
  const updateMany = vi.fn(async () => ({ count: options.count ?? 1 }));
  const create = vi.fn(async () => ({}));
  const connection = { family: options.family ?? "openai", activeConfig: options.endpoint ?? null, draftConfig: options.endpoint ?? {} };
  const stored = { id: model.id, modelClass: options.modelClass ?? "answer", modelId: options.upstreamModelId ?? "original",
    templateKey: options.templateKey ?? null, connection };
  const database = { providerModel: { updateMany, create, findFirst: vi.fn(async () => options.exists === false ? null : stored),
    findUnique: vi.fn(async () => options.exists === false ? null : stored) },
    providerConnection: { findUnique: vi.fn(async () => connection) } } as unknown as PrismaClient;
  const listConnections = vi.fn(async () => [fixtureConnection({ id: "provider", displayName: "Provider", models: [model] })]);
  const repository = { ...createPrismaAdminProviderRepository(database), listConnections };
  const probe = vi.fn(async (): Promise<never> => { throw Error("Metadata cannot dispatch provider"); });
  const service = createAdminProviderService({ repository, tester: { test: probe }, credentialTester: { test: probe }, now: () => new Date(model.updatedAt), idFactory: () => "new-model" });
  const deps = { service, resolveAuth: async () => ({ id: "session", expiresAt: new Date("2030-01-01"), userId: "admin",
    user: { id: "admin", displayName: "Admin", email: null, role: options.role ?? "admin", status: "active" } }) };
  const body = { action: "metadata", displayName: "Updated", expectedActiveVersion: model.activeVersion,
    expectedDraftVersion: model.draftVersion, expectedDisplayName: model.displayName, expectedUpdatedAt: model.updatedAt, pricing: manual };
  const request = (body: unknown, method = "PATCH") => new Request("http://localhost/api/admin/providers/provider/models/model", {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  const patch = (body: unknown) => createAdminProviderModelUpdateHandler(deps)(request(body), { params: { connectionId: "provider", modelId: "model" } });
  const post = (body: unknown) => createAdminProviderModelCreateHandler(deps)(request(body, "POST"), { params: { connectionId: "provider" } });
  return { model, service, repository, updateMany, create, listConnections, probe, body, patch, post, deps };
}

describe("admin model price metadata boundary", () => {
  it("saves four exact prices and a name atomically without activating or checking the model", async () => {
    const f = harness();
    const response = await f.patch(f.body);
    expect(response.status).toBe(200);
    const { receipt } = await response.json();
    expect(decodeAdminProviderModelSaveReceipt(receipt)).toMatchObject({ saved: "metadata", pricing: { prices, source: "admin", catalogPrices: null },
      publication: "not_requested", checks: "not_requested", draftVersion: f.model.draftVersion });
    expect(f.updateMany).toHaveBeenCalledOnce();
    expect(f.updateMany).toHaveBeenCalledWith({ data: { ...prices, priceSource: "admin", displayName: "Updated",
      updatedAt: new Date(new Date(f.model.updatedAt).getTime() + 1) }, where: expect.objectContaining({
      connectionId: "provider", id: "model", activeVersion: f.model.activeVersion, draftVersion: f.model.draftVersion,
      updatedAt: new Date(f.model.updatedAt), templateKey: null, modelClass: "answer", modelId: "original"
    }) });
    expect(f.probe).not.toHaveBeenCalled();
  });
  it.each([-1, "-1", "1e3", "1e-3", "+1", "no", "Infinity", "NaN", "0.000000001", "10000000000", 0.25])("rejects invalid wire value %j before mutation", async inputTokenPriceUsdPerMillion => {
    const f = harness();
    const response = await f.patch({ ...f.body, pricing: { mode: "manual", prices: { ...prices, inputTokenPriceUsdPerMillion } } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "provider_model_pricing_invalid", field: "inputTokenPriceUsdPerMillion" });
    expect(f.updateMany).not.toHaveBeenCalled(); expect(f.probe).not.toHaveBeenCalled();
  });
  it("names the rejected price field on create and configuration saves, and no field for a malformed change", async () => {
    const f = harness();
    const invalid = { mode: "manual", prices: { ...prices, outputTokenPriceUsdPerMillion: "1e3" } };
    const created = await f.post({ displayName: "Created", configuration: f.model.draftConfig, pricing: invalid });
    expect(await created.json()).toEqual({ error: "provider_model_pricing_invalid", field: "outputTokenPriceUsdPerMillion" });
    const updated = await f.patch({ ...f.body, action: "update", configuration: f.model.draftConfig, pricing: invalid });
    expect(await updated.json()).toEqual({ error: "provider_model_pricing_invalid", field: "outputTokenPriceUsdPerMillion" });
    const malformed = await f.patch({ ...f.body, pricing: { mode: "manual" } });
    expect(await malformed.json()).toEqual({ error: "provider_model_pricing_invalid" });
    expect(f.create).not.toHaveBeenCalled(); expect(f.updateMany).not.toHaveBeenCalled();
  });
  it("validates price changes again at the service boundary", async () => {
    const f = harness();
    await expect(f.service.updateModelMetadata({ ...f.body, connectionId: "provider", modelId: "model", pricing: {
      mode: "manual", prices: { ...prices, outputTokenPriceUsdPerMillion: "1e3" }
    } })).rejects.toMatchObject({ code: "provider_model_pricing_invalid" });
    expect(f.updateMany).not.toHaveBeenCalled();
  });
  it.each([{ pricing: { ...manual, source: "catalog" } }, { pricing: { mode: "restore_catalog", templateKey: "openai:gpt-6-sol" } },
    { templateKey: "openai:gpt-6-sol" }, { configuration: {} }, { activate: true }])("rejects forged authority/execution fields %#", async patch => {
    const f = harness(); expect((await f.patch({ ...f.body, ...patch })).status).toBe(400); expect(f.updateMany).not.toHaveBeenCalled();
  });
  it.each(["image", "embedding", "reranker", "decision"])("refuses price edits for %s deployments", async modelClass => {
    const f = harness({ modelClass }); const response = await f.patch(f.body);
    expect(await response.json()).toEqual({ error: "provider_model_pricing_unavailable" }); expect(f.updateMany).not.toHaveBeenCalled();
  });
  it.each([{ count: 0, code: "provider_draft_stale", status: 409 }, { exists: false, code: "provider_model_not_found", status: 404 }])("fails closed on $code", async ({ code, status, ...options }) => {
    const f = harness(options), response = await f.patch(f.body);
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: code }); expect(f.probe).not.toHaveBeenCalled();
  });
  it("refuses non-admin reads and writes before repository access", async () => {
    const f = harness({ role: "user" });
    expect((await f.patch(f.body)).status).toBe(403);
    expect((await createAdminProviderCatalogHandler(f.deps)(new Request("http://localhost/api/admin/providers"))).status).toBe(403);
    expect(f.listConnections).not.toHaveBeenCalled(); expect(f.updateMany).not.toHaveBeenCalled();
  });
  it("restores exact known templates and rejects the Jev decision template and custom/unknown rows", async () => {
    const catalog = harness({ templateKey: "openai:gpt-6-sol" });
    expect(await (await catalog.patch({ ...catalog.body, pricing: { mode: "restore_catalog" } })).json()).toMatchObject({ receipt: {
      pricing: { source: "catalog", prices: { inputTokenPriceUsdPerMillion: "2", cachedInputTokenPriceUsdPerMillion: "0.2", cacheWriteInputTokenPriceUsdPerMillion: "2.5", outputTokenPriceUsdPerMillion: "10" } }
    } });
    // Jev cost is provider-reported; its template carries no token price to restore.
    const decision = harness({ modelClass: "decision", templateKey: "openrouter:typesafe/jev-1.13" });
    expect(await (await decision.patch({ ...decision.body, pricing: { mode: "restore_catalog" } })).json()).toEqual({ error: "provider_model_pricing_unavailable" });
    expect(decision.updateMany).not.toHaveBeenCalled();
    for (const templateKey of [null, "unknown:template"]) {
      const f = harness({ templateKey }); expect((await f.patch({ ...f.body, pricing: { mode: "restore_catalog" } })).status).toBe(400);
      expect(f.updateMany).not.toHaveBeenCalled();
    }
  });
  it("projects decimal precision and normalizes zeroes without using binary floats", () => {
    const max = "9999999999.99999999", min = "0.00000001";
    const connection = { family: "openai_compatible", activeConfig: GENERIC, draftConfig: GENERIC };
    const row = { modelClass: "answer", modelId: "custom", templateKey: null };
    const result = projectAdminModelPricing({ ...row, priceSource: "admin",
      inputTokenPriceUsdPerMillion: new Prisma.Decimal(max), cachedInputTokenPriceUsdPerMillion: new Prisma.Decimal(min),
      cacheWriteInputTokenPriceUsdPerMillion: null, outputTokenPriceUsdPerMillion: new Prisma.Decimal(0) }, connection);
    expect(result.prices).toEqual({ ...prices, inputTokenPriceUsdPerMillion: max, cachedInputTokenPriceUsdPerMillion: min, outputTokenPriceUsdPerMillion: "0" });
    expect(resolveAdminModelPricingChange(row, connection, { mode: "manual", prices: { ...prices, inputTokenPriceUsdPerMillion: "0000.25000000" } })?.prices.inputTokenPriceUsdPerMillion).toBe("0.25");
  });
  it("projects no catalog prices for a Jev decision row", () => {
    const connection = { family: "openrouter", activeConfig: {}, draftConfig: {} };
    const jev = { modelClass: "decision", modelId: "typesafe/jev-1.13", templateKey: "openrouter:typesafe/jev-1.13" };
    expect(projectAdminModelPricing({ ...jev, priceSource: "catalog", inputTokenPriceUsdPerMillion: null, cachedInputTokenPriceUsdPerMillion: null,
      cacheWriteInputTokenPriceUsdPerMillion: null, outputTokenPriceUsdPerMillion: null }, connection).catalogPrices).toBeNull();
    expect(initialAdminModelPricing(jev, connection)).toBeNull();
  });
  it("persists optional prices in the create and guarded configuration write, with exact receipts", async () => {
    const f = harness();
    const created = await f.post({ displayName: "Created", configuration: f.model.draftConfig, pricing: manual });
    expect(created.status).toBe(201); expect(await created.json()).toMatchObject({ receipt: { saved: "configuration", pricing: { prices, source: "admin" } } });
    expect(f.create).toHaveBeenCalledWith({ data: expect.objectContaining({ ...prices, priceSource: "admin", displayName: "Created", draftVersion: 1 }) });
    const updated = await f.patch({ ...f.body, action: "update", configuration: f.model.draftConfig });
    expect(updated.status).toBe(200); expect(await updated.json()).toMatchObject({ receipt: { saved: "configuration", draftVersion: 2, pricing: { prices, source: "admin" } } });
    expect(f.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ ...prices, priceSource: "admin", draftVersion: { increment: 1 } }) }));
    expect(f.probe).not.toHaveBeenCalled();
  });
  it("acknowledges the exact saved prices when later configuration activation fails", async () => {
    const f = harness();
    vi.spyOn(f.service, "activateModel").mockRejectedValue(new AdminProviderServiceError("provider_refresh_failed"));
    const response = await f.patch({ ...f.body, action: "update", activate: true, configuration: f.model.draftConfig });
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("provider_refresh_failed");
    expect(decodeAdminProviderModelSaveReceipt(body.receipt)).toMatchObject({ saved: "configuration", publication: "draft",
      checks: "not_requested", pricing: { prices, source: "admin" } });
    expect(f.updateMany).toHaveBeenCalledOnce();
  });
  it("refuses a catalog restore on newly created custom models before any insert", async () => {
    const f = harness();
    const response = await f.post({ displayName: "Created", configuration: f.model.draftConfig, pricing: { mode: "restore_catalog" } });
    expect(await response.json()).toEqual({ error: "provider_model_pricing_unavailable" });
    expect(f.create).not.toHaveBeenCalled();
  });
  it("keeps an unpriced custom deployment administrator-owned instead of claiming a catalog tariff", async () => {
    const f = harness();
    expect((await f.post({ displayName: "Unpriced custom", configuration: f.model.draftConfig })).status).toBe(201);
    expect(f.create).toHaveBeenCalledWith({ data: expect.objectContaining({ priceSource: "admin" }) });
    expect(f.probe).not.toHaveBeenCalled();
  });
  it("offers and restores the OpenAI tariff for an administrator-priced codex-lb row without a template key", async () => {
    const codex = harness({ family: "openai_compatible", endpoint: CODEX, upstreamModelId: "gpt-6-sol" });
    const response = await codex.patch({ ...codex.body, pricing: { mode: "restore_catalog" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ receipt: { pricing: { source: "catalog", prices: OPENAI_PRICES, catalogPrices: OPENAI_PRICES } } });
    expect(codex.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ ...OPENAI_PRICES, priceSource: "catalog" }),
      where: expect.objectContaining({ templateKey: null, modelClass: "answer", modelId: "gpt-6-sol" }) }));
    for (const options of [{ family: "openai_compatible", endpoint: GENERIC, upstreamModelId: "gpt-6-sol" },
      { family: "openai_compatible", endpoint: CODEX, upstreamModelId: "vendor/unlisted" }]) {
      const f = harness(options);
      expect((await f.patch({ ...f.body, pricing: { mode: "restore_catalog" } })).status).toBe(400);
      expect(f.updateMany).not.toHaveBeenCalled();
    }
  });
  it("creates a codex-lb model without explicit prices at its catalog tariff and keeps other custom models administrator-owned", async () => {
    const codex = harness({ family: "openai_compatible", endpoint: CODEX });
    const configuration = { ...codex.model.draftConfig, adapterKind: "openai_responses_compatible", upstreamModelId: "gpt-6-sol" };
    const created = await codex.post({ displayName: "Created", configuration });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ receipt: { pricing: { source: "catalog", prices: OPENAI_PRICES } } });
    expect(codex.create).toHaveBeenCalledWith({ data: expect.objectContaining({ ...OPENAI_PRICES, priceSource: "catalog", modelId: "gpt-6-sol" }) });
    const generic = harness({ family: "openai_compatible", endpoint: GENERIC });
    expect((await generic.post({ displayName: "Created", configuration })).status).toBe(201);
    expect(generic.create).toHaveBeenCalledWith({ data: expect.objectContaining({ priceSource: "admin" }) });
    expect(generic.create).toHaveBeenCalledWith({ data: expect.not.objectContaining({ inputTokenPriceUsdPerMillion: expect.anything() }) });
  });
});

const MIGRATIONS = "prisma/migrations";
const TARIFF_LIST = /prices\(template, input, cached, write, output\) AS \(VALUES\n([\s\S]*?)\n\)/u;

/** Tariff lists of every catalog price migration, folded in migration order. */
function migratedTariffs() {
  const tariffs = new Map<string, readonly (number | null)[]>();
  for (const name of readdirSync(MIGRATIONS, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()) {
    const list = TARIFF_LIST.exec(readFileSync(`${MIGRATIONS}/${name}/migration.sql`, "utf8"))?.[1];
    for (const row of list?.split("\n") ?? []) {
      const [, key, ...values] = /^ {2}\('([^']+)', ([^,]+), ([^,]+), ([^,]+), ([^)]+)\),?$/u.exec(row) ?? [];
      expect(key, `unparsed tariff row in ${name}: ${row}`).toBeDefined();
      tariffs.set(key!, values.map(value => value === "NULL" ? null : Number(value)));
    }
  }
  return tariffs;
}

describe("catalog tariffs written by price migrations", () => {
  it("equal the TypeScript tariff map", () => {
    const migrated = migratedTariffs();
    expect(migrated.size).toBeGreaterThan(0);
    expect(Object.fromEntries(migrated)).toEqual(Object.fromEntries(Object.entries(catalogModelPrices).map(([key, price]) => [key, [
      price.inputTokenPriceUsdPerMillion, price.cachedInputTokenPriceUsdPerMillion,
      price.cacheWriteInputTokenPriceUsdPerMillion, price.outputTokenPriceUsdPerMillion
    ]])));
  });
});

describe("stored catalog identity", () => {
  const row = (modelId: string, modelClass = "answer", templateKey: string | null = null) => ({ modelClass, modelId, templateKey });
  const compatible = (activeConfig: unknown, draftConfig: unknown = activeConfig) => ({ family: "openai_compatible", activeConfig, draftConfig });
  it.each([
    ["a codex-lb endpoint", row("gpt-5.6-sol"), compatible(CODEX), "openai:gpt-5.6-sol"],
    ["the catalog marker on a draft-only endpoint", row("gpt-6-luna"), compatible(null, { ...GENERIC, responsesRequestIsolationDetected: true }), "openai:gpt-6-luna"],
    ["a negative marker on a Codex path", row("gpt-6-sol"), compatible({ ...CODEX, responsesRequestIsolationDetected: false }), null],
    ["a generic compatible endpoint", row("gpt-6-sol"), compatible(GENERIC), null],
    ["an upstream model without a tariff", row("vendor/unlisted"), compatible(CODEX), null],
    ["a codex-lb image model", row("gpt-image-2", "image"), compatible(CODEX), null],
    ["a second OpenRouter connection", row("google/gemini-3.5-flash"), { family: "openrouter", activeConfig: {}, draftConfig: {} }, "openrouter:google/gemini-3.5-flash"],
    ["a template key", row("gpt-6-sol", "answer", "openai:gpt-6-sol"), { family: "openai", activeConfig: {}, draftConfig: {} }, "openai:gpt-6-sol"],
    ["an unknown template key", row("gpt-6-sol", "answer", "legacy:priced"), { family: "openai", activeConfig: {}, draftConfig: {} }, null],
    ["a fake connection", row("gpt-6-sol"), { family: "fake", activeConfig: {}, draftConfig: {} }, null],
    ["the Jev decision template", row("typesafe/jev-1.13", "decision", "openrouter:typesafe/jev-1.13"), { family: "openrouter", activeConfig: {}, draftConfig: {} }, null],
    ["a priced template on a non-answer row", row("gpt-6-sol", "image", "openai:gpt-6-sol"), { family: "openai", activeConfig: {}, draftConfig: {} }, null]
  ])("resolves %s", (_name, stored, connection, key) => {
    expect(providerModelCatalogKey(stored, connection)).toBe(key);
  });
  it("carries the current second-connection tariff including the cached-input price", () => {
    expect(initialAdminModelPricing(row("google/gemini-3.5-flash"), { family: "openrouter", activeConfig: {}, draftConfig: {} })?.prices).toEqual({
      inputTokenPriceUsdPerMillion: "1.5", cachedInputTokenPriceUsdPerMillion: "0.15", cacheWriteInputTokenPriceUsdPerMillion: null, outputTokenPriceUsdPerMillion: "9" });
  });
  it("matches the Quick Setup families that the one-time price migration adopts", () => {
    const sql = readFileSync(`${MIGRATIONS}/20260930130000_model_token_prices/migration.sql`, "utf8");
    const families = /WHEN connection\.family IN \(([^)]*)\)/u.exec(sql)?.[1]?.split(",").map(family => family.trim().replaceAll("'", ""));
    expect(families).toEqual([...ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS]);
    expect(sql).toContain("right(endpoint.config->>'apiRoot', 18) = '/backend-api/codex'");
    expect("/backend-api/codex").toHaveLength(18);
  });
});

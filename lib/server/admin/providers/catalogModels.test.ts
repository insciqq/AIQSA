import { describe, expect, it } from "vitest";
import { fixtureConnection, fixtureModel } from "@/components/admin/providers/providerFixtures";
import { decodeAdminProviderCatalogUpdates } from "../../../contracts/adminProviders";
import { adminProviderModelConfiguration } from "./adminConfiguration";
import { providerSetupModels } from "./setupModels";
import { providerCatalogUpdates } from "./catalogModels";

describe("installed provider catalog suggestions", () => {
  it("counts manual, draft and disabled models by class and either active or draft identity", () => {
    const candidates = providerSetupModels("gemini");
    const [first, second, third] = candidates;
    const connection = fixtureConnection({ displayName: "Gemini", family: "gemini", id: "first", models: [first!, second!, third!].map((candidate, index) => {
      const configuration = adminProviderModelConfiguration(candidate.configuration);
      return fixtureModel({ id: `manual-${index}`, connectionId: "first", displayName: "Manual override", enabled: false,
        activeConfig: index === 0 ? null : configuration, draftConfig: index === 2 ? { ...configuration, upstreamModelId: "edited-draft" } : configuration,
        activeVersion: index === 0 ? 0 : 1, modelClass: configuration.modelClass });
    }) });
    const snapshot = structuredClone(connection);
    expect(providerCatalogUpdates(connection, []).available.map(({ id }) => id)).toEqual(candidates.slice(3).map(({ modelId }) => modelId));
    expect(connection).toEqual(snapshot);
    expect(providerCatalogUpdates({ ...connection, models: [] }, []).available).toHaveLength(candidates.length);
  });

  it("keeps distinct classes and the current endpoint; code-owned identities are not offered twice", () => {
    const candidate = providerSetupModels("gemini").find((entry) => entry.configuration.modelClass === "image")!;
    const manual = fixtureModel({ id: "manual", displayName: "Different class", connectionId: "first" });
    manual.draftConfig.upstreamModelId = candidate.configuration.upstreamModelId;
    const connection = fixtureConnection({ displayName: "Gemini", family: "gemini", id: "first", models: [manual] });
    expect(providerCatalogUpdates(connection, []).available.some(({ id }) => id === candidate.modelId)).toBe(true);
    manual.id = candidate.modelId;
    expect(providerCatalogUpdates(connection, []).available.some(({ id }) => id === candidate.modelId)).toBe(false);
    const compatible = fixtureConnection({ displayName: "Compatible", family: "openai_compatible", id: "compatible", models: [] });
    compatible.draftConfig = { ...compatible.draftConfig, apiRoot: "https://fixture.example.test/backend-api/codex" };
    expect(providerCatalogUpdates(compatible, []).available).toEqual([]);
    compatible.activeConfig = compatible.draftConfig;
    expect(providerCatalogUpdates(compatible, []).available.map(({ id }) => id)).toEqual(["codex-lb:gpt-image-2"]);
  });

  it("keeps skip specific to IDs and this connection; later candidates remain visible", () => {
    const connection = fixtureConnection({ displayName: "Gemini", family: "gemini", id: "first", models: [] });
    const candidates = providerSetupModels("gemini");
    const result = providerCatalogUpdates(connection, [candidates[0]!.modelId]);
    expect(result.skipped.map(({ id }) => id)).toEqual([candidates[0]!.modelId]);
    expect(result.available).toHaveLength(candidates.length - 1);
    expect(providerCatalogUpdates({ ...connection, id: "second" } as typeof connection, []).skipped).toEqual([]);
    expect(decodeAdminProviderCatalogUpdates(result)).toEqual(result);
    expect(decodeAdminProviderCatalogUpdates({ ...result, available: [...result.available, ...result.skipped] })).toBeNull();
    expect(decodeAdminProviderCatalogUpdates({ available: [{ ...result.skipped[0], secret: "synthetic" }], skipped: [] })).toBeNull();
  });
});

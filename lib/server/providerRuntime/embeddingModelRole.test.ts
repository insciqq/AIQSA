import { describe, expect, it, vi } from "vitest";
import { ProviderConfigurationError } from "../providers/providerConfiguration";
import { ProviderAdmissionError, type EmbeddingProviderAdmissionRole } from "./admission";
import {
  admitInstallationEmbeddingModel,
  createEmbeddingModelRoleResolver,
  type EmbeddingModelRolePrisma,
  type EmbeddingRoleLoader
} from "./embeddingModelRole";

const ROLE = { authority: { providerModelId: "embed-a" } } as unknown as EmbeddingProviderAdmissionRole;

function database(policy: Record<string, unknown> | null) {
  const findUnique = vi.fn(async () => policy);
  return { db: { systemModelPolicy: { findUnique } } as unknown as EmbeddingModelRolePrisma, findUnique };
}

describe("the past-chat embedding role", () => {
  it("reads only the embedding role column and keeps 'not set' apart from a model", async () => {
    const loadRole = vi.fn<EmbeddingRoleLoader>();
    const { db, findUnique } = database({
      embeddingProviderModelId: null,
      // Other roles' models are never borrowed for this one.
      providerModelId: "utility-model",
      rerankerProviderModelId: "reranker-model",
      version: 7
    });
    const resolver = createEmbeddingModelRoleResolver(db, { loadRole });
    expect(await resolver.resolve()).toEqual({ kind: "unset", policyVersion: 7 });
    expect(await resolver.assigned()).toBeNull();
    expect(loadRole).not.toHaveBeenCalled();
    expect(findUnique).toHaveBeenCalledWith({
      select: { embeddingProviderModelId: true, version: true },
      where: { id: "installation" }
    });
  });

  it("is not set without an installation policy row", async () => {
    const { db } = database(null);
    expect(await createEmbeddingModelRoleResolver(db, { loadRole: vi.fn() }).resolve())
      .toEqual({ kind: "unset", policyVersion: null });
  });

  it("resolves the assigned model on its installation credential", async () => {
    const loadRole = vi.fn<EmbeddingRoleLoader>(async () => ROLE);
    const { db } = database({ embeddingProviderModelId: "embed-a", version: 3 });
    const resolver = createEmbeddingModelRoleResolver(db, { loadRole });
    expect(await resolver.resolve()).toEqual({ kind: "model", policyVersion: 3, providerModelId: "embed-a", role: ROLE });
    expect(loadRole).toHaveBeenCalledWith(db, { providerModelId: "embed-a" });
    expect(await resolver.assigned()).toBe("embed-a");
  });

  it("reports a model that lost its evidence, configuration or credential as unavailable with a code, never another model", async () => {
    for (const [error, code] of [
      [new ProviderAdmissionError("model_not_available"), "model_not_available"],
      [new ProviderAdmissionError("credential_revoked"), "credential_revoked"],
      [new ProviderAdmissionError("credential_default_missing"), "credential_default_missing"],
      [new ProviderConfigurationError("provider_embedding_configuration_invalid"), "model_not_available"],
      [new Error("provider_execution_snapshot_invalid"), "model_not_available"]
    ] as const) {
      const { db } = database({ embeddingProviderModelId: "embed-a", version: 3 });
      const resolver = createEmbeddingModelRoleResolver(db, { loadRole: async () => { throw error; } });
      expect(await resolver.resolve()).toEqual({ code, kind: "unavailable", policyVersion: 3, providerModelId: "embed-a" });
    }
  });

  it("throws an unexpected failure instead of calling the model unavailable", async () => {
    const { db } = database({ embeddingProviderModelId: "embed-a", version: 3 });
    const resolver = createEmbeddingModelRoleResolver(db, { loadRole: async () => { throw new Error("database down"); } });
    await expect(resolver.resolve()).rejects.toThrow("database down");
    await expect(admitInstallationEmbeddingModel(db, "embed-a", async () => { throw new TypeError("bug"); }))
      .rejects.toThrow("bug");
  });
});

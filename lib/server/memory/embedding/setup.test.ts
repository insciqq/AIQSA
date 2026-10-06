import { describe, expect, it, vi } from "vitest";
import { MemoryPersistenceError } from "../persistence/errors";
import { MemoryRebuildServiceError } from "../rebuild/service";
import { ensureMemoryEmbeddingSetup, type MemoryEmbeddingSetupDependencies } from "./setup";

function fixture() {
  const settings = {
    activeIndexGenerationId: "old-index" as string | null,
    embeddingProviderModelId: null as string | null, embeddingSelectionResolved: false,
    memoryRevision: 7, settingsRevision: 0, useMemoryFacts: true
  };
  const dependencies = {
    readSettings: vi.fn(async () => ({ ...settings })),
    readDefault: vi.fn(async () => "verified-model" as string | null),
    readGeneration: vi.fn(async () => ({ embeddingProviderModelId: null as string | null, indexMode: "LEXICAL_ONLY" as "HYBRID" | "LEXICAL_ONLY" })),
    hasPendingRebuild: vi.fn(async () => false),
    hasStoppedRebuild: vi.fn(async () => false),
    select: vi.fn(async (_userId: string, modelId: string) => {
      Object.assign(settings, { embeddingProviderModelId: modelId, embeddingSelectionResolved: true,
        memoryRevision: 8, settingsRevision: settings.settingsRevision + 1 });
      return { ...settings };
    }),
    rebuild: vi.fn(async () => {})
  } satisfies MemoryEmbeddingSetupDependencies;
  return { dependencies, settings, run: () => ensureMemoryEmbeddingSetup(dependencies, "owner") };
}

describe("personal Memory embedding setup", () => {
  it("adopts a verified installation default once and queues re-embedding with the new revision", async () => {
    const f = fixture();
    expect(await f.run()).toBe("queued");
    expect(f.dependencies.select).toHaveBeenCalledWith("owner", "verified-model", expect.objectContaining({ settingsRevision: 0 }));
    expect(f.dependencies.rebuild).toHaveBeenCalledWith("owner", "verified-model", expect.objectContaining({ memoryRevision: 8, settingsRevision: 1 }));
    f.dependencies.hasPendingRebuild.mockResolvedValue(true);
    expect(await f.run()).toBe("pending");
    expect(f.dependencies.select).toHaveBeenCalledOnce();
    expect(f.dependencies.rebuild).toHaveBeenCalledOnce();
  });

  it.each([1, 11])("adopts the default after only unrelated settings revisions (revision %s)", async revision => {
    // The 2026-09-11 default-on migration bumped every existing owner to 1.
    const f = fixture(); f.settings.settingsRevision = revision;
    expect(await f.run()).toBe("queued");
    expect(f.dependencies.select).toHaveBeenCalledWith("owner", "verified-model", expect.objectContaining({ settingsRevision: revision }));
    expect(f.dependencies.rebuild).toHaveBeenCalledWith("owner", "verified-model", expect.objectContaining({ settingsRevision: revision + 1 }));
  });

  it.each([1, 9])("preserves an explicit clear or a selection a system path later cleared (revision %s)", async revision => {
    const f = fixture(); Object.assign(f.settings, { embeddingSelectionResolved: true, settingsRevision: revision });
    expect(await f.run()).toBe("preserved");
    expect(f.dependencies.readDefault).not.toHaveBeenCalled();
    expect(f.dependencies.select).not.toHaveBeenCalled();
    expect(f.dependencies.rebuild).not.toHaveBeenCalled();
  });

  it("does no adoption or work while Memory is paused", async () => {
    const f = fixture(); f.settings.useMemoryFacts = false;
    expect(await f.run()).toBe("disabled");
    expect(f.dependencies.readDefault).not.toHaveBeenCalled();
    expect(f.dependencies.rebuild).not.toHaveBeenCalled();
  });

  it("keeps the owner's chosen vector space when the installation default changes", async () => {
    const f = fixture(); f.settings.embeddingProviderModelId = "owner-model";
    f.dependencies.readGeneration.mockResolvedValue({ embeddingProviderModelId: "owner-model", indexMode: "HYBRID" });
    expect(await f.run()).toBe("current");
    expect(f.dependencies.readDefault).not.toHaveBeenCalled();
    expect(f.dependencies.rebuild).not.toHaveBeenCalled();
  });

  it("repairs interrupted setup after selection without selecting the default again", async () => {
    const f = fixture();
    f.dependencies.rebuild.mockRejectedValueOnce(new MemoryRebuildServiceError("memory_version_stale"));
    expect(await f.run()).toBe("unavailable");
    expect(await f.run()).toBe("queued");
    expect(f.dependencies.select).toHaveBeenCalledOnce();
    expect(f.dependencies.readDefault).toHaveBeenCalledOnce();
  });

  it("respects a failed or cancelled rebuild instead of replaying its provider work", async () => {
    const f = fixture(); f.settings.embeddingProviderModelId = "owner-model";
    f.dependencies.hasStoppedRebuild.mockResolvedValue(true);
    expect(await f.run()).toBe("preserved");
    expect(f.dependencies.rebuild).not.toHaveBeenCalled();
  });

  it("leaves lexical Memory usable when no default or owner entitlement is available", async () => {
    const f = fixture(); f.dependencies.readDefault.mockResolvedValueOnce(null);
    expect(await f.run()).toBe("unavailable");
    f.dependencies.select.mockRejectedValueOnce(new MemoryPersistenceError("memory_embedding_unavailable"));
    expect(await f.run()).toBe("unavailable");
    expect(f.dependencies.rebuild).not.toHaveBeenCalled();
    expect(f.settings.embeddingProviderModelId).toBeNull();
  });
});

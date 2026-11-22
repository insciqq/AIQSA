import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { ProviderAdmissionError } from "../../providerRuntime/admission";
import {
  AdminSystemModelPolicyServiceError,
  createAdminSystemModelPolicyService
} from "./systemModelPolicyService";

vi.mock("../../observability", () => ({ logEvent: vi.fn() }));

const NOW = new Date("2026-11-22T00:00:00.000Z");
const embeddingRole = { authority: { providerModelId: "embed-a" } };

type Dependencies = NonNullable<Parameters<typeof createAdminSystemModelPolicyService>[1]>;

function embeddingRow(id: string, displayName: string) {
  return {
    activeConfig: { adapterKind: "openai_embeddings_compatible", modelClass: "embedding" },
    activeVersion: 1,
    activatedAt: NOW,
    connection: {
      activeConfig: {}, activeVersion: 1, activatedAt: NOW, displayName: "Embedding provider", enabled: true, id: "connection-1"
    },
    connectionId: "connection-1",
    displayName,
    enabled: true,
    id
  };
}

function embeddingSave(current: string | null, options: Readonly<{
  loadEmbeddingRole?: ReturnType<typeof vi.fn>;
  scheduleReembedding?: ReturnType<typeof vi.fn>;
  version?: number;
}> = {}) {
  const update = vi.fn().mockResolvedValue({});
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ embeddingProviderModelId: current, version: options.version ?? 3 }]),
    systemModelPolicy: { update },
    user: { findFirst: vi.fn().mockResolvedValue({ id: "admin-1" }) }
  };
  const prisma = {
    $transaction: vi.fn(async (operation: (store: typeof tx) => Promise<void>) => operation(tx))
  } as unknown as PrismaClient;
  const loadEmbeddingRole = options.loadEmbeddingRole ?? vi.fn().mockResolvedValue(embeddingRole);
  const scheduleReembedding = options.scheduleReembedding ?? vi.fn().mockResolvedValue(4);
  const loadRole = vi.fn();
  const loadRerankerRole = vi.fn().mockResolvedValue({});
  const service = createAdminSystemModelPolicyService(prisma, {
    loadEmbeddingRole, loadRerankerRole, loadRole, scheduleReembedding
  } as unknown as Dependencies);
  const save = (embeddingProviderModelId: string | null) =>
    service.update({ embeddingProviderModelId, expectedVersion: 3, userId: "admin-1" });
  return { loadEmbeddingRole, loadRerankerRole, loadRole, prisma, save, scheduleReembedding, service, tx, update };
}

describe("the past-chat embedding role", () => {
  it("assigns a verified embedding model, records the choice and re-embeds the index once, after the save", async () => {
    const { loadEmbeddingRole, loadRerankerRole, loadRole, prisma, save, scheduleReembedding, tx, update } = embeddingSave(null);
    await save("embed-a");
    expect(loadEmbeddingRole).toHaveBeenCalledWith(tx, { providerModelId: "embed-a" });
    expect(update).toHaveBeenCalledWith({
      data: {
        embeddingConfiguredAt: expect.any(Date),
        embeddingProviderModelId: "embed-a",
        updatedByUserId: "admin-1",
        version: { increment: 1 }
      },
      where: { id: "installation" }
    });
    // An independent role: no other role is admitted or written.
    expect(loadRole).not.toHaveBeenCalled();
    expect(loadRerankerRole).not.toHaveBeenCalled();
    expect(scheduleReembedding).toHaveBeenCalledTimes(1);
    expect(scheduleReembedding).toHaveBeenCalledWith(prisma);
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(scheduleReembedding.mock.invocationCallOrder[0]!);
  });

  it("changes the model and re-embeds once", async () => {
    const { save, scheduleReembedding, update } = embeddingSave("embed-a");
    await save("embed-b");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ embeddingConfiguredAt: expect.any(Date), embeddingProviderModelId: "embed-b" })
    }));
    expect(scheduleReembedding).toHaveBeenCalledTimes(1);
  });

  it("clears the role without admitting anything, records the explicit clear and re-embeds once", async () => {
    const { loadEmbeddingRole, save, scheduleReembedding, update } = embeddingSave("embed-a");
    await save(null);
    expect(loadEmbeddingRole).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ embeddingConfiguredAt: expect.any(Date), embeddingProviderModelId: null })
    }));
    expect(scheduleReembedding).toHaveBeenCalledTimes(1);
  });

  it("records a save of the saved value but does not re-embed", async () => {
    for (const [current, next] of [["embed-a", "embed-a"], [null, null]] as const) {
      const { save, scheduleReembedding, update } = embeddingSave(current);
      await save(next);
      expect(update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ embeddingConfiguredAt: expect.any(Date), embeddingProviderModelId: next })
      }));
      expect(scheduleReembedding).not.toHaveBeenCalled();
    }
  });

  it("refuses a model without embedding capability evidence on its installation key, writing and scheduling nothing", async () => {
    for (const error of [
      new ProviderAdmissionError("model_not_available"),
      new ProviderAdmissionError("credential_default_missing")
    ]) {
      const { save, scheduleReembedding, update } = embeddingSave(null, { loadEmbeddingRole: vi.fn().mockRejectedValue(error) });
      await expect(save("answer-or-unchecked-model")).rejects.toEqual(
        new AdminSystemModelPolicyServiceError("system_model_policy_target_unavailable")
      );
      expect(update).not.toHaveBeenCalled();
      expect(scheduleReembedding).not.toHaveBeenCalled();
    }
  });

  it("schedules nothing when the save itself fails", async () => {
    const { save, scheduleReembedding, update } = embeddingSave(null, { version: 9 });
    await expect(save("embed-a")).rejects.toMatchObject({ code: "system_model_policy_stale" });
    expect(update).not.toHaveBeenCalled();
    expect(scheduleReembedding).not.toHaveBeenCalled();
  });

  it("keeps a committed save when scheduling fails; the backfill sweep catches up", async () => {
    const scheduleReembedding = vi.fn().mockRejectedValue(new Error("database down"));
    const { save, update } = embeddingSave(null, { scheduleReembedding });
    await expect(save("embed-a")).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledTimes(1);
    expect(scheduleReembedding).toHaveBeenCalledTimes(1);
  });

  it("leaves the role untouched on another role's save", async () => {
    const { scheduleReembedding, service, update } = embeddingSave("embed-a");
    await service.update({ expectedVersion: 3, rerankerProviderModelId: "reranker-1", userId: "admin-1" });
    const data = (update.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data).not.toHaveProperty("embeddingProviderModelId");
    expect(data).not.toHaveProperty("embeddingConfiguredAt");
    expect(scheduleReembedding).not.toHaveBeenCalled();
  });

  it("offers only admitted embedding models and marks the assigned one by its admission", async () => {
    const ready = embeddingRow("embed-a", "Ready embedding");
    const unchecked = embeddingRow("embed-b", "Unchecked embedding");
    const findMany = vi.fn(async (query: { where: { modelClass?: string } }) =>
      query.where.modelClass === "embedding" ? [ready, unchecked] : []);
    const loadEmbeddingRole = vi.fn(async (_db: unknown, { providerModelId }: { providerModelId: string }) => {
      if (providerModelId === "embed-a") return embeddingRole;
      throw new ProviderAdmissionError("model_not_available");
    });
    const absent = vi.fn().mockResolvedValue({ code: "absent", ok: false, selectedProviderModelId: null });
    const list = (assigned: typeof ready | null) => createAdminSystemModelPolicyService({
      memoryUtilityModelPolicy: { findUnique: vi.fn().mockResolvedValue({
        providerModelId: null, providerModel: null, reasoningEffort: null, version: 1, assignmentSource: "UNASSIGNED"
      }) },
      providerModel: { findMany },
      systemModelPolicy: { findUnique: vi.fn().mockResolvedValue({
        embeddingProviderModel: assigned, embeddingProviderModelId: assigned?.id ?? null,
        providerModel: null, providerModelId: null, reasoningEffort: null, rerankerProviderModel: null,
        rerankerProviderModelId: null, updatedAt: NOW, updatedBy: null, version: 6
      }) }
    } as unknown as PrismaClient, {
      loadEmbeddingRole, resolveChatPdfRole: absent, resolveRerankerRole: absent, resolveRole: absent
    } as unknown as Dependencies).list();

    const candidate = { connectionDisplayName: "Embedding provider", connectionId: "connection-1", displayName: "Ready embedding", id: "embed-a" };
    const withReady = await list(ready);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { modelClass: "embedding" } }));
    expect(withReady.embeddingCandidates).toEqual([candidate]);
    expect(withReady.policy.embeddingModel).toEqual({ ...candidate, available: true });
    // An assigned model that lost its evidence or key stays shown as unavailable, and nothing replaces it.
    const withUnchecked = await list(unchecked);
    expect(withUnchecked.embeddingCandidates).toEqual([candidate]);
    expect(withUnchecked.policy.embeddingModel).toEqual({
      available: false, connectionDisplayName: "Embedding provider", connectionId: "connection-1",
      displayName: "Unchecked embedding", id: "embed-b"
    });
    expect((await list(null)).policy.embeddingModel).toBeNull();
  });
});

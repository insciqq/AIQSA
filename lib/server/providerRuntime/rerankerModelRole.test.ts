import { describe, expect, it, vi } from "vitest";
import {
  ProviderAdmissionError,
  type RerankerProviderAdmissionRole
} from "./admission";
import { createRerankerModelRoleResolver } from "./rerankerModelRole";

const NOW = new Date("2026-08-27T00:00:00.000Z");

function rerankerConfiguration(upstreamModelId = "qwen/qwen3-reranker-8b") {
  return {
    adapterKind: "openrouter_rerank",
    answerSelectable: false,
    capabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      streaming: false,
      toolCalling: false,
      vision: false
    },
    defaultParams: {},
    modelClass: "reranker",
    openRouterRouting: { mode: "automatic", providers: [] },
    upstreamModelId
  };
}

function database(input: Readonly<{
  candidates?: Array<{ activeConfig: unknown; id: string }>;
  policies: Array<Record<string, unknown> | null>;
  updateCount?: number;
}>) {
  const policies = [...input.policies];
  return {
    providerModel: {
      findMany: vi.fn().mockResolvedValue(input.candidates ?? [])
    },
    systemModelPolicy: {
      findUnique: vi.fn().mockImplementation(async () =>
        policies.length > 1 ? policies.shift() : policies[0]),
      updateMany: vi.fn().mockResolvedValue({ count: input.updateCount ?? 1 })
    }
  };
}

describe("installation reranker model role resolver", () => {
  it("adopts the code-owned default once for a never-configured installation", async () => {
    const role = {} as RerankerProviderAdmissionRole;
    const loadRole = vi.fn().mockResolvedValue(role);
    const db = database({
      candidates: [{ activeConfig: rerankerConfiguration(), id: "reranker-1" }],
      policies: [{
        rerankerConfiguredAt: null,
        rerankerProviderModelId: null,
        version: 1
      }]
    });

    await expect(createRerankerModelRoleResolver(db as never, {
      loadRole
    }).resolve()).resolves.toEqual({
      credentialScope: "installation",
      ok: true,
      policyVersion: 2,
      providerModelId: "reranker-1",
      role
    });
    expect(loadRole).toHaveBeenCalledWith(db, { providerModelId: "reranker-1" });
    expect(db.systemModelPolicy.updateMany).toHaveBeenCalledExactlyOnceWith({
      data: {
        rerankerProviderModelId: "reranker-1",
        version: { increment: 1 }
      },
      where: {
        id: "installation",
        rerankerConfiguredAt: null,
        rerankerProviderModelId: null,
        version: 1
      }
    });
  });

  it("keeps an explicitly cleared role cleared", async () => {
    const db = database({
      policies: [{
        rerankerConfiguredAt: NOW,
        rerankerProviderModelId: null,
        version: 3
      }]
    });

    await expect(createRerankerModelRoleResolver(db as never, {
      loadRole: vi.fn()
    }).resolve()).resolves.toEqual({
      code: "reranker_model_absent",
      ok: false,
      selectedProviderModelId: null
    });
    expect(db.providerModel.findMany).not.toHaveBeenCalled();
    expect(db.systemModelPolicy.updateMany).not.toHaveBeenCalled();
  });

  it("never overwrites a manual selection", async () => {
    const role = {} as RerankerProviderAdmissionRole;
    const loadRole = vi.fn().mockResolvedValue(role);
    const db = database({
      policies: [{
        rerankerConfiguredAt: NOW,
        rerankerProviderModelId: "manual-1",
        version: 4
      }]
    });

    await expect(createRerankerModelRoleResolver(db as never, {
      loadRole
    }).resolve()).resolves.toEqual({
      credentialScope: "installation",
      ok: true,
      policyVersion: 4,
      providerModelId: "manual-1",
      role
    });
    expect(db.providerModel.findMany).not.toHaveBeenCalled();
    expect(db.systemModelPolicy.updateMany).not.toHaveBeenCalled();
  });

  it("skips non-default and unusable deployments without adopting", async () => {
    const loadRole = vi.fn().mockRejectedValue(
      new ProviderAdmissionError("model_not_available")
    );
    const db = database({
      candidates: [
        {
          activeConfig: rerankerConfiguration("qwen/qwen3-reranker-4b"),
          id: "alternative-1"
        },
        { activeConfig: rerankerConfiguration(), id: "default-1" }
      ],
      policies: [{
        rerankerConfiguredAt: null,
        rerankerProviderModelId: null,
        version: 1
      }]
    });

    await expect(createRerankerModelRoleResolver(db as never, {
      loadRole
    }).resolve()).resolves.toEqual({
      code: "reranker_model_absent",
      ok: false,
      selectedProviderModelId: null
    });
    expect(loadRole).toHaveBeenCalledExactlyOnceWith(db, {
      providerModelId: "default-1"
    });
    expect(db.systemModelPolicy.updateMany).not.toHaveBeenCalled();
  });

  it("yields to a concurrent explicit save that wins the guarded write", async () => {
    const role = {} as RerankerProviderAdmissionRole;
    const loadRole = vi.fn().mockResolvedValue(role);
    const db = database({
      candidates: [{ activeConfig: rerankerConfiguration(), id: "reranker-1" }],
      policies: [
        {
          rerankerConfiguredAt: null,
          rerankerProviderModelId: null,
          version: 1
        },
        {
          rerankerConfiguredAt: NOW,
          rerankerProviderModelId: "manual-2",
          version: 2
        }
      ],
      updateCount: 0
    });

    await expect(createRerankerModelRoleResolver(db as never, {
      loadRole
    }).resolve()).resolves.toEqual({
      credentialScope: "installation",
      ok: true,
      policyVersion: 2,
      providerModelId: "manual-2",
      role
    });
  });

  it("reports a retained-but-unavailable manual selection without substitution", async () => {
    const db = database({
      policies: [{
        rerankerConfiguredAt: NOW,
        rerankerProviderModelId: "manual-1",
        version: 4
      }]
    });

    await expect(createRerankerModelRoleResolver(db as never, {
      loadRole: vi.fn().mockRejectedValue(
        new ProviderAdmissionError("model_not_available")
      )
    }).resolve()).resolves.toEqual({
      code: "reranker_model_unavailable",
      ok: false,
      selectedProviderModelId: "manual-1"
    });
    expect(db.systemModelPolicy.updateMany).not.toHaveBeenCalled();
  });
});

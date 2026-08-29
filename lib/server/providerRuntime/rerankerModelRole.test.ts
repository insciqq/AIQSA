import { describe, expect, it, vi } from "vitest";
import { approvedRerankerDeployments } from "../admin/providers/approvedRerankers";
import { ProviderAdmissionError } from "./admission";
import { createRerankerModelRoleResolver } from "./rerankerModelRole";

describe("reranker model role resolver", () => {
  it("keeps the selected approved deployment first and skips unavailable fallbacks", async () => {
    const [voyage, cohere, qwen] = approvedRerankerDeployments;
    if (!voyage || !cohere || !qwen) throw new Error("approved route missing");
    const loadRole = vi.fn(async (_db: unknown, input: { providerModelId: string }) => {
      if (input.providerModelId === cohere.providerModelId) {
        throw new ProviderAdmissionError("model_not_available");
      }
      return { providerModelId: input.providerModelId } as never;
    });
    const db = {
      systemModelPolicy: {
        findUnique: vi.fn(async () => ({
          rerankerProviderModelId: voyage.providerModelId,
          version: 7
        }))
      }
    };

    const result = await createRerankerModelRoleResolver(db as never, {
      loadRole: loadRole as never
    }).resolve();

    expect(result).toMatchObject({
      ok: true,
      policyVersion: 7,
      providerModelId: voyage.providerModelId,
      selectedProviderModelId: voyage.providerModelId
    });
    if (!result.ok) throw new Error("reranker route unavailable");
    expect(result.routes?.map(({ providerModelId }) => providerModelId)).toEqual([
      voyage.providerModelId,
      qwen.providerModelId
    ]);
    expect(loadRole.mock.calls.map((call) => call[1].providerModelId)).toEqual(
      approvedRerankerDeployments.map(({ providerModelId }) => providerModelId)
    );
  });

  it("never adds code-owned fallbacks behind a custom administrator selection", async () => {
    const loadRole = vi.fn(async () => ({ custom: true }) as never);
    const db = {
      systemModelPolicy: {
        findUnique: vi.fn(async () => ({
          rerankerProviderModelId: "custom-reranker",
          version: 3
        }))
      }
    };

    const result = await createRerankerModelRoleResolver(db as never, {
      loadRole: loadRole as never
    }).resolve();

    expect(result).toMatchObject({
      ok: true,
      providerModelId: "custom-reranker",
      selectedProviderModelId: "custom-reranker"
    });
    if (!result.ok) throw new Error("custom reranker unavailable");
    expect(result.routes).toHaveLength(1);
    expect(loadRole).toHaveBeenCalledTimes(1);
  });
});

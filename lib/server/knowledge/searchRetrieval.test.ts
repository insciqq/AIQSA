import { describe, expect, it, vi } from "vitest";
import { OpenSearchTransportError } from "../search/opensearch/transport";
import { createKnowledgePassageBm25Search } from "./searchRetrieval";

describe("Knowledge passage BM25 search", () => {
  it("revalidates the exact index contract immediately before search", async () => {
    const order: string[] = [];
    const checkKnowledgeIndex = vi.fn(async () => {
      order.push("contract");
    });
    const searchKnowledgePassages = vi.fn(async () => {
      order.push("search");
      return {
        durationMs: 2,
        opaqueId: "request-1",
        variants: [[]]
      };
    });
    const search = createKnowledgePassageBm25Search({
      checkKnowledgeIndex,
      searchKnowledgePassages
    } as never);

    await expect(search({
      indexArtifactIds: ["artifact-1"],
      ownerUserId: "owner-1",
      queryVariants: ["Question"]
    })).resolves.toMatchObject({ hits: [] });

    expect(order).toEqual(["contract", "search"]);
    expect(checkKnowledgeIndex).toHaveBeenCalledOnce();
    expect(searchKnowledgePassages).toHaveBeenCalledOnce();
  });

  it("fails before search when the exact index contract has drifted", async () => {
    const checkKnowledgeIndex = vi.fn(async () => {
      throw new OpenSearchTransportError("opensearch_index_incompatible");
    });
    const searchKnowledgePassages = vi.fn();
    const search = createKnowledgePassageBm25Search({
      checkKnowledgeIndex,
      searchKnowledgePassages
    } as never);

    await expect(search({
      indexArtifactIds: ["artifact-1"],
      ownerUserId: "owner-1",
      queryVariants: ["Question"]
    })).rejects.toMatchObject({ code: "opensearch_index_incompatible" });
    expect(searchKnowledgePassages).not.toHaveBeenCalled();
  });

  it("does not touch the backend when the accepted scope has no artifacts", async () => {
    const checkKnowledgeIndex = vi.fn();
    const searchKnowledgePassages = vi.fn();
    const search = createKnowledgePassageBm25Search({
      checkKnowledgeIndex,
      searchKnowledgePassages
    } as never);

    await expect(search({
      indexArtifactIds: [],
      ownerUserId: "owner-1",
      queryVariants: ["Question"]
    })).resolves.toMatchObject({ hits: [] });
    expect(checkKnowledgeIndex).not.toHaveBeenCalled();
    expect(searchKnowledgePassages).not.toHaveBeenCalled();
  });
});

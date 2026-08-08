import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { loadAdminGrantableCatalog } from "./adminCatalogQueries";

const capabilities = {
  nativePdfInput: false,
  nativeSearch: true,
  pdf: false,
  reasoning: false,
  vision: false
};

function model(input: {
  answerSelectable?: boolean;
  connectionId: string;
  displayName: string;
  family?: string;
  id: string;
  modelClass?: "answer" | "embedding";
}) {
  const fake = input.family === "fake";
  return {
    activeConfig: input.modelClass === "embedding"
      ? {
          adapterKind: "openai_embeddings_compatible",
          answerSelectable: false,
          upstreamModelId: `${input.id}/upstream`
        }
      : fake
      ? {
          adapterKind: "fake",
          capabilities,
          defaultParams: {},
          upstreamModelId: "fake-qsa"
        }
      : {
          adapterKind: "openai_responses_compatible",
          ...(input.answerSelectable === undefined
            ? {}
            : { answerSelectable: input.answerSelectable }),
          capabilities,
          defaultParams: {},
          upstreamModelId: `${input.id}/upstream`
        },
    connection: {
      displayName: `${input.displayName} provider`,
      family: input.family ?? "openai_compatible",
      id: input.connectionId
    },
    displayName: input.displayName,
    id: input.id,
    modelClass: input.modelClass ?? "answer"
  };
}

describe("admin grantable catalog", () => {
  it("keeps answer and embedding grants while excluding technical-only runtimes", async () => {
    const prisma = {
      providerModel: {
        findMany: vi.fn(async () => [
          model({
            connectionId: "connection-answer",
            displayName: "Answer model",
            id: "model-answer"
          }),
          model({
            connectionId: "connection-embedding",
            displayName: "Embedding model",
            id: "model-embedding",
            modelClass: "embedding"
          }),
          model({
            answerSelectable: false,
            connectionId: "connection-search",
            displayName: "Web Search runtime",
            id: "model-search"
          }),
          model({
            connectionId: "connection-fake",
            displayName: "Fake QSA",
            family: "fake",
            id: "model-fake"
          })
        ])
      },
      searchOption: {
        findMany: vi.fn(async () => [{
          displayName: "Search option",
          optionId: "search-option"
        }])
      }
    };

    const catalog = await loadAdminGrantableCatalog(prisma as unknown as PrismaClient);

    expect(catalog.models.map(({ modelId }) => modelId)).toEqual([
      "model-answer",
      "model-embedding",
      "model-fake"
    ]);
    expect(catalog.providers.map(({ id }) => id)).toEqual([
      "connection-answer",
      "connection-embedding",
      "connection-fake"
    ]);
    expect(catalog.searchStrategies).toEqual([{
      displayName: "Search option",
      strategyId: "search-option"
    }]);
  });
});

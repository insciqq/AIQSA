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
}) {
  const fake = input.family === "fake";
  return {
    activeConfig: fake
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
    id: input.id
  };
}

describe("admin grantable catalog", () => {
  it("keeps legacy and Fake answer models while excluding technical-only runtimes", async () => {
    const prisma = {
      providerModel: {
        findMany: vi.fn(async () => [
          model({
            connectionId: "connection-answer",
            displayName: "Answer model",
            id: "model-answer"
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
      searchStrategy: {
        findMany: vi.fn(async () => [{
          displayName: "Search option",
          strategyId: "search-option"
        }])
      }
    };

    const catalog = await loadAdminGrantableCatalog(prisma as unknown as PrismaClient);

    expect(catalog.models.map(({ modelId }) => modelId)).toEqual([
      "model-answer",
      "model-fake"
    ]);
    expect(catalog.providers.map(({ id }) => id)).toEqual([
      "connection-answer",
      "connection-fake"
    ]);
    expect(catalog.searchStrategies).toEqual([{
      displayName: "Search option",
      strategyId: "search-option"
    }]);
  });
});

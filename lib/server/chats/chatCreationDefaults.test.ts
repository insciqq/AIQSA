import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { CatalogProviderModelRow } from "../catalog/prismaCatalogData";
import { loadChatCreationDefaults } from "./chatCreationDefaults";
import { createPrismaChatRepository } from "./prismaRepository";

const NOW = new Date("2026-08-08T00:00:00.000Z");
const USER_ID = "user-1";
const capabilities = {
  nativePdfInput: false,
  nativeSearch: false,
  pdf: false,
  reasoning: true,
  streaming: true,
  toolCalling: true,
  vision: false
};

function availableProviderModel(id: string): CatalogProviderModelRow {
  const connectionId = `connection:${id}`;
  const credentialId = `credential:${id}`;
  const credentialVersionId = `${credentialId}:v1`;
  const model = {
    activeConfig: {
      adapterKind: "openai_responses_native",
      answerSelectable: true,
      capabilities,
      defaultParams: { maxOutputTokens: 2_048 },
      modelClass: "answer",
      upstreamModelId: `upstream:${id}`
    },
    activeCredentialChecks: [{
      connectionId,
      connectionVersion: 5,
      credentialId,
      credentialVersionId,
      modelVersion: 7,
      providerModelId: id,
      status: "available"
    }],
    activeVersion: 7,
    activatedAt: NOW,
    capabilities: {},
    connection: {
      activeConfig: {
        allowPrivateNetwork: false,
        apiRoot: "https://api.example.test/v1",
        authenticationMode: "bearer",
        responseTimeoutMs: 300_000
      },
      activeVersion: 5,
      activatedAt: NOW,
      credentials: [{
        activeVersion: { id: credentialVersionId, revokedAt: null },
        enabled: true,
        groupAssignments: [],
        id: credentialId,
        userAssignments: []
      }],
      defaultCredentialId: credentialId,
      displayName: "Targeted provider",
      enabled: true,
      family: "openai",
      id: connectionId,
      templateKey: null,
      unassignedPolicy: "use_default"
    },
    connectionId,
    contextWindow: 8_192,
    createdAt: NOW,
    defaultParams: {},
    displayName: `Model ${id}`,
    draftConfig: {},
    draftVersion: 1,
    enabled: true,
    id,
    inputTokenPriceMicros: 0,
    modelClass: "answer",
    modelId: `unavailable:${id}`,
    outputTokenPriceMicros: 0,
    provider: "unavailable",
    supportsNativeSearch: false,
    supportsPdf: false,
    supportsReasoning: false,
    supportsVision: false,
    templateKey: null,
    updatedAt: NOW
  };
  return model as unknown as CatalogProviderModelRow;
}

function database(input: Readonly<{
  availableModelIds: readonly string[];
  entitledModelIds: readonly string[];
  organizationModelId: string | null;
  personalModelId: string | null;
}>) {
  const availableModelIds = new Set(input.availableModelIds);
  const entitledModelIds = new Set(input.entitledModelIds);
  const selectedModelId = input.personalModelId !== null
    ? input.personalModelId
    : input.organizationModelId;
  const state = { inTransaction: false };
  const events: string[] = [];
  const event = (name: string) => {
    events.push(`${name}:${state.inTransaction ? "inside" : "outside"}`);
  };
  const chatCreate = vi.fn(async (args: {
    data: {
      defaultProviderModelId: string | null;
      folderId: string | null;
      title: string;
    };
  }) => {
    event("chat.create");
    const modelId = args.data.defaultProviderModelId;
    return {
      _count: { messages: 0 },
      activeLeafMessageId: null,
      createdAt: NOW,
      defaultProviderModel: modelId
        ? { connectionId: `connection:${modelId}`, id: modelId }
        : null,
      folderId: args.data.folderId,
      id: "chat-1",
      pinned: false,
      title: args.data.title,
      updatedAt: NOW
    };
  });
  const tx = {
    chat: { create: chatCreate },
    folder: { findFirst: vi.fn() }
  };
  const prisma = {
    $transaction: vi.fn(async (operation: (store: typeof tx) => Promise<unknown>) => {
      events.push("transaction:start");
      state.inTransaction = true;
      try {
        return await operation(tx);
      } finally {
        state.inTransaction = false;
      }
    }),
    accessGrant: {
      findMany: vi.fn(async () => {
        event("accessGrant.findMany");
        if (!selectedModelId || !entitledModelIds.has(selectedModelId)) return [];
        return [{
          enabled: true,
          groupId: null,
          providerConnectionId: null,
          providerModel: { connectionId: `connection:${selectedModelId}` },
          providerModelId: selectedModelId,
          searchStrategy: null,
          userId: USER_ID
        }];
      })
    },
    modelPolicy: {
      findUnique: vi.fn(async () => {
        event("modelPolicy.findUnique");
        return { defaultProviderModelId: input.organizationModelId };
      })
    },
    providerModel: {
      findFirst: vi.fn(async (args: { where: { id: string } }) => {
        event("providerModel.findFirst");
        return availableModelIds.has(args.where.id)
          ? availableProviderModel(args.where.id)
          : null;
      })
    },
    userGroup: {
      findMany: vi.fn(async () => {
        event("userGroup.findMany");
        return [];
      })
    },
    userSettings: {
      findUnique: vi.fn(async () => {
        event("userSettings.findUnique");
        return {
          defaultFolderId: null,
          defaultProviderModelId: input.personalModelId
        };
      })
    }
  };
  return { chatCreate, events, prisma };
}

describe("chat creation defaults", () => {
  it.each([
    {
      availableModelIds: ["personal", "organization"],
      entitledModelIds: ["personal", "organization"],
      expected: "personal",
      organizationModelId: "organization",
      personalModelId: "personal",
      state: "personal set / installation present"
    },
    {
      availableModelIds: ["personal"],
      entitledModelIds: ["personal"],
      expected: "personal",
      organizationModelId: null,
      personalModelId: "personal",
      state: "personal set / installation absent"
    },
    {
      availableModelIds: ["organization"],
      entitledModelIds: ["organization"],
      expected: "organization",
      organizationModelId: "organization",
      personalModelId: null,
      state: "personal unset / installation present"
    },
    {
      availableModelIds: [],
      entitledModelIds: [],
      expected: null,
      organizationModelId: null,
      personalModelId: null,
      state: "personal unset / installation absent"
    },
    {
      availableModelIds: ["dangling", "organization"],
      entitledModelIds: ["organization"],
      expected: null,
      organizationModelId: "organization",
      personalModelId: "dangling",
      state: "personal dangling / installation present"
    },
    {
      availableModelIds: ["dangling"],
      entitledModelIds: [],
      expected: null,
      organizationModelId: null,
      personalModelId: "dangling",
      state: "personal dangling / installation absent"
    }
  ])("matches catalog precedence for $state", async ({
    availableModelIds,
    entitledModelIds,
    expected,
    organizationModelId,
    personalModelId
  }) => {
    const { prisma } = database({
      availableModelIds,
      entitledModelIds,
      organizationModelId,
      personalModelId
    });

    await expect(loadChatCreationDefaults(
      prisma as unknown as PrismaClient,
      USER_ID,
      {}
    )).resolves.toEqual({
      defaultFolderId: null,
      defaultProviderModelId: expected
    });

    const selectedModelId = personalModelId !== null
      ? personalModelId
      : organizationModelId;
    expect(prisma.providerModel.findFirst).toHaveBeenCalledTimes(selectedModelId ? 1 : 0);
    if (selectedModelId) {
      expect(prisma.providerModel.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: selectedModelId })
      }));
    }
  });

  it("finishes targeted default resolution before opening the create transaction", async () => {
    const { chatCreate, events, prisma } = database({
      availableModelIds: ["personal"],
      entitledModelIds: ["personal"],
      organizationModelId: "organization",
      personalModelId: "personal"
    });

    await expect(createPrismaChatRepository(
      prisma as unknown as PrismaClient
    ).createChat({ title: "Targeted", userId: USER_ID })).resolves.toMatchObject({
      defaultModelId: "personal",
      defaultProvider: "connection:personal",
      title: "Targeted"
    });

    expect(events.filter((entry) => entry.endsWith(":inside"))).toEqual([
      "chat.create:inside"
    ]);
    expect(events.indexOf("transaction:start")).toBeGreaterThan(
      events.indexOf("providerModel.findFirst:outside")
    );
    expect(chatCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ defaultProviderModelId: "personal" })
    }));
  });
});

import { Prisma, PrismaClient } from "@prisma/client";
import { defaultProviderModels, defaultSearchStrategies } from "../lib/domain/catalog";
import { textMessageContent } from "../lib/domain/content";
import { hashCanonicalMcpValue } from "../lib/server/mcp/definitions";
import {
  assertLocalSeedRuntime,
  ensureLocalFixturePasswordHash,
  ensureLocalOperatorPasswordHash,
  LOCAL_OPERATOR_EMAIL
} from "./local-seed-auth";
import {
  LOCAL_MCP_FIXTURE_GROUP,
  LOCAL_MCP_FIXTURE_TESTED_AT,
  LOCAL_MCP_MEMBER,
  LOCAL_ORDINARY_USERS,
  LOCAL_PRIVATE_MCP_DRAFT,
  LOCAL_PRIVATE_MCP_FIXTURE,
  LOCAL_SHARED_MCP_DRAFT,
  LOCAL_SHARED_MCP_FIXTURE
} from "./local-seed-fixtures";

const prisma = new PrismaClient();

const ids = {
  assistantMessage: "00000000-0000-4000-8000-000000000202",
  chat: "00000000-0000-4000-8000-000000000200",
  folderResearch: "00000000-0000-4000-8000-000000000101",
  group: "00000000-0000-4000-8000-000000000010",
  promptPreset: "00000000-0000-4000-8000-000000000300",
  user: "00000000-0000-4000-8000-000000000001",
  userMessage: "00000000-0000-4000-8000-000000000201"
};

const asJson = (value: unknown) => value as Prisma.InputJsonValue;

async function seedLocalOrdinaryUser(user: (typeof LOCAL_ORDINARY_USERS)[number]) {
  const [emailOwner, emailIdentity, passwordIdentities] = await Promise.all([
    prisma.user.findUnique({ select: { id: true }, where: { email: user.email } }),
    prisma.authIdentity.findUnique({
      select: {
        emailVerifiedAt: true,
        id: true,
        passwordHash: true,
        userId: true
      },
      where: {
        provider_normalizedEmail: {
          normalizedEmail: user.email,
          provider: "password"
        }
      }
    }),
    prisma.authIdentity.findMany({
      select: {
        emailVerifiedAt: true,
        id: true,
        passwordHash: true,
        userId: true
      },
      where: {
        provider: "password",
        userId: user.id
      }
    })
  ]);

  if (emailOwner && emailOwner.id !== user.id) {
    throw new Error(`The local fixture email ${user.email} belongs to another user`);
  }
  if (emailIdentity && emailIdentity.userId !== user.id) {
    throw new Error(`The local fixture password identity ${user.email} belongs to another user`);
  }
  if (passwordIdentities.length > 1) {
    throw new Error(`The local fixture ${user.email} has multiple password identities`);
  }

  const existingIdentity = emailIdentity ?? passwordIdentities[0];
  const passwordHash = await ensureLocalFixturePasswordHash(user.password, existingIdentity?.passwordHash);

  await prisma.$transaction(async (tx) => {
    await tx.user.upsert({
      create: {
        displayName: user.displayName,
        email: user.email,
        id: user.id,
        role: "user",
        status: "active"
      },
      update: {
        displayName: user.displayName,
        email: user.email,
        role: "user",
        status: "active"
      },
      where: { id: user.id }
    });

    if (existingIdentity) {
      await tx.authIdentity.update({
        data: {
          emailVerifiedAt: existingIdentity.emailVerifiedAt ?? new Date(),
          normalizedEmail: user.email,
          passwordHash,
          providerAccountId: user.email
        },
        where: { id: existingIdentity.id }
      });
    } else {
      await tx.authIdentity.create({
        data: {
          emailVerifiedAt: new Date(),
          normalizedEmail: user.email,
          passwordHash,
          provider: "password",
          providerAccountId: user.email,
          userId: user.id
        }
      });
    }
  });
}

async function seedLocalMcpFixture(input: Readonly<{
  description: string;
  displayName: string;
  draft: typeof LOCAL_SHARED_MCP_DRAFT;
  id: string;
  namespace: string;
  revisionId: string;
  toolName: string;
}>) {
  const draftHash = hashCanonicalMcpValue(input.draft);
  const validationEvidence = {
    evidence: { fixture: true, protocolVersion: "2025-06-18" },
    testedAt: LOCAL_MCP_FIXTURE_TESTED_AT,
    toolInventory: [{ description: "Deterministic development access fixture.", name: input.toolName }]
  };
  const draftTestEvidence = {
    draftHash,
    resolvedArtifact: null,
    ...validationEvidence
  };

  await prisma.mcpServer.upsert({
    create: {
      description: input.description,
      displayName: input.displayName,
      draft: asJson(input.draft),
      draftTestEvidence: asJson(draftTestEvidence),
      enabled: true,
      id: input.id,
      namespace: input.namespace,
      testedDraftHash: draftHash
    },
    update: {
      archivedAt: null,
      description: input.description,
      displayName: input.displayName,
      draft: asJson(input.draft),
      draftTestEvidence: asJson(draftTestEvidence),
      enabled: true,
      testedDraftHash: draftHash
    },
    where: { id: input.id }
  });

  await prisma.mcpRevision.upsert({
    create: {
      configuration: asJson(input.draft),
      draftHash,
      id: input.revisionId,
      identityHash: hashCanonicalMcpValue({ draftHash, fixture: input.id }),
      resolvedArtifact: Prisma.DbNull,
      revisionNumber: 1,
      serverId: input.id,
      validationEvidence: asJson(validationEvidence)
    },
    update: {
      configuration: asJson(input.draft),
      draftHash,
      identityHash: hashCanonicalMcpValue({ draftHash, fixture: input.id }),
      resolvedArtifact: Prisma.DbNull,
      validationEvidence: asJson(validationEvidence)
    },
    where: { id: input.revisionId }
  });

  await prisma.mcpServer.update({
    data: { activeRevisionId: input.revisionId },
    where: { id: input.id }
  });
}

async function main() {
  assertLocalSeedRuntime();

  const [localEmailOwner, localEmailIdentity, operatorPasswordIdentities] = await Promise.all([
    prisma.user.findUnique({
      select: {
        id: true
      },
      where: {
        email: LOCAL_OPERATOR_EMAIL
      }
    }),
    prisma.authIdentity.findUnique({
      select: {
        emailVerifiedAt: true,
        id: true,
        passwordHash: true,
        userId: true
      },
      where: {
        provider_normalizedEmail: {
          normalizedEmail: LOCAL_OPERATOR_EMAIL,
          provider: "password"
        }
      }
    }),
    prisma.authIdentity.findMany({
      select: {
        emailVerifiedAt: true,
        id: true,
        passwordHash: true,
        userId: true
      },
      where: {
        provider: "password",
        userId: ids.user
      }
    })
  ]);

  if (localEmailOwner && localEmailOwner.id !== ids.user) {
    throw new Error("The local operator email belongs to another user");
  }

  if (localEmailIdentity && localEmailIdentity.userId !== ids.user) {
    throw new Error("The local operator password identity belongs to another user");
  }

  if (operatorPasswordIdentities.length > 1) {
    throw new Error("The seeded local operator has multiple password identities");
  }

  const existingOperatorIdentity = localEmailIdentity ?? operatorPasswordIdentities[0];
  const passwordHash = await ensureLocalOperatorPasswordHash(existingOperatorIdentity?.passwordHash);

  await prisma.$transaction(async (tx) => {
    await tx.user.upsert({
      create: {
        displayName: "Local Operator",
        email: LOCAL_OPERATOR_EMAIL,
        id: ids.user,
        role: "admin",
        status: "active"
      },
      update: {
        email: LOCAL_OPERATOR_EMAIL,
        role: "admin",
        status: "active"
      },
      where: {
        id: ids.user
      }
    });

    if (existingOperatorIdentity) {
      await tx.authIdentity.update({
        data: {
          emailVerifiedAt: existingOperatorIdentity.emailVerifiedAt ?? new Date(),
          normalizedEmail: LOCAL_OPERATOR_EMAIL,
          passwordHash,
          providerAccountId: LOCAL_OPERATOR_EMAIL
        },
        where: {
          id: existingOperatorIdentity.id
        }
      });
    } else {
      await tx.authIdentity.create({
        data: {
          emailVerifiedAt: new Date(),
          normalizedEmail: LOCAL_OPERATOR_EMAIL,
          passwordHash,
          provider: "password",
          providerAccountId: LOCAL_OPERATOR_EMAIL,
          userId: ids.user
        }
      });
    }
  });

  for (const user of LOCAL_ORDINARY_USERS) {
    await seedLocalOrdinaryUser(user);
  }

  await prisma.group.upsert({
    create: {
      id: ids.group,
      name: "private-operators"
    },
    update: {},
    where: {
      id: ids.group
    }
  });

  await prisma.userGroup.upsert({
    create: {
      groupId: ids.group,
      role: "owner",
      userId: ids.user
    },
    update: {
      role: "owner"
    },
    where: {
      userId_groupId: {
        groupId: ids.group,
        userId: ids.user
      }
    }
  });

  await prisma.group.upsert({
    create: LOCAL_MCP_FIXTURE_GROUP,
    update: {
      archivedAt: null,
      name: LOCAL_MCP_FIXTURE_GROUP.name
    },
    where: { id: LOCAL_MCP_FIXTURE_GROUP.id }
  });

  for (const user of LOCAL_ORDINARY_USERS) {
    await prisma.userGroup.upsert({
      create: {
        groupId: LOCAL_MCP_FIXTURE_GROUP.id,
        role: "member",
        userId: user.id
      },
      update: { role: "member" },
      where: {
        userId_groupId: {
          groupId: LOCAL_MCP_FIXTURE_GROUP.id,
          userId: user.id
        }
      }
    });

    const existingFixtureSettings = await prisma.userSettings.findUnique({
      select: { defaultPromptPresetId: true },
      where: { userId: user.id }
    });
    const seedPromptIsFixtureDefault = !existingFixtureSettings ||
      existingFixtureSettings.defaultPromptPresetId === user.promptPresetId;

    if (seedPromptIsFixtureDefault) {
      await prisma.promptPreset.updateMany({
        data: { isDefault: false },
        where: {
          id: { not: user.promptPresetId },
          isDefault: true,
          userId: user.id
        }
      });
    }

    await prisma.promptPreset.upsert({
      create: {
        developerPrompt: null,
        id: user.promptPresetId,
        isDefault: seedPromptIsFixtureDefault,
        name: "Helpful Assistant",
        systemPrompt: "You are a helpful AI assistant. Today is {local_date}, local time is {local_time}.",
        userId: user.id
      },
      update: {
        developerPrompt: null,
        isDefault: seedPromptIsFixtureDefault,
        name: "Helpful Assistant",
        systemPrompt: "You are a helpful AI assistant. Today is {local_date}, local time is {local_time}."
      },
      where: { id: user.promptPresetId }
    });

    await prisma.userSettings.upsert({
      create: {
        defaultControlValues: {},
        defaultFolderId: null,
        defaultModelId: "fake-qsa",
        defaultPromptPresetId: user.promptPresetId,
        defaultProvider: "fake",
        defaultSearchStrategyId: "search-disabled",
        showCitations: true,
        showReasoningBlocks: false,
        showToolActivity: true,
        userId: user.id
      },
      update: {},
      where: { userId: user.id }
    });
  }

  await prisma.folder.upsert({
    create: {
      id: ids.folderResearch,
      name: "Research",
      sortOrder: 20,
      userId: ids.user
    },
    update: {
      sortOrder: 20
    },
    where: {
      id: ids.folderResearch
    }
  });

  const existingSettings = await prisma.userSettings.findUnique({
    select: {
      defaultPromptPresetId: true
    },
    where: {
      userId: ids.user
    }
  });
  const seedPromptIsUserDefault = !existingSettings || existingSettings.defaultPromptPresetId === ids.promptPreset;

  if (seedPromptIsUserDefault) {
    await prisma.promptPreset.updateMany({
      data: {
        isDefault: false
      },
      where: {
        id: {
          not: ids.promptPreset
        },
        isDefault: true,
        userId: ids.user
      }
    });
  }

  await prisma.promptPreset.upsert({
    create: {
      developerPrompt: null,
      id: ids.promptPreset,
      isDefault: seedPromptIsUserDefault,
      name: "Helpful Assistant",
      systemPrompt: "You are a helpful AI assistant. Today is {local_date}, local time is {local_time}.",
      userId: ids.user
    },
    update: {
      developerPrompt: null,
      ...(seedPromptIsUserDefault ? { isDefault: true } : {}),
      name: "Helpful Assistant",
      systemPrompt: "You are a helpful AI assistant. Today is {local_date}, local time is {local_time}."
    },
    where: {
      id: ids.promptPreset
    }
  });

  for (const model of defaultProviderModels) {
    await prisma.providerModel.upsert({
      create: {
        capabilities: asJson(model.capabilities),
        contextWindow: model.contextWindow,
        defaultParams: asJson(model.defaultParams),
        displayName: model.displayName,
        inputTokenPriceMicros: model.inputTokenPriceMicros,
        modelId: model.modelId,
        outputTokenPriceMicros: model.outputTokenPriceMicros,
        provider: model.provider,
        supportsNativeSearch: model.capabilities.nativeSearch,
        supportsPdf: model.capabilities.pdf,
        supportsReasoning: model.capabilities.reasoning,
        supportsVision: model.capabilities.vision
      },
      update: {
        capabilities: asJson(model.capabilities),
        contextWindow: model.contextWindow,
        defaultParams: asJson(model.defaultParams),
        displayName: model.displayName,
        inputTokenPriceMicros: model.inputTokenPriceMicros,
        outputTokenPriceMicros: model.outputTokenPriceMicros,
        supportsNativeSearch: model.capabilities.nativeSearch,
        supportsPdf: model.capabilities.pdf,
        supportsReasoning: model.capabilities.reasoning,
        supportsVision: model.capabilities.vision
      },
      where: {
        provider_modelId: {
          modelId: model.modelId,
          provider: model.provider
        }
      }
    });
  }

  await prisma.providerModel.updateMany({
    data: {
      enabled: false
    },
    where: {
      OR: [
        {
          provider: "anthropic",
          modelId: "claude-opus-4-7"
        },
        {
          provider: "openrouter",
          modelId: "anthropic/claude-opus-4.7"
        },
        {
          provider: "openrouter",
          modelId: "google/gemini-3-pro-preview"
        }
      ]
    }
  });

  for (const strategy of defaultSearchStrategies) {
    await prisma.searchStrategy.upsert({
      create: {
        config: asJson(strategy.config),
        description: strategy.description,
        displayName: strategy.displayName,
        kind: strategy.kind,
        modelId: strategy.modelId,
        provider: strategy.provider,
        strategyId: strategy.strategyId
      },
      update: {
        config: asJson(strategy.config),
        description: strategy.description,
        displayName: strategy.displayName,
        kind: strategy.kind,
        modelId: strategy.modelId,
        provider: strategy.provider
      },
      where: {
        strategyId: strategy.strategyId
      }
    });
  }

  await prisma.userSettings.upsert({
    create: {
      defaultControlValues: {},
      defaultFolderId: null,
      defaultModelId: "gpt-5.5",
      defaultPromptPresetId: ids.promptPreset,
      defaultProvider: "openai",
      defaultSearchStrategyId: "openai-native-web-search",
      showCitations: true,
      showReasoningBlocks: false,
      showToolActivity: true,
      userId: ids.user
    },
    update: {},
    where: {
      userId: ids.user
    }
  });

  const grants = [
    { id: "00000000-0000-4000-8000-000000000401", groupId: ids.group, provider: "fake", modelId: "fake-qsa" },
    { id: "00000000-0000-4000-8000-000000000402", groupId: ids.group, provider: "openai", modelId: "gpt-5.5" },
    {
      id: "00000000-0000-4000-8000-000000000412",
      groupId: ids.group,
      provider: "openai",
      modelId: "gpt-5.6-sol"
    },
    {
      id: "00000000-0000-4000-8000-000000000413",
      groupId: ids.group,
      provider: "openai",
      modelId: "gpt-5.6-terra"
    },
    {
      id: "00000000-0000-4000-8000-000000000414",
      groupId: ids.group,
      provider: "openai",
      modelId: "gpt-5.6-luna"
    },
    {
      id: "00000000-0000-4000-8000-000000000403",
      groupId: ids.group,
      provider: "anthropic",
      modelId: "claude-opus-4-8"
    },
    {
      id: "00000000-0000-4000-8000-000000000404",
      groupId: ids.group,
      provider: "openrouter",
      modelId: "perplexity/sonar-pro-search"
    },
    {
      id: "00000000-0000-4000-8000-000000000407",
      groupId: ids.group,
      provider: "openrouter",
      modelId: "anthropic/claude-opus-4.8"
    },
    {
      id: "00000000-0000-4000-8000-000000000408",
      groupId: ids.group,
      provider: "openrouter",
      modelId: "google/gemini-3.5-flash"
    },
    {
      id: "00000000-0000-4000-8000-000000000409",
      groupId: ids.group,
      provider: "openrouter",
      modelId: "~google/gemini-pro-latest"
    },
    {
      id: "00000000-0000-4000-8000-000000000405",
      groupId: ids.group,
      searchStrategy: "openai-native-web-search"
    },
    {
      id: "00000000-0000-4000-8000-000000000411",
      groupId: ids.group,
      searchStrategy: "perplexity-tool-search"
    }
  ];

  for (const grant of grants) {
    await prisma.accessGrant.upsert({
      create: {
        enabled: true,
        groupId: grant.groupId,
        id: grant.id,
        modelId: grant.modelId ?? null,
        provider: grant.provider ?? null,
        searchStrategy: grant.searchStrategy ?? null,
        userId: null
      },
      update: {
        enabled: true,
        groupId: grant.groupId,
        modelId: grant.modelId ?? null,
        provider: grant.provider ?? null,
        searchStrategy: grant.searchStrategy ?? null,
        userId: null
      },
      where: {
        id: grant.id
      }
    });
  }

  await prisma.accessGrant.upsert({
    create: {
      enabled: true,
      groupId: LOCAL_MCP_FIXTURE_GROUP.id,
      id: "00000000-0000-4000-8000-000000000421",
      modelId: "fake-qsa",
      provider: "fake"
    },
    update: {
      enabled: true,
      groupId: LOCAL_MCP_FIXTURE_GROUP.id,
      modelId: "fake-qsa",
      provider: "fake"
    },
    where: { id: "00000000-0000-4000-8000-000000000421" }
  });

  await seedLocalMcpFixture({
    ...LOCAL_SHARED_MCP_FIXTURE,
    draft: LOCAL_SHARED_MCP_DRAFT
  });
  await seedLocalMcpFixture({
    ...LOCAL_PRIVATE_MCP_FIXTURE,
    draft: LOCAL_PRIVATE_MCP_DRAFT
  });

  const mcpGrants = [
    {
      canUse: true,
      groupId: LOCAL_MCP_FIXTURE_GROUP.id,
      id: "00000000-0000-4000-8000-000000000601",
      personalSlotKeys: [] as string[],
      serverId: LOCAL_SHARED_MCP_FIXTURE.id,
      userId: null
    },
    {
      canUse: false,
      groupId: null,
      id: "00000000-0000-4000-8000-000000000602",
      personalSlotKeys: ["workspace"],
      serverId: LOCAL_SHARED_MCP_FIXTURE.id,
      userId: LOCAL_MCP_MEMBER.id
    },
    {
      canUse: true,
      groupId: null,
      id: "00000000-0000-4000-8000-000000000603",
      personalSlotKeys: [] as string[],
      serverId: LOCAL_PRIVATE_MCP_FIXTURE.id,
      userId: LOCAL_MCP_MEMBER.id
    }
  ];

  for (const grant of mcpGrants) {
    await prisma.mcpGrant.upsert({
      create: grant,
      update: {
        canUse: grant.canUse,
        groupId: grant.groupId,
        personalSlotKeys: grant.personalSlotKeys,
        serverId: grant.serverId,
        userId: grant.userId
      },
      where: { id: grant.id }
    });
  }

  await prisma.chat.upsert({
    create: {
      defaultModelId: "gpt-5.5",
      defaultPromptPresetId: ids.promptPreset,
      defaultProvider: "openai",
      folderId: null,
      id: ids.chat,
      title: "OpenAI web search shape",
      userId: ids.user
    },
    update: {
      defaultModelId: "gpt-5.5",
      defaultPromptPresetId: ids.promptPreset,
      defaultProvider: "openai",
      title: "OpenAI web search shape"
    },
    where: {
      id: ids.chat
    }
  });

  await prisma.message.upsert({
    create: {
      chatId: ids.chat,
      content: asJson(
        textMessageContent(
          "Compare native web search with the OpenRouter Perplexity route for a short technical answer."
        )
      ),
      id: ids.userMessage,
      modelId: "gpt-5.5",
      provider: "openai",
      role: "user",
      status: "complete"
    },
    update: {},
    where: {
      id: ids.userMessage
    }
  });

  await prisma.message.upsert({
    create: {
      chatId: ids.chat,
      content: asJson(
        textMessageContent(
          "Native search keeps the OpenAI response and citations in one provider run. OpenRouter Perplexity keeps search explicit as a separate strategy for cross-provider QSA."
        )
      ),
      id: ids.assistantMessage,
      inputTokens: 18,
      modelId: "gpt-5.5",
      outputTokens: 28,
      parentMessageId: ids.userMessage,
      provider: "openai",
      role: "assistant",
      status: "complete"
    },
    update: {
      parentMessageId: ids.userMessage
    },
    where: {
      id: ids.assistantMessage
    }
  });

  await prisma.chat.update({
    data: {
      activeLeafMessageId: ids.assistantMessage,
      totalInputTokens: 18,
      totalOutputTokens: 28,
      totalReasoningTokens: 0
    },
    where: {
      id: ids.chat
    }
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { defaultProviderModels, defaultSearchStrategies } from "../lib/domain/catalog";
import {
  providerConnectionTemplates,
  providerModelTemplateId,
  providerTemplateIds
} from "../lib/domain/providerTemplates";
import { hashCanonicalMcpValue } from "../lib/server/mcp/definitions";
import { ensureFullAccessGroup } from "../lib/server/auth/fullAccessGroup";
import {
  builtInSearchDraft,
  normalizeSearchDraft,
  searchDraftHash
} from "../lib/server/search/configuration";
import { searchValidationFingerprint } from "../lib/server/search/probeBinding";
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
  group: "00000000-0000-4000-8000-000000000010",
  user: "00000000-0000-4000-8000-000000000001"
};

const builtInSearchOptions = Object.freeze({
  "anthropic-web-search": Object.freeze({
    description: "Web search provided by Anthropic.",
    displayName: "Anthropic Search",
    id: "00000000-0000-4000-8000-000000001405",
    kind: "web_search",
    sourceConnectionId: providerTemplateIds.anthropicConnection,
    templateKey: "search:anthropic"
  }),
  "gemini-google-search": Object.freeze({
    description: "Google Search grounding for eligible Gemini models.",
    displayName: "Google Search",
    id: "00000000-0000-4000-8000-000000001403",
    kind: "gemini_google_search",
    sourceConnectionId: providerTemplateIds.geminiConnection,
    templateKey: "search:gemini-google"
  }),
  "openai-native-web-search": Object.freeze({
    description: "Web search provided by OpenAI.",
    displayName: "OpenAI Search",
    id: "00000000-0000-4000-8000-000000001402",
    kind: "web_search",
    sourceConnectionId: providerTemplateIds.openAiConnection,
    templateKey: "search:openai"
  }),
  "perplexity-tool-search": Object.freeze({
    description: "Web search provided by Perplexity through OpenRouter.",
    displayName: "Perplexity Search",
    id: "00000000-0000-4000-8000-000000001404",
    kind: "perplexity_search",
    sourceConnectionId: providerTemplateIds.openRouterConnection,
    templateKey: "search:perplexity"
  }),
  "search-disabled": Object.freeze({
    description: "Answer without web search.",
    displayName: "Off",
    id: "00000000-0000-4000-8000-000000001401",
    kind: "none",
    sourceConnectionId: null,
    templateKey: "search:none"
  })
});

function builtInSearchOption(strategyId: string) {
  return builtInSearchOptions[strategyId as keyof typeof builtInSearchOptions];
}

const asJson = (value: unknown) => value as Prisma.InputJsonValue;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerModelDraftConfig(model: (typeof defaultProviderModels)[number]) {
  const adapterKind = {
    anthropic: "anthropic_messages",
    fake: "fake",
    gemini: "gemini_interactions_native",
    openai: "openai_responses_native",
    openrouter: "openrouter_chat_completions"
  }[model.provider];
  const routeProvider = isRecord(model.defaultParams.provider)
    ? model.defaultParams.provider
    : {};
  const selectedProviders = Array.isArray(routeProvider.only)
    ? [...new Set(routeProvider.only.filter((value): value is string =>
        typeof value === "string" && Boolean(value.trim())
      ).map((value) => value.trim()))]
    : [];

  return {
    adapterKind,
    capabilities: {
      ...model.capabilities,
      contextWindow: model.contextWindow
    },
    defaultParams: model.defaultParams,
    ...(model.provider === "openrouter"
      ? {
          openRouterRouting: selectedProviders.length > 0
            ? { mode: "only_selected", providers: selectedProviders }
            : { mode: "automatic", providers: [] }
        }
      : {}),
    upstreamModelId: model.modelId
  };
}

async function synchronizeLocalProviderTemplates(): Promise<Map<string, string>> {
  const connectionIds = new Map<string, string>();
  for (const template of providerConnectionTemplates) {
    const active = template.family === "fake";
    const row = await prisma.providerConnection.upsert({
      create: {
        activeConfig: active ? asJson(template.config) : undefined,
        activeVersion: active ? 1 : 0,
        activatedAt: active ? new Date() : undefined,
        defaultCredentialId: null,
        displayName: template.displayName,
        draftConfig: asJson(template.config),
        draftVersion: 1,
        enabled: active,
        family: template.family,
        id: template.id,
        templateKey: template.templateKey,
        unassignedPolicy: "use_default"
      },
      update: {
        activeConfig: active ? asJson(template.config) : Prisma.DbNull,
        activeVersion: active ? 1 : 0,
        activatedAt: active ? new Date() : null,
        defaultCredentialId: null,
        displayName: template.displayName,
        draftConfig: asJson(template.config),
        draftVersion: 1,
        enabled: active,
        family: template.family,
        unassignedPolicy: "use_default"
      },
      where: { templateKey: template.templateKey }
    });
    connectionIds.set(template.family, row.id);
  }

  const modelIds = new Map<string, string>();

  for (const model of defaultProviderModels) {
    const templateKey = `${model.provider}:${model.modelId}`;
    const id = providerModelTemplateId(templateKey);
    const connectionId = connectionIds.get(model.provider);
    if (!id || !connectionId) {
      throw new Error(`Missing local provider template identity: ${templateKey}`);
    }
    const active = model.provider === "fake";
    const draftConfig = providerModelDraftConfig(model);
    const row = await prisma.providerModel.upsert({
      create: {
        activeConfig: active ? asJson(draftConfig) : undefined,
        activeVersion: active ? 1 : 0,
        activatedAt: active ? new Date() : undefined,
        capabilities: asJson(model.capabilities),
        connectionId,
        contextWindow: model.contextWindow,
        defaultParams: asJson(model.defaultParams),
        displayName: model.displayName,
        draftConfig: asJson(draftConfig),
        draftVersion: 1,
        enabled: active,
        id,
        inputTokenPriceMicros: model.inputTokenPriceMicros,
        modelId: model.modelId,
        outputTokenPriceMicros: model.outputTokenPriceMicros,
        provider: model.provider,
        supportsNativeSearch: model.capabilities.nativeSearch,
        supportsPdf: model.capabilities.pdf,
        supportsReasoning: model.capabilities.reasoning,
        supportsVision: model.capabilities.vision,
        templateKey
      },
      update: {
        activeConfig: active ? asJson(draftConfig) : Prisma.DbNull,
        activeVersion: active ? 1 : 0,
        activatedAt: active ? new Date() : null,
        capabilities: asJson(model.capabilities),
        connectionId,
        contextWindow: model.contextWindow,
        defaultParams: asJson(model.defaultParams),
        displayName: model.displayName,
        draftConfig: asJson(draftConfig),
        draftVersion: 1,
        enabled: active,
        inputTokenPriceMicros: model.inputTokenPriceMicros,
        modelId: model.modelId,
        outputTokenPriceMicros: model.outputTokenPriceMicros,
        provider: model.provider,
        supportsNativeSearch: model.capabilities.nativeSearch,
        supportsPdf: model.capabilities.pdf,
        supportsReasoning: model.capabilities.reasoning,
        supportsVision: model.capabilities.vision
      },
      where: { templateKey }
    });
    modelIds.set(templateKey, row.id);
  }

  return modelIds;
}

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

  const providerModelIds = await synchronizeLocalProviderTemplates();
  const fakeProviderModelId = providerModelIds.get("fake:fake-qsa");
  if (!fakeProviderModelId) {
    throw new Error("Fake provider model template was not seeded");
  }

  await prisma.modelPolicy.upsert({
    create: {
      defaultProviderModelId: null,
      id: "installation"
    },
    // Local reseeding must not overwrite an administrator's current policy.
    update: {},
    where: { id: "installation" }
  });

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

  await ensureFullAccessGroup(prisma, ids.user);

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

    await prisma.userSettings.upsert({
      create: {
        defaultControlValues: {},
        defaultFolderId: null,
        defaultProviderModelId: fakeProviderModelId,
        defaultSearchPlan: asJson({ mode: "all_selected", optionIds: [] }),
        defaultSearchStrategyId: "search-disabled",
        showCitations: true,
        showReasoningBlocks: false,
        showToolActivity: true,
        userId: user.id
      },
      update: {
        defaultProviderModelId: fakeProviderModelId,
        defaultSearchPlan: asJson({ mode: "all_selected", optionIds: [] }),
        defaultSearchStrategyId: "search-disabled"
      },
      where: { userId: user.id }
    });
  }

  for (const [optionId, option] of Object.entries(builtInSearchOptions)) {
    await prisma.searchOption.upsert({
      create: {
        description: option.description,
        displayName: option.displayName,
        enabled: true,
        id: option.id,
        kind: option.kind,
        optionId,
        sourceConnectionId: option.sourceConnectionId,
        templateKey: option.templateKey
      },
      update: {
        description: option.description,
        displayName: option.displayName,
        kind: option.kind,
        sourceConnectionId: option.sourceConnectionId,
        templateKey: option.templateKey
      },
      where: { id: option.id }
    });
  }

  for (const logicalOption of defaultSearchStrategies) {
    const searchOption = builtInSearchOption(logicalOption.strategyId);
    if (!searchOption) {
      throw new Error(`Missing seeded logical Search option: ${logicalOption.strategyId}`);
    }
    const physicalRoutes = logicalOption.kind === "none"
      ? [{
          config: {},
          credentialMode: "answer_provider",
          kind: "none",
          physicalStrategyId: logicalOption.strategyId,
          providerModelId: null
        }]
      : logicalOption.routes;
    for (const route of physicalRoutes) {
      const providerModelId = route.credentialMode === "provider_model"
        ? providerModelIds.get(`openrouter:${route.providerModelId ?? ""}`) ?? null
        : null;
      if (route.credentialMode === "provider_model" && !providerModelId) {
        throw new Error(`Missing seeded search deployment: ${route.physicalStrategyId}`);
      }
      const draft = builtInSearchDraft({
        config: route.config,
        kind: route.kind,
        providerModelId
      });
      const draftHash = route.kind === "none"
        ? `seed:${route.physicalStrategyId}`
        : searchDraftHash(normalizeSearchDraft(draft));
      const stored = await prisma.searchStrategy.upsert({
        create: {
          adapterKind: String(draft.adapterKind),
          config: asJson(route.config),
          credentialMode: String(draft.credentialMode),
          description: logicalOption.description,
          displayName: logicalOption.displayName,
          draft: asJson(draft),
          draftTestEvidence: asJson({
            checkedAt: new Date().toISOString(),
            method: "configuration",
            normalizedSourceCount: 0,
            protocol: draft.protocol,
            status: "available"
          }),
          id: randomUUID(),
          kind: route.kind,
          modelId: route.providerModelId ?? null,
          provider: logicalOption.sourceConnectionId ?? "fake",
          providerModelId,
          searchOptionId: searchOption.id,
          strategyId: route.physicalStrategyId,
          testedDraftHash: draftHash
        },
        update: {
          config: asJson(route.config),
          description: logicalOption.description,
          displayName: logicalOption.displayName,
          kind: route.kind,
          modelId: route.providerModelId ?? null,
          provider: logicalOption.sourceConnectionId ?? "fake",
          providerModelId,
          searchOptionId: searchOption.id
        },
        where: {
          strategyId: route.physicalStrategyId
        }
      });
      if (!stored.activeRevisionId) {
        const revision = await prisma.searchIntegrationRevision.create({
          data: {
            adapterKind: String(draft.adapterKind),
            configuration: asJson(draft),
            credentialMode: String(draft.credentialMode),
            draftHash,
            id: randomUUID(),
            providerModelId,
            revisionNumber: 1,
            searchStrategyId: stored.id,
            validationEvidence: asJson({ method: "seed", status: "available" }),
            validationFingerprint: searchValidationFingerprint({
              method: "seed",
              status: "available"
            })
          }
        });
        await prisma.searchStrategy.update({
          data: { activeRevisionId: revision.id, activatedAt: new Date() },
          where: { id: stored.id }
        });
      }
    }
  }

  await prisma.userSettings.upsert({
    create: {
      defaultControlValues: {},
      defaultFolderId: null,
      defaultProviderModelId: fakeProviderModelId,
      defaultSearchPlan: asJson({ mode: "all_selected", optionIds: [] }),
      defaultSearchStrategyId: "search-disabled",
      showCitations: true,
      showReasoningBlocks: false,
      showToolActivity: true,
      userId: ids.user
    },
    update: {
      defaultProviderModelId: fakeProviderModelId,
      defaultSearchPlan: asJson({ mode: "all_selected", optionIds: [] }),
      defaultSearchStrategyId: "search-disabled"
    },
    where: {
      userId: ids.user
    }
  });

  const grants: {
    groupId: string;
    id: string;
    modelTemplateKey?: string;
    searchStrategy?: string;
  }[] = [
    {
      groupId: ids.group,
      id: "00000000-0000-4000-8000-000000000401",
      modelTemplateKey: "fake:fake-qsa"
    },
    {
      groupId: ids.group,
      id: "00000000-0000-4000-8000-000000000402",
      modelTemplateKey: "openai:gpt-5.5"
    },
    {
      id: "00000000-0000-4000-8000-000000000412",
      groupId: ids.group,
      modelTemplateKey: "openai:gpt-5.6-sol"
    },
    {
      id: "00000000-0000-4000-8000-000000000413",
      groupId: ids.group,
      modelTemplateKey: "openai:gpt-5.6-terra"
    },
    {
      id: "00000000-0000-4000-8000-000000000414",
      groupId: ids.group,
      modelTemplateKey: "openai:gpt-5.6-luna"
    },
    {
      id: "00000000-0000-4000-8000-000000000403",
      groupId: ids.group,
      modelTemplateKey: "anthropic:claude-opus-4-8"
    },
    {
      id: "00000000-0000-4000-8000-000000000404",
      groupId: ids.group,
      modelTemplateKey: "openrouter:perplexity/sonar-pro-search"
    },
    {
      id: "00000000-0000-4000-8000-000000000407",
      groupId: ids.group,
      modelTemplateKey: "openrouter:anthropic/claude-opus-4.8"
    },
    {
      id: "00000000-0000-4000-8000-000000000408",
      groupId: ids.group,
      modelTemplateKey: "openrouter:google/gemini-3.5-flash"
    },
    {
      id: "00000000-0000-4000-8000-000000000409",
      groupId: ids.group,
      modelTemplateKey: "openrouter:~google/gemini-pro-latest"
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
    const providerModelId = grant.modelTemplateKey
      ? providerModelIds.get(grant.modelTemplateKey) ?? null
      : null;
    if (grant.modelTemplateKey && !providerModelId) {
      throw new Error(`Missing seeded grant deployment: ${grant.modelTemplateKey}`);
    }
    await prisma.accessGrant.upsert({
      create: {
        enabled: true,
        groupId: grant.groupId,
        id: grant.id,
        providerConnectionId: null,
        providerModelId,
        searchStrategy: grant.searchStrategy ?? null,
        userId: null
      },
      update: {
        enabled: true,
        groupId: grant.groupId,
        providerConnectionId: null,
        providerModelId,
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
      providerConnectionId: null,
      providerModelId: fakeProviderModelId,
      searchStrategy: null,
      userId: null
    },
    update: {
      enabled: true,
      groupId: LOCAL_MCP_FIXTURE_GROUP.id,
      providerConnectionId: null,
      providerModelId: fakeProviderModelId,
      searchStrategy: null,
      userId: null
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

}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

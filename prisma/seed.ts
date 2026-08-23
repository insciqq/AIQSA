import { Prisma, PrismaClient } from "@prisma/client";
import { hashCanonicalMcpValue } from "../lib/server/mcp/definitions";
import { ensureFullAccessGroup } from "../lib/server/auth/fullAccessGroup";
import { synchronizeCodeOwnedCatalog } from "../lib/server/bootstrap/codeOwnedCatalog";
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
import { runOptionalLocalDevProfile } from "./local-dev-profile";

const prisma = new PrismaClient();

const ids = {
  group: "00000000-0000-4000-8000-000000000010",
  user: "00000000-0000-4000-8000-000000000001"
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

  await prisma.userMemorySettings.createMany({
    data: [ids.user, ...LOCAL_ORDINARY_USERS.map((user) => user.id)].map((userId) => ({ userId })),
    skipDuplicates: true
  });

  const { providerModelIds } = await synchronizeCodeOwnedCatalog(prisma, {
    mode: "local_seed"
  });
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
  await prisma.knowledgeAnswerPolicy.upsert({
    create: { id: "installation" },
    // Local reseeding must not overwrite administrator-owned answer policy.
    update: {},
    where: { id: "installation" }
  });
  await prisma.memoryEgressAdminPolicy.upsert({
    create: { id: "installation" },
    // Local reseeding must not overwrite administrator-owned acceptance.
    update: {},
    where: { id: "installation" }
  });
  await prisma.systemModelPolicy.upsert({
    create: {
      id: "installation",
      providerModelId: null
    },
    // Local reseeding must not overwrite an administrator's current role.
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
        showCitations: true,
        showReasoningBlocks: false,
        userId: user.id
      },
      update: {
        defaultProviderModelId: fakeProviderModelId,
        defaultSearchPlan: asJson({ mode: "all_selected", optionIds: [] })
      },
      where: { userId: user.id }
    });
  }


  await prisma.userSettings.upsert({
    create: {
      defaultControlValues: {},
      defaultFolderId: null,
      defaultProviderModelId: fakeProviderModelId,
      defaultSearchPlan: asJson({ mode: "all_selected", optionIds: [] }),
      showCitations: true,
      showReasoningBlocks: false,
      userId: ids.user
    },
    update: {
      defaultProviderModelId: fakeProviderModelId,
      defaultSearchPlan: asJson({ mode: "all_selected", optionIds: [] })
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
  .then(async () => {
    const profile = await runOptionalLocalDevProfile(prisma);
    if (profile === "executed") {
      console.info("Applied the optional local development profile.");
    }
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

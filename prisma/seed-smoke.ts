import { PrismaClient } from "@prisma/client";
import { defaultProviderModels, defaultSearchStrategies } from "../lib/domain/catalog";
import { providerConnectionTemplates } from "../lib/domain/providerTemplates";
import { verifyPassword } from "../lib/server/auth/password";
import { LOCAL_OPERATOR_EMAIL, LOCAL_OPERATOR_PASSWORD } from "./local-seed-auth";
import {
  LOCAL_MCP_FIXTURE_GROUP,
  LOCAL_MCP_MEMBER,
  LOCAL_ORDINARY_USERS,
  LOCAL_PRIVATE_MCP_FIXTURE,
  LOCAL_RESTRICTED_MEMBER,
  LOCAL_SHARED_MCP_FIXTURE
} from "./local-seed-fixtures";

const prisma = new PrismaClient();
const expectEmptyWorkspace = process.argv.includes("--expect-empty-workspace");

async function main() {
  const user = await prisma.user.findUnique({
    include: {
      authIdentities: true,
      chats: { select: { id: true } },
      folders: { select: { id: true } },
      groups: { include: { group: true } },
      settings: true
    },
    where: {
      id: "00000000-0000-4000-8000-000000000001"
    }
  });

  if (!user?.settings) {
    throw new Error("Seeded user/settings were not found");
  }

  const passwordIdentity = user.authIdentities.find(
    (identity) =>
      identity.provider === "password" &&
      identity.normalizedEmail === LOCAL_OPERATOR_EMAIL &&
      identity.providerAccountId === LOCAL_OPERATOR_EMAIL &&
      Boolean(identity.emailVerifiedAt)
  );
  const hasLocalOperatorPassword = await verifyPassword(LOCAL_OPERATOR_PASSWORD, passwordIdentity?.passwordHash);

  if (
    user.email !== LOCAL_OPERATOR_EMAIL ||
    user.role !== "admin" ||
    user.status !== "active" ||
    !passwordIdentity ||
    !hasLocalOperatorPassword
  ) {
    throw new Error("Seeded local operator credential was not found");
  }
  const fullAccessMembership = user.groups.find(
    (membership) => membership.group.systemRole === "full_access"
  );
  if (
    !fullAccessMembership ||
    fullAccessMembership.group.name !== "Full access" ||
    fullAccessMembership.group.archivedAt ||
    fullAccessMembership.role !== "owner"
  ) {
    throw new Error("Seeded local operator is not an owner of the active Full access group");
  }

  const expectedModelTemplateKeys = defaultProviderModels.map(
    (model) => `${model.provider}:${model.modelId}`
  );
  const [
    knowledgePolicy,
    modelPolicy,
    systemModelPolicy,
    providerConnections,
    providerModels,
    searchOptions,
    searchStrategies
  ] = await Promise.all([
    prisma.knowledgePolicy.findUnique({ where: { id: "installation" } }),
    prisma.modelPolicy.findUnique({ where: { id: "installation" } }),
    prisma.systemModelPolicy.findUnique({ where: { id: "installation" } }),
    prisma.providerConnection.findMany({
      where: {
        templateKey: { in: providerConnectionTemplates.map((template) => template.templateKey) }
      }
    }),
    prisma.providerModel.findMany({
      where: { templateKey: { in: expectedModelTemplateKeys } }
    }),
    prisma.searchOption.findMany({
      where: {
        templateKey: {
          in: [
            "search:anthropic",
            "search:gemini-google",
            "search:none",
            "search:openai",
            "search:perplexity"
          ]
        }
      }
    }),
    prisma.searchStrategy.findMany({
      where: {
        strategyId: { in: defaultSearchStrategies.map((strategy) => strategy.strategyId) }
      }
    })
  ]);
  const fakeModel = providerModels.find((model) => model.templateKey === "fake:fake-qsa");

  if (
    !knowledgePolicy ||
    knowledgePolicy.version < 1 ||
    knowledgePolicy.candidateLimit < knowledgePolicy.resultLimit ||
    !modelPolicy ||
    modelPolicy.version < 1 ||
    !systemModelPolicy ||
    systemModelPolicy.version < 1 ||
    providerConnections.length !== providerConnectionTemplates.length ||
    providerModels.length !== defaultProviderModels.length ||
    searchOptions.length !== 5 ||
    searchStrategies.length !== defaultSearchStrategies.length ||
    !fakeModel ||
    !fakeModel.enabled ||
    fakeModel.activeVersion !== 1 ||
    !fakeModel.activeConfig ||
    !fakeModel.activatedAt
  ) {
    throw new Error("Seed smoke did not find the complete provider template catalog");
  }
  if (
    user.settings.defaultProviderModelId !== fakeModel.id ||
    user.settings.defaultSearchStrategyId !== "search-disabled"
  ) {
    throw new Error("Seed smoke found inconsistent stable Fake defaults");
  }

  for (const template of providerConnectionTemplates) {
    const connection = providerConnections.find(
      (candidate) => candidate.templateKey === template.templateKey
    );
    const active = template.family === "fake";
    if (
      !connection ||
      connection.enabled !== active ||
      connection.activeVersion !== (active ? 1 : 0) ||
      Boolean(connection.activeConfig) !== active ||
      Boolean(connection.activatedAt) !== active ||
      connection.defaultCredentialId !== null
    ) {
      throw new Error(`Seed smoke found invalid provider connection state: ${template.templateKey}`);
    }
  }

  for (const model of providerModels) {
    const active = model.templateKey === "fake:fake-qsa";
    if (
      model.enabled !== active ||
      model.activeVersion !== (active ? 1 : 0) ||
      Boolean(model.activeConfig) !== active ||
      Boolean(model.activatedAt) !== active
    ) {
      throw new Error(`Seed smoke found invalid provider model state: ${model.templateKey}`);
    }
  }

  const modelIdByTemplate = new Map(
    providerModels.map((model) => [model.templateKey, model.id])
  );
  for (const strategyTemplate of defaultSearchStrategies) {
    const route = strategyTemplate.routes[0];
    const physicalStrategyId = route?.physicalStrategyId ?? strategyTemplate.strategyId;
    const strategy = searchStrategies.find(
      (candidate) => candidate.strategyId === physicalStrategyId
    );
    const expectedProviderModelId = route?.credentialMode === "provider_model"
      ? modelIdByTemplate.get(
          `${strategyTemplate.sourceConnectionId}:${route.providerModelId ?? ""}`
        )
      : null;
    const expectedSearchOption = searchOptions.find((option) =>
      strategyTemplate.strategyId === "search-disabled"
        ? option.templateKey === "search:none"
        : strategyTemplate.strategyId === "anthropic-web-search"
          ? option.templateKey === "search:anthropic"
          : strategyTemplate.strategyId === "openai-native-web-search"
          ? option.templateKey === "search:openai"
          : strategyTemplate.strategyId === "gemini-google-search"
            ? option.templateKey === "search:gemini-google"
            : option.templateKey === "search:perplexity"
    );
    if (
      !strategy ||
      !expectedSearchOption ||
      strategy.providerModelId !== expectedProviderModelId ||
      strategy.searchOptionId !== expectedSearchOption.id
    ) {
      throw new Error(`Seed smoke found invalid search deployment: ${physicalStrategyId}`);
    }
  }

  const ordinaryUsers = await prisma.user.findMany({
    include: {
      _count: {
        select: {
          chats: true,
          folders: true
        }
      },
      authIdentities: true,
      groups: true,
      mcpGrants: true,
      settings: true
    },
    orderBy: { id: "asc" },
    where: { id: { in: LOCAL_ORDINARY_USERS.map((fixture) => fixture.id) } }
  });
  if (ordinaryUsers.length !== 2) {
    throw new Error("Seed smoke did not find exactly two ordinary-user fixtures");
  }

  if (
    expectEmptyWorkspace &&
    (
      user.chats.length !== 0 ||
      user.folders.length !== 0 ||
      user.settings.defaultFolderId !== null ||
      ordinaryUsers.some(
        (ordinary) =>
          ordinary._count.chats !== 0 ||
          ordinary._count.folders !== 0 ||
          ordinary.settings?.defaultFolderId !== null
      )
    )
  ) {
    throw new Error("Fresh seed unexpectedly created workspace folders or chats");
  }
  for (const fixture of LOCAL_ORDINARY_USERS) {
    const ordinary = ordinaryUsers.find((candidate) => candidate.id === fixture.id);
    const identity = ordinary?.authIdentities.find((candidate) =>
      candidate.provider === "password" && candidate.normalizedEmail === fixture.email &&
      candidate.providerAccountId === fixture.email && Boolean(candidate.emailVerifiedAt)
    );
    if (!ordinary || ordinary.email !== fixture.email || ordinary.role !== "user" ||
      ordinary.status !== "active" || !ordinary.settings ||
      ordinary.settings.defaultProviderModelId !== fakeModel.id ||
      ordinary.settings.defaultSearchStrategyId !== "search-disabled" ||
      !ordinary.groups.some((membership) => membership.groupId === LOCAL_MCP_FIXTURE_GROUP.id) ||
      !identity || !await verifyPassword(fixture.password, identity.passwordHash)) {
      throw new Error(`Seed smoke found an invalid ordinary-user fixture: ${fixture.email}`);
    }
  }

  const [sharedServer, privateServer, groupGrant, modelGrant, fullAccessMcpGrants] = await Promise.all([
    prisma.mcpServer.findUnique({
      include: { grants: true },
      where: { id: LOCAL_SHARED_MCP_FIXTURE.id }
    }),
    prisma.mcpServer.findUnique({
      include: { grants: true },
      where: { id: LOCAL_PRIVATE_MCP_FIXTURE.id }
    }),
    prisma.mcpGrant.findUnique({
      where: {
        serverId_groupId: {
          groupId: LOCAL_MCP_FIXTURE_GROUP.id,
          serverId: LOCAL_SHARED_MCP_FIXTURE.id
        }
      }
    }),
    prisma.accessGrant.findFirst({
      where: {
        enabled: true,
        groupId: LOCAL_MCP_FIXTURE_GROUP.id,
        providerConnectionId: null,
        providerModelId: fakeModel.id,
        searchStrategy: null
      }
    }),
    prisma.mcpGrant.findMany({
      where: { groupId: fullAccessMembership.groupId },
      orderBy: { serverId: "asc" }
    })
  ]);
  const member = ordinaryUsers.find((candidate) => candidate.id === LOCAL_MCP_MEMBER.id)!;
  const restricted = ordinaryUsers.find((candidate) => candidate.id === LOCAL_RESTRICTED_MEMBER.id)!;
  const memberSharedGrant = member.mcpGrants.find((grant) => grant.serverId === LOCAL_SHARED_MCP_FIXTURE.id);
  const memberPrivateGrant = member.mcpGrants.find((grant) => grant.serverId === LOCAL_PRIVATE_MCP_FIXTURE.id);

  if (!sharedServer?.enabled || !sharedServer.activeRevisionId || !privateServer?.enabled ||
    !privateServer.activeRevisionId || !groupGrant?.canUse || groupGrant.personalSlotKeys.length !== 0 ||
    fullAccessMcpGrants.length < 2 ||
    fullAccessMcpGrants.some((grant) => !grant.canUse || grant.personalSlotKeys.length !== 0) ||
    memberSharedGrant?.canUse !== false || memberSharedGrant.personalSlotKeys.join(",") !== "workspace" ||
    !memberPrivateGrant?.canUse || restricted.mcpGrants.length !== 0 || !modelGrant) {
    throw new Error("Seed smoke did not find the expected ordinary-user MCP grant matrix");
  }

  console.log(
    `AIQSA seed smoke ok: chats=${user.chats.length}, folders=${user.folders.length}, models=${providerModels.length}, searchStrategies=${searchStrategies.length}, ordinaryUsers=${ordinaryUsers.length}`
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

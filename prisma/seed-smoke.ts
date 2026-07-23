import { PrismaClient } from "@prisma/client";
import { getVisibleMessagePath } from "../lib/domain/branching";
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

async function main() {
  const user = await prisma.user.findUnique({
    include: {
      authIdentities: true,
      chats: {
        include: {
          messages: true
        }
      },
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

  const chat = user.chats.find((candidate) => candidate.id === "00000000-0000-4000-8000-000000000200");

  if (!chat?.activeLeafMessageId) {
    throw new Error("Seeded chat or active leaf was not found");
  }

  const path = getVisibleMessagePath(
    chat.messages.map((message) => ({
      id: message.id,
      parentMessageId: message.parentMessageId,
      role: message.role as "assistant" | "system" | "tool" | "user"
    })),
    chat.activeLeafMessageId
  );

  const providerModelCount = await prisma.providerModel.count();
  const searchStrategyCount = await prisma.searchStrategy.count();

  const ordinaryUsers = await prisma.user.findMany({
    include: {
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
  for (const fixture of LOCAL_ORDINARY_USERS) {
    const ordinary = ordinaryUsers.find((candidate) => candidate.id === fixture.id);
    const identity = ordinary?.authIdentities.find((candidate) =>
      candidate.provider === "password" && candidate.normalizedEmail === fixture.email &&
      candidate.providerAccountId === fixture.email && Boolean(candidate.emailVerifiedAt)
    );
    if (!ordinary || ordinary.email !== fixture.email || ordinary.role !== "user" ||
      ordinary.status !== "active" || !ordinary.settings ||
      ordinary.settings.defaultProvider !== "fake" || ordinary.settings.defaultModelId !== "fake-qsa" ||
      ordinary.settings.defaultSearchStrategyId !== "search-disabled" ||
      !ordinary.groups.some((membership) => membership.groupId === LOCAL_MCP_FIXTURE_GROUP.id) ||
      !identity || !await verifyPassword(fixture.password, identity.passwordHash)) {
      throw new Error(`Seed smoke found an invalid ordinary-user fixture: ${fixture.email}`);
    }
  }

  const [sharedServer, privateServer, groupGrant, modelGrant] = await Promise.all([
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
        modelId: "fake-qsa",
        provider: "fake"
      }
    })
  ]);
  const member = ordinaryUsers.find((candidate) => candidate.id === LOCAL_MCP_MEMBER.id)!;
  const restricted = ordinaryUsers.find((candidate) => candidate.id === LOCAL_RESTRICTED_MEMBER.id)!;
  const memberSharedGrant = member.mcpGrants.find((grant) => grant.serverId === LOCAL_SHARED_MCP_FIXTURE.id);
  const memberPrivateGrant = member.mcpGrants.find((grant) => grant.serverId === LOCAL_PRIVATE_MCP_FIXTURE.id);

  if (!sharedServer?.enabled || !sharedServer.activeRevisionId || !privateServer?.enabled ||
    !privateServer.activeRevisionId || !groupGrant?.canUse || groupGrant.personalSlotKeys.length !== 0 ||
    memberSharedGrant?.canUse !== false || memberSharedGrant.personalSlotKeys.join(",") !== "workspace" ||
    !memberPrivateGrant?.canUse || restricted.mcpGrants.length !== 0 || !modelGrant) {
    throw new Error("Seed smoke did not find the expected ordinary-user MCP grant matrix");
  }

  if (path.length < 2 || providerModelCount < 5 || searchStrategyCount < 3) {
    throw new Error("Seed smoke did not find the expected demo data");
  }

  console.log(
    `AIQSA seed smoke ok: chats=${user.chats.length}, visiblePath=${path.length}, models=${providerModelCount}, searchStrategies=${searchStrategyCount}, ordinaryUsers=${ordinaryUsers.length}`
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

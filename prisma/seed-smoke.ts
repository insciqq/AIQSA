import { PrismaClient } from "@prisma/client";
import { getVisibleMessagePath } from "../lib/domain/branching";
import { verifyPassword } from "../lib/server/auth/password";
import { LOCAL_OPERATOR_EMAIL, LOCAL_OPERATOR_PASSWORD } from "./local-seed-auth";

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

  if (path.length < 2 || providerModelCount < 5 || searchStrategyCount < 3) {
    throw new Error("Seed smoke did not find the expected demo data");
  }

  console.log(
    `AIQSA seed smoke ok: chats=${user.chats.length}, visiblePath=${path.length}, models=${providerModelCount}, searchStrategies=${searchStrategyCount}`
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

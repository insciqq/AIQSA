import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const expectedConstraintNames = [
  "AccessGrant_subject_check",
  "AccessGrant_target_check",
  "Chat_id_activeLeafMessageId_fkey",
  "Message_chatId_parentMessageId_fkey"
] as const;

class ExpectedRollback extends Error {}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function errorDetails(error: unknown): string {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return `${error.code}: ${error.message}\n${JSON.stringify(error.meta ?? {})}`;
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

async function expectDatabaseRejection(
  label: string,
  expected: string,
  operation: (tx: Prisma.TransactionClient) => Promise<void>
): Promise<void> {
  try {
    await prisma.$transaction(operation);
  } catch (error) {
    const details = errorDetails(error);
    if (!details.includes(expected)) {
      throw new Error(`${label} failed for an unexpected reason:\n${details}`, { cause: error });
    }
    return;
  }

  throw new Error(`${label} unexpectedly succeeded; expected ${expected}.`);
}

async function expectRolledBackSuccess(
  label: string,
  operation: (tx: Prisma.TransactionClient) => Promise<void>
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await operation(tx);
      throw new ExpectedRollback(label);
    });
  } catch (error) {
    if (error instanceof ExpectedRollback) {
      return;
    }
    throw error;
  }
}

async function createUserAndChats(tx: Prisma.TransactionClient, chatCount = 2) {
  const suffix = randomUUID();
  const user = await tx.user.create({
    data: {
      displayName: "Schema integrity smoke",
      email: `schema-integrity-${suffix}@example.invalid`,
      id: randomUUID(),
      role: "user",
      status: "active"
    }
  });
  const chats = [];
  for (let index = 0; index < chatCount; index += 1) {
    chats.push(
      await tx.chat.create({
        data: {
          defaultModelId: "fake-qsa",
          defaultProvider: "fake",
          id: randomUUID(),
          title: `Integrity chat ${index + 1}`,
          userId: user.id
        }
      })
    );
  }
  return { chats, user };
}

async function createMessage(
  tx: Prisma.TransactionClient,
  input: {
    chatId: string;
    parentMessageId?: string | null;
    role?: "assistant" | "user";
    status?: "complete" | "streaming";
  }
) {
  return tx.message.create({
    data: {
      chatId: input.chatId,
      content: json({ blocks: [] }),
      id: randomUUID(),
      parentMessageId: input.parentMessageId ?? null,
      role: input.role ?? "user",
      status: input.status ?? "complete"
    }
  });
}

async function createModelRunFixture(tx: Prisma.TransactionClient) {
  const { chats, user } = await createUserAndChats(tx, 1);
  const userMessage = await createMessage(tx, { chatId: chats[0].id });
  const run = await tx.modelRun.create({
    data: {
      chatId: chats[0].id,
      id: randomUUID(),
      modelId: "fake-qsa",
      normalizedRequest: json({}),
      provider: "fake",
      status: "streaming",
      userId: user.id,
      userMessageId: userMessage.id
    }
  });
  return { chat: chats[0], run, user, userMessage };
}

async function assertConstraintCatalog(): Promise<void> {
  const constraints = await prisma.$queryRaw<Array<{ conname: string; convalidated: boolean }>>`
    SELECT conname, convalidated
    FROM pg_constraint
    WHERE conname IN (
      'AccessGrant_subject_check',
      'AccessGrant_target_check',
      'Chat_id_activeLeafMessageId_fkey',
      'Message_chatId_parentMessageId_fkey'
    )
    ORDER BY conname
  `;
  const actual = new Map(constraints.map((constraint) => [constraint.conname, constraint.convalidated]));
  for (const name of expectedConstraintNames) {
    if (actual.get(name) !== true) {
      throw new Error(`Expected validated database constraint ${name}.`);
    }
  }
}

async function assertSameChatRelations(): Promise<void> {
  await expectDatabaseRejection(
    "cross-user message parent",
    "Message_chatId_parentMessageId_fkey",
    async (tx) => {
      const { chats: ownerChats } = await createUserAndChats(tx, 1);
      const { chats: otherUserChats } = await createUserAndChats(tx, 1);
      const parent = await createMessage(tx, { chatId: ownerChats[0].id });
      await createMessage(tx, {
        chatId: otherUserChats[0].id,
        parentMessageId: parent.id
      });
    }
  );

  await expectDatabaseRejection(
    "cross-user active leaf",
    "Chat_id_activeLeafMessageId_fkey",
    async (tx) => {
      const { chats: ownerChats } = await createUserAndChats(tx, 1);
      const { chats: otherUserChats } = await createUserAndChats(tx, 1);
      const leaf = await createMessage(tx, { chatId: ownerChats[0].id });
      await tx.chat.update({
        data: { activeLeafMessageId: leaf.id },
        where: { id: otherUserChats[0].id }
      });
    }
  );

  await expectDatabaseRejection(
    "cross-chat message parent",
    "Message_chatId_parentMessageId_fkey",
    async (tx) => {
      const { chats } = await createUserAndChats(tx);
      const parent = await createMessage(tx, { chatId: chats[0].id });
      await createMessage(tx, { chatId: chats[1].id, parentMessageId: parent.id });
    }
  );

  await expectDatabaseRejection(
    "cross-chat active leaf",
    "Chat_id_activeLeafMessageId_fkey",
    async (tx) => {
      const { chats } = await createUserAndChats(tx);
      const leaf = await createMessage(tx, { chatId: chats[0].id });
      await tx.chat.update({
        data: { activeLeafMessageId: leaf.id },
        where: { id: chats[1].id }
      });
    }
  );

  await expectDatabaseRejection(
    "referenced message parent deletion",
    "Message_chatId_parentMessageId_fkey",
    async (tx) => {
      const { chats } = await createUserAndChats(tx, 1);
      const parent = await createMessage(tx, { chatId: chats[0].id });
      await createMessage(tx, { chatId: chats[0].id, parentMessageId: parent.id });
      await tx.message.delete({ where: { id: parent.id } });
    }
  );

  await expectRolledBackSuccess("same-chat relation behavior", async (tx) => {
    const { chats } = await createUserAndChats(tx, 2);
    const parent = await createMessage(tx, { chatId: chats[0].id });
    const leaf = await createMessage(tx, {
      chatId: chats[0].id,
      parentMessageId: parent.id,
      role: "assistant"
    });
    await tx.chat.update({ data: { activeLeafMessageId: leaf.id }, where: { id: chats[0].id } });
    await tx.message.delete({ where: { id: leaf.id } });
    const cleared = await tx.chat.findUniqueOrThrow({
      select: { activeLeafMessageId: true },
      where: { id: chats[0].id }
    });
    if (cleared.activeLeafMessageId !== null) {
      throw new Error("Deleting an active leaf did not clear Chat.activeLeafMessageId.");
    }

    const cascadeParent = await createMessage(tx, { chatId: chats[1].id });
    const cascadeLeaf = await createMessage(tx, {
      chatId: chats[1].id,
      parentMessageId: cascadeParent.id,
      role: "assistant"
    });
    await tx.chat.update({ data: { activeLeafMessageId: cascadeLeaf.id }, where: { id: chats[1].id } });
    await tx.chat.delete({ where: { id: chats[1].id } });
    if ((await tx.message.count({ where: { chatId: chats[1].id } })) !== 0) {
      throw new Error("Deleting a chat did not cascade through its message tree.");
    }
  });
}

async function assertGrantShapes(): Promise<void> {
  await expectDatabaseRejection("grant with two principals", "AccessGrant_subject_check", async (tx) => {
    const { user } = await createUserAndChats(tx, 0);
    const group = await tx.group.create({ data: { id: randomUUID(), name: `integrity-${randomUUID()}` } });
    await tx.accessGrant.create({
      data: { groupId: group.id, id: randomUUID(), provider: "fake", userId: user.id }
    });
  });

  await expectDatabaseRejection("grant without a principal", "AccessGrant_subject_check", async (tx) => {
    await tx.accessGrant.create({ data: { id: randomUUID(), provider: "fake" } });
  });

  for (const [label, target] of [
    ["empty target", {}],
    ["model without provider", { modelId: "fake-qsa" }],
    ["provider plus search", { provider: "fake", searchStrategy: "search-disabled" }],
    ["blank provider", { provider: "   " }],
    ["blank model", { modelId: "   ", provider: "fake" }],
    ["blank search", { searchStrategy: "   " }]
  ] as const) {
    await expectDatabaseRejection(`grant ${label}`, "AccessGrant_target_check", async (tx) => {
      const { user } = await createUserAndChats(tx, 0);
      await tx.accessGrant.create({ data: { id: randomUUID(), userId: user.id, ...target } });
    });
  }

  await expectRolledBackSuccess("all supported grant shapes", async (tx) => {
    const { user } = await createUserAndChats(tx, 0);
    const group = await tx.group.create({ data: { id: randomUUID(), name: `integrity-${randomUUID()}` } });
    for (const principal of [{ userId: user.id }, { groupId: group.id }]) {
      for (const target of [
        { provider: "fake" },
        { modelId: "fake-qsa", provider: "fake" },
        { searchStrategy: "search-disabled" }
      ]) {
        await tx.accessGrant.create({ data: { id: randomUUID(), ...principal, ...target } });
      }
    }
  });
}

async function assertStatusEnums(): Promise<void> {
  await expectDatabaseRejection('invalid MessageStatus', 'invalid input value for enum "MessageStatus"', async (tx) => {
    const { chats } = await createUserAndChats(tx, 1);
    const message = await createMessage(tx, { chatId: chats[0].id });
    await tx.$executeRawUnsafe(
      `UPDATE "Message" SET "status" = 'not-a-status' WHERE "id" = $1`,
      message.id
    );
  });

  await expectDatabaseRejection('invalid ModelRunStatus', 'invalid input value for enum "ModelRunStatus"', async (tx) => {
    const { run } = await createModelRunFixture(tx);
    await tx.$executeRawUnsafe(
      `UPDATE "ModelRun" SET "status" = 'not-a-status' WHERE "id" = $1`,
      run.id
    );
  });

  await expectDatabaseRejection('invalid SearchRunStatus', 'invalid input value for enum "SearchRunStatus"', async (tx) => {
    const { run } = await createModelRunFixture(tx);
    const searchRun = await tx.searchRun.create({
      data: {
        artifacts: json({}),
        id: randomUUID(),
        modelRunId: run.id,
        provider: "fake",
        requestPreview: json({}),
        status: "complete",
        strategyId: "search-disabled"
      }
    });
    await tx.$executeRawUnsafe(
      `UPDATE "SearchRun" SET "status" = 'not-a-status' WHERE "id" = $1`,
      searchRun.id
    );
  });

  await expectDatabaseRejection('invalid AttachmentStatus', 'invalid input value for enum "AttachmentStatus"', async (tx) => {
    const { user } = await createUserAndChats(tx, 0);
    const attachment = await tx.attachment.create({
      data: {
        byteSize: 1,
        fileName: "integrity.txt",
        id: randomUUID(),
        kind: "document",
        metadata: json({}),
        mimeType: "text/plain",
        status: "ready",
        storageKey: `integrity/${randomUUID()}`,
        userId: user.id
      }
    });
    await tx.$executeRawUnsafe(
      `UPDATE "Attachment" SET "status" = 'not-a-status' WHERE "id" = $1`,
      attachment.id
    );
  });
}

async function main() {
  await assertConstraintCatalog();
  await assertSameChatRelations();
  await assertGrantShapes();
  await assertStatusEnums();
  console.log(
    "AIQSA schema integrity smoke ok: validated constraints, tenant-safe pointers, six grant shapes, and lifecycle enums."
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

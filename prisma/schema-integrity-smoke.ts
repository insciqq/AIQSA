import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { providerTemplateIds } from "../lib/domain/providerTemplates";

const prisma = new PrismaClient();

const expectedConstraintNames = [
  "AccessGrant_subject_check",
  "AccessGrant_target_check",
  "AuthRateLimitBucket_attemptCount_check",
  "AuthSession_revocation_attribution_check",
  "AuthSession_revokedByUserId_fkey",
  "Chat_id_activeLeafMessageId_fkey",
  "KnowledgeBase_activeIndexGeneration_fkey",
  "KnowledgeBasePublication_scope_group_check",
  "KnowledgeChunk_dimension_check",
  "KnowledgeDocument_currentVersion_fkey",
  "KnowledgeDocumentVersion_ingestGeneration_fkey",
  "KnowledgeDocumentVersion_ingest_progress_check",
  "KnowledgeDocumentVersion_normalized_object_check",
  "KnowledgeDocumentVersion_storage_key_check",
  "KnowledgeDocumentVersion_visibility_check",
  "KnowledgeGenerationDocument_error_check",
  "KnowledgeGenerationDocument_generation_fkey",
  "KnowledgeGenerationDocument_progress_check",
  "KnowledgeGenerationDocument_state_check",
  "KnowledgeGenerationDocument_version_fkey",
  "KnowledgeIndexGeneration_dimension_check",
  "KnowledgeIndexGeneration_reindex_source_check",
  "KnowledgePolicy_candidate_limit_check",
  "KnowledgePolicy_result_limit_check",
  "KnowledgePolicy_score_threshold_check",
  "KnowledgePolicy_singleton_check",
  "KnowledgePolicy_version_check",
  "Message_chatId_parentMessageId_fkey",
  "ModelPolicy_defaultProviderModelId_fkey",
  "ModelPolicy_singleton_check",
  "ModelPolicy_version_check",
  "SearchOption_archive_check",
  "SearchOption_kind_check",
  "SearchOption_source_check",
  "SearchOption_sourceConnectionId_fkey",
  "SearchStrategy_searchOptionId_fkey",
  "SystemModelPolicy_providerModelId_fkey",
  "SystemModelPolicy_singleton_check",
  "SystemModelPolicy_version_check",
  "UsageEvent_knowledge_shape_check"
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
          defaultProviderModelId: providerTemplateIds.fakeModel,
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
      'AuthRateLimitBucket_attemptCount_check',
      'AuthSession_revocation_attribution_check',
      'AuthSession_revokedByUserId_fkey',
      'Chat_id_activeLeafMessageId_fkey',
      'KnowledgeBase_activeIndexGeneration_fkey',
      'KnowledgeBasePublication_scope_group_check',
      'KnowledgeChunk_dimension_check',
      'KnowledgeDocument_currentVersion_fkey',
      'KnowledgeDocumentVersion_ingestGeneration_fkey',
      'KnowledgeDocumentVersion_ingest_progress_check',
      'KnowledgeDocumentVersion_normalized_object_check',
      'KnowledgeDocumentVersion_storage_key_check',
      'KnowledgeDocumentVersion_visibility_check',
      'KnowledgeGenerationDocument_error_check',
      'KnowledgeGenerationDocument_generation_fkey',
      'KnowledgeGenerationDocument_progress_check',
      'KnowledgeGenerationDocument_state_check',
      'KnowledgeGenerationDocument_version_fkey',
      'KnowledgeIndexGeneration_dimension_check',
      'KnowledgeIndexGeneration_reindex_source_check',
      'KnowledgePolicy_candidate_limit_check',
      'KnowledgePolicy_result_limit_check',
      'KnowledgePolicy_score_threshold_check',
      'KnowledgePolicy_singleton_check',
      'KnowledgePolicy_version_check',
      'Message_chatId_parentMessageId_fkey',
      'ModelPolicy_defaultProviderModelId_fkey',
      'ModelPolicy_singleton_check',
      'ModelPolicy_version_check',
      'SearchOption_archive_check',
      'SearchOption_kind_check',
      'SearchOption_source_check',
      'SearchOption_sourceConnectionId_fkey',
      'SearchStrategy_searchOptionId_fkey',
      'SystemModelPolicy_providerModelId_fkey',
      'SystemModelPolicy_singleton_check',
      'SystemModelPolicy_version_check',
      'UsageEvent_knowledge_shape_check'
    )
    ORDER BY conname
  `;
  const actual = new Map(constraints.map((constraint) => [constraint.conname, constraint.convalidated]));
  for (const name of expectedConstraintNames) {
    if (actual.get(name) !== true) {
      throw new Error(`Expected validated database constraint ${name}.`);
    }
  }
  const destinationIndexes = await prisma.$queryRaw<Array<{ indexdef: string }>>`
    SELECT indexdef
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'SearchOption_sourceConnectionId_kind_key'
  `;
  if (
    destinationIndexes.length !== 1 ||
    !/CREATE UNIQUE INDEX.*"sourceConnectionId".*"?kind"?/u.test(
      destinationIndexes[0]!.indexdef
    )
  ) {
    throw new Error("Expected unique logical Search destination index.");
  }
  const activeRouteIndexes = await prisma.$queryRaw<Array<{ indexdef: string }>>`
    SELECT indexdef
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'SearchStrategy_searchOptionId_adapterKind_active_key'
  `;
  if (
    activeRouteIndexes.length !== 1 ||
    !/CREATE UNIQUE INDEX.*"searchOptionId".*"adapterKind".*WHERE.*"archivedAt" IS NULL/u.test(
      activeRouteIndexes[0]!.indexdef
    )
  ) {
    throw new Error("Expected one active physical Search route per adapter kind.");
  }
  const knowledgeIndexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname IN (
        'KnowledgeChunk_embedding_1024_hnsw_idx',
        'KnowledgeChunk_embedding_1536_hnsw_idx',
        'KnowledgeChunk_searchVector_gin_idx'
      )
    ORDER BY indexname
  `;
  if (knowledgeIndexes.length !== 3) {
    throw new Error("Expected both committed Knowledge HNSW profiles and the FTS index.");
  }
  const knowledgeIngestionIndexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname IN (
        'KnowledgeGenerationDocument_state_nextAttemptAt_claimedAt_createdAt_idx',
        'KnowledgeIndexGeneration_one_building_reindex_idx',
        'KnowledgeDocumentVersion_one_active_ingest_idx',
        'UsageEvent_knowledge_batch_key'
      )
    ORDER BY indexname
  `;
  if (knowledgeIngestionIndexes.length !== 4) {
    throw new Error("Expected Knowledge ingestion queue and idempotency indexes.");
  }
}

async function assertSearchOptionSources(): Promise<void> {
  await expectDatabaseRejection(
    "non-Off Search without source",
    "SearchOption_source_check",
    async (tx) => {
      await tx.searchOption.create({
        data: {
          description: "Invalid source",
          displayName: "Invalid Search",
          id: randomUUID(),
          kind: "web_search",
          optionId: `invalid-search-${randomUUID()}`,
          sourceConnectionId: null
        }
      });
    }
  );
  await expectDatabaseRejection(
    "arbitrary connectionless Off Search",
    "SearchOption_source_check",
    async (tx) => {
      await tx.searchOption.create({
        data: {
          description: "Invalid Off",
          displayName: "Invalid Off",
          id: randomUUID(),
          kind: "none",
          optionId: `invalid-off-${randomUUID()}`,
          sourceConnectionId: null
        }
      });
    }
  );
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
      data: {
        groupId: group.id,
        id: randomUUID(),
        providerConnectionId: providerTemplateIds.fakeConnection,
        userId: user.id
      }
    });
  });

  await expectDatabaseRejection("grant without a principal", "AccessGrant_subject_check", async (tx) => {
    await tx.accessGrant.create({
      data: { id: randomUUID(), providerConnectionId: providerTemplateIds.fakeConnection }
    });
  });

  for (const [label, target] of [
    ["empty target", {}],
    [
      "provider plus search",
      { providerConnectionId: providerTemplateIds.fakeConnection, searchStrategy: "search-disabled" }
    ],
    ["blank provider", { providerConnectionId: "   " }],
    ["blank model", { providerModelId: "   " }],
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
        { providerConnectionId: providerTemplateIds.fakeConnection },
        { providerModelId: providerTemplateIds.fakeModel },
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
  await assertSearchOptionSources();
  await assertSameChatRelations();
  await assertGrantShapes();
  await assertStatusEnums();
  console.log(
    "AIQSA schema integrity smoke ok: validated constraints, tenant-safe pointers, Knowledge ingestion/indexes, six grant shapes, and lifecycle enums."
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

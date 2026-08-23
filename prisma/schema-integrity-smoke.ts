import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { providerTemplateIds } from "../lib/domain/providerTemplates";

const prisma = new PrismaClient();

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

function memoryIndexGenerationData(
  userId: string,
  generation: number,
  state: "ACTIVE" | "FAILED" | "READY"
): Prisma.MemoryIndexGenerationUncheckedCreateInput {
  const readyAt = new Date();
  return {
    activatedAt: state === "ACTIVE" ? readyAt : null,
    chunkingVersion: "memory-chunking-v1",
    generation,
    id: randomUUID(),
    indexMode: "LEXICAL_ONLY",
    indexedThroughMemoryRevision: 0,
    languageProfile: "simple",
    normalizationVersion: "memory-normalization-v1",
    readyAt,
    retrievalPipelineVersion: "memory-retrieval-v1",
    state,
    targetMemoryRevision: 0,
    userId
  };
}

type QueryClient = Pick<Prisma.TransactionClient, "$queryRaw">;
type SemanticDuplicateIndex = Readonly<{
  indexNames: string[];
  tableName: string;
}>;

async function semanticDuplicateIndexes(
  client: QueryClient,
  schemaName: string
): Promise<SemanticDuplicateIndex[]> {
  return client.$queryRaw<SemanticDuplicateIndex[]>(Prisma.sql`
    WITH index_signatures AS (
      SELECT
        table_relation.oid AS "tableOid",
        table_relation.relname AS "tableName",
        index_relation.relname AS "indexName",
        access_method.amname AS "accessMethod",
        index_catalog.indisunique AS "isUnique",
        index_catalog.indnullsnotdistinct AS "nullsNotDistinct",
        index_catalog.indisexclusion AS "isExclusion",
        index_catalog.indimmediate AS "isImmediate",
        index_catalog.indnkeyatts AS "keyAttributeCount",
        index_catalog.indnatts AS "attributeCount",
        index_catalog.indkey::text AS "columns",
        index_catalog.indcollation::text AS "collations",
        index_catalog.indclass::text AS "operatorClasses",
        index_catalog.indoption::text AS "columnOptions",
        COALESCE(
          pg_get_expr(index_catalog.indexprs, index_catalog.indrelid, true),
          ''
        ) AS "expressions",
        COALESCE(
          pg_get_expr(index_catalog.indpred, index_catalog.indrelid, true),
          ''
        ) AS "predicate",
        COALESCE(
          (
            SELECT string_agg(option, ',' ORDER BY option)
            FROM unnest(index_relation.reloptions) AS option
          ),
          ''
        ) AS "storageOptions"
      FROM pg_index AS index_catalog
      INNER JOIN pg_class AS index_relation
        ON index_relation.oid = index_catalog.indexrelid
      INNER JOIN pg_class AS table_relation
        ON table_relation.oid = index_catalog.indrelid
      INNER JOIN pg_namespace AS namespace
        ON namespace.oid = table_relation.relnamespace
      INNER JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE namespace.nspname = ${schemaName}
        AND index_catalog.indisvalid
        AND index_catalog.indisready
        AND index_catalog.indislive
    )
    SELECT
      "tableName",
      array_agg("indexName" ORDER BY "indexName") AS "indexNames"
    FROM index_signatures
    GROUP BY
      "tableOid",
      "tableName",
      "accessMethod",
      "isUnique",
      "nullsNotDistinct",
      "isExclusion",
      "isImmediate",
      "keyAttributeCount",
      "attributeCount",
      "columns",
      "collations",
      "operatorClasses",
      "columnOptions",
      "expressions",
      "predicate",
      "storageOptions"
    HAVING count(*) > 1
    ORDER BY "tableName", "indexNames"
  `);
}

async function assertNoSemanticDuplicateIndexes(
  client: QueryClient,
  schemaName: string
): Promise<void> {
  const duplicates = await semanticDuplicateIndexes(client, schemaName);
  if (duplicates.length > 0) {
    const details = duplicates
      .map((duplicate) => `${duplicate.tableName}: ${duplicate.indexNames.join(", ")}`)
      .join("\n");
    throw new Error(`Semantic duplicate indexes found in ${schemaName}:\n${details}`);
  }
}

async function assertSemanticIndexSignatureCoverage(): Promise<void> {
  await expectRolledBackSuccess("semantic index signature fixture", async (tx) => {
    const schemaName = `aiqsa_index_signature_${randomUUID().replaceAll("-", "")}`;
    if (!/^aiqsa_index_signature_[a-f0-9]{32}$/u.test(schemaName)) {
      throw new Error("Invalid generated index-signature fixture schema.");
    }
    const fixture = `"${schemaName}"."IndexFixture"`;
    await tx.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`);
    await tx.$executeRawUnsafe(
      `CREATE TABLE ${fixture} (
        "textValue" text,
        "includeA" text,
        "includeB" text,
        "tags" text[],
        "embedding" vector(3)
      )`
    );
    for (const statement of [
      `CREATE INDEX "duplicate_a" ON ${fixture} USING btree ("textValue")`,
      `CREATE INDEX "duplicate_b" ON ${fixture} USING btree ("textValue")`,
      `CREATE UNIQUE INDEX "unique_value" ON ${fixture} USING btree ("textValue")`,
      `CREATE INDEX "partial_present" ON ${fixture} USING btree ("textValue") WHERE "includeA" IS NOT NULL`,
      `CREATE INDEX "partial_absent" ON ${fixture} USING btree ("textValue") WHERE "includeA" IS NULL`,
      `CREATE INDEX "expression_lower" ON ${fixture} USING btree (lower("textValue"))`,
      `CREATE INDEX "expression_upper" ON ${fixture} USING btree (upper("textValue"))`,
      `CREATE INDEX "include_a" ON ${fixture} USING btree ("textValue") INCLUDE ("includeA")`,
      `CREATE INDEX "include_b" ON ${fixture} USING btree ("textValue") INCLUDE ("includeB")`,
      `CREATE INDEX "pattern_ops" ON ${fixture} USING btree ("textValue" text_pattern_ops)`,
      `CREATE INDEX "descending" ON ${fixture} USING btree ("textValue" DESC NULLS LAST)`,
      `CREATE INDEX "fillfactor_70" ON ${fixture} USING btree ("textValue") WITH (fillfactor = 70)`,
      `CREATE INDEX "fillfactor_80" ON ${fixture} USING btree ("textValue") WITH (fillfactor = 80)`,
      `CREATE INDEX "method_btree" ON ${fixture} USING btree ("tags")`,
      `CREATE INDEX "method_gin" ON ${fixture} USING gin ("tags")`,
      `CREATE INDEX "method_hnsw_cosine" ON ${fixture} USING hnsw ("embedding" vector_cosine_ops)`,
      `CREATE INDEX "method_hnsw_l2" ON ${fixture} USING hnsw ("embedding" vector_l2_ops)`
    ]) {
      await tx.$executeRawUnsafe(statement);
    }

    const duplicates = await semanticDuplicateIndexes(tx, schemaName);
    if (
      duplicates.length !== 1 ||
      duplicates[0]!.tableName !== "IndexFixture" ||
      duplicates[0]!.indexNames.join(",") !== "duplicate_a,duplicate_b"
    ) {
      throw new Error(
        `Index signature failed to distinguish uniqueness, predicates, expressions, includes, operator classes, methods, ordering, or storage options: ${JSON.stringify(duplicates)}`
      );
    }
  });
}

async function assertConstraintCatalog(): Promise<void> {
  await assertSemanticIndexSignatureCoverage();
  await assertNoSemanticDuplicateIndexes(prisma, "public");

  const unvalidatedConstraints = await prisma.$queryRaw<
    Array<{ constraintName: string; tableName: string }>
  >`
    SELECT
      constraint_catalog.conname AS "constraintName",
      table_relation.relname AS "tableName"
    FROM pg_constraint AS constraint_catalog
    INNER JOIN pg_class AS table_relation
      ON table_relation.oid = constraint_catalog.conrelid
    INNER JOIN pg_namespace AS namespace
      ON namespace.oid = constraint_catalog.connamespace
    WHERE namespace.nspname = current_schema()
      AND NOT constraint_catalog.convalidated
    ORDER BY table_relation.relname, constraint_catalog.conname
  `;
  if (unvalidatedConstraints.length > 0) {
    throw new Error(
      `Unvalidated database constraints found: ${JSON.stringify(unvalidatedConstraints)}`
    );
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
        'KnowledgeGenerationDocument_state_nextAttemptAt_claimedAt_c_idx',
        'KnowledgeIndexGeneration_one_building_reindex_idx',
        'KnowledgeDocumentVersion_one_active_ingest_idx',
        'UsageEvent_knowledgeIndexGenerationId_knowledgeDocumentVers_key'
      )
    ORDER BY indexname
  `;
  if (knowledgeIngestionIndexes.length !== 4) {
    throw new Error("Expected Knowledge ingestion queue and idempotency indexes.");
  }
  const fairnessQueueIndexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname IN (
        'AttachmentProcessingJob_owner_due_idx',
        'AttachmentProcessingJob_due_owner_idx',
        'KnowledgeDocumentVersion_owner_due_active_idx',
        'KnowledgeGenerationDocument_owner_due_active_idx'
      )
    ORDER BY indexname
  `;
  if (fairnessQueueIndexes.length !== 4) {
    throw new Error("Expected tenant-fair document-processing queue indexes.");
  }
  const memorySearchColumns = await prisma.$queryRaw<Array<{
    columnName: string;
    isGenerated: string;
  }>>`
    SELECT column_name AS "columnName", is_generated AS "isGenerated"
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'MemorySearchEntry'
      AND (column_name ILIKE '%search%' OR column_name ILIKE '%vector%')
    ORDER BY column_name
  `;
  if (
    memorySearchColumns.length !== 2 ||
    memorySearchColumns[0]?.columnName !== "normalizedSearchText" ||
    memorySearchColumns[0]?.isGenerated !== "NEVER" ||
    memorySearchColumns[1]?.columnName !== "searchVectorSimple" ||
    memorySearchColumns[1]?.isGenerated !== "ALWAYS"
  ) {
    throw new Error("Expected one canonical Memory search text and one generated simple vector.");
  }
  const memoryOperationOutcomes = await prisma.$queryRaw<Array<{ label: string }>>`
    SELECT enum_label.enumlabel AS label
    FROM pg_type AS enum_type
    INNER JOIN pg_enum AS enum_label ON enum_label.enumtypid = enum_type.oid
    INNER JOIN pg_namespace AS namespace ON namespace.oid = enum_type.typnamespace
    WHERE namespace.nspname = current_schema()
      AND enum_type.typname = 'MemoryOperationOutcome'
    ORDER BY enum_label.enumsortorder
  `;
  if (memoryOperationOutcomes.map(({ label }) => label).join(",") !== "APPLIED,REJECTED") {
    throw new Error("MemoryOperationOutcome contains an unsupported compatibility value.");
  }
}

async function assertMemoryActiveGenerationGuard(): Promise<void> {
  await expectDatabaseRejection(
    "unselected active Memory generation",
    "ACTIVE Memory generation must be selected by owner settings",
    async (tx) => {
      const { user } = await createUserAndChats(tx, 0);
      await tx.memoryIndexGeneration.create({
        data: memoryIndexGenerationData(user.id, 1, "ACTIVE")
      });
    }
  );

  await expectDatabaseRejection(
    "Memory settings pointer to a non-active generation",
    "Memory settings must point to the one same-owner ACTIVE generation",
    async (tx) => {
      const { user } = await createUserAndChats(tx, 0);
      const generation = await tx.memoryIndexGeneration.create({
        data: memoryIndexGenerationData(user.id, 1, "READY")
      });
      await tx.userMemorySettings.update({
        data: { activeIndexGenerationId: generation.id },
        where: { userId: user.id }
      });
    }
  );

  const fixture = await prisma.$transaction(async (tx) => {
    const { user } = await createUserAndChats(tx, 0);
    const generations = await Promise.all([
      tx.memoryIndexGeneration.create({
        data: memoryIndexGenerationData(user.id, 1, "READY")
      }),
      tx.memoryIndexGeneration.create({
        data: memoryIndexGenerationData(user.id, 2, "FAILED")
      })
    ]);
    return { generations, user };
  });

  try {
    const outcomes = await Promise.allSettled(
      fixture.generations.map((generation) =>
        prisma.$transaction(async (tx) => {
          await tx.memoryIndexGeneration.update({
            data: { activatedAt: new Date(), state: "ACTIVE" },
            where: { id: generation.id }
          });
          await tx.userMemorySettings.update({
            data: { activeIndexGenerationId: generation.id },
            where: { userId: fixture.user.id }
          });
        })
      )
    );
    if (
      outcomes.filter((outcome) => outcome.status === "fulfilled").length !== 1 ||
      outcomes.filter((outcome) => outcome.status === "rejected").length !== 1
    ) {
      throw new Error(
        `Concurrent Memory generation activation did not produce exactly one winner: ${JSON.stringify(
          outcomes.map((outcome) => outcome.status)
        )}`
      );
    }

    const [settings, activeGenerations] = await Promise.all([
      prisma.userMemorySettings.findUniqueOrThrow({ where: { userId: fixture.user.id } }),
      prisma.memoryIndexGeneration.findMany({
        where: { state: "ACTIVE", userId: fixture.user.id }
      })
    ]);
    if (
      activeGenerations.length !== 1 ||
      settings.activeIndexGenerationId !== activeGenerations[0]?.id
    ) {
      throw new Error("Concurrent Memory generation activation left an invalid active pointer.");
    }
  } finally {
    await prisma.user.delete({ where: { id: fixture.user.id } });
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

async function assertMemoryCandidateSourceAuthority(): Promise<void> {
  await expectDatabaseRejection(
    "assistant Memory candidate source",
    "exact settled direct USER message",
    async (tx) => {
      const hash = () =>
        `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
      const { chats, user } = await createUserAndChats(tx, 1);
      const userMessage = await createMessage(tx, { chatId: chats[0].id });
      const assistantMessage = await createMessage(tx, {
        chatId: chats[0].id,
        parentMessageId: userMessage.id,
        role: "assistant"
      });
      const sourceHash = hash();
      const pipelineVersion = "memory-fact-extraction-v1";
      const job = await tx.memoryJob.create({
        data: {
          acceptedResultHash: hash(),
          activeLeafMessageId: assistantMessage.id,
          branchGeneration: 0,
          chatId: chats[0].id,
          completedAt: new Date(),
          id: randomUUID(),
          idempotencyFingerprint: hash(),
          kind: "EXTRACT_FACTS",
          memoryGenerationSnapshot: 0,
          memoryRevisionSnapshot: 0,
          pipelineVersion,
          sourceHash,
          sourceMessageId: userMessage.id,
          sourceRevision: 0,
          state: "SUCCEEDED",
          userId: user.id
        }
      });
      const createdAt = new Date(Date.now() - 10_000);
      const completedAt = new Date(Date.now() - 1_000);
      const execution = await tx.memoryExecutionBinding.create({
        data: {
          acceptedOutputHash: hash(),
          completedAt,
          createdAt,
          destinationFingerprint: hash(),
          id: randomUUID(),
          inputHash: hash(),
          logicalRole: "MEMORY_FACT_EXTRACT",
          memoryJobId: job.id,
          ordinal: 0,
          ownerType: "JOB",
          pipelineVersion,
          policyVersion: "memory-fact-policy-v1",
          promptVersion: "memory-fact-prompt-v1",
          providerId: "fake",
          recoverableUntil: new Date(createdAt.getTime() + 1_000),
          relationsDetachedAt: completedAt,
          schemaVersion: "memory-fact-schema-v1",
          secretFreeExecutionSnapshot: json({}),
          state: "SUCCEEDED",
          userId: user.id
        }
      });
      const candidateId = hash();
      await tx.memoryCandidate.create({
        data: {
          branchGeneration: 0,
          chatId: chats[0].id,
          confidence: 0.9,
          createdByExecutionId: execution.id,
          id: candidateId,
          importance: 0.5,
          jobId: job.id,
          languageCode: "en",
          negated: false,
          pipelineVersion,
          proposedCanonicalKey: "user.preference.drink",
          proposedCategory: "preference",
          proposedDirectness: "DIRECT",
          proposedDisplayText: "I prefer tea.",
          proposedModality: "PREFERENCE",
          proposedScope: json({ target_id: chats[0].id, type: "CHAT" }),
          proposedSensitivity: "NORMAL",
          proposedValue: json({ drink: "tea" }),
          sourceHash,
          sourceProjectionHash: hash(),
          sourceProjectionVersion: "memory-fact-source-projection-v1",
          sourceRevision: 0,
          sourceTimezone: "UTC",
          state: "PENDING",
          userId: user.id
        }
      });
      await tx.memoryCandidateMessage.create({
        data: {
          candidateId,
          chatId: chats[0].id,
          endOffset: 4,
          messageId: assistantMessage.id,
          ordinal: 0,
          sourceTextHash: hash(),
          startOffset: 0,
          userId: user.id
        }
      });
    }
  );
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
  await assertMemoryActiveGenerationGuard();
  await assertSearchOptionSources();
  await assertSameChatRelations();
  await assertMemoryCandidateSourceAuthority();
  await assertGrantShapes();
  await assertStatusEnums();
  console.log(
    "AIQSA schema integrity smoke ok: validated semantic index uniqueness, constraint validation, concurrent Memory generation activation, tenant-safe pointers, direct-USER Memory candidates and fact decisions, Knowledge ingestion/indexes, six grant shapes, and lifecycle enums."
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

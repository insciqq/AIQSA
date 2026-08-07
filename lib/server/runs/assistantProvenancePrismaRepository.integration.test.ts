import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { createPrismaRunRepository } from "./prismaRepository";
import type { RunRepository } from "./runRepositoryContract";

const enabled = process.env.AIQSA_ASSISTANT_RUN_AUTHORIZATION_INTEGRATION_TEST === "1";
const integration = enabled ? describe : describe.skip;
const database = new PrismaClient();
const suffix = randomUUID();
const connectionId = `assistant-run-connection-${suffix}`;
const modelId = `assistant-run-model-${suffix}`;

type Fixture = Awaited<ReturnType<typeof createFixture>>;

const fixtures: Fixture[] = [];
const clients: PrismaClient[] = [];

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function namedClient(label: string): PrismaClient {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for Assistant run integration tests");
  const url = new URL(databaseUrl);
  url.searchParams.set("application_name", `${label}-${randomUUID()}`.slice(0, 63));
  const client = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  clients.push(client);
  return client;
}

async function activeApplicationName(client: PrismaClient): Promise<string> {
  const rows = await client.$queryRaw<Array<{ applicationName: string }>>`
    SELECT current_setting('application_name') AS "applicationName"
  `;
  return rows[0]!.applicationName;
}

async function waitForLock(applicationName: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await database.$queryRaw<Array<{ waiting: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE application_name = ${applicationName}
          AND wait_event_type = 'Lock'
      ) AS "waiting"
    `;
    if (rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for PostgreSQL lock: ${applicationName}`);
}

async function createFixture(): Promise<{
  assistantId: string;
  chatId: string;
  groupId: string;
  memberId: string;
  ownerId: string;
  publicationId: string;
  revisionOneId: string;
  revisionTwoId: string;
}> {
  const fixtureSuffix = randomUUID();
  const ownerId = `assistant-run-owner-${fixtureSuffix}`;
  const memberId = `assistant-run-member-${fixtureSuffix}`;
  const groupId = `assistant-run-group-${fixtureSuffix}`;
  await database.user.createMany({
    data: [
      {
        displayName: "Assistant run owner",
        email: `${ownerId}@test.local`,
        id: ownerId,
        status: "active"
      },
      {
        displayName: "Assistant run member",
        email: `${memberId}@test.local`,
        id: memberId,
        status: "active"
      }
    ]
  });
  await database.group.create({
    data: { id: groupId, name: `Assistant run group ${fixtureSuffix}` }
  });
  await database.userGroup.createMany({
    data: [
      { groupId, userId: ownerId },
      { groupId, userId: memberId }
    ]
  });
  const definition = await database.assistantDefinition.create({
    data: { ownerUserId: ownerId }
  });
  const revisionData = {
    assistantId: definition.id,
    authorUserId: ownerId,
    avatar: {
      accents: [0, 3],
      backgroundShape: "hexagon",
      foregroundShape: "triangle",
      kind: "generated",
      paletteId: "meadow",
      recipeVersion: 1,
      rotations: [1, 0]
    },
    category: "coding",
    description: "Assistant run authorization fixture",
    developerPrompt: null,
    mcpServerIds: [],
    providerModelId: modelId,
    runControls: {},
    searchPlan: { mode: "all_selected", optionIds: [] },
    starterPrompts: [],
    systemPrompt: "Test Assistant run authorization."
  };
  const revisionOne = await database.assistantRevision.create({
    data: { ...revisionData, name: "Authorization fixture v1", revisionNumber: 1 }
  });
  const revisionTwo = await database.assistantRevision.create({
    data: { ...revisionData, name: "Authorization fixture v2", revisionNumber: 2 }
  });
  await database.assistantDefinition.update({
    data: { currentRevisionId: revisionTwo.id },
    where: { id: definition.id }
  });
  const publication = await database.assistantPublication.create({
    data: {
      assistantId: definition.id,
      groupId,
      publishedByUserId: ownerId,
      revisionId: revisionOne.id,
      scope: "group"
    }
  });
  const chat = await database.chat.create({
    data: { title: "Assistant run authorization", userId: memberId }
  });
  const fixture = {
    assistantId: definition.id,
    chatId: chat.id,
    groupId,
    memberId,
    ownerId,
    publicationId: publication.id,
    revisionOneId: revisionOne.id,
    revisionTwoId: revisionTwo.id
  };
  fixtures.push(fixture);
  return fixture;
}

function createRunInput(
  fixture: Fixture,
  revisionId: string
): Parameters<RunRepository["createRun"]>[0] {
  const content = textMessageContent("Verify Assistant authorization");
  return {
    assistant: { assistantId: fixture.assistantId, revisionId },
    chatId: fixture.chatId,
    content,
    expectedActiveLeafId: null,
    modelId: "assistant-run-model",
    normalizedRequest: {
      attachmentIds: [],
      chatId: fixture.chatId,
      content,
      modelCapabilities: {
        nativePdfInput: false,
        nativeSearch: false,
        pdf: false,
        reasoning: false,
        vision: false
      },
      modelId: "assistant-run-model",
      params: {},
      prompt: { developer: null, system: "Test Assistant run authorization." },
      provider: "fake",
      searchStrategy: "search-disabled"
    },
    provider: "fake",
    providerRequestPreview: {},
    userId: fixture.memberId
  };
}

type PreparedRepositoryRun =
  | {
      input: Parameters<RunRepository["createRun"]>[0];
      kind: "send";
      sourceMessageId: null;
    }
  | {
      input: Parameters<RunRepository["createRegenerationRun"]>[0];
      kind: "regeneration";
      sourceMessageId: string;
    };

async function prepareRepositoryRun(
  fixture: Fixture,
  revisionId: string,
  kind: PreparedRepositoryRun["kind"]
): Promise<PreparedRepositoryRun> {
  const sendInput = createRunInput(fixture, revisionId);
  if (kind === "send") {
    return { input: sendInput, kind, sourceMessageId: null };
  }

  const sourceMessage = await database.message.create({
    data: {
      chatId: fixture.chatId,
      content: textMessageContent("Verify Assistant authorization"),
      role: "user",
      status: "complete"
    }
  });
  await database.chat.update({
    data: { activeLeafMessageId: sourceMessage.id },
    where: { id: fixture.chatId }
  });
  return {
    input: {
      assistant: { assistantId: fixture.assistantId, revisionId },
      chatId: sendInput.chatId,
      modelId: sendInput.modelId,
      normalizedRequest: sendInput.normalizedRequest,
      provider: sendInput.provider,
      providerRequestPreview: sendInput.providerRequestPreview,
      userId: sendInput.userId,
      userMessageId: sourceMessage.id
    },
    kind,
    sourceMessageId: sourceMessage.id
  };
}

function executePreparedRun(
  repository: RunRepository,
  prepared: PreparedRepositoryRun
) {
  return prepared.kind === "send"
    ? repository.createRun(prepared.input)
    : repository.createRegenerationRun(prepared.input);
}

async function expectEmptyRunGraph(fixture: Fixture): Promise<void> {
  await expect(database.chat.findUniqueOrThrow({
    select: {
      _count: { select: { messages: true, modelRuns: true } },
      activeLeafMessageId: true
    },
    where: { id: fixture.chatId }
  })).resolves.toEqual({
    _count: { messages: 0, modelRuns: 0 },
    activeLeafMessageId: null
  });
}

async function expectPreparedRunRolledBack(
  fixture: Fixture,
  prepared: PreparedRepositoryRun
): Promise<void> {
  if (prepared.kind === "send") {
    await expectEmptyRunGraph(fixture);
    return;
  }

  await expect(database.chat.findUniqueOrThrow({
    select: {
      _count: { select: { messages: true, modelRuns: true } },
      activeLeafMessageId: true
    },
    where: { id: fixture.chatId }
  })).resolves.toEqual({
    _count: { messages: 1, modelRuns: 0 },
    activeLeafMessageId: prepared.sourceMessageId
  });
}

const accessLossCases = [
  ["send", "archive"],
  ["send", "membership"],
  ["send", "revoke"],
  ["regeneration", "archive"],
  ["regeneration", "membership"],
  ["regeneration", "revoke"]
] as const;

integration("Assistant run authorization transaction", () => {
  beforeAll(async () => {
    await database.providerConnection.create({
      data: {
        displayName: "Assistant run authorization provider",
        family: "fake",
        id: connectionId
      }
    });
    await database.providerModel.create({
      data: {
        capabilities: {},
        connectionId,
        contextWindow: 128_000,
        defaultParams: {},
        displayName: "Assistant run authorization model",
        id: modelId,
        modelId: `upstream-${suffix}`,
        provider: "fake"
      }
    });
  });

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.$disconnect()));
    for (const fixture of fixtures) {
      await database.chat.deleteMany({ where: { id: fixture.chatId } });
      await database.assistantPin.deleteMany({ where: { assistantId: fixture.assistantId } });
      await database.assistantPublication.deleteMany({
        where: { assistantId: fixture.assistantId }
      });
      await database.assistantDefinition.updateMany({
        data: { currentRevisionId: null },
        where: { id: fixture.assistantId }
      });
      await database.assistantRevision.deleteMany({
        where: { assistantId: fixture.assistantId }
      });
      await database.assistantDefinition.deleteMany({
        where: { id: fixture.assistantId }
      });
      await database.userGroup.deleteMany({
        where: { groupId: fixture.groupId }
      });
      await database.group.deleteMany({ where: { id: fixture.groupId } });
      await database.userSettings.deleteMany({
        where: { userId: { in: [fixture.ownerId, fixture.memberId] } }
      });
      await database.user.deleteMany({
        where: { id: { in: [fixture.ownerId, fixture.memberId] } }
      });
    }
    await database.providerModel.deleteMany({ where: { id: modelId } });
    await database.providerConnection.deleteMany({ where: { id: connectionId } });
    await database.$disconnect();
  });

  it.each(["send", "regeneration"] as const)(
    "rejects a prepared revision for %s when only another revision remains published",
    async (kind) => {
      const fixture = await createFixture();
      const repository = createPrismaRunRepository(database);
      const prepared = await prepareRepositoryRun(fixture, fixture.revisionTwoId, kind);

      await expect(executePreparedRun(repository, prepared)).rejects.toEqual(
        expect.objectContaining({
          message: "assistant_not_available",
          name: "AssistantRunConflictError"
        })
      );
      await expectPreparedRunRolledBack(fixture, prepared);
    }
  );

  it.each(accessLossCases)(
    "%s returns a privacy-safe conflict when %s commits after the run snapshot",
    async (kind, mutation) => {
      const fixture = await createFixture();
      await database.assistantPublication.update({
        data: { revisionId: fixture.revisionTwoId },
        where: { id: fixture.publicationId }
      });
      const prepared = await prepareRepositoryRun(fixture, fixture.revisionTwoId, kind);
      const blockerClient = namedClient(`assistant-${kind}-${mutation}-blocker`);
      const runClient = namedClient(`assistant-${kind}-${mutation}-run`);
      const mutationClient = namedClient(`assistant-${kind}-${mutation}-mutation`);
      const runApplicationName = await activeApplicationName(runClient);
      const mutationApplicationName = await activeApplicationName(mutationClient);
      const lockReady = deferred();
      const releaseLock = deferred();
      const blocker = blockerClient.$transaction(async (tx) => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Chat" WHERE "id" = ${fixture.chatId} FOR UPDATE
        `;
        lockReady.resolve();
        await releaseLock.promise;
      }, { timeout: 30_000 });
      await lockReady.promise;

      const order: string[] = [];
      const run = executePreparedRun(createPrismaRunRepository(runClient), prepared)
        .then((result) => {
          order.push("run");
          return result;
        });
      await waitForLock(runApplicationName);

      const mutationPromise = (mutation === "archive"
        ? mutationClient.assistantDefinition.update({
            data: { archivedAt: new Date() },
            where: { id: fixture.assistantId }
          })
        : mutation === "membership"
          ? mutationClient.userGroup.delete({
              where: {
                userId_groupId: {
                  groupId: fixture.groupId,
                  userId: fixture.memberId
                }
              }
            })
          : mutationClient.assistantPublication.delete({
              where: { id: fixture.publicationId }
            }))
        .then((result) => {
          order.push("mutation");
          return result;
        });
      await Promise.race([
        mutationPromise.then(() => undefined),
        waitForLock(mutationApplicationName)
      ]);
      releaseLock.resolve();
      await blocker;

      await expect(run).rejects.toEqual(expect.objectContaining({
        message: "assistant_not_available",
        name: "AssistantRunConflictError"
      }));
      await mutationPromise;
      expect(order).toEqual(["mutation"]);
      await expectPreparedRunRolledBack(fixture, prepared);
    }
  );

  it("keeps a selected published revision valid across a concurrent current-revision advance", async () => {
    const fixture = await createFixture();
    await database.assistantDefinition.update({
      data: { currentRevisionId: fixture.revisionOneId, version: { increment: 1 } },
      where: { id: fixture.assistantId }
    });
    const blockerClient = namedClient("assistant-advance-blocker");
    const runClient = namedClient("assistant-advance-run");
    const advanceClient = namedClient("assistant-advance-mutation");
    const runApplicationName = await activeApplicationName(runClient);
    const lockReady = deferred();
    const releaseLock = deferred();
    const blocker = blockerClient.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Chat" WHERE "id" = ${fixture.chatId} FOR UPDATE
      `;
      lockReady.resolve();
      await releaseLock.promise;
    }, { timeout: 30_000 });
    await lockReady.promise;

    const order: string[] = [];
    const run = createPrismaRunRepository(runClient)
      .createRun(createRunInput(fixture, fixture.revisionOneId))
      .then((result) => {
        order.push("run");
        return result;
      });
    await waitForLock(runApplicationName);
    await advanceClient.assistantDefinition.update({
      data: { currentRevisionId: fixture.revisionTwoId, version: { increment: 1 } },
      where: { id: fixture.assistantId }
    });
    order.push("advance");
    releaseLock.resolve();
    await blocker;

    await expect(run).resolves.toEqual(expect.objectContaining({
      assistantMessageId: expect.any(String),
      runId: expect.any(String),
      userMessageId: expect.any(String)
    }));
    expect(order).toEqual(["advance", "run"]);
    await expect(database.modelRun.findFirstOrThrow({
      select: { assistantRevisionId: true },
      where: { chatId: fixture.chatId }
    })).resolves.toEqual({ assistantRevisionId: fixture.revisionOneId });
  });
});

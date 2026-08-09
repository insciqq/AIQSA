import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AssistantDraft } from "../../contracts/assistants";
import type { CatalogWireModel } from "../../contracts/catalog";
import type { AssistantCatalogView } from "./catalogValidation";
import { createPrismaAssistantRepository } from "./prismaRepository";
import { createPrismaKnowledgeRepository } from "../knowledge/prismaRepository";

const enabled = process.env.AIQSA_ASSISTANTS_INTEGRATION_TEST === "1";
const integration = enabled ? describe : describe.skip;
const database = new PrismaClient();
const liveMcpGenerations = new Set<string>();
const repository = createPrismaAssistantRepository(database, {
  isMcpGenerationLive: (generationId) => liveMcpGenerations.has(generationId),
  loadCatalogView: async () => duplicateCatalogView()
});
const suffix = randomUUID();

const ownerId = `assistant-owner-${suffix}`;
const memberId = `assistant-member-${suffix}`;
const outsiderId = `assistant-outsider-${suffix}`;
const groupId = `assistant-group-${suffix}`;
const otherGroupId = `assistant-group-b-${suffix}`;
const connectionId = `assistant-connection-${suffix}`;
const modelId = `assistant-model-${suffix}`;
const mcpServerId = `assistant-mcp-${suffix}`;
const mcpRevisionId = `assistant-mcp-revision-${suffix}`;
const mcpUserServerId = `assistant-mcp-user-${suffix}`;
const mcpGenerationId = `assistant-mcp-generation-${suffix}`;
const knowledgeBaseIds: string[] = [];

function catalogModel(): CatalogWireModel {
  return {
    capabilities: {
      background: false,
      documentInputMode: "none",
      imageInput: false,
      nativeWebSearch: false,
      openRouterPerplexitySearch: false,
      reasoning: true,
      streaming: true,
      text: true,
      toolCalling: true
    },
    contextWindow: 128_000,
    defaultParams: {},
    displayName: "Integration model",
    modelId,
    parameterControls: {
      background: { defaultValue: false, supported: false },
      maxOutputTokens: { defaultValue: 4096, maxValue: 128_000 },
      reasoningEffort: {
        defaultValue: "medium",
        options: ["low", "medium", "high"],
        supported: true
      },
      stream: { defaultValue: true, supported: true },
      temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
    },
    provider: connectionId,
    providerFamily: "fake",
    searchOptionCompatibility: {},
    searchStrategyIds: [],
    upstreamModelId: `upstream-${suffix}`
  };
}

function duplicateCatalogView(
  overrides: Partial<AssistantCatalogView> = {}
): AssistantCatalogView {
  return {
    accessibleMcpServerIds: new Set<string>(),
    entitledSearchOptionIds: new Set<string>(),
    mcpRunPlan: {
      isGenerationLive: () => false,
      now: new Date("2026-08-07T10:00:00.000Z"),
      recordsByServerId: new Map()
    },
    modelById: new Map([[modelId, catalogModel()]]),
    ...overrides
  };
}

function repositoryWithCatalogView(view: AssistantCatalogView) {
  return createPrismaAssistantRepository(database, {
    isMcpGenerationLive: (generationId) => liveMcpGenerations.has(generationId),
    loadCatalogView: async () => view
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitForBlockedBy(
  blockerPid: number,
  minimumCount = 1
): Promise<Array<{ pid: number; query: string }>> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const rows = await database.$queryRaw<Array<{ pid: number; query: string }>>`
      SELECT activity."pid", activity."query"
      FROM "pg_stat_activity" AS activity
      WHERE ${blockerPid} = ANY(pg_blocking_pids(activity."pid"))
        AND activity."datname" = current_database()
    `;
    if (rows.length >= minimumCount) return rows;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("assistant_integration_lock_wait_timeout");
}

function draft(overrides: Partial<AssistantDraft> = {}): AssistantDraft {
  return {
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
    description: "Integration assistant.",
    developerPrompt: null,
    knowledgeBaseIds: [],
    mcpServerIds: [],
    name: "Integration Reviewer",
    providerModelId: modelId,
    runControls: { reasoningEffort: "high" },
    searchPlan: { mode: "all_selected", optionIds: [] },
    starterPrompts: ["Review a diff"],
    systemPrompt: "You review integration changes.",
    ...overrides
  };
}

async function createKnowledgeBase(ownerUserId: string, name: string): Promise<string> {
  const base = await database.knowledgeBase.create({
    data: { name: `${name} ${suffix}`, ownerUserId }
  });
  knowledgeBaseIds.push(base.id);
  return base.id;
}

async function duplicateAfterCommittedMutation(
  assistantId: string,
  mutate: () => Promise<unknown>
) {
  const blocker = new PrismaClient();
  const lockReady = deferred<number>();
  const releaseLock = deferred<void>();
  const blockingTransaction = blocker.$transaction(async (tx) => {
    const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`
      SELECT pg_backend_pid() AS "pid"
    `;
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "AssistantDefinition"
      WHERE "id" = ${assistantId}
      FOR UPDATE
    `;
    lockReady.resolve(backend!.pid);
    await releaseLock.promise;
  }, { timeout: 10_000 });

  let duplicatePromise: ReturnType<typeof repository.duplicate> | null = null;
  try {
    const blockerPid = await lockReady.promise;
    duplicatePromise = repository.duplicate(memberId, assistantId);
    await waitForBlockedBy(blockerPid);
    await mutate();
    releaseLock.resolve();
    return await duplicatePromise;
  } finally {
    releaseLock.resolve();
    await Promise.allSettled([
      blockingTransaction,
      ...(duplicatePromise ? [duplicatePromise] : [])
    ]);
    await blocker.$disconnect();
  }
}

integration("assistant repository integration", () => {
  beforeAll(async () => {
    await database.user.createMany({
      data: [
        { displayName: "Owner", email: `${ownerId}@test.local`, id: ownerId, status: "active" },
        { displayName: "Member", email: `${memberId}@test.local`, id: memberId, status: "active" },
        { displayName: "Outsider", email: `${outsiderId}@test.local`, id: outsiderId, status: "active" }
      ]
    });
    await database.group.createMany({
      data: [
        { id: groupId, name: `Assistant group ${suffix}` },
        { id: otherGroupId, name: `Assistant group B ${suffix}` }
      ]
    });
    await database.userGroup.createMany({
      data: [
        { groupId, userId: ownerId },
        { groupId, userId: memberId }
      ]
    });
    await database.providerConnection.create({
      data: {
        displayName: "Assistant integration provider",
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
        displayName: "Integration model",
        id: modelId,
        modelId: `upstream-${suffix}`,
        provider: "fake"
      }
    });
  });

  afterAll(async () => {
    await database.modelRun.deleteMany({ where: { assistantId: { not: null }, userId: { in: [ownerId, memberId, outsiderId] } } });
    await database.assistantPin.deleteMany({ where: { userId: { in: [ownerId, memberId, outsiderId] } } });
    await database.assistantPublication.deleteMany({
      where: { assistant: { ownerUserId: { in: [ownerId, memberId, outsiderId] } } }
    });
    await database.assistantDefinition.updateMany({
      data: { currentRevisionId: null },
      where: { ownerUserId: { in: [ownerId, memberId, outsiderId] } }
    });
    await database.assistantRevision.deleteMany({
      where: { assistant: { ownerUserId: { in: [ownerId, memberId, outsiderId] } } }
    });
    await database.assistantDefinition.deleteMany({
      where: { ownerUserId: { in: [ownerId, memberId, outsiderId] } }
    });
    await database.mcpRuntimeGeneration.deleteMany({
      where: { userServerId: mcpUserServerId }
    });
    await database.mcpUserServer.deleteMany({ where: { id: mcpUserServerId } });
    await database.mcpGrant.deleteMany({ where: { serverId: mcpServerId } });
    await database.mcpServer.updateMany({
      data: { activeRevisionId: null },
      where: { id: mcpServerId }
    });
    await database.mcpRevision.deleteMany({ where: { serverId: mcpServerId } });
    await database.mcpServer.deleteMany({ where: { id: mcpServerId } });
    await database.knowledgeBasePublication.deleteMany({
      where: { knowledgeBaseId: { in: knowledgeBaseIds } }
    });
    await database.knowledgeBase.deleteMany({ where: { id: { in: knowledgeBaseIds } } });
    await database.providerModel.deleteMany({ where: { id: modelId } });
    await database.providerConnection.deleteMany({ where: { id: connectionId } });
    await database.userGroup.deleteMany({ where: { groupId: { in: [groupId, otherGroupId] } } });
    await database.group.deleteMany({ where: { id: { in: [groupId, otherGroupId] } } });
    await database.userSettings.deleteMany({ where: { userId: { in: [ownerId, memberId, outsiderId] } } });
    await database.user.deleteMany({ where: { id: { in: [ownerId, memberId, outsiderId] } } });
    await database.$disconnect();
  });

  it("keeps revisions append-only with CAS current-pointer updates", async () => {
    const assistantId = await repository.create(ownerId, draft());
    const created = await repository.getDetail(ownerId, assistantId);
    expect(created?.revision.revisionNumber).toBe(1);
    expect(created?.version).toBe(1);

    const stale = await repository.revise(ownerId, assistantId, 99, draft({ name: "Stale" }));
    expect(stale.kind).toBe("version_conflict");

    const revised = await repository.revise(
      ownerId,
      assistantId,
      created!.version!,
      draft({ name: "Integration Reviewer v2" })
    );
    expect(revised.kind).toBe("ok");

    const detail = await repository.getDetail(ownerId, assistantId);
    expect(detail?.revision.revisionNumber).toBe(2);
    expect(detail?.revisionCount).toBe(2);
    expect(detail?.revision.name).toBe("Integration Reviewer v2");

    const revisions = await repository.listRevisions(ownerId, assistantId);
    expect(revisions?.map((revision) => revision.revisionNumber)).toEqual([2, 1]);
  });

  it("enforces private-by-default with privacy-neutral cross-user reads", async () => {
    const assistantId = await repository.create(ownerId, draft({ name: "Private" }));
    expect(await repository.getDetail(memberId, assistantId)).toBeNull();
    expect(await repository.getDetail(outsiderId, `missing-${suffix}`)).toBeNull();
    expect(await repository.setPinned(memberId, assistantId, true)).toBe(false);
    const resolution = await repository.resolveForRun(memberId, assistantId);
    expect(resolution.ok).toBe(false);
  });

  it("publishes exact revisions per group with independent advancement and revoke", async () => {
    const assistantId = await repository.create(ownerId, draft({ name: "Shared" }));
    const publishRevisionOne = await repository.publish({
      actorIsAdmin: false,
      assistantId,
      groupId,
      revisionNumber: null,
      scope: "group",
      userId: ownerId
    });
    expect(publishRevisionOne.kind).toBe("ok");

    const detailBefore = await repository.getDetail(ownerId, assistantId);
    await repository.revise(ownerId, assistantId, detailBefore!.version!, draft({ name: "Shared v2" }));

    // Saving never advances a publication: the member still runs revision 1.
    const memberView = await repository.getDetail(memberId, assistantId);
    expect(memberView?.revision.revisionNumber).toBe(1);
    expect(memberView?.revision.name).toBe("Shared");
    expect(memberView?.publications).toBeNull();
    const memberRun = await repository.resolveForRun(memberId, assistantId);
    expect(memberRun.ok && memberRun.assistant.revisionNumber).toBe(1);

    // Publish update moves the pinned revision explicitly.
    const publishUpdate = await repository.publish({
      actorIsAdmin: false,
      assistantId,
      groupId,
      revisionNumber: null,
      scope: "group",
      userId: ownerId
    });
    expect(publishUpdate.kind === "ok" && publishUpdate.publication.revisionNumber).toBe(2);
    const memberRunAfter = await repository.resolveForRun(memberId, assistantId);
    expect(memberRunAfter.ok && memberRunAfter.assistant.revisionNumber).toBe(2);

    // Publishing to a group without active membership is forbidden.
    const foreignPublish = await repository.publish({
      actorIsAdmin: false,
      assistantId,
      groupId: otherGroupId,
      revisionNumber: null,
      scope: "group",
      userId: ownerId
    });
    expect(foreignPublish.kind).toBe("forbidden");

    // Installation publication is admin-curated.
    const memberInstall = await repository.publish({
      actorIsAdmin: false,
      assistantId,
      groupId: null,
      revisionNumber: null,
      scope: "installation",
      userId: ownerId
    });
    expect(memberInstall.kind).toBe("forbidden");

    const ownerDetail = await repository.getDetail(ownerId, assistantId);
    const publicationId = ownerDetail!.publications![0]!.id;
    expect(
      await repository.revokePublication({
        actorIsAdmin: false,
        assistantId,
        publicationId,
        userId: memberId
      })
    ).toBe("not_found");
    expect(
      await repository.revokePublication({
        actorIsAdmin: false,
        assistantId,
        publicationId,
        userId: ownerId
      })
    ).toBe("revoked");
    expect(await repository.getDetail(memberId, assistantId)).toBeNull();
  });

  it("does not revoke a publication through a mismatched Assistant path parent", async () => {
    const pathAssistantId = await repository.create(
      ownerId,
      draft({ name: "Publication path parent" })
    );
    const publishedAssistantId = await repository.create(
      ownerId,
      draft({ name: "Publication actual parent" })
    );
    const published = await repository.publish({
      actorIsAdmin: false,
      assistantId: publishedAssistantId,
      groupId,
      revisionNumber: null,
      scope: "group",
      userId: ownerId
    });
    if (published.kind !== "ok") throw new Error("assistant_publication_failed");

    await expect(repository.revokePublication({
      actorIsAdmin: false,
      assistantId: pathAssistantId,
      publicationId: published.publication.id,
      userId: ownerId
    })).resolves.toBe("not_found");
    await expect(database.assistantPublication.findUnique({
      select: { assistantId: true },
      where: { id: published.publication.id }
    })).resolves.toEqual({ assistantId: publishedAssistantId });
  });

  it("rechecks the publication path parent after acquiring the Assistant lock", async () => {
    const originalAssistantId = await repository.create(
      ownerId,
      draft({ name: "Publication parent before lock" })
    );
    const movedAssistantId = await repository.create(
      ownerId,
      draft({ name: "Publication parent after lock" })
    );
    const movedRevision = (await repository.getDetail(ownerId, movedAssistantId))!
      .revision.id;
    const published = await repository.publish({
      actorIsAdmin: false,
      assistantId: originalAssistantId,
      groupId,
      revisionNumber: null,
      scope: "group",
      userId: ownerId
    });
    if (published.kind !== "ok") throw new Error("assistant_publication_failed");

    const blocker = new PrismaClient();
    const mover = new PrismaClient();
    const lockReady = deferred<number>();
    const releaseLock = deferred<void>();
    const blockingTransaction = blocker.$transaction(async (tx) => {
      const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`
        SELECT pg_backend_pid() AS "pid"
      `;
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "AssistantDefinition"
        WHERE "id" = ${originalAssistantId}
        FOR UPDATE
      `;
      lockReady.resolve(backend!.pid);
      await releaseLock.promise;
    }, { timeout: 10_000 });

    let revokePromise: ReturnType<typeof repository.revokePublication> | null = null;
    try {
      const blockerPid = await lockReady.promise;
      revokePromise = repository.revokePublication({
        actorIsAdmin: false,
        assistantId: originalAssistantId,
        publicationId: published.publication.id,
        userId: ownerId
      });
      await waitForBlockedBy(blockerPid);
      await mover.assistantPublication.update({
        data: {
          assistantId: movedAssistantId,
          revisionId: movedRevision
        },
        where: { id: published.publication.id }
      });
      releaseLock.resolve();

      await expect(revokePromise).resolves.toBe("not_found");
      await expect(database.assistantPublication.findUnique({
        select: { assistantId: true },
        where: { id: published.publication.id }
      })).resolves.toEqual({ assistantId: movedAssistantId });
    } finally {
      releaseLock.resolve();
      if (revokePromise) await revokePromise.catch(() => undefined);
      await blockingTransaction.catch(() => undefined);
      await blocker.$disconnect();
      await mover.$disconnect();
    }
  });

  it.each(["membership", "group_archive"] as const)(
    "rejects group publication when concurrent %s access loss wins",
    async (mutation) => {
      const assistantId = await repository.create(
        ownerId,
        draft({ name: `Publish access loss ${mutation}` })
      );
      const mutationClient = new PrismaClient();
      const mutationReady = deferred<number>();
      const releaseMutation = deferred<void>();
      const mutationTransaction = mutationClient.$transaction(
        async (tx) => {
          const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`
            SELECT pg_backend_pid() AS "pid"
          `;
          if (mutation === "membership") {
            await tx.userGroup.delete({
              where: { userId_groupId: { groupId, userId: ownerId } }
            });
          } else {
            await tx.group.update({
              data: { archivedAt: new Date() },
              where: { id: groupId }
            });
          }
          mutationReady.resolve(backend!.pid);
          await releaseMutation.promise;
        },
        { timeout: 10_000 }
      );

      let publishPromise: ReturnType<typeof repository.publish> | null = null;
      try {
        const mutationPid = await mutationReady.promise;
        publishPromise = repository.publish({
          actorIsAdmin: false,
          assistantId,
          groupId,
          revisionNumber: null,
          scope: "group",
          userId: ownerId
        });
        const publishState = await Promise.race([
          publishPromise.then(() => "completed" as const),
          waitForBlockedBy(mutationPid).then(() => "blocked" as const)
        ]);
        expect(publishState).toBe("blocked");

        releaseMutation.resolve();
        await mutationTransaction;
        await expect(publishPromise).resolves.toEqual({ kind: "forbidden" });
        await expect(database.assistantPublication.count({
          where: { assistantId }
        })).resolves.toBe(0);
      } finally {
        releaseMutation.resolve();
        await Promise.allSettled([
          ...(publishPromise ? [publishPromise] : []),
          mutationTransaction
        ]);
        await mutationClient.$disconnect();
        if (mutation === "membership") {
          await database.userGroup.upsert({
            create: { groupId, userId: ownerId },
            update: {},
            where: { userId_groupId: { groupId, userId: ownerId } }
          });
        } else {
          await database.group.update({
            data: { archivedAt: null },
            where: { id: groupId }
          });
        }
      }
    }
  );

  it.each(["membership", "group_archive"] as const)(
    "serializes group publication before concurrent %s access loss when publication wins",
    async (mutation) => {
      const assistantId = await repository.create(
        ownerId,
        draft({ name: `Publish lock winner ${mutation}` })
      );
      const blocker = new PrismaClient();
      const mutationClient = new PrismaClient();
      const lockReady = deferred<number>();
      const releaseLock = deferred<void>();
      const blockingTransaction = blocker.$transaction(
        async (tx) => {
          const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`
            SELECT pg_backend_pid() AS "pid"
          `;
          await tx.$executeRaw`LOCK TABLE "AssistantPublication" IN SHARE MODE`;
          lockReady.resolve(backend!.pid);
          await releaseLock.promise;
        },
        { timeout: 10_000 }
      );

      let publishPromise: ReturnType<typeof repository.publish> | null = null;
      let mutationPromise: Promise<unknown> | null = null;
      let mutationState: "blocked" | "committed" | null = null;
      try {
        const blockerPid = await lockReady.promise;
        publishPromise = repository.publish({
          actorIsAdmin: false,
          assistantId,
          groupId,
          revisionNumber: null,
          scope: "group",
          userId: ownerId
        });
        const [blockedPublish] = await waitForBlockedBy(blockerPid);

        mutationPromise = mutation === "membership"
          ? mutationClient.userGroup.delete({
              where: { userId_groupId: { groupId, userId: ownerId } }
            })
          : mutationClient.group.update({
              data: { archivedAt: new Date() },
              where: { id: groupId }
            });
        mutationState = await Promise.race([
          mutationPromise.then(() => "committed" as const),
          waitForBlockedBy(blockedPublish!.pid).then(() => "blocked" as const)
        ]);

        releaseLock.resolve();
        await blockingTransaction;
        await expect(publishPromise).resolves.toMatchObject({ kind: "ok" });
        await mutationPromise;
        expect(mutationState).toBe("blocked");
      } finally {
        releaseLock.resolve();
        await Promise.allSettled([
          ...(publishPromise ? [publishPromise] : []),
          ...(mutationPromise ? [mutationPromise] : []),
          blockingTransaction
        ]);
        await blocker.$disconnect();
        await mutationClient.$disconnect();
        await database.assistantPublication.deleteMany({ where: { assistantId } });
        if (mutation === "membership") {
          await database.userGroup.upsert({
            create: { groupId, userId: ownerId },
            update: {},
            where: { userId_groupId: { groupId, userId: ownerId } }
          });
        } else {
          await database.group.update({
            data: { archivedAt: null },
            where: { id: groupId }
          });
        }
      }
    }
  );

  it("blocks archived assistants from new runs while duplication stays private", async () => {
    const assistantId = await repository.create(ownerId, draft({ name: "Archive target" }));
    await repository.publish({
      actorIsAdmin: false,
      assistantId,
      groupId,
      revisionNumber: null,
      scope: "group",
      userId: ownerId
    });

    const duplicated = await repository.duplicate(memberId, assistantId);
    expect(duplicated.kind).toBe("ok");
    if (duplicated.kind !== "ok") throw new Error("duplicate_not_created");
    const duplicate = await repository.getDetail(memberId, duplicated.assistantId);
    expect(duplicate?.owned).toBe(true);
    expect(duplicate?.revision.name).toBe("Copy of Archive target");
    expect(await repository.getDetail(ownerId, duplicated.assistantId)).toBeNull();

    const detail = await repository.getDetail(ownerId, assistantId);
    const archived = await repository.setArchived(ownerId, assistantId, detail!.version!, true);
    expect(archived.kind).toBe("ok");
    const archivedRun = await repository.resolveForRun(ownerId, assistantId);
    expect(archivedRun.ok).toBe(false);
    expect(await repository.getDetail(memberId, assistantId)).toBeNull();

    const archivedDetail = await repository.getDetail(ownerId, assistantId);
    expect(archivedDetail?.archived).toBe(true);
    const reviseArchived = await repository.revise(
      ownerId,
      assistantId,
      archivedDetail!.version!,
      draft({ name: "Should fail" })
    );
    expect(reviseArchived.kind).toBe("archived");
  });

  it("rejects duplication before creating a private copy when dependencies are hidden", async () => {
    const assistantId = await repository.create(
      ownerId,
      draft({ mcpServerIds: [mcpServerId], name: "Hidden dependency source" })
    );
    await repository.publish({
      actorIsAdmin: false,
      assistantId,
      groupId,
      revisionNumber: null,
      scope: "group",
      userId: ownerId
    });
    const before = await database.assistantDefinition.count({
      where: { ownerUserId: memberId }
    });

    const hiddenModel = await repositoryWithCatalogView(
      duplicateCatalogView({ modelById: new Map() })
    ).duplicate(memberId, assistantId);
    expect(hiddenModel.kind).toBe("model_not_available");

    const hiddenTools = await repository.duplicate(memberId, assistantId);
    expect(hiddenTools.kind).toBe("tools_not_available");
    expect(
      await database.assistantDefinition.count({ where: { ownerUserId: memberId } })
    ).toBe(before);
  });

  it("rejects duplication before creating a private copy when Search is hidden", async () => {
    const assistantId = await repository.create(
      ownerId,
      draft({
        name: "Hidden Search source",
        searchPlan: { mode: "all_selected", optionIds: ["hidden-search"] }
      })
    );
    await repository.publish({
      actorIsAdmin: false,
      assistantId,
      groupId,
      revisionNumber: null,
      scope: "group",
      userId: ownerId
    });
    const before = await database.assistantDefinition.count({
      where: { ownerUserId: memberId }
    });
    const compatibleModel = catalogModel();
    compatibleModel.searchOptionCompatibility = {
      "hidden-search": {
        clientToolCompatible: true,
        executionModes: ["all_selected", "model_choice"]
      }
    };
    compatibleModel.searchStrategyIds = ["hidden-search"];

    const hiddenSearch = await repositoryWithCatalogView(
      duplicateCatalogView({
        entitledSearchOptionIds: new Set(),
        modelById: new Map([[modelId, compatibleModel]])
      })
    ).duplicate(memberId, assistantId);

    expect(hiddenSearch.kind).toBe("search_not_available");
    expect(
      await database.assistantDefinition.count({ where: { ownerUserId: memberId } })
    ).toBe(before);
  });

  it("copies Knowledge ids exactly only when every dependency is independently visible", async () => {
    const publishedBaseId = await createKnowledgeBase(ownerId, "Published knowledge");
    const callerOwnedBaseId = await createKnowledgeBase(memberId, "Caller-owned knowledge");
    const hiddenBaseId = await createKnowledgeBase(ownerId, "Hidden knowledge");
    await database.knowledgeBasePublication.create({
      data: {
        groupId,
        knowledgeBaseId: publishedBaseId,
        publishedByUserId: ownerId,
        scope: "group"
      }
    });

    const sourceId = await repository.create(ownerId, draft({
      knowledgeBaseIds: [callerOwnedBaseId, publishedBaseId],
      name: "Visible Knowledge source"
    }));
    await repository.publish({
      actorIsAdmin: false,
      assistantId: sourceId,
      groupId,
      revisionNumber: null,
      scope: "group",
      userId: ownerId
    });

    const copied = await repository.duplicate(memberId, sourceId);
    expect(copied.kind).toBe("ok");
    if (copied.kind !== "ok") throw new Error("knowledge_duplicate_not_created");
    expect((await repository.getDetail(memberId, copied.assistantId))?.revision.knowledgeBaseIds)
      .toEqual([callerOwnedBaseId, publishedBaseId]);

    const hiddenSourceId = await repository.create(ownerId, draft({
      knowledgeBaseIds: [publishedBaseId, hiddenBaseId],
      name: "Mixed Knowledge source"
    }));
    await repository.publish({
      actorIsAdmin: false,
      assistantId: hiddenSourceId,
      groupId,
      revisionNumber: null,
      scope: "group",
      userId: ownerId
    });
    const beforeDefinitions = await database.assistantDefinition.count({
      where: { ownerUserId: memberId }
    });
    const beforeRevisions = await database.assistantRevision.count({
      where: { assistant: { ownerUserId: memberId } }
    });

    await expect(repository.duplicate(memberId, hiddenSourceId)).resolves.toEqual({
      kind: "knowledge_not_available"
    });
    expect(await database.assistantDefinition.count({ where: { ownerUserId: memberId } }))
      .toBe(beforeDefinitions);
    expect(await database.assistantRevision.count({
      where: { assistant: { ownerUserId: memberId } }
    })).toBe(beforeRevisions);

    const missingSourceId = await repository.create(ownerId, draft({
      knowledgeBaseIds: [publishedBaseId, randomUUID()],
      name: "Missing Knowledge source"
    }));
    await repository.publish({
      actorIsAdmin: false,
      assistantId: missingSourceId,
      groupId,
      revisionNumber: null,
      scope: "group",
      userId: ownerId
    });
    await expect(repository.duplicate(memberId, missingSourceId)).resolves.toEqual({
      kind: "knowledge_not_available"
    });
    expect(await database.assistantDefinition.count({ where: { ownerUserId: memberId } }))
      .toBe(beforeDefinitions);
    expect(await database.assistantRevision.count({
      where: { assistant: { ownerUserId: memberId } }
    })).toBe(beforeRevisions);
  });

  it("fails atomically when Knowledge publication, membership, or archive access wins the race", async () => {
    const baseId = await createKnowledgeBase(ownerId, "Racing knowledge");
    let publication = await database.knowledgeBasePublication.create({
      data: {
        groupId,
        knowledgeBaseId: baseId,
        publishedByUserId: ownerId,
        scope: "group"
      }
    });
    const sourceId = await repository.create(ownerId, draft({
      knowledgeBaseIds: [baseId],
      name: "Racing Knowledge source"
    }));
    await repository.publish({
      actorIsAdmin: true,
      assistantId: sourceId,
      groupId: null,
      revisionNumber: null,
      scope: "installation",
      userId: ownerId
    });
    const before = await database.assistantDefinition.count({ where: { ownerUserId: memberId } });
    const knowledgeRepository = createPrismaKnowledgeRepository(database);

    const afterRevoke = await duplicateAfterCommittedMutation(sourceId, async () => {
      await knowledgeRepository.revokePublication({
        actorIsAdmin: false,
        knowledgeBaseId: baseId,
        publicationId: publication.id,
        userId: ownerId
      });
    });
    expect(afterRevoke.kind).toBe("knowledge_not_available");
    expect(await database.assistantDefinition.count({ where: { ownerUserId: memberId } }))
      .toBe(before);
    publication = await database.knowledgeBasePublication.create({
      data: {
        groupId,
        knowledgeBaseId: baseId,
        publishedByUserId: ownerId,
        scope: "group"
      }
    });

    const afterMembershipLoss = await duplicateAfterCommittedMutation(sourceId, async () => {
      await database.userGroup.delete({
        where: { userId_groupId: { groupId, userId: memberId } }
      });
    });
    expect(afterMembershipLoss.kind).toBe("knowledge_not_available");
    expect(await database.assistantDefinition.count({ where: { ownerUserId: memberId } }))
      .toBe(before);
    await database.userGroup.create({ data: { groupId, userId: memberId } });

    const afterGroupArchive = await duplicateAfterCommittedMutation(sourceId, async () => {
      await database.group.update({ data: { archivedAt: new Date() }, where: { id: groupId } });
    });
    expect(afterGroupArchive.kind).toBe("knowledge_not_available");
    expect(await database.assistantDefinition.count({ where: { ownerUserId: memberId } }))
      .toBe(before);
    await database.group.update({ data: { archivedAt: null }, where: { id: groupId } });

    const afterArchive = await duplicateAfterCommittedMutation(sourceId, async () => {
      await database.knowledgeBase.update({ data: { archivedAt: new Date() }, where: { id: baseId } });
    });
    expect(afterArchive.kind).toBe("knowledge_not_available");
    expect(await database.assistantDefinition.count({ where: { ownerUserId: memberId } }))
      .toBe(before);
    await database.knowledgeBase.update({ data: { archivedAt: null }, where: { id: baseId } });
  });

  it("takes Knowledge bases before groups so concurrent publication cannot deadlock", async () => {
    const baseId = await createKnowledgeBase(memberId, "Lock-order knowledge");
    const sourceId = await repository.create(ownerId, draft({
      knowledgeBaseIds: [baseId],
      name: "Lock-order source"
    }));
    await repository.publish({
      actorIsAdmin: false,
      assistantId: sourceId,
      groupId,
      revisionNumber: null,
      scope: "group",
      userId: ownerId
    });

    const blocker = new PrismaClient();
    const publisherClient = new PrismaClient();
    const duplicateClient = new PrismaClient();
    const probe = new PrismaClient();
    const publisher = createPrismaKnowledgeRepository(publisherClient);
    const duplicateRepository = createPrismaAssistantRepository(duplicateClient, {
      isMcpGenerationLive: (generationId) => liveMcpGenerations.has(generationId),
      loadCatalogView: async () => duplicateCatalogView()
    });
    const lockReady = deferred<number>();
    const releaseLock = deferred<void>();
    const blockingTransaction = blocker.$transaction(async (tx) => {
      const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`
        SELECT pg_backend_pid() AS "pid"
      `;
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "KnowledgeBase"
        WHERE "id" = ${baseId}
        FOR UPDATE
      `;
      lockReady.resolve(backend!.pid);
      await releaseLock.promise;
    }, { timeout: 10_000 });

    let publishPromise: ReturnType<typeof publisher.publish> | null = null;
    let duplicatePromise: ReturnType<typeof duplicateRepository.duplicate> | null = null;
    try {
      const blockerPid = await lockReady.promise;
      publishPromise = publisher.publish({
        actorIsAdmin: false,
        groupId,
        knowledgeBaseId: baseId,
        scope: "group",
        userId: memberId
      });
      const [blockedPublisher] = await waitForBlockedBy(blockerPid);
      duplicatePromise = duplicateRepository.duplicate(memberId, sourceId);
      await waitForBlockedBy(blockedPublisher!.pid);

      // While both operations wait on the base, duplication must not already
      // own the shared Group row. This is the deterministic regression proof
      // for the former group -> base inversion.
      await probe.$transaction((tx) => tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "Group"
        WHERE "id" = ${groupId}
        FOR UPDATE NOWAIT
      `);

      releaseLock.resolve();
      const [published, duplicated] = await Promise.all([
        publishPromise,
        duplicatePromise
      ]);
      expect(published.kind).toBe("ok");
      expect(duplicated.kind).toBe("ok");
    } finally {
      releaseLock.resolve();
      await Promise.allSettled([
        blockingTransaction,
        ...(publishPromise ? [publishPromise] : []),
        ...(duplicatePromise ? [duplicatePromise] : [])
      ]);
      await blocker.$disconnect();
      await publisherClient.$disconnect();
      await duplicateClient.$disconnect();
      await probe.$disconnect();
    }
  });

  it("does not combine stale dependency entitlement with later source access", async () => {
    const assistantId = await repository.create(
      ownerId,
      draft({ name: "No joint authorization instant" })
    );
    const grant = await database.accessGrant.create({
      data: { providerModelId: modelId, userId: memberId }
    });
    const atomicOptions = {
      isMcpGenerationLive: (generationId: string) =>
        liveMcpGenerations.has(generationId),
      loadCatalogView: async (
        tx: Pick<PrismaClient, "accessGrant">,
        userId: string
      ) => {
        const currentGrant = await tx.accessGrant.findFirst({
          select: { id: true },
          where: { enabled: true, providerModelId: modelId, userId }
        });
        return currentGrant
          ? duplicateCatalogView()
          : duplicateCatalogView({ modelById: new Map() });
      }
    };
    const atomicRepository = createPrismaAssistantRepository(database, atomicOptions);
    expect(
      (await atomicOptions.loadCatalogView(database, memberId))?.modelById.has(modelId)
    ).toBe(true);
    await database.accessGrant.delete({ where: { id: grant.id } });
    await repository.publish({
      actorIsAdmin: false,
      assistantId,
      groupId,
      revisionNumber: null,
      scope: "group",
      userId: ownerId
    });
    const before = await database.assistantDefinition.count({
      where: { ownerUserId: memberId }
    });

    const duplicated = await atomicRepository.duplicate(memberId, assistantId);

    expect(duplicated.kind).toBe("model_not_available");
    expect(
      await database.assistantDefinition.count({ where: { ownerUserId: memberId } })
    ).toBe(before);
  });

  it("creates no copy when membership loss, group archive, or revoke commits before duplicate validation", async () => {
    const assistantId = await repository.create(ownerId, draft({ name: "Access loss source" }));
    const published = await repository.publish({
      actorIsAdmin: false,
      assistantId,
      groupId,
      revisionNumber: null,
      scope: "group",
      userId: ownerId
    });
    if (published.kind !== "ok") throw new Error("assistant_publication_failed");
    const before = await database.assistantDefinition.count({
      where: { ownerUserId: memberId }
    });

    await database.userGroup.delete({
      where: { userId_groupId: { groupId, userId: memberId } }
    });
    try {
      const afterMembershipLoss = await repository.duplicate(memberId, assistantId);
      expect(afterMembershipLoss.kind).toBe("not_found");
      expect(
        await database.assistantDefinition.count({ where: { ownerUserId: memberId } })
      ).toBe(before);
    } finally {
      await database.userGroup.upsert({
        create: { groupId, userId: memberId },
        update: {},
        where: { userId_groupId: { groupId, userId: memberId } }
      });
    }

    await database.group.update({
      data: { archivedAt: new Date() },
      where: { id: groupId }
    });
    try {
      const afterGroupArchive = await repository.duplicate(memberId, assistantId);
      expect(afterGroupArchive.kind).toBe("not_found");
      expect(
        await database.assistantDefinition.count({ where: { ownerUserId: memberId } })
      ).toBe(before);
    } finally {
      await database.group.update({ data: { archivedAt: null }, where: { id: groupId } });
    }

    await repository.revokePublication({
      actorIsAdmin: false,
      assistantId,
      publicationId: published.publication.id,
      userId: ownerId
    });
    const afterRevoke = await repository.duplicate(memberId, assistantId);
    expect(afterRevoke.kind).toBe("not_found");
    expect(
      await database.assistantDefinition.count({ where: { ownerUserId: memberId } })
    ).toBe(before);
  });

  it("lets a duplicate that wins source locks finish before revoke, membership loss, and group archive", async () => {
    const assistantId = await repository.create(ownerId, draft({ name: "Locked copy source" }));
    const published = await repository.publish({
      actorIsAdmin: false,
      assistantId,
      groupId,
      revisionNumber: null,
      scope: "group",
      userId: ownerId
    });
    if (published.kind !== "ok") throw new Error("assistant_publication_failed");

    const blocker = new PrismaClient();
    const groupArchiveClient = new PrismaClient();
    const membershipClient = new PrismaClient();
    const revokeClient = new PrismaClient();
    const revokeRepository = createPrismaAssistantRepository(revokeClient);
    const lockReady = deferred<number>();
    const releaseLock = deferred<void>();
    const blockingTransaction = blocker.$transaction(
      async (tx) => {
        const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`
          SELECT pg_backend_pid() AS "pid"
        `;
        await tx.$executeRaw`LOCK TABLE "AssistantDefinition" IN SHARE MODE`;
        lockReady.resolve(backend!.pid);
        await releaseLock.promise;
      },
      { timeout: 10_000 }
    );

    let duplicatePromise: ReturnType<typeof repository.duplicate> | null = null;
    let groupArchivePromise: Promise<
      Awaited<ReturnType<typeof database.group.update>>
    > | null = null;
    let membershipLossPromise: Promise<
      Awaited<ReturnType<typeof database.userGroup.delete>>
    > | null = null;
    let revokePromise: ReturnType<typeof repository.revokePublication> | null = null;
    try {
      const blockerPid = await lockReady.promise;
      duplicatePromise = repository.duplicate(memberId, assistantId);
      const [blockedDuplicate] = await waitForBlockedBy(blockerPid);

      membershipLossPromise = membershipClient.userGroup
        .delete({ where: { userId_groupId: { groupId, userId: memberId } } })
        .then((membership) => membership);
      await waitForBlockedBy(blockedDuplicate!.pid);
      groupArchivePromise = groupArchiveClient.group
        .update({ data: { archivedAt: new Date() }, where: { id: groupId } })
        .then((group) => group);
      await waitForBlockedBy(blockedDuplicate!.pid, 2);
      revokePromise = revokeRepository.revokePublication({
        actorIsAdmin: false,
        assistantId,
        publicationId: published.publication.id,
        userId: ownerId
      });
      await waitForBlockedBy(blockedDuplicate!.pid, 3);

      releaseLock.resolve();
      const [duplicated, revoked] = await Promise.all([
        duplicatePromise,
        revokePromise
      ]);
      await Promise.all([membershipLossPromise, groupArchivePromise]);
      expect(duplicated.kind).toBe("ok");
      expect(revoked).toBe("revoked");
      if (duplicated.kind !== "ok") throw new Error("duplicate_not_created");
      expect(await repository.getDetail(memberId, duplicated.assistantId)).toMatchObject({
        owned: true,
        revision: { name: "Copy of Locked copy source" }
      });
      expect(await repository.getDetail(memberId, assistantId)).toBeNull();
    } finally {
      releaseLock.resolve();
      const pending: unknown[] = [];
      if (duplicatePromise) pending.push(duplicatePromise);
      if (groupArchivePromise) pending.push(groupArchivePromise);
      if (membershipLossPromise) pending.push(membershipLossPromise);
      if (revokePromise) pending.push(revokePromise);
      await Promise.allSettled(pending);
      await blockingTransaction.catch(() => undefined);
      await blocker.$disconnect();
      await groupArchiveClient.$disconnect();
      await membershipClient.$disconnect();
      await revokeClient.$disconnect();
      await database.userGroup.upsert({
        create: { groupId, userId: memberId },
        update: {},
        where: { userId_groupId: { groupId, userId: memberId } }
      });
      await database.group.update({ data: { archivedAt: null }, where: { id: groupId } });
    }
  });

  it("reports the authorization scope that selected the highest runnable revision", async () => {
    const assistantId = await repository.create(ownerId, draft({ name: "Scoped revision one" }));
    await repository.publish({
      actorIsAdmin: false,
      assistantId,
      groupId,
      revisionNumber: null,
      scope: "group",
      userId: ownerId
    });
    const detail = await repository.getDetail(ownerId, assistantId);
    await repository.revise(
      ownerId,
      assistantId,
      detail!.version!,
      draft({ name: "Scoped revision two" })
    );
    await repository.publish({
      actorIsAdmin: true,
      assistantId,
      groupId: null,
      revisionNumber: null,
      scope: "installation",
      userId: ownerId
    });

    const entry = (await repository.listForUser(memberId)).find(
      (candidate) => candidate.id === assistantId
    );
    expect(entry).toMatchObject({
      installationScope: true,
      memberGroupNames: [],
      revision: { revisionNumber: 2 }
    });
  });

  it("distinguishes granted MCP identities from enabled ready runtimes", async () => {
    await database.mcpServer.create({
      data: {
        displayName: "Assistant MCP",
        enabled: true,
        id: mcpServerId,
        namespace: `assistant_${suffix.replaceAll("-", "_")}`
      }
    });
    await database.mcpRevision.create({
      data: {
        configuration: {},
        draftHash: `draft-${suffix}`,
        id: mcpRevisionId,
        identityHash: `identity-${suffix}`,
        revisionNumber: 1,
        serverId: mcpServerId,
        validationEvidence: {}
      }
    });
    await database.mcpServer.update({
      data: { activeRevisionId: mcpRevisionId },
      where: { id: mcpServerId }
    });
    await database.mcpGrant.create({
      data: { canUse: true, serverId: mcpServerId, userId: memberId }
    });
    await database.mcpUserServer.create({
      data: {
        enabled: false,
        id: mcpUserServerId,
        serverId: mcpServerId,
        userId: memberId
      }
    });

    await expect(repository.loadUserAccessibleMcpServerIds(memberId)).resolves.toEqual(
      new Set([mcpServerId])
    );
    await expect(repository.loadUserRunnableMcpServerIds(memberId)).resolves.toEqual(
      new Set()
    );

    await database.mcpRuntimeGeneration.create({
      data: {
        fingerprint: suffix.replaceAll("-", "").repeat(2),
        id: mcpGenerationId,
        inventory: { tools: [], version: 1 },
        inventoryUpdatedAt: new Date(),
        revisionId: mcpRevisionId,
        state: "ready",
        userServerId: mcpUserServerId
      }
    });
    await database.mcpUserServer.update({
      data: { desiredRuntimeGenerationId: mcpGenerationId, enabled: true },
      where: { id: mcpUserServerId }
    });
    // A persisted `ready` generation from a prior process is not runnable.
    await expect(repository.loadUserRunnableMcpServerIds(memberId)).resolves.toEqual(
      new Set()
    );
    liveMcpGenerations.add(mcpGenerationId);
    await expect(repository.loadUserRunnableMcpServerIds(memberId)).resolves.toEqual(
      new Set([mcpServerId])
    );

    await database.mcpRuntimeGeneration.update({
      data: { inventory: { tools: [{ name: "missing strict tool fields" }], version: 1 } },
      where: { id: mcpGenerationId }
    });
    await expect(repository.loadUserRunnableMcpServerIds(memberId)).resolves.toEqual(
      new Set()
    );
    await database.mcpRuntimeGeneration.update({
      data: { inventory: { tools: [], version: 1 }, state: "failed" },
      where: { id: mcpGenerationId }
    });
    await expect(repository.loadUserRunnableMcpServerIds(memberId)).resolves.toEqual(
      new Set()
    );
    liveMcpGenerations.delete(mcpGenerationId);
  });

  it("stores pins per user without granting or leaking access", async () => {
    const assistantId = await repository.create(ownerId, draft({ name: "Pin target" }));
    await repository.publish({
      actorIsAdmin: false,
      assistantId,
      groupId,
      revisionNumber: null,
      scope: "group",
      userId: ownerId
    });

    expect(await repository.setPinned(memberId, assistantId, true)).toBe(true);
    expect(await repository.setPinned(outsiderId, assistantId, true)).toBe(false);

    const memberList = await repository.listForUser(memberId);
    const pinnedEntry = memberList.find((entry) => entry.id === assistantId);
    expect(pinnedEntry?.pinned).toBe(true);
    const outsiderList = await repository.listForUser(outsiderId);
    expect(outsiderList.some((entry) => entry.id === assistantId)).toBe(false);

    expect(await repository.setPinned(memberId, assistantId, false)).toBe(true);
  });
});

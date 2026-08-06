import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AssistantDraft } from "../../contracts/assistants";
import { createPrismaAssistantRepository } from "./prismaRepository";

const enabled = process.env.AIQSA_ASSISTANTS_INTEGRATION_TEST === "1";
const integration = enabled ? describe : describe.skip;
const database = new PrismaClient();
const repository = createPrismaAssistantRepository(database);
const suffix = randomUUID();

const ownerId = `assistant-owner-${suffix}`;
const memberId = `assistant-member-${suffix}`;
const outsiderId = `assistant-outsider-${suffix}`;
const groupId = `assistant-group-${suffix}`;
const otherGroupId = `assistant-group-b-${suffix}`;
const connectionId = `assistant-connection-${suffix}`;
const modelId = `assistant-model-${suffix}`;

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
        publicationId,
        userId: memberId
      })
    ).toBe("not_found");
    expect(
      await repository.revokePublication({
        actorIsAdmin: false,
        publicationId,
        userId: ownerId
      })
    ).toBe("revoked");
    expect(await repository.getDetail(memberId, assistantId)).toBeNull();
  });

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

    const duplicateId = await repository.duplicate(memberId, assistantId);
    expect(duplicateId).not.toBeNull();
    const duplicate = await repository.getDetail(memberId, duplicateId!);
    expect(duplicate?.owned).toBe(true);
    expect(duplicate?.revision.name).toBe("Copy of Archive target");
    expect(await repository.getDetail(ownerId, duplicateId!)).toBeNull();

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

import { randomInt, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createQueryCountingClient } from "@/tests/support/prismaQueryLog";
import {
  assistantRowsFromLegacyFields,
  decodeAssistantDetailResponse,
  decodeAssistantListResponse,
  type AssistantDetailResponse,
  type AssistantDraft,
  type AssistantListResponse,
  type AssistantRows
} from "../../contracts/assistants";
import { prisma } from "../prisma";
import { createPrismaProjectRepository } from "../projects/prismaRepository";
import { createPrismaSkillRepository } from "../skills/prismaRepository";
import { createSkillSharingService } from "../skills/shareRequests";
import { assertAssistantRunProvenance } from "../runs/prismaRepositoryBindings";
import { createAssistantListingService } from "./listingRequests";
import type { CatalogData } from "../catalog/currentUserCatalog";
import { createGetAssistantHandler, createListAssistantsHandler } from "./handlers";
import { loadFeaturedAssistantOrders } from "./listedAssistants";
import { createPrismaAssistantRepository } from "./prismaRepository";
import { loadPersonalAssistantRowContext } from "./rowContext";

const catalogDataWithoutModels: CatalogData = {
  entitlements: { modelKeys: new Set(), providerKeys: new Set(), searchStrategies: new Set() },
  models: [],
  searchStrategies: [],
  settings: {
    defaultControlValues: {}, defaultProviderModelId: null, defaultSearchPlan: null,
    showCitations: true, showReasoningBlocks: false
  }
};

function assistantDraft(providerModelId: string, skillIds: string[]): AssistantDraft {
  return {
    avatar: {
      accents: [0, 4],
      backgroundShape: "circle",
      foregroundShape: "diamond",
      kind: "generated",
      paletteId: "ocean",
      recipeVersion: 1,
      rotations: [0, 2]
    },
    answerRules: null,
    category: "analysis",
    description: "Uses an ordered workflow.",
    name: "Workflow assistant",
    responseReminder: "",
    rows: assistantRowsFromLegacyFields({
      knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
      mcpServerIds: [],
      providerModelId,
      runControls: {},
      searchPlan: { mode: "all_selected", optionIds: [] },
      skillIds
    }),
    starterPrompts: [],
    systemPrompt: "Follow the included workflows."
  };
}

describe("Prisma Assistant Skill links", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("keeps ordered live links, enforces publication audiences, and detaches on delete", async () => {
    const suffix = randomUUID();
    const ownerUserId = `assistant-skill-owner-${suffix}`;
    const memberUserId = `assistant-skill-member-${suffix}`;
    const providerConnectionId = `assistant-skill-connection-${suffix}`;
    const providerModelId = `assistant-skill-model-${suffix}`;
    const group = await prisma.group.create({
      data: { name: `Assistant Skill Workspace ${suffix}` }
    });
    const skillIds: string[] = [];
    let assistantId: string | null = null;
    let knowledgeBaseId: string | null = null;

    await prisma.user.createMany({
      data: [{
        displayName: "Assistant Skill owner",
        id: ownerUserId,
        status: "active"
      }, {
        displayName: "Assistant Skill member",
        id: memberUserId,
        status: "active"
      }]
    });
    await prisma.userGroup.createMany({
      data: [
        { groupId: group.id, userId: ownerUserId },
        { groupId: group.id, userId: memberUserId }
      ]
    });
    await prisma.providerConnection.create({
      data: {
        displayName: "Assistant Skill test provider",
        family: "test",
        id: providerConnectionId
      }
    });
    await prisma.providerModel.create({
      data: {
        capabilities: {},
        connectionId: providerConnectionId,
        defaultParams: {},
        displayName: "Assistant Skill test model",
        id: providerModelId,
        modelId: `model-${suffix}`,
        provider: "test"
      }
    });

    try {
      const skillRepository = createPrismaSkillRepository(prisma);
      const assistantRepository = createPrismaAssistantRepository(prisma);
      const firstSkillId = await skillRepository.create(ownerUserId, {
        description: "Ends with next actions.",
        instructions: "End with a short action list.",
        name: "Action closer"
      });
      const liveSkillId = await skillRepository.create(ownerUserId, {
        description: "Checks claims.",
        instructions: "Verify every factual claim.",
        name: "Careful reviewer"
      });
      skillIds.push(firstSkillId, liveSkillId);

      await expect(skillRepository.publish({
        actorIsAdmin: false,
        groupId: group.id,
        scope: "group",
        skillId: firstSkillId,
        userId: ownerUserId
      })).resolves.toMatchObject({ kind: "ok" });

      const created = await assistantRepository.create(
        ownerUserId,
        assistantDraft(providerModelId, [liveSkillId, firstSkillId])
      );
      expect(created.kind).toBe("ok");
      if (created.kind !== "ok") throw new Error("assistant_skill_fixture_create_failed");
      assistantId = created.assistantId;

      await expect(prisma.assistantSkill.findMany({
        orderBy: { ordinal: "asc" },
        select: { ordinal: true, skillId: true },
        where: { assistantId }
      })).resolves.toEqual([
        { ordinal: 0, skillId: liveSkillId },
        { ordinal: 1, skillId: firstSkillId }
      ]);
      await expect(assistantRepository.resolveForRun(ownerUserId, assistantId)).resolves.toMatchObject({
        assistant: { skillIds: [liveSkillId, firstSkillId] },
        ok: true
      });

      await expect(assistantRepository.publish({
        actorIsAdmin: false,
        assistantId,
        groupId: group.id,
        scope: "group",
        userId: ownerUserId
      })).resolves.toEqual({ kind: "skill_audience_mismatch", skillNames: ["Careful reviewer", "Action closer"] });

      const livePublication = await skillRepository.publish({
        actorIsAdmin: false,
        groupId: group.id,
        scope: "group",
        skillId: liveSkillId,
        userId: ownerUserId
      });
      expect(livePublication.kind).toBe("ok");

      // Audience rows alone cannot publish an Assistant dependency before
      // those Skill revisions have been reviewed.
      await expect(assistantRepository.publish({ actorIsAdmin: false, assistantId,
        groupId: group.id, scope: "group", userId: ownerUserId }))
        .resolves.toEqual({ kind: "skill_audience_mismatch", skillNames: ["Careful reviewer", "Action closer"] });
      await prisma.user.update({ where: { id: ownerUserId }, data: { role: "admin" } });
      for (const skillId of [firstSkillId, liveSkillId]) {
        await createSkillSharingService(prisma).request(ownerUserId, skillId, 1);
      }

      const published = await assistantRepository.publish({
        actorIsAdmin: false,
        assistantId,
        groupId: group.id,
        scope: "group",
        userId: ownerUserId
      });
      expect(published.kind).toBe("ok");
      if (published.kind !== "ok") throw new Error("assistant_skill_fixture_publish_failed");

      const version = (await prisma.assistantDefinition.findUniqueOrThrow({ where: { id: assistantId } })).version;
      const base = assistantDraft(providerModelId, [liveSkillId, firstSkillId]);
      const edited: AssistantDraft = { ...base,
        rows: { ...base.rows, skills: { policy: "fixed", value: { links: [
          { delivery: "on_demand", skillId: liveSkillId }, { delivery: "always", skillId: firstSkillId }
        ], mode: "off" } } },
        name: "Updated workflow", systemPrompt: "Use the updated workflow.", responseReminder: "End with a next step." };
      await expect(assistantRepository.update(ownerUserId, assistantId, version, edited))
        .resolves.toEqual({ assistantId, kind: "ok" });
      await expect(assistantRepository.resolveForRun(memberUserId, assistantId)).resolves.toMatchObject({
        ok: true, assistant: { name: "Updated workflow", systemPrompt: "Use the updated workflow.", responseReminder: "End with a next step.",
          skills: { mode: "off" }, skillModes: { [liveSkillId]: "available", [firstSkillId]: "pinned" },
          identity: { name: "Updated workflow" } }
      });
      await expect(assistantRepository.update(ownerUserId, assistantId, version, edited))
        .resolves.toEqual({ kind: "version_conflict" });

      const privateSkill = await skillRepository.create(ownerUserId, {
        name: "Private workflow", description: "Private synthetic procedure", instructions: "Private instructions"
      });
      skillIds.push(privateSkill);
      const currentVersion = (await prisma.assistantDefinition.findUniqueOrThrow({ where: { id: assistantId } })).version;
      await expect(assistantRepository.update(ownerUserId, assistantId, currentVersion,
        { ...edited, rows: { ...edited.rows, skills: { policy: "fixed", value: {
          links: [{ delivery: "always", skillId: privateSkill }], mode: "auto" } } } }))
        .resolves.toEqual({ kind: "skill_audience_mismatch" });
      expect((await prisma.assistantDefinition.findUniqueOrThrow({ where: { id: assistantId } })).version)
        .toBe(currentVersion);

      const memberAssistant = await assistantRepository.resolveForRun(memberUserId, assistantId);
      expect(memberAssistant).toMatchObject({
        assistant: { skillIds: [liveSkillId, firstSkillId] },
        ok: true
      });
      if (!memberAssistant.ok) throw new Error("assistant_skill_fixture_resolution_failed");
      // A complete materialization can be admitted only while its version is
      // current. A concurrent editor waits for an accepted transaction's lock.
      const admission = { assistantId, definitionVersion: memberAssistant.assistant.definitionVersion,
        userId: memberUserId };
      let concurrentEdit: ReturnType<typeof assistantRepository.update> | undefined;
      await prisma.$transaction(async (tx) => {
        await assertAssistantRunProvenance(tx, admission);
        concurrentEdit = assistantRepository.update(ownerUserId, assistantId!, admission.definitionVersion,
          { ...edited, name: "Concurrent identity", systemPrompt: "Concurrent instructions" });
        await expect(tx.assistantDefinition.findUniqueOrThrow({ where: { id: assistantId! } }))
          .resolves.toMatchObject({ name: "Updated workflow", systemPrompt: "Use the updated workflow." });
      });
      await expect(concurrentEdit).resolves.toEqual({ kind: "ok", assistantId });
      await expect(prisma.$transaction((tx) => assertAssistantRunProvenance(tx, admission)))
        .rejects.toThrow("assistant_not_available");
      await expect(assistantRepository.resolveForRun(memberUserId, assistantId)).resolves.toMatchObject({
        ok: true, assistant: { identity: { name: "Concurrent identity" },
          systemPrompt: "Concurrent instructions", skillIds: [liveSkillId, firstSkillId] }
      });
      await expect(assistantRepository.listForUser(memberUserId)).resolves.toEqual([
        expect.objectContaining({ id: assistantId, content: expect.objectContaining({ name: "Concurrent identity" }) })
      ]);
      await expect(assistantRepository.getDetail(memberUserId, assistantId)).resolves.toMatchObject({
        dependencyAvailability: { knowledge: "ready", skills: true },
        content: {
          responseReminder: "End with a next step.",
          skillIds: [liveSkillId, firstSkillId],
          skillSummaries: [
            { id: liveSkillId, name: "Careful reviewer" },
            { id: firstSkillId, name: "Action closer" }
          ]
        }
      });
      const liveSkillVersion = (await skillRepository.getForUser(ownerUserId, liveSkillId))!.version;
      await expect(skillRepository.setArchived(ownerUserId, liveSkillId, liveSkillVersion, true)).resolves.toMatchObject({ kind: "ok" });
      for (const userId of [ownerUserId, memberUserId]) {
        expect((await assistantRepository.listForUser(userId)).find((entry) => entry.id === assistantId)?.dependencyAvailability?.skills).toBe(false);
        expect((await assistantRepository.getDetail(userId, assistantId))?.dependencyAvailability?.skills).toBe(false);
        // The definition still resolves; admission's row chain finds the link
        // unusable and answers the neutral conflict.
        expect((await assistantRepository.resolveForRun(userId, assistantId)).ok).toBe(true);
        const context = await loadPersonalAssistantRowContext(prisma, {
          ids: { knowledgeBaseIds: [], knowledgeSourceIds: [], skillIds: [liveSkillId, firstSkillId] },
          userId
        }, { loadCatalogData: async () => catalogDataWithoutModels });
        expect(context?.available.skillIds).toEqual(new Set([firstSkillId]));
      }
      expect((await assistantRepository.getDetail(memberUserId, assistantId))?.content.skillSummaries)
        .toEqual([{ id: firstSkillId, name: "Action closer", available: true, mode: "pinned", instructionApproxTokens: 8 }]);
      await expect(skillRepository.setArchived(ownerUserId, liveSkillId, liveSkillVersion + 1, false)).resolves.toMatchObject({ kind: "ok" });
      expect((await assistantRepository.getDetail(memberUserId, assistantId))?.dependencyAvailability?.skills).toBe(true);

      const revoked = await prisma.skillPublication.findUniqueOrThrow({ where: { id: livePublication.kind === "ok" ? livePublication.id : "" } });
      await prisma.skillPublication.delete({ where: { id: revoked.id } });
      expect((await assistantRepository.getDetail(memberUserId, assistantId))?.dependencyAvailability?.skills).toBe(false);
      expect((await assistantRepository.getDetail(memberUserId, assistantId))?.content.skillSummaries)
        .toEqual([{ id: firstSkillId, name: "Action closer", available: true, mode: "pinned", instructionApproxTokens: 8 }]);
      await prisma.skillPublication.create({ data: revoked });
      expect((await assistantRepository.getDetail(memberUserId, assistantId))?.dependencyAvailability?.skills).toBe(true);
      const beforeEdit = await skillRepository.resolveForRun(
        memberUserId,
        memberAssistant.assistant.skillIds
      );
      expect(beforeEdit).toMatchObject({
        ok: true,
        skills: [{ instructions: "Verify every factual claim." }, { skillId: firstSkillId }]
      });
      if (!beforeEdit.ok) throw new Error("assistant_skill_fixture_skill_resolution_failed");
      const acceptedLiveRevisionId = beforeEdit.skills[0]!.revisionId;

      const editableSkillVersion = (await skillRepository.getForUser(ownerUserId, liveSkillId))!.version;
      await expect(skillRepository.revise(ownerUserId, liveSkillId, editableSkillVersion, {
        description: "Checks claims and sources.",
        instructions: "Verify every factual claim and cite its source.",
        name: "Careful reviewer"
      })).resolves.toEqual({ kind: "ok", skillId: liveSkillId });
      await expect(skillRepository.resolveForRun(memberUserId, [liveSkillId])).resolves.toMatchObject({
        skills: [{ revisionId: acceptedLiveRevisionId, instructions: "Verify every factual claim." }]
      });
      await createSkillSharingService(prisma).request(ownerUserId, liveSkillId, editableSkillVersion + 1);
      const afterEditAssistant = await assistantRepository.resolveForRun(memberUserId, assistantId);
      expect(afterEditAssistant).toMatchObject({
        assistant: { skillIds: [liveSkillId, firstSkillId] },
        ok: true
      });
      if (!afterEditAssistant.ok) throw new Error("assistant_skill_fixture_resolution_failed");
      const afterEdit = await skillRepository.resolveForRun(
        memberUserId,
        afterEditAssistant.assistant.skillIds
      );
      expect(afterEdit).toMatchObject({
        ok: true,
        skills: [
          { instructions: "Verify every factual claim and cite its source." },
          { skillId: firstSkillId }
        ]
      });
      if (!afterEdit.ok) throw new Error("assistant_skill_fixture_skill_resolution_failed");
      expect(afterEdit.skills[0]!.revisionId).not.toBe(acceptedLiveRevisionId);
      await expect(skillRepository.getForUser(ownerUserId, liveSkillId)).resolves.toMatchObject({
        assistantUsageCount: 1
      });

      await expect(skillRepository.revokePublication({
        actorIsAdmin: false,
        publicationId: livePublication.kind === "ok" ? livePublication.id : "",
        skillId: liveSkillId,
        userId: ownerUserId
      })).resolves.toBe("dependency_conflict");
      await expect(assistantRepository.revokePublication({
        actorIsAdmin: false,
        assistantId,
        publicationId: published.publication.id,
        userId: ownerUserId
      })).resolves.toBe("revoked");
      await expect(assistantRepository.resolveForRun(memberUserId, assistantId))
        .resolves.toMatchObject({ ok: false, code: "assistant_not_available" });
      await expect(skillRepository.revokePublication({
        actorIsAdmin: false,
        publicationId: livePublication.kind === "ok" ? livePublication.id : "",
        skillId: liveSkillId,
        userId: ownerUserId
      })).resolves.toBe("ok");

      await expect(skillRepository.publish({
        actorIsAdmin: false,
        groupId: group.id,
        scope: "group",
        skillId: liveSkillId,
        userId: ownerUserId
      })).resolves.toMatchObject({ kind: "ok" });
      await expect(assistantRepository.publish({
        actorIsAdmin: false,
        assistantId,
        groupId: group.id,
        scope: "group",
        userId: ownerUserId
      })).resolves.toMatchObject({ kind: "ok" });

      const knowledge = await prisma.knowledgeBase.create({ data: { ownerUserId, name: "Dependency fixture" } });
      knowledgeBaseId = knowledge.id;
      await prisma.assistantDefinition.update({ where: { id: assistantId }, data: {
        knowledgeSelection: { mode: "explicit", version: 1, baseIds: [knowledge.id], sourceIds: [] }
      } });
      // Owner can see the empty base; the recipient cannot. Neither can run it.
      for (const userId of [ownerUserId, memberUserId]) {
        expect((await assistantRepository.getDetail(userId, assistantId))?.dependencyAvailability?.knowledge).toBe(userId === ownerUserId ? "not_ready" : "access_denied");
      }
      await prisma.knowledgeBase.update({ where: { id: knowledge.id }, data: { trashedAt: new Date() } });
      expect((await assistantRepository.getDetail(ownerUserId, assistantId))?.dependencyAvailability?.knowledge).toBe("access_denied");
      await prisma.knowledgeBase.delete({ where: { id: knowledge.id } });
      expect((await assistantRepository.getDetail(ownerUserId, assistantId))?.dependencyAvailability?.knowledge).toBe("access_denied");
      await prisma.assistantDefinition.update({ where: { id: assistantId }, data: {
        knowledgeSelection: { mode: "none", version: 1, baseIds: [], sourceIds: [] }
      } });
      expect((await assistantRepository.getDetail(ownerUserId, assistantId))?.dependencyAvailability?.knowledge).toBe("ready");

      await expect(skillRepository.delete(ownerUserId, liveSkillId)).resolves.toBe("ok");
      await expect(prisma.assistantSkill.count({ where: { skillId: liveSkillId } }))
        .resolves.toBe(0);
      await expect(prisma.skillPublication.count({ where: { skillId: liveSkillId } }))
        .resolves.toBe(0);
      await expect(assistantRepository.resolveForRun(memberUserId, assistantId)).resolves.toMatchObject({
        assistant: { skillIds: [firstSkillId] },
        ok: true
      });
      await expect(skillRepository.resolveForRun(memberUserId, [liveSkillId])).resolves.toEqual({
        code: "skill_not_available",
        ok: false,
        status: 404
      });
    } finally {
      const assistantIds = assistantId
        ? [assistantId]
        : (await prisma.assistantDefinition.findMany({
            select: { id: true },
            where: { ownerUserId }
          })).map((definition) => definition.id);
      await prisma.assistantPublication.deleteMany({ where: { assistantId: { in: assistantIds } } });
      await prisma.assistantPin.deleteMany({ where: { assistantId: { in: assistantIds } } });
      await prisma.assistantDefinition.deleteMany({ where: { id: { in: assistantIds } } });
      if (knowledgeBaseId) await prisma.knowledgeBase.deleteMany({ where: { id: knowledgeBaseId } });

      await prisma.skillPublication.deleteMany({ where: { skillId: { in: skillIds } } });
      await prisma.skillDefinition.updateMany({
        data: { currentRevisionId: null, sharedRevisionId: null },
        where: { id: { in: skillIds } }
      });
      await prisma.skillShareRequest.deleteMany({ where: { skillId: { in: skillIds } } });
      await prisma.skillRevision.deleteMany({ where: { skillId: { in: skillIds } } });
      await prisma.skillDefinition.deleteMany({ where: { id: { in: skillIds } } });
      await prisma.providerModel.deleteMany({ where: { id: providerModelId } });
      await prisma.providerConnection.deleteMany({ where: { id: providerConnectionId } });
      await prisma.group.deleteMany({ where: { id: group.id } });
      await prisma.user.deleteMany({ where: { id: { in: [ownerUserId, memberUserId] } } });
    }
  });
});

describe("Prisma Assistant rows", () => {
  const defaultRows: AssistantRows = {
    controls: { policy: "adjustable", value: {} },
    knowledge: { policy: "adjustable", value: { mode: "none" } },
    model: { policy: "adjustable", value: { mode: "inherit" } },
    search: { policy: "adjustable", value: { mode: "inherit" } },
    skills: { policy: "adjustable", value: { links: [], mode: "auto" } },
    tools: { policy: "adjustable", value: { mode: "inherit" } }
  };

  function rowsDraft(rows: AssistantRows): AssistantDraft {
    return { ...assistantDraft("unused", []), name: "Row defaults", rows, systemPrompt: "Answer as the team's editor." };
  }

  it("stores inherit rows, downgrades a copy, serves Project members, withdraws listing on archive and lists recents", async () => {
    const suffix = randomUUID();
    const ownerUserId = `assistant-rows-owner-${suffix}`;
    const memberUserId = `assistant-rows-member-${suffix}`;
    const projectUserId = `assistant-rows-project-${suffix}`;
    const userIds = [ownerUserId, memberUserId, projectUserId];
    const group = await prisma.group.create({ data: { name: `Assistant Rows ${suffix}` } });
    await prisma.user.createMany({ data: userIds.map((id) => ({ displayName: id, id, status: "active" as const })) });
    // Provisioned users always have settings; without them no catalog loads.
    await prisma.userSettings.createMany({ data: userIds.map((userId) => ({ userId })) });
    await prisma.userGroup.createMany({ data: [ownerUserId, memberUserId].map((userId) => ({ groupId: group.id, userId })) });
    const repository = createPrismaAssistantRepository(prisma);
    // The detail response as the route answers it to `userId`.
    const readDetail = async (userId: string, assistantId: string) => {
      const response = await createGetAssistantHandler({
        loadCatalogData: async () => catalogDataWithoutModels,
        repository,
        resolveAuth: async () => ({ expiresAt: new Date(Date.now() + 60_000), id: `session-${userId}`, userId,
          user: { displayName: userId, email: null, id: userId, role: "user", status: "active" } })
      })(new Request(`http://test/api/me/assistants/${assistantId}`), { params: { assistantId } });
      expect(response.status).toBe(200);
      const body = await response.json() as AssistantDetailResponse;
      expect(decodeAssistantDetailResponse(body)).not.toBeNull();
      return body.assistant;
    };
    const updatedAt = async (assistantId: string) =>
      (await prisma.assistantDefinition.findUniqueOrThrow({ where: { id: assistantId } })).updatedAt.toISOString();
    let projectId: string | null = null;
    let knowledgeBaseId: string | null = null;
    try {
      // Every row at its new default needs no catalog entry and no dependency.
      const created = await repository.create(ownerUserId, rowsDraft(defaultRows));
      if (created.kind !== "ok") throw new Error("assistant_rows_fixture_create_failed");
      const assistantId = created.assistantId;
      await expect(repository.getDetail(ownerUserId, assistantId)).resolves.toMatchObject({
        content: { knowledgeSelection: expect.objectContaining({ mode: "none" }), mcpServerIds: [], providerModelId: null,
          rows: defaultRows },
        dependencyAvailability: { knowledge: "ready", skills: true }
      });
      // Inherit rows are runnable: the run resolves them from the chat's context.
      await expect(repository.resolveForRun(ownerUserId, assistantId)).resolves.toMatchObject({
        assistant: { provider: null, providerModelId: null, rows: defaultRows },
        ok: true
      });

      // A fixed Knowledge base the copier cannot open becomes an adjustable None.
      const knowledge = await prisma.knowledgeBase.create({ data: { ownerUserId, name: "Private handbook" } });
      knowledgeBaseId = knowledge.id;
      const withKnowledge = await repository.update(ownerUserId, assistantId, 1, rowsDraft({
        ...defaultRows,
        knowledge: { policy: "fixed", value: { baseIds: [knowledge.id], mode: "explicit", sourceIds: [] } }
      }));
      expect(withKnowledge).toEqual({ assistantId, kind: "ok" });
      await expect(repository.publish({ actorIsAdmin: false, assistantId, groupId: group.id, scope: "group", userId: ownerUserId }))
        .resolves.toMatchObject({ kind: "ok" });
      await expect(repository.getDetail(memberUserId, assistantId)).resolves.toMatchObject({
        audience: null,
        content: { systemPrompt: "Answer as the team's editor." },
        visibleKnowledge: { baseIds: [], sourceIds: [] }
      });
      // The group member reads how it reaches them; the owner reads the audience.
      await expect(readDetail(memberUserId, assistantId)).resolves.toMatchObject({
        audience: null, scope: { groupNames: [group.name], kind: "group" }, updatedAt: await updatedAt(assistantId)
      });
      await expect(readDetail(ownerUserId, assistantId)).resolves.toMatchObject({
        audience: { everyone: false, groupNames: [group.name] }, scope: { kind: "owner" }, updatedAt: await updatedAt(assistantId)
      });
      const copy = await repository.duplicate(memberUserId, assistantId);
      expect(copy).toMatchObject({ kind: "ok", report: { downgradedRows: ["knowledge"], droppedSkillCount: 0 } });
      if (copy.kind !== "ok") throw new Error("assistant_rows_fixture_copy_failed");
      await expect(repository.getDetail(memberUserId, copy.assistantId)).resolves.toMatchObject({
        content: { name: "Copy of Row defaults", rows: { ...defaultRows, knowledge: { policy: "adjustable", value: { mode: "none" } } } },
        owned: true
      });
      const ownCopy = await repository.duplicate(ownerUserId, assistantId);
      expect(ownCopy).toMatchObject({ kind: "ok", report: { downgradedRows: [], droppedSkillCount: 0 } });

      // A Project member reads the detail, instructions included, and nothing more.
      const project = await createPrismaProjectRepository(prisma).create({
        actorDisplayName: ownerUserId, description: "Disposable Assistant rows fixture", name: `Rows ${suffix}`, userId: ownerUserId
      });
      if (project.kind !== "ok") throw new Error(`assistant_rows_fixture_project_${project.kind}`);
      projectId = project.value.id;
      await expect(repository.getDetail(projectUserId, assistantId)).resolves.toBeNull();
      await prisma.projectAssistantBinding.create({ data: { assistantId, projectId } });
      await prisma.projectGrant.create({ data: { projectId, role: "VIEWER", userId: projectUserId } });
      await expect(repository.getDetail(projectUserId, assistantId)).resolves.toMatchObject({
        audience: null, content: { systemPrompt: "Answer as the team's editor." }, owned: false,
        projectName: `Rows ${suffix}`, publications: null
      });
      // A Project member reads the Project scope and the update date, never the owner's group.
      const memberDetail = await readDetail(projectUserId, assistantId);
      expect(memberDetail).toMatchObject({
        audience: null, scope: { kind: "project", projectName: `Rows ${suffix}` }, updatedAt: await updatedAt(assistantId)
      });
      expect(JSON.stringify(memberDetail)).not.toContain(group.name);
      expect((await repository.listForUser(projectUserId)).map((entry) => entry.id)).not.toContain(assistantId);
      await expect(repository.setPinned(projectUserId, assistantId, true)).resolves.toBe(false);
      await expect(repository.duplicate(projectUserId, assistantId)).resolves.toEqual({ kind: "not_found" });
      await expect(repository.getDetail(ownerUserId, assistantId)).resolves.toMatchObject({
        projects: { otherProjectCount: 0, projects: [{ id: projectId, name: `Rows ${suffix}` }] },
        recentChatCount: 0
      });

      // Archiving withdraws a pending listing request.
      const version = (await prisma.assistantDefinition.findUniqueOrThrow({ where: { id: assistantId } })).version;
      await createAssistantListingService(prisma).request(ownerUserId, assistantId, version);
      await expect(repository.getDetail(ownerUserId, assistantId)).resolves.toMatchObject({
        listingRequest: { canWithdraw: true, request: { outdated: false, state: "pending" } }
      });
      await expect(repository.setArchived(ownerUserId, assistantId, version, true)).resolves.toEqual({ assistantId, kind: "ok" });
      await expect(prisma.assistantListingRequest.findMany({ select: { state: true }, where: { assistantId } }))
        .resolves.toEqual([{ state: "withdrawn" }]);
      await expect(repository.getDetail(projectUserId, assistantId)).resolves.toBeNull();

      // Recents follow the latest personal chats, distinct and newest first,
      // among the listed candidates only.
      const second = await repository.create(memberUserId, rowsDraft(defaultRows));
      if (second.kind !== "ok") throw new Error("assistant_rows_fixture_second_failed");
      const at = (minute: number) => new Date(Date.UTC(2026, 8, 28, 12, minute));
      await prisma.chat.createMany({ data: [
        { assistantId: copy.assistantId, title: "Oldest", updatedAt: at(1), userId: memberUserId },
        { assistantId: second.assistantId, title: "Middle", updatedAt: at(2), userId: memberUserId },
        { assistantId: copy.assistantId, title: "Newest", updatedAt: at(3), userId: memberUserId },
        { assistantId, title: "Not a candidate", updatedAt: at(4), userId: memberUserId },
        { assistantId: second.assistantId, archived: true, title: "Archived chat", updatedAt: at(5), userId: memberUserId },
        { title: "Plain", updatedAt: at(6), userId: memberUserId }
      ] });
      await expect(repository.loadRecentAssistantIds(memberUserId, [second.assistantId, copy.assistantId]))
        .resolves.toEqual([copy.assistantId, second.assistantId]);
      await expect(repository.loadRecentAssistantIds(ownerUserId, [copy.assistantId])).resolves.toEqual([]);
      await expect(repository.loadRecentAssistantIds(memberUserId, [])).resolves.toEqual([]);
    } finally {
      await prisma.chat.deleteMany({ where: { userId: { in: userIds } } });
      if (projectId) await prisma.project.deleteMany({ where: { id: projectId } });
      const assistantIds = (await prisma.assistantDefinition.findMany({
        select: { id: true }, where: { ownerUserId: { in: userIds } }
      })).map((definition) => definition.id);
      await prisma.assistantListingRequest.deleteMany({ where: { assistantId: { in: assistantIds } } });
      await prisma.assistantPublication.deleteMany({ where: { assistantId: { in: assistantIds } } });
      await prisma.assistantPin.deleteMany({ where: { assistantId: { in: assistantIds } } });
      await prisma.assistantDefinition.deleteMany({ where: { id: { in: assistantIds } } });
      if (knowledgeBaseId) await prisma.knowledgeBase.deleteMany({ where: { id: knowledgeBaseId } });
      await prisma.group.deleteMany({ where: { id: group.id } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  });
});

describe("Prisma Assistant list summary fields", () => {
  it("lists Skill link counts, Featured positions and active group members in a constant number of queries", async () => {
    const suffix = randomUUID();
    const ownerUserId = `assistant-summary-owner-${suffix}`;
    const consumerUserId = `assistant-summary-consumer-${suffix}`;
    const adminUserId = `assistant-summary-admin-${suffix}`;
    const disabledUserId = `assistant-summary-disabled-${suffix}`;
    const pendingUserId = `assistant-summary-pending-${suffix}`;
    const userIds = [ownerUserId, consumerUserId, adminUserId, disabledUserId, pendingUserId];
    await prisma.user.createMany({ data: [
      { displayName: "Summary owner", id: ownerUserId, status: "active" },
      { displayName: "Summary consumer", id: consumerUserId, status: "active" },
      { displayName: "Summary admin", id: adminUserId, role: "admin", status: "active" },
      { displayName: "Summary disabled", id: disabledUserId, status: "disabled" },
      { displayName: "Summary pending", id: pendingUserId, status: "pending" }
    ] });
    const team = await prisma.group.create({ data: { name: `Summary A ${suffix}` } });
    const solo = await prisma.group.create({ data: { name: `Summary B ${suffix}` } });
    const retired = await prisma.group.create({ data: { archivedAt: new Date(), name: `Summary C ${suffix}` } });
    // An audience the consumer does not belong to.
    const outside = await prisma.group.create({ data: { name: `Summary E ${suffix}` } });
    const groupIds = [team.id, solo.id, retired.id, outside.id];
    await prisma.userGroup.createMany({ data: [
      ...[ownerUserId, consumerUserId, disabledUserId, pendingUserId].map((userId) => ({ groupId: team.id, userId })),
      { groupId: solo.id, userId: ownerUserId },
      { groupId: retired.id, userId: ownerUserId }
    ] });
    // Counts every SQL statement the list sends, relation loads included.
    const counting = createQueryCountingClient();
    const repository = createPrismaAssistantRepository(counting.client);
    const skillIds: string[] = [];
    try {
      const skillRepository = createPrismaSkillRepository(prisma);
      for (const name of ["Summary first", "Summary second"]) {
        skillIds.push(await skillRepository.create(ownerUserId, {
          description: "Synthetic summary Skill.", instructions: "Answer briefly.", name
        }));
      }
      const create = async (name: string, linkedSkillIds: string[]) => {
        const created = await repository.create(ownerUserId, { ...assistantDraft("unused", []), name, rows: {
          controls: { policy: "adjustable", value: {} },
          knowledge: { policy: "adjustable", value: { mode: "none" } },
          model: { policy: "adjustable", value: { mode: "inherit" } },
          search: { policy: "adjustable", value: { mode: "inherit" } },
          skills: { policy: "adjustable", value: {
            links: linkedSkillIds.map((skillId) => ({ delivery: "always" as const, skillId })), mode: "auto" } },
          tools: { policy: "adjustable", value: { mode: "inherit" } }
        } });
        if (created.kind !== "ok") throw new Error("assistant_summary_fixture_create_failed");
        return created.assistantId;
      };
      const linked = await create("Summary linked", skillIds);
      const plain = await create("Summary plain", []);
      const grouped = await create("Summary grouped", [skillIds[0]!]);
      const unpublished = await create("Summary private", []);
      // Stored positions far above any real ones keep the unique Featured
      // index free; the list answers dense positions.
      const stored = 1_000_000 + randomInt(1_000_000);
      // Owner audiences: none (unpublished), everyone (plain), two groups and an
      // archived one that reaches no one (grouped), everyone and three groups (linked).
      await prisma.assistantPublication.createMany({ data: [
        { assistantId: plain, featuredOrder: stored, scope: "installation" },
        { assistantId: linked, featuredOrder: stored + 1, scope: "installation" },
        ...[team, solo, outside].map((group) => ({ assistantId: linked, groupId: group.id, scope: "group" as const })),
        ...[team, solo, retired].map((group) => ({ assistantId: grouped, groupId: group.id, scope: "group" as const }))
      ] });

      const list = async (userId: string, role: "admin" | "user" = "user") => {
        const response = await createListAssistantsHandler({
          loadCatalogData: async () => catalogDataWithoutModels,
          repository,
          resolveAuth: async () => ({ expiresAt: new Date(Date.now() + 60_000), id: `session-${userId}`, userId,
            user: { displayName: userId, email: null, id: userId, role, status: "active" } })
        })(new Request("http://test/api/me/assistants"));
        expect(response.status).toBe(200);
        const body = await response.json() as AssistantListResponse;
        expect(decodeAssistantListResponse(body)).not.toBeNull();
        return body;
      };
      const fields = (body: AssistantListResponse, ids: readonly string[]) => Object.fromEntries(body.assistants
        .filter((assistant) => ids.includes(assistant.id))
        .map(({ featured, featuredOrder, id, skillLinkCount }) => [id, { featured, featuredOrder, skillLinkCount }]));
      const sharing = (body: AssistantListResponse, ids: readonly string[]) => Object.fromEntries(body.assistants
        .filter((assistant) => ids.includes(assistant.id))
        .map(({ audience, id, scope }) => [id, { audience, scope }]));
      const orders = await loadFeaturedAssistantOrders(prisma);
      const first = orders.get(plain)!;
      expect(orders.get(linked)).toBe(first + 1);
      const ids = [linked, plain, grouped, unpublished];
      const featuredPair = {
        [linked]: { featured: true, featuredOrder: first + 1, skillLinkCount: 2 },
        [plain]: { featured: true, featuredOrder: first, skillLinkCount: 0 }
      };

      await counting.reset();
      const owner = await list(ownerUserId);
      const ownerQueries = await counting.count();
      expect(fields(owner, ids)).toEqual({
        ...featuredPair,
        [grouped]: { featured: false, featuredOrder: null, skillLinkCount: 1 },
        [unpublished]: { featured: false, featuredOrder: null, skillLinkCount: 0 }
      });
      expect(owner.publishableGroups).toEqual([
        { id: team.id, memberCount: 2, name: team.name },
        { id: solo.id, memberCount: 1, name: solo.name }
      ]);
      const ownerScope = { kind: "owner" };
      expect(sharing(owner, ids)).toEqual({
        [linked]: { audience: { everyone: true, groupNames: [team.name, solo.name, outside.name] }, scope: ownerScope },
        [plain]: { audience: { everyone: true, groupNames: [] }, scope: ownerScope },
        [grouped]: { audience: { everyone: false, groupNames: [team.name, solo.name] }, scope: ownerScope },
        [unpublished]: { audience: { everyone: false, groupNames: [] }, scope: ownerScope }
      });

      // The consumer cannot open the owner's Skills and learns only how many are linked.
      const consumer = await list(consumerUserId);
      expect(fields(consumer, ids)).toEqual({
        ...featuredPair,
        [grouped]: { featured: false, featuredOrder: null, skillLinkCount: 1 }
      });
      expect(consumer.publishableGroups).toEqual([{ id: team.id, memberCount: 2, name: team.name }]);
      expect(JSON.stringify(consumer)).not.toMatch(new RegExp([...skillIds, "Summary first", "Summary second"].join("|"), "u"));
      // The consumer learns how each reaches them, never the owner's other audiences.
      expect(sharing(consumer, ids)).toEqual({
        [linked]: { audience: null, scope: { groupNames: [team.name], kind: "group" } },
        [plain]: { audience: null, scope: { kind: "installation" } },
        [grouped]: { audience: null, scope: { groupNames: [team.name], kind: "group" } }
      });
      expect(JSON.stringify(consumer)).not.toMatch(new RegExp([solo.name, retired.name, outside.name].join("|"), "u"));

      const admin = await list(adminUserId, "admin");
      expect(fields(admin, ids)).toEqual(featuredPair);
      expect(sharing(admin, ids)).toEqual({
        [linked]: { audience: null, scope: { kind: "installation" } },
        [plain]: { audience: null, scope: { kind: "installation" } }
      });
      expect(admin.publishableGroups).toEqual([]);
      expect(admin.viewer.canPublishInstallation).toBe(true);

      // More Assistants, links, publications and groups send no more statements.
      const extra = await prisma.group.create({ data: { name: `Summary D ${suffix}` } });
      groupIds.push(extra.id);
      await prisma.userGroup.createMany({ data: [ownerUserId, consumerUserId].map((userId) => ({ groupId: extra.id, userId })) });
      for (const name of ["Summary extra one", "Summary extra two", "Summary extra three"]) {
        const assistantId = await create(name, [skillIds[1]!]);
        await prisma.assistantPublication.create({ data: { assistantId, groupId: extra.id, scope: "group" } });
      }
      await counting.reset();
      const grown = await list(ownerUserId);
      expect(grown.assistants.length).toBeGreaterThanOrEqual(owner.assistants.length + 3);
      expect(grown.publishableGroups).toHaveLength(3);
      expect(await counting.count()).toBe(ownerQueries);
    } finally {
      await counting.client.$disconnect();
      const assistantIds = (await prisma.assistantDefinition.findMany({
        select: { id: true }, where: { ownerUserId }
      })).map((definition) => definition.id);
      await prisma.assistantPublication.deleteMany({ where: { assistantId: { in: assistantIds } } });
      await prisma.assistantDefinition.deleteMany({ where: { id: { in: assistantIds } } });
      await prisma.skillDefinition.updateMany({
        data: { currentRevisionId: null, sharedRevisionId: null },
        where: { id: { in: skillIds } }
      });
      await prisma.skillRevision.deleteMany({ where: { skillId: { in: skillIds } } });
      await prisma.skillDefinition.deleteMany({ where: { id: { in: skillIds } } });
      await prisma.group.deleteMany({ where: { id: { in: groupIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  });
});

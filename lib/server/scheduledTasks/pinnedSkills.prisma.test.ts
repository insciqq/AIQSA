// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { ScheduledTaskDraft } from "../../contracts/scheduledTasks";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { prisma } from "../prisma";
import { loadProviderAdmissionPlan } from "../providerRuntime/admission";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import { createPrismaSkillRepository } from "../skills/prismaRepository";
import { createPrismaScheduledTaskPinnedSkillLoader } from "./pinnedSkills";
import { scheduledPromptUrlDigests } from "./promptUrls";
import { createPrismaScheduledTaskStore } from "./store";

const users: string[] = [];
const skillIds: string[] = [];
const skills = createPrismaSkillRepository(prisma);
const store = createPrismaScheduledTaskStore(prisma);
const runs = createPrismaRunRepository(prisma);
const loadPinnedSkills = createPrismaScheduledTaskPinnedSkillLoader(prisma);
const noUrls = scheduledPromptUrlDigests("", { kind: "owner" });
const due = new Date("2026-10-05T06:00:00.000Z");
const draft: ScheduledTaskDraft = {
  title: "Synthetic digest", prompt: "Run the synthetic digest", schedule: { kind: "daily", time: "09:00" },
  timeZone: "Europe/Moscow", modelId: providerTemplateIds.fakeModel, provider: providerTemplateIds.fakeConnection, searchEnabled: false,
  emailNotify: false, toolsEnabled: true, workspaceEnabled: false, memoryEnabled: false, pinnedSkillIds: [], chatMode: "same",
  kind: "standard", historyRetentionDays: 90
};

async function user(prefix: string): Promise<string> {
  const id = `${prefix}-${randomUUID()}`;
  await prisma.user.create({ data: { displayName: "Synthetic pinned Skills", email: `${id}@example.test`, id, status: "active" } });
  users.push(id);
  return id;
}

async function skill(ownerId: string, name: string): Promise<string> {
  const id = await skills.create(ownerId, { name, description: "Synthetic workflow", instructions: "Follow the synthetic steps." });
  skillIds.push(id);
  return id;
}

/** Publishes a Skill's current revision to everyone, as an approved share does. */
async function share(skillId: string): Promise<void> {
  const revision = (await prisma.skillDefinition.findUniqueOrThrow({ where: { id: skillId } })).currentRevisionId!;
  await prisma.skillDefinition.update({ where: { id: skillId }, data: { sharedRevisionId: revision } });
  await prisma.skillPublication.create({ data: { skillId, scope: "installation" } });
}

afterEach(async () => {
  const ids = users.splice(0);
  const created = skillIds.splice(0);
  await prisma.scheduledTask.deleteMany({ where: { userId: { in: ids } } });
  await prisma.chat.deleteMany({ where: { userId: { in: ids } } });
  await prisma.memoryDeletionOutbox.deleteMany({ where: { userId: { in: ids } } });
  await prisma.userSkillPreference.deleteMany({ where: { skillId: { in: created } } });
  await prisma.skillPublication.deleteMany({ where: { skillId: { in: created } } });
  await prisma.skillDefinition.updateMany({ where: { id: { in: created } }, data: { currentRevisionId: null, sharedRevisionId: null } });
  await prisma.skillRevision.deleteMany({ where: { skillId: { in: created } } });
  await prisma.skillDefinition.deleteMany({ where: { id: { in: created } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});
afterAll(() => prisma.$disconnect());

describe("a scheduled task's pinned Skills", () => {
  it("are available exactly when a run's Auto catalog would offer them, and named only while the owner sees them", async () => {
    const runner = await user("pinned-runner");
    const author = await user("pinned-author");
    const own = await skill(runner, "Own digest");
    const archived = await skill(runner, "Archived digest");
    const disabled = await skill(runner, "Disabled digest");
    const deleted = await skill(runner, "Deleted digest");
    const enabledShare = await skill(author, "Shared digest");
    const defaultShare = await skill(author, "Shared but not enabled");
    const unshared = await skill(author, "No longer shared");
    for (const id of [enabledShare, defaultShare, unshared]) await share(id);
    await prisma.userSkillPreference.createMany({ data: [
      { userId: runner, skillId: disabled, enabled: false }, { userId: runner, skillId: enabledShare, enabled: true },
      { userId: runner, skillId: unshared, enabled: true }
    ] });
    await prisma.skillDefinition.update({ where: { id: archived }, data: { archivedAt: new Date() } });
    await prisma.skillDefinition.update({ where: { id: deleted }, data: { deletedAt: new Date() } });
    await prisma.skillPublication.deleteMany({ where: { skillId: unshared } });

    expect(await loadPinnedSkills(runner, [own, archived, disabled, deleted, enabledShare, defaultShare, unshared])).toEqual([
      { id: own, name: "Own digest", available: true, hasExecutables: false },
      { id: archived, name: "Archived digest", available: false, hasExecutables: false },
      { id: disabled, name: "Disabled digest", available: false, hasExecutables: false },
      { id: deleted, name: null, available: false, hasExecutables: false },
      { id: enabledShare, name: "Shared digest", available: true, hasExecutables: false },
      { id: defaultShare, name: "Shared but not enabled", available: false, hasExecutables: false },
      { id: unshared, name: null, available: false, hasExecutables: false }
    ]);
  });

  it("persist with the task under the database's bound and tools rule and project the owner's view", async () => {
    const runner = await user("pinned-store");
    const own = await skill(runner, "Own digest");
    const created = await store.create(runner, { ...draft, pinnedSkillIds: [own] }, due, noUrls);
    expect(created).toMatchObject({ pinnedSkillIds: [own], pinnedSkills: [{ id: own, name: "Own digest", available: true }] });
    // Changing the pins bumps the revision but keeps the generation and its baseline.
    const updated = await store.update(runner, created.id, { draft: { ...draft, pinnedSkillIds: [] }, expectedRevision: 1,
      nextRunAt: undefined, promptUrls: "keep", status: "active" });
    expect(updated).toMatchObject({ pinnedSkillIds: [], pinnedSkills: [], revision: 2 });
    expect(await prisma.scheduledTask.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ generation: 1 });
    // The database refuses pins without tools and more than four.
    await expect(prisma.scheduledTask.update({ where: { id: created.id }, data: { pinnedSkillIds: [own], toolsEnabled: false } }))
      .rejects.toThrow();
    await expect(prisma.scheduledTask.update({ where: { id: created.id }, data: { pinnedSkillIds: ["a", "b", "c", "d", "e"] } }))
      .rejects.toThrow();
    const listed = await store.list(runner);
    expect(listed.tasks[0]).toMatchObject({ pinnedSkillIds: [], pinnedSkills: [] });
  });

  it("shows each run's pinned Skills with the version it used, from the run's bindings", async () => {
    const runner = await user("pinned-history");
    await prisma.userSettings.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel,
      defaultSearchStrategyId: "search-disabled", userId: runner } });
    await prisma.accessGrant.create({ data: { providerConnectionId: providerTemplateIds.fakeConnection, userId: runner } });
    const own = await skill(runner, "Own digest");
    const revision = await prisma.skillDefinition.findUniqueOrThrow({ select: { currentRevisionId: true }, where: { id: own } });
    const created = await store.create(runner, { ...draft, pinnedSkillIds: [own] }, due, noUrls);
    const row = await prisma.scheduledTask.findUniqueOrThrow({ where: { id: created.id } });
    const chat = await prisma.chat.create({ data: { defaultProviderModelId: providerTemplateIds.fakeModel, memoryMode: "EXCLUDED",
      title: "Synthetic digest", userId: runner } });
    const occurrence = await prisma.scheduledTaskOccurrence.create({ data: {
      scheduledFor: new Date(), startedAt: new Date(), taskId: created.id, trigger: "manual", userId: runner
    } });
    const content = textMessageContent("Run the synthetic digest");
    const run = await runs.createRun({
      chatId: chat.id, content, expectedActiveLeafId: null, modelId: "fake-qsa", provider: "fake", providerRequestPreview: {},
      defaults: { controlDefaults: {}, modelId: providerTemplateIds.fakeModel, provider: providerTemplateIds.fakeConnection,
        searchPlan: { mode: "all_selected", optionIds: [] }, userId: runner },
      providerAdmissionPlan: await loadProviderAdmissionPlan(prisma, { providerConnectionId: providerTemplateIds.fakeConnection,
        providerModelId: providerTemplateIds.fakeModel, searchPlan: { mode: "all_selected", optionIds: [] }, userId: runner }),
      normalizedRequest: { attachmentIds: [], chatId: chat.id, content, knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
        modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
        modelId: "fake-qsa", params: {}, prompt: { developer: null, system: null }, provider: "fake",
        searchPlan: { mode: "all_selected", options: [] }, toolMode: "none" },
      scheduledOccurrence: { occurrenceId: occurrence.id, previousResult: null, relevantMcpServerIds: null,
        taskGeneration: row.generation, taskId: created.id, taskRevision: row.revision },
      userId: runner
    });
    await prisma.modelRunSkillBinding.create({ data: {
      alias: "own-digest", mode: "pinned", modelRunId: run.runId, revisionId: revision.currentRevisionId!, skillId: own
    } });
    const detail = await store.detail(runner, created.id);
    expect(detail?.recentRuns).toMatchObject([{ id: occurrence.id, skills: [{ name: "Own digest", version: 1 }] }]);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { prisma } from "../prisma";
import { loadProviderAdmissionPlan } from "../providerRuntime/admission";
import { createPrismaMessageBranchRepository } from "../messages/prismaRepository";
import { createPrismaProjectRepository } from "../projects/prismaRepository";
import { createPrismaShareRepository } from "../shares/prismaRepository";
import { createPrismaRunRepository } from "./prismaRepository";
import { createPrismaRunFollowupOperations, messageFollowupSelect } from "./prismaRepositoryFollowups";
import { projectMessageFollowups } from "./runFollowups";
import type { CreateRunInput, CreatedRun, ProjectRunAdmission } from "./runRepositoryContract";

const repository = createPrismaRunRepository(prisma);
const followups = createPrismaRunFollowupOperations(prisma);
const cancelPayload = { code: "model_run_cancelled", message: "Model run cancelled" };

async function fixture<T>(execute: (fixture: {
  userId: string; otherId: string; chatId: string; input: CreateRunInput;
  create(): Promise<CreatedRun>;
}) => Promise<T>, projectMode = false): Promise<T> {
  const userId = `followup-owner-${randomUUID()}`, otherId = `followup-other-${randomUUID()}`;
  let projectId: string | undefined;
  await prisma.user.createMany({ data: [userId, otherId].map(id => ({ id, displayName: "Synthetic author", status: "active" })) });
  try {
    await prisma.userSettings.create({ data: { userId, defaultControlValues: {},
      defaultProviderModelId: providerTemplateIds.fakeModel, defaultSearchStrategyId: "search-disabled" } });
    await prisma.accessGrant.create({ data: { userId, providerConnectionId: providerTemplateIds.fakeConnection } });
    let project: ProjectRunAdmission | undefined;
    if (projectMode) {
      const result = await createPrismaProjectRepository(prisma).create({ userId, actorDisplayName: "Synthetic author", name: "Follow-up fixture", description: "" });
      if (result.kind !== "ok") throw new Error("project_fixture_failed");
      const value = result.value;
      projectId = value.id;
      await prisma.projectGrant.create({ data: { projectId, userId: otherId, role: "CONTRIBUTOR" } });
      const current = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { accessRevision: true } });
      project = { accessRevision: current.accessRevision, assistantBindings: [], defaults: value.defaults,
        instructions: value.instructions, instructionsRevision: value.instructionsRevision, knowledgeBaseIds: [],
        mcpServerIds: [], memoryEnabled: false, memoryItems: [], memoryRevision: value.memoryRevision,
        modelIds: ["fake-qsa"], policy: value.policy, policyRevision: value.policyRevision, projectId,
        role: "OWNER", searchOptionIds: [] };
    }
    const chat = await prisma.chat.create({ data: { userId: project ? null : userId, projectId,
      ...(project ? { createdByUserId: userId, createdByDisplayName: "Synthetic author" } : {}),
      memoryMode: "EXCLUDED", title: "Follow-up fixture", defaultProviderModelId: providerTemplateIds.fakeModel } });
    const content = textMessageContent("Original question");
    const input: CreateRunInput = { chatId: chat.id, content, expectedActiveLeafId: null, userId,
      modelId: "fake-qsa", provider: "fake", providerRequestPreview: {}, project,
      defaults: { userId, controlDefaults: {}, modelId: providerTemplateIds.fakeModel,
        provider: providerTemplateIds.fakeConnection, searchPlan: { mode: "all_selected", optionIds: [] } },
      providerAdmissionPlan: await loadProviderAdmissionPlan(prisma, { userId,
        ...(project ? { executionScope: "project" as const } : {}),
        providerConnectionId: providerTemplateIds.fakeConnection, providerModelId: providerTemplateIds.fakeModel,
        searchPlan: { mode: "all_selected", optionIds: [] } }),
      followupAdmission: { budgetTokens: 4_096 },
      normalizedRequest: { attachmentIds: [], chatId: chat.id, content, toolMode: "auto",
        knowledgePlan: { version: 1, mode: "none", baseIds: [], sourceIds: [] },
        modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
        modelId: "fake-qsa", params: {}, prompt: { developer: null, system: null }, provider: "fake",
        followupContextReserveTokens: 4_096, searchPlan: { mode: "all_selected", options: [] } } };
    return await execute({ userId, otherId, chatId: chat.id, input, create: () => repository.createRun(input) });
  } finally {
    if (projectId) {
      await prisma.chat.deleteMany({ where: { projectId } });
      await prisma.project.delete({ where: { id: projectId } });
    }
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
  }
}

function submission(f: { chatId: string; userId: string }, run: CreatedRun, nonce: string = randomUUID(), text = "Use a table") {
  return { chatId: f.chatId, userId: f.userId, assistantMessageId: run.assistantMessageId, runId: run.runId, nonce, text };
}
function completion(f: { chatId: string; userId: string }, run: CreatedRun, revision = 0) {
  return { chatId: f.chatId, userId: f.userId, assistantMessageId: run.assistantMessageId, runId: run.runId,
    followupRevision: revision, modelId: "fake-qsa", provider: "fake", finalText: "Updated answer", estimatedCostMicros: null,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, completeness: "complete" as const } };
}

describe("durable in-run Follow-up", () => {
  afterAll(() => prisma.$disconnect());

  it("accepts PREPARING input and delivers one ordered batch without publishing an early answer", async () => fixture(async f => {
    const run = await repository.admitPreparingRun({ ...f.input, admissionKind: "NORMAL_SEND" });
    const accepted = await followups.accept(submission(f, run));
    expect(accepted).toMatchObject({ kind: "accepted", entry: { ordinal: 1, delivery: "accepted" } });
    expect(await repository.completeRun(completion(f, run))).toBe(false);
    expect(await followups.deliver({ runId: run.runId, userId: f.userId, revision: 1, precedingText: "", budgetTokens: 2_000 })).toBe(true);
    expect(await followups.load({ runId: run.runId, userId: f.userId })).toMatchObject({ revision: 1, entries: [{ delivery: "delivered" }] });
    await repository.cancelRun({ runId: run.runId, userId: f.userId, payload: cancelPayload });
  }));

  it("serializes duplicate submissions, preserves their receipt after completion and rejects nonce reuse", async () => fixture(async f => {
    const run = await f.create(), input = submission(f, run);
    const [a, b] = await Promise.all([followups.accept(input), followups.accept(input)]);
    expect(a).toEqual(b);
    expect(await prisma.runFollowup.count({ where: { modelRunId: run.runId } })).toBe(1);
    expect(await followups.accept({ ...input, text: "Changed text" })).toEqual({ kind: "conflict" });
    expect(await followups.deliver({ runId: run.runId, userId: f.userId, revision: 1, precedingText: "Old partial", budgetTokens: 2_000 })).toBe(true);
    expect(await followups.close({ runId: run.runId, userId: f.userId, revision: 1 })).toBe(true);
    expect(await repository.completeRun(completion(f, run, 1))).toBe(true);
    expect(await followups.accept(input)).toMatchObject({ kind: "accepted", entry: { delivery: "delivered", precedingText: "Old partial" } });
    expect(await followups.accept(submission(f, run))).toEqual({ kind: "closed" });
  }));

  it("gives clarification and completion exactly one winner", async () => fixture(async f => {
    const run = await f.create();
    const [accepted, completed] = await Promise.all([followups.accept(submission(f, run)), repository.completeRun(completion(f, run))]);
    expect(Number(accepted.kind === "accepted") + Number(completed)).toBe(1);
    if (!completed) {
      expect(await followups.close({ runId: run.runId, userId: f.userId, revision: 0 })).toBe(false);
      await repository.cancelRun({ runId: run.runId, userId: f.userId, payload: cancelPayload });
      expect(await followups.load({ runId: run.runId, userId: f.userId })).toMatchObject({ entries: [{ delivery: "undelivered" }] });
    }
  }));

  it("keeps Stop terminal when a concurrent clarification is accepted first", async () => fixture(async f => {
    const run = await f.create();
    const [accepted] = await Promise.all([followups.accept(submission(f, run)), repository.cancelRun({ runId: run.runId, userId: f.userId, payload: cancelPayload })]);
    expect(["accepted", "closed"]).toContain(accepted.kind);
    expect(await followups.deliver({ runId: run.runId, userId: f.userId, revision: 1, precedingText: "", budgetTokens: 1_000 })).toBe(false);
    expect(await repository.completeRun(completion(f, run, 1))).toBe(false);
    const state = await followups.load({ runId: run.runId, userId: f.userId });
    expect(state?.entries.every(entry => entry.delivery === "undelivered")).toBe(true);
  }));

  it("rechecks ownership, branch binding, entitlement and bounded remaining context", async () => fixture(async f => {
    const run = await f.create(), input = submission(f, run);
    expect(await followups.accept({ ...input, userId: f.otherId })).toEqual({ kind: "not_found" });
    expect(await followups.accept({ ...input, assistantMessageId: "wrong-branch" })).toEqual({ kind: "not_found" });
    await prisma.accessGrant.updateMany({ where: { userId: f.userId }, data: { enabled: false } });
    expect(await followups.accept(input)).toEqual({ kind: "closed" });
    await prisma.accessGrant.updateMany({ where: { userId: f.userId }, data: { enabled: true } });
    await prisma.modelRun.update({ where: { id: run.runId }, data: { followupBudgetTokens: 1 } });
    expect(await followups.accept(input)).toEqual({ kind: "context_full" });
    expect(await prisma.runFollowup.count({ where: { modelRunId: run.runId } })).toBe(0);
  }));

  it("orders two Project contributors and denies a member after role revocation", async () => fixture(async f => {
    const run = await f.create();
    const results = await Promise.all([followups.accept(submission(f, run)), followups.accept({ ...submission(f, run), userId: f.otherId })]);
    expect(results.every(result => result.kind === "accepted")).toBe(true);
    expect(results.flatMap(result => result.kind === "accepted" ? [result.entry.ordinal] : []).sort()).toEqual([1, 2]);
    await prisma.projectGrant.updateMany({ where: { userId: f.otherId, projectId: f.input.project!.projectId }, data: { role: "VIEWER" } });
    expect(await followups.accept({ ...submission(f, run), userId: f.otherId })).toEqual({ kind: "not_found" });
  }, true));

  it("preserves branch history after source deletion and projects readable immutable shares", async () => fixture(async f => {
    const run = await f.create();
    await followups.accept(submission(f, run, "private-nonce", "Clarified question"));
    await followups.deliver({ runId: run.runId, userId: f.userId, revision: 1, precedingText: "Previous partial", budgetTokens: 1_000 });
    await followups.close({ runId: run.runId, userId: f.userId, revision: 1 });
    expect(await repository.completeRun(completion(f, run, 1))).toBe(true);
    const branch = await createPrismaMessageBranchRepository(prisma).createChatBranchFromMessage({ sourceMessageId: run.assistantMessageId, userId: f.userId });
    expect(branch?.activeLeafMessageId).toBeTruthy();
    await prisma.chat.delete({ where: { id: f.chatId } });
    const message = await prisma.message.findUniqueOrThrow({ where: { id: branch!.activeLeafMessageId! }, select: messageFollowupSelect });
    expect(projectMessageFollowups(message)).toMatchObject({ available: false, entries: [{ text: "Clarified question", precedingText: "Previous partial" }] });
    const context = await repository.loadConversationContext(branch!.id, f.userId);
    expect(context.map(item => textFromContentBlocks(item.content))).toEqual(["Original question",
      "Partial answer before follow-up:\nPrevious partial", "Follow-up:\nClarified question", "Updated answer"]);
    const source = await repository.findRegenerationSource(branch!.activeLeafMessageId!, f.userId);
    expect(source?.followups).toMatchObject({ revision: 1, entries: [{ text: "Clarified question" }] });
    const share = await createPrismaShareRepository(prisma).createChatShare({ chatId: branch!.id, activeLeafMessageId: null,
      userId: f.userId, shareToken: randomUUID(), slugHash: randomUUID() });
    expect(share && "snapshot" in share).toBe(true);
    const serialized = JSON.stringify(share && "snapshot" in share ? share.snapshot : null);
    expect(serialized).toContain("Clarified question");
    expect(serialized).toContain("Previous partial");
    expect(serialized).not.toMatch(/private-nonce|authorUserId|modelRunId/);
    expect(serialized).not.toContain(f.userId);
  }));

  it("regenerates the clarified question once on a new sibling run", async () => fixture(async f => {
    const first = await f.create();
    await followups.accept(submission(f, first));
    await followups.deliver({ runId: first.runId, userId: f.userId, revision: 1, precedingText: "Partial", budgetTokens: 1_000 });
    await followups.close({ runId: first.runId, userId: f.userId, revision: 1 });
    expect(await repository.completeRun(completion(f, first, 1))).toBe(true);
    const next = await repository.createRegenerationRun({ ...f.input, workspaceFollowup: undefined, userMessageId: first.userMessageId,
      preSendAssistantMessageId: first.assistantMessageId,
      followupAdmission: { budgetTokens: 4_096, inherited: { messageId: first.assistantMessageId, revision: 1 } } });
    expect(await followups.load({ runId: next.runId, userId: f.userId })).toMatchObject({ revision: 1, entries: [{ text: "Use a table", delivery: "accepted" }] });
    const cloned = await prisma.runFollowup.findFirstOrThrow({ where: { modelRunId: next.runId } });
    expect(cloned.precedingText).toBeNull();
    expect(cloned.deliveredAt).toBeNull();
    expect(await repository.completeRun(completion(f, next, 0))).toBe(false);
    expect(await prisma.runFollowup.count({ where: { modelRunId: first.runId } })).toBe(1);
  }));

  it("enforces durable history and completion guards, then cascades owned receipts", async () => fixture(async f => {
    const run = await f.create();
    await followups.accept(submission(f, run));
    const row = await prisma.runFollowup.findFirstOrThrow({ where: { modelRunId: run.runId } });
    await expect(prisma.runFollowup.update({ where: { id: row.id }, data: { text: "Rewritten" } })).rejects.toThrow();
    await expect(prisma.modelRun.update({ where: { id: run.runId }, data: { status: "complete" } })).rejects.toThrow();
    await followups.deliver({ runId: run.runId, userId: f.userId, revision: 1, precedingText: "Partial", budgetTokens: 1_000 });
    await expect(prisma.runFollowup.update({ where: { id: row.id }, data: { precedingText: "Rewritten partial" } })).rejects.toThrow();
    await prisma.modelRun.delete({ where: { id: run.runId } });
    expect(await prisma.runFollowup.count({ where: { id: row.id } })).toBe(0);
  }));
});

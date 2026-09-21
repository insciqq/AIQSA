import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { NOOP_MEMORY_SOURCE_MUTATION_HOOKS } from "../memory/sourceState";
import { prisma } from "../prisma";
import type { NormalizedRunRequest } from "../providers/types";
import { createPrismaRunToolLoopOperations } from "../runs/prismaRepositoryToolLoop";
import { snapshotToolLoopJson, toolLoopPersistenceLimits, type PersistedToolLoopCall, type ToolLoopJsonValue } from "../runs/toolLoopPersistence";
import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import type { StorageAdapter } from "../uploads/storage";
import { createSkillBundle } from "./bundle";
import { createSkillBundleService } from "./bundleService";
import { createSkillCatalogRepository } from "./catalogRepository";
import { createSkillPreferenceService } from "./preferenceService";
import { freezeSkillManifest } from "./runManifest";
import { createSkillToolService } from "./toolService";
import { createWorkspaceSkillBundles } from "./workspaceBundles";
import { parseSkillArchive } from "../workspace/skillBundles";

const referencePath = "references/procedure.md";
const originalReference = "a".repeat(65_535) + "🙂 Frozen final page.";
const originalInstructions = "Read references/procedure.md and apply the frozen procedure.";
const textOnlyStorage: StorageAdapter = {
  async putObject() { throw new Error("unexpected_binary_storage"); },
  async getObject() { throw new Error("unexpected_binary_storage"); },
  async deleteObject() { throw new Error("unexpected_binary_storage"); }
};

function resultValue(result: ToolExecutionResult) {
  return result.content[0]?.type === "json" ? result.content[0].value : null;
}

function resultSnapshot(result: ToolExecutionResult) {
  const value = snapshotToolLoopJson(result, toolLoopPersistenceLimits.resultBytes);
  if (value === null) throw new Error("fixture_result_not_persistable");
  return value;
}

function modelCall(call: PersistedToolLoopCall): ModelToolCall {
  return { id: call.providerCallId, name: call.toolName, arguments: { ...call.arguments } };
}

async function withFixture(run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const ownerId = randomUUID(), userId = randomUUID(), groupId = randomUUID();
  await prisma.user.createMany({ data: [ownerId, userId].map((id) => ({ id, displayName: "Progressive Skill fixture", status: "active" })) });
  try {
    await run(await createFixture({ ownerId, userId, groupId }));
  } finally {
    await prisma.modelRun.deleteMany({ where: { userId } });
    await prisma.chat.deleteMany({ where: { userId } });
    const skills = await prisma.skillDefinition.findMany({ where: { ownerUserId: ownerId }, select: { id: true } });
    const skillIds = skills.map(({ id }) => id);
    await prisma.skillPublication.deleteMany({ where: { skillId: { in: skillIds } } });
    await prisma.skillDefinition.updateMany({ where: { id: { in: skillIds } }, data: { currentRevisionId: null, sharedRevisionId: null } });
    await prisma.skillShareRequest.deleteMany({ where: { skillId: { in: skillIds } } });
    await prisma.skillRevisionFile.deleteMany({ where: { skillId: { in: skillIds } } });
    await prisma.skillRevision.deleteMany({ where: { skillId: { in: skillIds } } });
    await prisma.skillDefinition.deleteMany({ where: { id: { in: skillIds } } });
    await prisma.group.deleteMany({ where: { id: groupId } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, userId] } } });
  }
}

async function createFixture(input: { ownerId: string; userId: string; groupId: string }) {
  const { ownerId, userId, groupId } = input;
  const bundles = createSkillBundleService(prisma, textOnlyStorage);
  const draft = { name: "Progressive workflow", description: "Synthetic reference-reading procedure", instructions: originalInstructions };
  const bundle = createSkillBundle(draft, [{ path: referencePath, bytes: Buffer.from(originalReference) }]);
  const imported = (await bundles.importCandidates(ownerId, [{ name: bundle.name, bundle }], 0)).results[0];
  if (!imported || imported.outcome !== "created") throw new Error("fixture_import_failed");
  const skillId = imported.skillId;
  const revisionId = (await prisma.skillDefinition.findUniqueOrThrow({ where: { id: skillId } })).currentRevisionId!;
  await prisma.skillDefinition.update({ where: { id: skillId }, data: { sharedRevisionId: revisionId } });
  await prisma.group.create({ data: { id: groupId, name: `Progressive ${groupId}` } });
  await prisma.userGroup.create({ data: { userId, groupId } });
  const publication = await prisma.skillPublication.create({ data: { skillId, scope: "group", groupId } });
  expect(await createSkillPreferenceService(prisma).set(userId, skillId, true)).toEqual({ skillId, enabled: true });
  const catalog = createSkillCatalogRepository(prisma);
  const available = await catalog.listEnabledForRun(userId);
  expect(available).toEqual([expect.objectContaining({ skillId, revisionId, fileCount: 1 })]);
  const { manifest } = freezeSkillManifest({ mode: "auto", pinned: [], available, toolsSupported: true });
  const alias = manifest.available[0]!.alias;
  const chat = await prisma.chat.create({ data: { userId, title: "Progressive Skill fixture", memoryMode: "EXCLUDED" } });
  const question = await prisma.message.create({ data: { chatId: chat.id, role: "user", content: textMessageContent("Apply the procedure") } });
  const answer = await prisma.message.create({ data: { chatId: chat.id, role: "assistant", parentMessageId: question.id,
    status: "streaming", content: textMessageContent("") } });
  const request: NormalizedRunRequest = {
    attachmentIds: [], chatId: chat.id, content: textMessageContent("Apply the procedure"),
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
    modelId: "fixture-model", provider: "fake", params: {}, prompt: { developer: null, system: null },
    searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto", skills: manifest
  };
  const modelRun = await prisma.modelRun.create({ data: {
    userId, chatId: chat.id, userMessageId: question.id, assistantMessageId: answer.id,
    modelId: request.modelId, provider: request.provider, status: "streaming",
    normalizedRequest: request as unknown as Prisma.InputJsonValue
  } });
  const operations = createPrismaRunToolLoopOperations(prisma, NOOP_MEMORY_SOURCE_MUTATION_HOOKS);
  const identity = { runId: modelRun.id, userId };
  expect(await operations.beginToolLoopProviderRound({ ...identity, providerContinuation: null, roundIndex: 0 })).toBe("started");
  const callInputs: Array<{ toolName: string; arguments: Record<string, ToolLoopJsonValue> }> = [
    { toolName: "load_skill", arguments: { skill: alias } },
    { toolName: "load_skill", arguments: { skill: alias } },
    { toolName: "read_skill_file", arguments: { skill: alias, path: referencePath } },
    { toolName: "read_skill_file", arguments: { skill: alias, path: referencePath, offset: 65_535 } },
    { toolName: "load_skill", arguments: { skill: alias } }
  ];
  const persisted = await operations.persistToolLoopCallBatch({ ...identity, providerContinuation: null, roundIndex: 0,
    calls: callInputs.map((call, ordinal) => ({ ...call, ordinal, providerCallId: `fixture-call-${ordinal}` }))
  });
  if (persisted.kind !== "persisted") throw new Error("fixture_calls_not_persisted");
  const service = createSkillToolService({
    resolveFrozen: catalog.resolveFrozen,
    async isLoaded({ runId, skillId: requestedSkillId }) {
      return await prisma.modelRunSkillBinding.count({ where: { modelRunId: runId, skillId: requestedSkillId } }) > 0;
    },
    async readText({ revisionId: requestedRevisionId, path }) {
      return (await prisma.skillRevisionFile.findUnique({ where: { revisionId_path: { revisionId: requestedRevisionId, path } },
        select: { textContent: true } }))?.textContent ?? null;
    }
  });
  const context = { ...identity, request: { ...request, attachments: [] } };
  return { ...input, ...identity, alias, skillId, revisionId, manifest, catalog, operations, request,
    chatId: chat.id, questionId: question.id, calls: persisted.calls,
    execute: (call: PersistedToolLoopCall) => service.execute(modelCall(call), context),
    claim: (call: PersistedToolLoopCall) => operations.claimToolLoopCall({ ...identity, callId: call.id }),
    settle: (call: PersistedToolLoopCall, result: ToolExecutionResult) => operations.settleToolLoopCall({ ...identity,
      callId: call.id, result: resultSnapshot(result), state: result.status }),
    revoke: () => prisma.skillPublication.delete({ where: { id: publication.id } }),
    async advanceApprovedRevision() {
      const replacement = createSkillBundle({ ...draft, instructions: "New approved instructions after run admission." },
        [{ path: referencePath, bytes: Buffer.from("New approved reference.") }]);
      expect((await bundles.importCandidates(ownerId, [{ name: replacement.name, bundle: replacement }], 0)).results[0])
        .toMatchObject({ outcome: "updated", skillId });
      const next = (await prisma.skillDefinition.findUniqueOrThrow({ where: { id: skillId } })).currentRevisionId!;
      expect(next).not.toBe(revisionId);
      await prisma.skillDefinition.update({ where: { id: skillId }, data: { sharedRevisionId: next } });
      return next;
    }
  };
}

describe("progressive Skill run persistence", () => {
  afterAll(() => prisma.$disconnect());

  it("restores only settled frozen Workspace loads and denies fresh reads after revocation", async () => {
    await withFixture(async f => {
      await prisma.modelRun.update({ where: { id: f.runId }, data: { normalizedRequest: {
        ...f.request, workspace: { enabled: true }
      } as unknown as Prisma.InputJsonValue } });
      const service = createWorkspaceSkillBundles(prisma, textOnlyStorage);
      const identity = { runId: f.runId, userId: f.userId };
      const empty = await service.plan(identity);
      expect(empty.initial).toEqual([]);
      await expect(service.archive({ ...identity, alias: f.alias })).rejects.toMatchObject({ code: "workspace_skill_bundle_invalid" });
      const first = await service.archive({ ...identity, alias: f.alias, currentAccess: true });
      expect(first.bundle).toMatchObject({ revisionId: f.revisionId, discover: false });
      const load = f.calls[0]!;
      expect(await f.claim(load)).toMatchObject({ kind: "claimed" });
      expect(await f.settle(load, await f.execute(load))).toBe("settled");
      const loaded = await service.plan(identity);
      expect(loaded.manifestHash).toBe(empty.manifestHash);
      expect(loaded.initial).toEqual([first.bundle]);
      await f.advanceApprovedRevision();
      await f.revoke();
      const archive = await service.archive({ ...identity, alias: f.alias });
      const bytes = new Uint8Array(await new Response(archive.archive).arrayBuffer());
      const reference = parseSkillArchive(bytes).find(entry => entry.path === referencePath)!;
      expect(Buffer.from(reference.content).toString()).toBe(originalReference);
      await expect(service.archive({ ...identity, alias: f.alias, currentAccess: true })).rejects.toMatchObject({ issue: { code: "skill_not_available" } });
      await expect(service.plan({ ...identity, userId: f.ownerId })).rejects.toMatchObject({ code: "workspace_skill_bundle_invalid" });
      await prisma.user.update({ where: { id: f.userId }, data: { status: "disabled" } });
      await expect(service.plan(identity)).rejects.toMatchObject({ code: "workspace_skill_bundle_invalid" });
    });
  });

  it("loads the frozen revision after editing and commits one loaded binding atomically with its result", async () => {
    await withFixture(async (f) => {
      const load = f.calls[0]!, repeat = f.calls[1]!, read = f.calls[2]!;
      const nextRevisionId = await f.advanceApprovedRevision();
      expect(await f.catalog.listEnabledForRun(f.userId)).toEqual([expect.objectContaining({ revisionId: nextRevisionId })]);
      expect(resultValue(await f.execute(read))).toEqual({ error: "skill_not_loaded" });
      expect(await f.claim(load)).toMatchObject({ kind: "claimed", call: { state: "running" } });
      const result = await f.execute(load);
      expect(resultValue(result)).toMatchObject({ instructions: originalInstructions, files: [{ path: referencePath }] });

      // Execute the real settlement writes, then fail before the transaction
      // commits. Neither half of the durable load may escape the rollback.
      const rollbackClient = new Proxy(prisma, {
        get(target, property, receiver) {
          if (property !== "$transaction") return Reflect.get(target, property, receiver);
          return (write: (tx: Prisma.TransactionClient) => Promise<unknown>) => target.$transaction(async (tx) => {
            expect(await write(tx)).toBe("settled");
            expect(await tx.modelRunSkillBinding.count({ where: { modelRunId: f.runId } })).toBe(1);
            expect((await tx.modelRunToolCall.findUniqueOrThrow({ where: { id: load.id } })).state).toBe("complete");
            throw new Error("fixture_settlement_rollback");
          });
        }
      });
      const rollbackOperations = createPrismaRunToolLoopOperations(rollbackClient, NOOP_MEMORY_SOURCE_MUTATION_HOOKS);
      const settlement = { runId: f.runId, userId: f.userId, callId: load.id, result: resultSnapshot(result), state: "complete" as const };
      await expect(rollbackOperations.settleToolLoopCall(settlement)).rejects.toThrow("fixture_settlement_rollback");
      expect(await prisma.modelRunSkillBinding.count({ where: { modelRunId: f.runId } })).toBe(0);
      expect(await prisma.modelRunToolCall.findUniqueOrThrow({ where: { id: load.id } }))
        .toMatchObject({ state: "running", result: null, completedAt: null });
      const retries = await Promise.all([f.operations.settleToolLoopCall(settlement), f.operations.settleToolLoopCall(settlement)]);
      expect(retries.sort()).toEqual(["reused", "settled"]);
      expect(await f.claim(repeat)).toMatchObject({ kind: "claimed" });
      expect(await f.settle(repeat, await f.execute(repeat))).toBe("settled");
      expect(await prisma.modelRunSkillBinding.findMany({ where: { modelRunId: f.runId },
        select: { skillId: true, revisionId: true, mode: true, alias: true, modelRunToolCallId: true } }))
        .toEqual([{ skillId: f.skillId, revisionId: f.revisionId, mode: "loaded", alias: f.alias, modelRunToolCallId: load.id }]);
      expect(resultValue(await f.execute(read))).toMatchObject({ content: "a".repeat(65_535), nextOffset: 65_535 });

      const otherRun = await prisma.modelRun.create({ data: { chatId: f.chatId, userId: f.userId, userMessageId: f.questionId,
        provider: f.request.provider, modelId: f.request.modelId, status: "complete",
        normalizedRequest: f.request as unknown as Prisma.InputJsonValue } });
      const otherCall = await prisma.modelRunToolCall.create({ data: { modelRunId: otherRun.id, roundIndex: 0,
        ordinal: 0, providerCallId: "other-call", toolName: "load_skill", arguments: { skill: f.alias } } });
      await expect(prisma.modelRunSkillBinding.update({
        where: { modelRunId_skillId: { modelRunId: f.runId, skillId: f.skillId } }, data: { modelRunToolCallId: otherCall.id }
      })).rejects.toThrow();
      expect((await prisma.modelRunSkillBinding.findUniqueOrThrow({
        where: { modelRunId_skillId: { modelRunId: f.runId, skillId: f.skillId } }
      })).modelRunToolCallId).toBe(load.id);
    });
  });

  it("rechecks grants between file pages while replaying committed results without current Skill access", async () => {
    await withFixture(async (f) => {
      const load = f.calls[0]!, firstPage = f.calls[2]!, nextPage = f.calls[3]!, revokedLoad = f.calls[4]!;
      expect(await f.claim(load)).toMatchObject({ kind: "claimed" });
      const loaded = await f.execute(load);
      expect(await f.settle(load, loaded)).toBe("settled");
      expect(firstPage.state).toBe("pending");
      expect(await f.claim(firstPage)).toMatchObject({ kind: "claimed", call: { state: "running" } });
      // An interrupted read is safe to claim again, without an ambiguous
      // side-effect outcome or a second load binding.
      expect(await f.claim(firstPage)).toMatchObject({ kind: "claimed", call: { state: "running" } });
      const page = await f.execute(firstPage);
      expect(resultValue(page)).toMatchObject({ content: "a".repeat(65_535), nextOffset: 65_535 });
      expect(await f.settle(firstPage, page)).toBe("settled");
      await f.revoke();
      expect(await f.catalog.resolveFrozen({ userId: f.userId, skillId: f.skillId, revisionId: f.revisionId })).toBeNull();

      for (const call of [nextPage, revokedLoad]) {
        expect(await f.claim(call)).toMatchObject({ kind: "claimed" });
        expect(await f.claim(call)).toMatchObject({ kind: "claimed" });
        const denied = await f.execute(call);
        expect(denied.status).toBe("error");
        expect(resultValue(denied)).toEqual({ error: "skill_not_available" });
        expect(await f.settle(call, denied)).toBe("settled");
      }
      expect(await f.claim(load)).toMatchObject({ kind: "settled", call: { result: resultSnapshot(loaded) } });
      expect(await f.claim(firstPage)).toMatchObject({ kind: "settled", call: { result: resultSnapshot(page) } });
      const recovered = await f.operations.loadCheckpointedToolLoopRun({ runId: f.runId, userId: f.userId });
      expect(recovered?.normalizedRequest.skills).toEqual(f.manifest);
      expect(recovered?.calls.find(({ id }) => id === firstPage.id)?.result).toEqual(resultSnapshot(page));
      const loadRecovery = f.operations.loadProviderDispatchRecoveryRequest;
      if (!loadRecovery) throw new Error("fixture_recovery_operation_missing");
      expect(await loadRecovery({ runId: f.runId, userId: f.userId }))
        .toMatchObject({ skills: f.manifest });
      expect(await prisma.modelRunSkillBinding.count({ where: { modelRunId: f.runId, mode: "loaded" } })).toBe(1);
    });
  });
});

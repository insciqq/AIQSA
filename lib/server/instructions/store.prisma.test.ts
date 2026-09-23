// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { Prisma } from "@prisma/client";
import { createInstructionPresetStore, assertInstructionPresetSelection } from "./store";
import { admitPreparingRunWithClient } from "../runs/prismaRepositoryPreparation";
import type { PreparingRunAdmissionInput } from "../runs/runRepositoryContract";

const users: string[] = [];
const store = createInstructionPresetStore(prisma);
const draft = { name: "Work", systemInstructions: "Synthetic first line\nPrivate second line", responseReminder: "Synthetic reminder" };
async function owner() {
  const id = `instructions-test-${randomUUID()}`;
  await prisma.user.create({ data: { id, displayName: "Synthetic instructions", status: "active" } }); users.push(id);
  await prisma.userSettings.upsert({ where: { userId: id }, create: { userId: id }, update: {} });
  await prisma.userMemorySettings.update({ where: { userId: id }, data: { useMemoryFacts: false, learnAutomatically: false, referenceChatHistory: false } });
  return id;
}
async function preset(userId: string) {
  await store.mutate(userId, { action: "create", value: draft });
  return (await store.list(userId)).presets[0]!;
}
async function plan(userId: string): Promise<PreparingRunAdmissionInput> {
  const chat = await prisma.chat.create({ data: { userId, title: "Synthetic instruction run" } });
  const { systemInstructions, responseReminder, answerRules: _answerRules, ...instructionPreset } = await store.resolveForRun(userId);
  const content = { blocks: [{ type: "text", text: "Synthetic question" }] };
  return { admissionKind: "NORMAL_SEND", chatId: chat.id, userId, content, expectedActiveLeafId: null,
    modelId: "fake-qsa", provider: "fake", providerRequestPreview: {}, normalizedRequest: {
      attachmentIds: [], chatId: chat.id, content, instructionPreset,
      knowledgePlan: { mode: "none", baseIds: [], sourceIds: [], version: 1 }, toolMode: "none",
      modelCapabilities: { vision: false, pdf: false, nativePdfInput: false, nativeSearch: false, reasoning: false },
      modelId: "fake-qsa", params: {}, provider: "fake", searchPlan: { mode: "all_selected", options: [] },
      prompt: { system: "Server baseline", developer: null, personalInstructions: systemInstructions, responseReminder }
    } };
}
afterEach(async () => {
  const ids = users.splice(0);
  await prisma.modelRun.deleteMany({ where: { userId: { in: ids } } });
  await prisma.chat.updateMany({ where: { userId: { in: ids } }, data: { activeLeafMessageId: null } });
  await prisma.message.deleteMany({ where: { chat: { userId: { in: ids } } } });
  await prisma.chat.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});
afterAll(() => prisma.$disconnect());

describe("persisted owner instructions", () => {
  it("persists custom rules with the preset revision and resets to inherited rules", async () => {
    const userId = await owner(), row = await preset(userId);
    await store.mutate(userId, { action: "select", id: row.id, selectionVersion: 0 });
    await store.mutate(userId, { action: "update", id: row.id, revision: 1, value: { ...draft, answerRules: "Use numbered paragraphs." } });
    const accepted = await store.resolveForRun(userId);
    expect(accepted).toMatchObject({ revision: 2, answerRules: "Use numbered paragraphs." });
    expect(await store.get(userId, row.id)).toMatchObject({ answerRules: "Use numbered paragraphs." });
    await store.mutate(userId, { action: "update", id: row.id, revision: 2, value: { ...draft, answerRules: null } });
    expect(await store.resolveForRun(userId)).toMatchObject({ revision: 3, answerRules: null });
    expect(accepted.answerRules).toBe("Use numbered paragraphs.");
  });
  it("isolates details and active references by owner, including the database constraint", async () => {
    const a = await owner(), b = await owner(), row = await preset(a);
    expect(await store.get(b, row.id)).toBeNull(); expect((await store.list(b)).presets).toEqual([]);
    await expect(store.mutate(b, { action: "select", id: row.id, selectionVersion: 0 })).rejects.toThrow("instruction_preset_not_found");
    await expect(prisma.userSettings.update({ where: { userId: b }, data: { activeInstructionPresetId: row.id } })).rejects.toMatchObject({ code: "P2003" });
    expect((await store.list(a)).presets[0]?.firstLine).toBe("Synthetic first line");
    expect(JSON.stringify(await store.list(a))).not.toContain("Private second line");
    expect(await store.get(a, row.id)).toMatchObject(draft);
  });

  it("serializes edit and selection conflicts, clears active deletion, and retains accepted texts", async () => {
    const userId = await owner(), row = await preset(userId);
    await store.mutate(userId, { action: "select", id: row.id, selectionVersion: 0 });
    const accepted = await store.resolveForRun(userId);
    const edits = await Promise.allSettled(["First edit", "Second edit"].map(systemInstructions => store.mutate(userId,
      { action: "update", id: row.id, revision: 1, value: { ...draft, systemInstructions } })));
    expect(edits.filter(result => result.status === "fulfilled")).toHaveLength(1);
    await expect(prisma.$transaction(tx => assertInstructionPresetSelection(tx, userId, accepted))).rejects.toThrow("instruction_selection_conflict");
    await expect(store.mutate(userId, { action: "select", id: null, selectionVersion: 0 })).rejects.toThrow("instruction_selection_conflict");
    await store.mutate(userId, { action: "delete", id: row.id, revision: 2 });
    expect(await store.resolveForRun(userId)).toMatchObject({ presetId: null, revision: null, selectionVersion: 2, systemInstructions: "", responseReminder: "" });
    expect(accepted.systemInstructions).toBe(draft.systemInstructions);
  });

  it("enforces the count limit during concurrent creation", async () => {
    const userId = await owner();
    for (let i = 0; i < 19; i++) await store.mutate(userId, { action: "create", value: { ...draft, name: `Preset ${i}` } });
    const writes = await Promise.allSettled(["Last A", "Last B"].map(name => store.mutate(userId, { action: "create", value: { ...draft, name } })));
    expect(writes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((await store.list(userId)).presets).toHaveLength(20);
  });

  it("fences initial run acceptance after an edit and preserves the exact preparing snapshot", async () => {
    const userId = await owner(), row = await preset(userId);
    await store.mutate(userId, { action: "select", id: row.id, selectionVersion: 0 });
    const stale = await plan(userId);
    await store.mutate(userId, { action: "update", id: row.id, revision: 1, value: { ...draft, systemInstructions: "Current accepted text" } });
    await expect(admitPreparingRunWithClient(prisma, stale)).rejects.toThrow("instruction_selection_conflict");
    expect(await prisma.message.count({ where: { chatId: stale.chatId } })).toBe(0);
    const current = await plan(userId);
    const admitted = await admitPreparingRunWithClient(prisma, current);
    const before = await prisma.memoryRetrievalAttempt.findUniqueOrThrow({ where: { id: admitted.attemptId } });
    await store.mutate(userId, { action: "delete", id: row.id, revision: 2 });
    const after = await prisma.memoryRetrievalAttempt.findUniqueOrThrow({ where: { id: admitted.attemptId } });
    expect(after.boundedPrivateBaseRequestSnapshot).toEqual(before.boundedPrivateBaseRequestSnapshot);
    expect(JSON.stringify(after.boundedPrivateBaseRequestSnapshot)).toContain("Current accepted text");
    expect(JSON.stringify(after.boundedPrivateBaseRequestSnapshot)).toContain(draft.responseReminder);
  });

  it("rejects a repeatable-read snapshot that waited behind a preset mutation", async () => {
    const userId = await owner(), row = await preset(userId);
    await store.mutate(userId, { action: "select", id: row.id, selectionVersion: 0 });
    const accepted = await store.resolveForRun(userId);
    let started!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const proceed = new Promise<void>(resolve => { release = resolve; });
    const stale = prisma.$transaction(async tx => {
      await tx.userSettings.findUniqueOrThrow({ where: { userId } }); started(); await proceed;
      await assertInstructionPresetSelection(tx, userId, accepted);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    const outcome = stale.then(() => "accepted", () => "rejected");
    await ready;
    await store.mutate(userId, { action: "update", id: row.id, revision: 1, value: { ...draft, responseReminder: "new reminder" } });
    release(); expect(await outcome).toBe("rejected");
  });
});

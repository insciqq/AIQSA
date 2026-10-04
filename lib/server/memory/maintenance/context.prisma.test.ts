import { randomUUID } from "node:crypto";
import type { MessageStatus } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  createAutomaticMaintenanceFact, createMaintenanceOwner, deleteMaintenanceOwner, maintenanceFixtureTime,
  settleMaintenanceJob, type MaintenanceFixtureMessage
} from "@/tests/support/memoryMaintenance";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import { createMemorySuppressionInTransaction } from "../persistence/suppressions";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import { MemorySuppressionKeyring } from "../suppressionKeyring";
import { loadMemoryMaintenanceContext } from "./context";
import { scheduleOwnerMemoryMaintenance } from "./reconcile";
import { loadMemoryMaintenanceSources } from "./source";

const owners: string[] = [];
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const userId of owners.splice(0)) await deleteMaintenanceOwner(userId);
});
afterAll(async () => { await prisma.$disconnect(); });

async function owner(): Promise<string> {
  const userId = await createMaintenanceOwner("memory-maintenance-context");
  owners.push(userId);
  return userId;
}

const QUESTION = "Which club suits my schedule?";
const PARTIAL_REPLY = "Unsettled partial reply.";
type Reply = Readonly<{ role?: "user" | "assistant"; status: MessageStatus }>;
/** question -> reply -> source a minute apart, the source being the active leaf. */
async function conversation(userId: string, reply: Reply) {
  const at = (minutes: number) => new Date(maintenanceFixtureTime().getTime() - minutes * 60_000);
  const chat = await prisma.chat.create({ data: { userId, title: "Synthetic failed reply" } });
  const question = await prisma.message.create({ data: { chatId: chat.id, role: "user", status: "complete",
    createdAt: at(3), updatedAt: at(3), content: textMessageContent(QUESTION) } });
  const replied = await prisma.message.create({ data: { chatId: chat.id, role: reply.role ?? "assistant", status: reply.status,
    parentMessageId: question.id, createdAt: at(2), updatedAt: at(2), content: textMessageContent(PARTIAL_REPLY) } });
  const text = "I train in the evenings.";
  const answer = await prisma.message.create({ data: { chatId: chat.id, role: "user", status: "complete",
    parentMessageId: replied.id, createdAt: at(1), updatedAt: at(1), content: textMessageContent(text) } });
  await prisma.chat.update({ where: { id: chat.id }, data: { activeLeafMessageId: answer.id, memorySourceRevision: 1 } });
  const source: MaintenanceFixtureMessage = { chatId: chat.id, messageId: answer.id, text };
  return { question, source, load: () => loadMemoryMaintenanceContext(prisma, userId, "unused-version",
    [{ messageId: answer.id, startOffset: 0, endOffset: text.length }]) };
}
const keyring = MemorySuppressionKeyring.parse(
  `current=test-v1,test-v1=${Buffer.from(Array.from({ length: 32 }, (_, index) => index + 71)).toString("base64")}`);

describe("maintenance context around failed replies", () => {
  it.each(["error", "cancelled"] as const)("reviews a source that follows a %s reply, passing over the reply", async (status) => {
    const userId = await owner();
    const { source, load } = await conversation(userId, { status });
    const context = await load();
    expect(context?.map(({ kind, role, text }) => ({ kind, role, text }))).toEqual([
      { kind: "REFERENCE_MESSAGE", role: "user", text: QUESTION },
      { kind: "SOURCE_MESSAGE", role: "user", text: source.text }]);
    expect(JSON.stringify(context)).not.toContain(PARTIAL_REPLY);
    const fact = await createAutomaticMaintenanceFact(userId, [{ statement: source.text, source }]);
    const read = await loadMemoryMaintenanceSources(prisma, userId, { now: new Date(), versionIds: [fact.currentVersionId] });
    expect(read.blockers.size).toBe(0);
    expect(read.sources.get(fact.currentVersionId)?.context).toEqual(context);
    // Planned and settled as an ordinary review: the apply snapshot reproduces the planned source hash.
    expect(await scheduleOwnerMemoryMaintenance(prisma, userId, new Date())).toBe(1);
    const settled = await settleMaintenanceJob(userId, () => status === "error" ? "REMOVE" : "KEEP");
    expect(settled.factIds).toEqual([fact.factId]);
    expect(await prisma.memoryMaintenanceReview.findMany({ where: { userId }, select: { disposition: true } }))
      .toEqual([{ disposition: status === "error" ? "REMOVED" : "KEEP" }]);
  });

  it.each([["assistant", "streaming"], ["assistant", "queued"], ["assistant", "complete"], ["user", "error"]] as const)(
    "keeps an %s parent in status %s a hidden boundary", async (role, status) => {
      // A complete reply without its own completed run is not verified assistant context either.
      const userId = await owner();
      const { load } = await conversation(userId, { role, status });
      expect(await load()).toBeNull();
    });

  it.each(["PAUSED", "FORGOTTEN", "RESET"] as const)("never passes over a failed reply to a %s message", async (fence) => {
    const userId = await owner();
    const { question, load } = await conversation(userId, { status: "error" });
    expect(await load()).toHaveLength(2);
    const asked = question.createdAt.getTime();
    if (fence === "PAUSED") await prisma.memoryPauseInterval.create({ data: { userId, scope: "MASTER", memoryGeneration: 0,
      pausedAt: new Date(asked - 1), resumedAt: new Date(asked + 1) } });
    if (fence === "RESET") await prisma.memorySourceBarrier.create({ data: { userId, kind: "ALL_REUSABLE",
      memoryGeneration: 0, sourceCreatedAtCutoff: new Date(asked + 1), explicitOverrideAllowed: false } });
    if (fence === "FORGOTTEN") await withLockedMemoryTransaction(prisma, userId, (tx, settings) =>
      createMemorySuppressionInTransaction(tx, settings, keyring, { suppressionId: randomUUID(), scope: "SOURCE_MESSAGE",
        chatId: question.chatId, messageId: question.id, branchGeneration: 0, explicitOverrideAllowed: false }));
    expect(await load()).toBeNull();
  });

  /** Owner actions on the conversation; each alone leaves the source unreviewable. */
  const boundaries: Readonly<Record<string, (userId: string, chatId: string) => Promise<unknown>>> = {
    "deletes the chat": async (userId, chatId) => {
      const deletion = await prisma.memoryDeletionOutbox.create({ data: { userId, operation: "SOURCE_PURGE",
        targetType: "CHAT@memory-chat-delete-v1", targetId: chatId, memoryGeneration: 0, admissionAuthorizationId: randomUUID(),
        admittedChatSourceRevision: 1, alsoForgetOriginMemories: false } });
      cleanups.push(() => prisma.chat.deleteMany({ where: { id: chatId } }));
      await prisma.chat.update({ where: { id: chatId }, data: { archived: true, memoryMode: "EXCLUDED",
        permanentDeletionAt: new Date(), permanentDeletionOperationId: deletion.id } });
    },
    "moves the chat into a Project": async (userId, chatId) => {
      const project = await prisma.project.create({ data: { name: "Synthetic Project", createdByUserId: userId,
        createdByDisplayName: "Maintenance fixture", grants: { create: { userId, role: "OWNER" } } } });
      cleanups.push(() => prisma.project.deleteMany({ where: { id: project.id } }));
      await prisma.chat.update({ where: { id: chatId }, data: { userId: null, projectId: project.id, memoryMode: "EXCLUDED",
        createdByUserId: userId, createdByDisplayName: "Maintenance fixture" } });
    },
    "edits the question onto another branch": async (_userId, chatId) => {
      const edited = await prisma.message.create({ data: { chatId, content: textMessageContent("Which gym suits my schedule?"),
        role: "user", status: "complete" } });
      await prisma.chat.update({ where: { id: chatId }, data: { activeLeafMessageId: edited.id, memorySourceRevision: { increment: 1 } } });
    }
  };
  it.each(Object.keys(boundaries))("keeps a source after a failed reply unreviewable when the owner %s", async (boundary) => {
    const userId = await owner();
    const { question, load } = await conversation(userId, { status: "cancelled" });
    expect(await load()).toHaveLength(2);
    await boundaries[boundary]!(userId, question.chatId);
    expect(await load()).toBeNull();
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { prisma } from "../prisma";
import {
  ANSWER_PROBLEM_REPORT_RETENTION_MS,
  createPrismaAnswerProblemReportRepository,
  deleteExpiredAnswerProblemReports,
  listAnswerProblemReports
} from "./repository";

/**
 * Answer problem reports on the disposable database: who may report which
 * answer, one report per user and answer, the deletion cascades, the
 * administrator list and retention. Fixture rows carry a per-test marker and
 * are removed afterwards; listed and pruned reports live in 2003, a window no
 * other fixture writes.
 */

const repository = createPrismaAnswerProblemReportRepository(prisma);
const NOW = new Date();

afterAll(() => prisma.$disconnect());

type Chat = Readonly<{ answerId: string; chatId: string; questionId: string; runId: string }>;
type Fixture = Readonly<{
  admin: string;
  member: string;
  owner: string;
  personal: Chat;
  /** Another chat of the owner. */
  other: Chat;
  /** The member's own chat. */
  memberChat: Chat;
  /** A second answer of the personal chat, still streaming. */
  streamingId: string;
}>;

/** A question and its settled answer. */
async function exchange(chatId: string, userId: string, connectionId: string, modelId: string): Promise<Chat> {
  const questionId = randomUUID();
  const answerId = randomUUID();
  const runId = randomUUID();
  await prisma.message.create({ data: { chatId, content: textMessageContent("Synthetic question"), id: questionId, role: "user" } });
  await prisma.message.create({ data: { chatId, content: textMessageContent("Synthetic answer"), id: answerId, parentMessageId: questionId,
    role: "assistant", status: "complete" } });
  await prisma.modelRun.create({ data: { assistantMessageId: answerId, chatId, id: runId, modelId, normalizedRequest: {},
    provider: connectionId, status: "complete", userId, userMessageId: questionId } });
  await prisma.providerRunBinding.create({ data: { connectionId, credentialSource: "default", executionSnapshot: {},
    modelRunId: runId, providerModelId: modelId, role: "answer" } });
  return { answerId, chatId, questionId, runId };
}

async function withFixture<T>(execute: (fixture: Fixture) => Promise<T>): Promise<T> {
  const marker = `problem-report-${randomUUID()}`;
  const connectionId = `${marker}-conn`;
  const modelId = `${marker}-model`;
  const chatIds: string[] = [];
  try {
    await prisma.providerConnection.create({ data: { displayName: "Problem Conn", family: `${marker}-family`, id: connectionId } });
    await prisma.providerModel.create({ data: { capabilities: {}, connectionId, defaultParams: {}, displayName: "Problem Model",
      id: modelId, modelId: `${marker}/model`, provider: `${marker}-family` } });
    const user = (name: string, role: "admin" | "user" = "user") => prisma.user.create({ data: {
      displayName: name, email: `${name.toLowerCase()}@${marker}.example.com`, role, status: "active"
    } });
    const owner = await user("Owner");
    const member = await user("Member");
    const admin = await user("Admin", "admin");
    const personalChat = await prisma.chat.create({ data: { memoryMode: "EXCLUDED", title: "Problem report fixture", userId: owner.id } });
    chatIds.push(personalChat.id);
    const personal = await exchange(personalChat.id, owner.id, connectionId, modelId);
    const streamingId = randomUUID();
    await prisma.message.create({ data: { chatId: personalChat.id, content: textMessageContent(""), id: streamingId,
      parentMessageId: personal.questionId, role: "assistant", status: "streaming" } });
    const otherChat = await prisma.chat.create({ data: { memoryMode: "EXCLUDED", title: "Problem report second fixture",
      userId: owner.id } });
    chatIds.push(otherChat.id);
    const other = await exchange(otherChat.id, owner.id, connectionId, modelId);
    const memberOwnChat = await prisma.chat.create({ data: { memoryMode: "EXCLUDED", title: "Problem report member fixture",
      userId: member.id } });
    chatIds.push(memberOwnChat.id);
    const memberChat = await exchange(memberOwnChat.id, member.id, connectionId, modelId);
    return await execute({ admin: admin.id, member: member.id, memberChat, other, owner: owner.id, personal, streamingId });
  } finally {
    await prisma.chat.deleteMany({ where: { id: { in: chatIds } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${marker}.example.com` } } });
    await prisma.providerModel.deleteMany({ where: { connectionId } });
    await prisma.providerConnection.deleteMany({ where: { id: connectionId } });
  }
}

const resolve = (chat: Pick<Chat, "chatId">, messageId: string, userId: string) =>
  repository.resolveAnswer({ chatId: chat.chatId, messageId, now: NOW, userId });

describe("answer problem report storage", () => {
  it("keeps one report per user and answer, updated in place with the answer's run", async () => withFixture(async (f) => {
    const target = await resolve(f.personal, f.personal.answerId, f.owner);
    expect(target).toEqual({ chatId: f.personal.chatId, messageId: f.personal.answerId, runId: f.personal.runId });

    const created = await repository.save({ comment: "It invented a source.", reason: "wrong_or_made_up", target: target!, userId: f.owner });
    expect(created).toMatchObject({ outcome: "created", report: { comment: "It invented a source.", reason: "wrong_or_made_up" } });
    const updated = await repository.save({ comment: null, reason: "too_slow", target: target!, userId: f.owner });
    expect(updated).toMatchObject({ outcome: "updated", report: { comment: null, reason: "too_slow" } });
    expect(updated!.report.updatedAt.getTime()).toBeGreaterThanOrEqual(created!.report.updatedAt.getTime());

    const rows = await prisma.answerProblemReport.findMany({ where: { messageId: f.personal.answerId } });
    expect(rows).toEqual([expect.objectContaining({ chatId: f.personal.chatId, comment: null, reason: "too_slow",
      runId: f.personal.runId, userId: f.owner })]);
    expect(await repository.readOwn(target!, f.owner)).toMatchObject({ comment: null, reason: "too_slow" });
  }));

  it("finds no answer the user cannot see, that does not exist or that is not a settled answer", async () => withFixture(async (f) => {
    // Another user, an administrator, the wrong chat, a question, a streaming answer and an unknown id look alike.
    expect(await resolve(f.personal, f.personal.answerId, f.member)).toBeNull();
    expect(await resolve(f.personal, f.personal.answerId, f.admin)).toBeNull();
    expect(await resolve(f.memberChat, f.memberChat.answerId, f.admin)).toBeNull();
    expect(await resolve(f.memberChat, f.memberChat.answerId, f.owner)).toBeNull();
    expect(await resolve(f.other, f.personal.answerId, f.owner)).toBeNull();
    expect(await resolve(f.personal, f.personal.questionId, f.owner)).toBeNull();
    expect(await resolve(f.personal, f.streamingId, f.owner)).toBeNull();
    expect(await resolve(f.personal, randomUUID(), f.owner)).toBeNull();
    expect(await resolve({ chatId: randomUUID() }, f.personal.answerId, f.owner)).toBeNull();
    // The owner's own report is not readable through another chat.
    const target = await resolve(f.personal, f.personal.answerId, f.owner);
    await repository.save({ comment: null, reason: "other", target: target!, userId: f.owner });
    expect(await repository.readOwn({ ...target!, chatId: f.other.chatId }, f.owner)).toBeNull();
  }));

  it("follows the answer, its run, its chat and the reporting account out of existence", async () => withFixture(async (f) => {
    const personal = await resolve(f.personal, f.personal.answerId, f.owner);
    await repository.save({ comment: null, reason: "other", target: personal!, userId: f.owner });
    const other = await resolve(f.other, f.other.answerId, f.owner);
    await repository.save({ comment: null, reason: "other", target: other!, userId: f.owner });
    const member = await resolve(f.memberChat, f.memberChat.answerId, f.member);
    await repository.save({ comment: null, reason: "other", target: member!, userId: f.member });

    // Deleting the run clears only the run column.
    await prisma.modelRun.delete({ where: { id: f.personal.runId } });
    expect(await prisma.answerProblemReport.findFirst({ where: { messageId: f.personal.answerId } }))
      .toMatchObject({ chatId: f.personal.chatId, runId: null });
    // Deleting the answer removes its reports.
    await prisma.message.delete({ where: { id: f.personal.answerId } });
    expect(await prisma.answerProblemReport.count({ where: { messageId: f.personal.answerId } })).toBe(0);
    // Deleting the reporting account removes that account's reports only.
    await prisma.user.delete({ where: { id: f.member } });
    expect(await prisma.answerProblemReport.findMany({ select: { userId: true },
      where: { chatId: { in: [f.other.chatId, f.memberChat.chatId] } } })).toEqual([{ userId: f.owner }]);
    // Deleting the chat removes the rest.
    await prisma.chat.delete({ where: { id: f.other.chatId } });
    expect(await prisma.answerProblemReport.count({ where: { chatId: { in: [f.personal.chatId, f.other.chatId] } } })).toBe(0);
  }));

  it("lists reports newest first with names for administrators and prunes those past 90 days", async () => withFixture(async (f) => {
    const personal = await resolve(f.personal, f.personal.answerId, f.owner);
    const older = await repository.save({ comment: "Old note", reason: "too_slow", target: personal!, userId: f.owner });
    const member = await resolve(f.memberChat, f.memberChat.answerId, f.member);
    await repository.save({ comment: "Recent note", reason: "did_not_follow_request", target: member!, userId: f.member });
    expect(older).not.toBeNull();
    const setUpdatedAt = (messageId: string, updatedAt: Date) => prisma.answerProblemReport.updateMany({
      data: { updatedAt }, where: { messageId } });
    await setUpdatedAt(f.personal.answerId, new Date("2003-07-01T00:00:00.000Z"));
    await setUpdatedAt(f.memberChat.answerId, new Date("2003-11-20T00:00:00.000Z"));
    const window = { from: new Date("2003-01-01T00:00:00.000Z"), to: new Date("2004-01-01T00:00:00.000Z") };

    const first = await listAnswerProblemReports(prisma, { ...window, limit: 1 });
    expect(first.total).toBe(2);
    expect(first.rows).toEqual([expect.objectContaining({
      comment: "Recent note", connectionName: "Problem Conn", modelName: "Problem Model", reason: "did_not_follow_request",
      runId: f.memberChat.runId, updatedAt: new Date("2003-11-20T00:00:00.000Z"),
      user: { displayName: "Member", email: expect.stringMatching(/^member@/u), id: f.member }
    })]);
    expect(first.rows[0]).not.toHaveProperty("chatId");
    expect(first.rows[0]).not.toHaveProperty("messageId");
    expect((await listAnswerProblemReports(prisma, { ...window, limit: 5 })).rows.map((row) => row.comment))
      .toEqual(["Recent note", "Old note"]);
    const own = await listAnswerProblemReports(prisma, { ...window, limit: 5, userId: f.owner });
    expect({ comments: own.rows.map((row) => row.comment), total: own.total }).toEqual({ comments: ["Old note"], total: 1 });
    await expect(listAnswerProblemReports(prisma, { ...window, limit: 0 })).rejects.toThrow(RangeError);

    // 2003-12-01 minus 90 days is 2003-09-02: the July report goes, the November one stays.
    const now = new Date("2003-12-01T00:00:00.000Z");
    expect(new Date(now.getTime() - ANSWER_PROBLEM_REPORT_RETENTION_MS).toISOString()).toBe("2003-09-02T00:00:00.000Z");
    expect(await deleteExpiredAnswerProblemReports(prisma, now)).toBeGreaterThanOrEqual(1);
    expect((await listAnswerProblemReports(prisma, { ...window, limit: 5 })).rows.map((row) => row.comment)).toEqual(["Recent note"]);
  }));
});

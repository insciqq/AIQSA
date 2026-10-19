// @vitest-environment node
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { createPrismaPasswordChangeRepository } from "../../auth/accountRepository";
import { createPrismaAdminRepository } from "../../auth/adminRepository";
import { deactivateUserAsSystem } from "../../auth/adminUserSessionCommands";
import { hashPassword } from "../../auth/password";
import { createPrismaPasswordAuthRepository } from "../../auth/passwordRepository";
import { hashToken } from "../../auth/token";
import { lockActiveAdmins, lockAuthUser } from "../../auth/transactionLocks";
import { prisma } from "../../prisma";
import { scheduledTaskScheduleColumns } from "../../scheduledTasks/store";
import { newTelegramCallbackId } from "../store/callbacks";

/**
 * Every account-security event that ends sessions ends the account's Telegram
 * link in the same transaction, and nobody else's. The installation-wide
 * revoke-all is proven by its recorded arguments in `adminRepository.prisma.test.ts`
 * (it must not delete links this test does not own).
 */

const NOW = new Date("2026-10-19T08:00:00.000Z");
const domains: string[] = [];

afterEach(async () => {
  for (const domain of domains.splice(0)) {
    const users = await prisma.user.findMany({ select: { id: true }, where: { email: { endsWith: `@${domain}` } } });
    const ids = users.map((user) => user.id);
    await prisma.scheduledTask.deleteMany({ where: { userId: { in: ids } } });
    await prisma.chat.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
});

function fixture() {
  const domain = `telegram-revoke-${randomUUID()}.example.test`;
  domains.push(domain);
  const botId = 6_000_000_000 + randomInt(1_000_000_000);
  return {
    async admin() {
      const admin = await prisma.user.create({ data: { displayName: "Telegram admin", email: `admin@${domain}`, role: "admin", status: "active" } });
      return admin.id;
    },
    /** An active account with a password, two sessions, a Telegram link and an unused link code. */
    async linkedUser(local: string, password = `password-${randomUUID()}`) {
      const email = `${local}@${domain}`;
      const user = await prisma.user.create({ data: { displayName: `Telegram ${local}`, email, status: "active" } });
      const identity = await prisma.authIdentity.create({
        data: { emailVerifiedAt: NOW, normalizedEmail: email, passwordHash: await hashPassword(password), provider: "password", providerAccountId: email,
          userId: user.id }
      });
      const sessions = await Promise.all([0, 1].map(() => prisma.authSession.create({
        data: { expiresAt: new Date("2099-01-01T00:00:00.000Z"), tokenHash: randomBytes(32).toString("hex"), userId: user.id }
      })));
      const telegramUserId = BigInt(400_000_000 + randomInt(1_000_000_000));
      const link = await prisma.telegramLink.create({
        data: { botId: BigInt(botId), telegramChatId: telegramUserId, telegramUserId, userId: user.id }
      });
      await prisma.telegramLinkCode.create({
        data: { authSessionId: sessions[0]!.id, botId: BigInt(botId), codeHash: hashToken(randomUUID()), createdAt: NOW,
          expiresAt: new Date("2099-01-01T00:00:00.000Z"), userId: user.id }
      });
      return { identityId: identity.id, linkId: link.id, password, sessions: sessions.map((session) => session.id), userId: user.id };
    }
  };
}

async function telegramRows(userId: string) {
  const [links, codes] = await Promise.all([
    prisma.telegramLink.count({ where: { userId } }), prisma.telegramLinkCode.count({ where: { userId } })
  ]);
  return { codes, links };
}

describe("Telegram links end with the account's sessions (stateful)", () => {
  it("revoking one account's sessions, disabling it or resetting its second factor ends only its link", async () => {
    const { admin, linkedUser } = fixture();
    const adminId = await admin();
    const repository = createPrismaAdminRepository(prisma);
    const revoked = await linkedUser("revoked");
    const disabled = await linkedUser("disabled");
    const reset = await linkedUser("reset");
    const bystander = await linkedUser("bystander");
    await expect(repository.revokeUserSessions({ revokedByUserId: adminId, userId: revoked.userId })).resolves.toBe(2);
    await expect(repository.disableUser({ revokedByUserId: adminId, userId: disabled.userId })).resolves.toBe("disabled");
    await expect(repository.resetUserTwoFactor({ revokedByUserId: adminId, userId: reset.userId })).resolves.toBe(2);
    for (const account of [revoked, disabled, reset]) await expect(telegramRows(account.userId)).resolves.toEqual({ codes: 0, links: 0 });
    await expect(telegramRows(bystander.userId)).resolves.toEqual({ codes: 1, links: 1 });
  });

  it("a password change ends the link while keeping the current session", async () => {
    const { linkedUser } = fixture();
    const account = await linkedUser("change");
    const identity = await prisma.authIdentity.findUniqueOrThrow({ where: { id: account.identityId } });
    await expect(createPrismaPasswordChangeRepository(prisma).changePassword({
      expectedPasswordHash: identity.passwordHash!, identityId: account.identityId, keepSessionId: account.sessions[0]!, now: NOW,
      passwordHash: await hashPassword("changed-password-ends-telegram")
    })).resolves.toBe(true);
    await expect(telegramRows(account.userId)).resolves.toEqual({ codes: 0, links: 0 });
    await expect(prisma.authSession.findUniqueOrThrow({ where: { id: account.sessions[0]! } })).resolves.toMatchObject({ revokedAt: null });
  });

  it("a password reset ends the link", async () => {
    const { linkedUser } = fixture();
    const account = await linkedUser("reset-password");
    const email = (await prisma.user.findUniqueOrThrow({ where: { id: account.userId } })).email!;
    const token = `reset-${randomUUID()}`;
    await prisma.authFlowToken.create({
      data: { expiresAt: new Date("2099-01-01T00:00:00.000Z"), identityId: account.identityId, normalizedEmail: email, purpose: "password_reset",
        sentToEmail: email, tokenHash: hashToken(token), userId: account.userId }
    });
    await expect(createPrismaPasswordAuthRepository(prisma).completePasswordReset({
      now: NOW, passwordHash: await hashPassword("reset-password-ends-telegram"), tokenHash: hashToken(token)
    })).resolves.toEqual({ normalizedEmail: email, userId: account.userId });
    await expect(telegramRows(account.userId)).resolves.toEqual({ codes: 0, links: 0 });
  });

  it("SCIM deactivation ends the link", async () => {
    const { admin, linkedUser } = fixture();
    await admin();
    const account = await linkedUser("scim");
    await expect(prisma.$transaction(async (tx) => {
      const activeAdmins = await lockActiveAdmins(tx);
      await lockAuthUser(tx, account.userId);
      return deactivateUserAsSystem(tx, { activeAdmins, now: NOW, userId: account.userId });
    })).resolves.toEqual({ kind: "disabled" });
    await expect(telegramRows(account.userId)).resolves.toEqual({ codes: 0, links: 0 });
  });

  it("deleting a task, a chat or the account removes the Telegram rows hanging off it (cascade)", async () => {
    const { linkedUser } = fixture();
    const account = await linkedUser("deleted");
    const chat = await prisma.chat.create({ data: { title: "Synthetic chat", userId: account.userId } });
    const message = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent("synthetic"), role: "user" } });
    const run = await prisma.modelRun.create({ data: {
      chatId: chat.id, modelId: "fixture", normalizedRequest: {}, provider: "fake", status: "complete", userId: account.userId, userMessageId: message.id
    } });
    const link = await prisma.telegramLink.findUniqueOrThrow({ where: { id: account.linkId } });
    await prisma.telegramCallback.create({
      data: { createdAt: NOW, expiresAt: new Date("2099-01-01T00:00:00.000Z"), id: newTelegramCallbackId(), kind: "stop_run", linkId: link.id,
        payload: { runId: run.id } }
    });
    await prisma.telegramMessageRef.create({
      data: { botId: link.botId, chatId: chat.id, linkId: link.id, messageId: message.id, telegramChatId: link.telegramChatId,
        telegramMessageId: 9n, userId: account.userId }
    });
    await prisma.telegramRunLink.create({
      data: { draftId: 3, linkId: link.id, runId: run.id, telegramChatId: link.telegramChatId, userId: account.userId }
    });
    const task = await prisma.scheduledTask.create({ data: {
      ...scheduledTaskScheduleColumns({ kind: "daily", time: "09:00" }), modelId: "fixture", prompt: "Synthetic", provider: "fake",
      telegramNotify: true, timeZone: "Europe/Moscow", title: "Synthetic brief", userId: account.userId
    } });
    const occurrence = await prisma.scheduledTaskOccurrence.create({ data: {
      finishedAt: NOW, scheduledFor: NOW, state: "COMPLETED", taskId: task.id, trigger: "manual", userId: account.userId
    } });
    await prisma.telegramScheduledDelivery.create({ data: { occurrenceId: occurrence.id, userId: account.userId } });

    await prisma.scheduledTask.deleteMany({ where: { userId: account.userId } });
    await expect(prisma.telegramScheduledDelivery.count({ where: { userId: account.userId } })).resolves.toBe(0);
    await prisma.chat.deleteMany({ where: { userId: account.userId } });
    await expect(prisma.telegramMessageRef.count({ where: { userId: account.userId } })).resolves.toBe(0);
    await expect(prisma.telegramRunLink.count({ where: { userId: account.userId } })).resolves.toBe(0);
    await prisma.user.delete({ where: { id: account.userId } });
    await expect(prisma.telegramLink.count({ where: { id: link.id } })).resolves.toBe(0);
    await expect(prisma.telegramLinkCode.count({ where: { userId: account.userId } })).resolves.toBe(0);
    await expect(prisma.telegramCallback.count({ where: { linkId: link.id } })).resolves.toBe(0);
  });
});

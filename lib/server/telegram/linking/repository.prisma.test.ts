// @vitest-environment node
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";
import { hashToken } from "../../auth/token";
import { prisma } from "../../prisma";
import type { TelegramEffectiveControl } from "../control/state";
import { newTelegramCallbackId } from "../store/callbacks";
import { createPrismaTelegramLinkingRepository, type TelegramLinkTarget } from "./repository";

/**
 * Link codes and links on a disposable database. Each test owns its users (by
 * email domain) and a random bot id, so it never touches another test's links;
 * the control state is passed in, not read from the shared singleton.
 */

const repository = createPrismaTelegramLinkingRepository(prisma);
const domains: string[] = [];
const NOW = new Date("2026-10-19T08:00:00.000Z");
const LATER = new Date("2026-10-19T08:05:00.000Z");
const EXPIRES = new Date("2026-10-19T08:10:00.000Z");

afterEach(async () => {
  for (const domain of domains.splice(0)) {
    const users = await prisma.user.findMany({ select: { id: true }, where: { email: { endsWith: `@${domain}` } } });
    const ids = users.map((user) => user.id);
    await prisma.chat.deleteMany({ where: { userId: { in: ids } } });
    await prisma.group.deleteMany({ where: { name: { startsWith: `telegram-link-${domain}` } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
});

function fixture() {
  const domain = `telegram-link-${randomUUID()}.example.test`;
  domains.push(domain);
  const botId = 5_000_000_000 + randomInt(1_000_000_000);
  const control = (overrides: Partial<TelegramEffectiveControl> = {}): TelegramEffectiveControl => ({
    bot: { generation: 1, id: botId, token: `${botId}:AAFakeTelegramBotTokenForTests_0000000`, username: "aiqsa_test_bot" },
    enabled: true, groupIds: new Set(), restricted: false, tokenState: "ready", version: 1, ...overrides
  });
  const target = (telegramUserId: number, username = "alex_example"): TelegramLinkTarget => ({
    botId, displayName: "Alex Example", telegramChatId: telegramUserId, telegramUserId, telegramUsername: username
  });
  return {
    botId,
    control,
    domain,
    target,
    telegramUser: () => 300_000_000 + randomInt(1_000_000_000),
    async user(input: Readonly<{ local?: string; status?: "active" | "disabled" | "pending"; scimDeactivated?: boolean }> = {}) {
      const user = await prisma.user.create({
        data: {
          displayName: `Telegram ${input.local ?? "user"}`, email: `${input.local ?? randomUUID()}@${domain}`,
          scimDeactivatedAt: input.scimDeactivated ? NOW : null, status: input.status ?? "active"
        }
      });
      return user.id;
    },
    async session(userId: string, input: Readonly<{ revokedAt?: Date; expiresAt?: Date }> = {}) {
      const session = await prisma.authSession.create({
        data: { expiresAt: input.expiresAt ?? new Date("2099-01-01T00:00:00.000Z"), revokedAt: input.revokedAt ?? null,
          tokenHash: randomBytes(32).toString("hex"), userId }
      });
      return session.id;
    },
    async code(userId: string, sessionId: string, input: Readonly<{ expiresAt?: Date; botId?: number }> = {}) {
      const code = randomBytes(32).toString("base64url");
      await repository.createCode({
        authSessionId: sessionId, botId: input.botId ?? botId, codeHash: hashToken(code), expiresAt: input.expiresAt ?? EXPIRES, now: NOW, userId
      });
      return hashToken(code);
    }
  };
}

describe("Telegram link codes and links (stateful)", () => {
  it("links a Telegram account once per code and keeps its username and name only on the link", async () => {
    const { code, control, session, target, telegramUser, user } = fixture();
    const userId = await user();
    const codeHash = await code(userId, await session(userId));
    const telegramUserId = telegramUser();
    const linked = await repository.consumeCodeAndLink({ codeHash, control: control(), now: LATER, target: target(telegramUserId) });
    expect(linked).toMatchObject({ accountName: "Telegram user", kind: "linked", link: { telegramUserId, userId }, replaced: null });
    await expect(repository.consumeCodeAndLink({ codeHash, control: control(), now: LATER, target: target(telegramUser()) }))
      .resolves.toEqual({ code: "telegram_link_code_invalid", kind: "refused" });
    const row = await prisma.telegramLink.findUniqueOrThrow({ where: { userId } });
    expect(row).toMatchObject({ displayName: "Alex Example", telegramChatId: BigInt(telegramUserId), telegramUsername: "alex_example" });
    await expect(prisma.telegramLinkCode.findUniqueOrThrow({ where: { codeHash } })).resolves.toMatchObject({ consumedAt: LATER });
  });

  it("refuses an expired code, another bot's code, and a code whose creating session was revoked or expired, consuming it", async () => {
    const { code, control, session, target, telegramUser, user } = fixture();
    const userId = await user();
    const live = await session(userId);
    const expired = await code(userId, live, { expiresAt: new Date(NOW.getTime() + 60_000) });
    await expect(repository.consumeCodeAndLink({ codeHash: expired, control: control(), now: EXPIRES, target: target(telegramUser()) }))
      .resolves.toEqual({ code: "telegram_link_code_invalid", kind: "refused" });
    const otherBot = await code(userId, live);
    await expect(repository.consumeCodeAndLink({
      codeHash: otherBot, control: control(), now: LATER, target: { ...target(telegramUser()), botId: 42 }
    })).resolves.toEqual({ code: "telegram_link_code_invalid", kind: "refused" });
    for (const sessionId of [await session(userId, { revokedAt: NOW }), await session(userId, { expiresAt: NOW })]) {
      const codeHash = await code(userId, sessionId);
      await expect(repository.consumeCodeAndLink({ codeHash, control: control(), now: LATER, target: target(telegramUser()) }))
        .resolves.toEqual({ code: "telegram_link_code_invalid", kind: "refused" });
      await expect(prisma.telegramLinkCode.findUniqueOrThrow({ where: { codeHash } })).resolves.toMatchObject({ consumedAt: LATER });
    }
    await expect(prisma.telegramLink.count({ where: { userId } })).resolves.toBe(0);
  });

  it("refuses accounts without Telegram access: disabled, SCIM-deactivated, outside the allowed groups or only in an archived one", async () => {
    const context = fixture();
    const { code, control, domain, session, target, telegramUser, user } = context;
    const group = await prisma.group.create({ data: { name: `telegram-link-${domain}-allowed` } });
    const archived = await prisma.group.create({ data: { archivedAt: NOW, name: `telegram-link-${domain}-archived` } });
    const restricted = control({ groupIds: new Set([group.id, archived.id]), restricted: true });
    const cases: Array<[Promise<string>, TelegramEffectiveControl]> = [
      [user({ status: "disabled" }), control()],
      [user({ scimDeactivated: true }), control()],
      [user(), restricted],
      [user(), control({ enabled: false })]
    ];
    const archivedMember = await user();
    await prisma.userGroup.create({ data: { groupId: archived.id, userId: archivedMember } });
    cases.push([Promise.resolve(archivedMember), restricted]);
    for (const [pending, state] of cases) {
      const userId = await pending;
      const codeHash = await code(userId, await session(userId));
      await expect(repository.consumeCodeAndLink({ codeHash, control: state, now: LATER, target: target(telegramUser()) }))
        .resolves.toEqual({ code: "telegram_access_off", kind: "refused" });
    }
    const member = await user();
    await prisma.userGroup.create({ data: { groupId: group.id, userId: member } });
    const codeHash = await code(member, await session(member));
    await expect(repository.consumeCodeAndLink({ codeHash, control: restricted, now: LATER, target: target(telegramUser()) }))
      .resolves.toMatchObject({ kind: "linked" });
  });

  it("refuses a Telegram account linked to another user and leaves that link alone", async () => {
    const { code, control, session, target, telegramUser, user } = fixture();
    const first = await user({ local: "first" });
    const second = await user({ local: "second" });
    const telegramUserId = telegramUser();
    await repository.consumeCodeAndLink({ codeHash: await code(first, await session(first)), control: control(), now: LATER, target: target(telegramUserId) });
    await expect(repository.consumeCodeAndLink({
      codeHash: await code(second, await session(second)), control: control(), now: LATER, target: target(telegramUserId)
    })).resolves.toEqual({ code: "telegram_account_in_use", kind: "refused" });
    await expect(prisma.telegramLink.findUniqueOrThrow({ where: { userId: first } })).resolves.toMatchObject({ telegramUserId: BigInt(telegramUserId) });
    await expect(prisma.telegramLink.count({ where: { userId: second } })).resolves.toBe(0);
  });

  it("replaces the user's link to another Telegram account with its buttons and references, keeping chats", async () => {
    const { botId, code, control, session, target, telegramUser, user } = fixture();
    const userId = await user();
    const oldAccount = telegramUser();
    const first = await repository.consumeCodeAndLink({
      codeHash: await code(userId, await session(userId)), control: control(), now: LATER, target: target(oldAccount)
    });
    if (first.kind !== "linked") throw new Error("first link refused");
    const chat = await prisma.chat.create({ data: { title: "Synthetic chat", userId } });
    await prisma.telegramCallback.create({
      data: { createdAt: NOW, expiresAt: EXPIRES, id: newTelegramCallbackId(), kind: "select_chat", linkId: first.link.id, payload: {} }
    });
    await prisma.telegramMessageRef.create({
      data: { botId: BigInt(botId), chatId: chat.id, linkId: first.link.id, telegramChatId: BigInt(oldAccount), telegramMessageId: 7n, userId }
    });
    const newAccount = telegramUser();
    const second = await repository.consumeCodeAndLink({
      codeHash: await code(userId, await session(userId)), control: control(), now: LATER, target: target(newAccount, "alex_new")
    });
    expect(second).toMatchObject({ kind: "linked", replaced: { botId, telegramChatId: oldAccount } });
    if (second.kind !== "linked") throw new Error("second link refused");
    expect(second.link.id).not.toBe(first.link.id);
    await expect(prisma.telegramCallback.count({ where: { linkId: first.link.id } })).resolves.toBe(0);
    await expect(prisma.telegramMessageRef.count({ where: { linkId: first.link.id } })).resolves.toBe(0);
    await expect(prisma.chat.count({ where: { id: chat.id } })).resolves.toBe(1);
  });

  it("refreshes the same Telegram account's link in place, keeping its chat and settings", async () => {
    const { code, control, session, target, telegramUser, user } = fixture();
    const userId = await user();
    const account = telegramUser();
    const first = await repository.consumeCodeAndLink({
      codeHash: await code(userId, await session(userId)), control: control(), now: LATER, target: target(account)
    });
    if (first.kind !== "linked") throw new Error("first link refused");
    const chat = await prisma.chat.create({ data: { title: "Synthetic chat", userId } });
    await prisma.telegramLink.update({ data: { currentChatId: chat.id, searchEnabled: false }, where: { id: first.link.id } });
    const again = await repository.consumeCodeAndLink({
      codeHash: await code(userId, await session(userId)), control: control(), now: EXPIRES, target: target(account, "alex_renamed")
    });
    expect(again).toMatchObject({ kind: "linked", link: { id: first.link.id, telegramUsername: "alex_renamed" }, replaced: null });
    await expect(prisma.telegramLink.findUniqueOrThrow({ where: { id: first.link.id } }))
      .resolves.toMatchObject({ currentChatId: chat.id, linkedAt: LATER, searchEnabled: false });
    // Deleting the current chat clears only that column (column-scoped SET NULL).
    await prisma.chat.delete({ where: { id: chat.id } });
    await expect(prisma.telegramLink.findUniqueOrThrow({ where: { id: first.link.id } })).resolves.toMatchObject({ currentChatId: null, userId });
  });

  it("lets exactly one of two concurrent uses of a code win", async () => {
    const { code, control, session, target, telegramUser, user } = fixture();
    const userId = await user();
    const codeHash = await code(userId, await session(userId));
    const outcomes = await Promise.all([telegramUser(), telegramUser()].map((account) =>
      repository.consumeCodeAndLink({ codeHash, control: control(), now: LATER, target: target(account) })));
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["linked", "refused"]);
    await expect(prisma.telegramLink.count({ where: { userId } })).resolves.toBe(1);
  });

  it("spends the losing code when another account links the same Telegram account during its attempt", async () => {
    const { botId, code, control, session, target, telegramUser, user } = fixture();
    const winner = await user({ local: "winner" });
    const loser = await user({ local: "loser" });
    const telegramUserId = telegramUser();
    const codeHash = await code(loser, await session(loser));
    // The winner's link commits between the loser's holder check and its insert, so the insert hits the unique key.
    const racing = createPrismaTelegramLinkingRepository({
      $transaction: ((work: (tx: Prisma.TransactionClient) => Promise<unknown>) => prisma.$transaction((tx) => work(new Proxy(tx, {
        get(client, property) {
          const value: unknown = Reflect.get(client, property);
          if (property !== "telegramLink") return typeof value === "function" ? value.bind(client) : value;
          const links = value as Prisma.TransactionClient["telegramLink"];
          return new Proxy(links, {
            get(delegate, method) {
              const member: unknown = Reflect.get(delegate, method);
              if (method !== "create") return typeof member === "function" ? member.bind(delegate) : member;
              return async (args: Parameters<typeof links.create>[0]) => {
                await prisma.telegramLink.create({
                  data: { botId: BigInt(botId), linkedAt: NOW, telegramChatId: BigInt(telegramUserId), telegramUserId: BigInt(telegramUserId), userId: winner }
                });
                return links.create(args);
              };
            }
          });
        }
      })))) as typeof prisma.$transaction,
      telegramLink: prisma.telegramLink,
      telegramLinkCode: prisma.telegramLinkCode
    });
    await expect(racing.consumeCodeAndLink({ codeHash, control: control(), now: LATER, target: target(telegramUserId) }))
      .resolves.toEqual({ code: "telegram_account_in_use", kind: "refused" });
    await expect(prisma.telegramLinkCode.findUniqueOrThrow({ where: { codeHash } })).resolves.toMatchObject({ consumedAt: LATER });
    await expect(prisma.telegramLink.count({ where: { userId: loser } })).resolves.toBe(0);
    await expect(prisma.telegramLink.findUniqueOrThrow({ where: { userId: winner } })).resolves.toMatchObject({ telegramUserId: BigInt(telegramUserId) });
    // The spent code cannot link the loser once the winner unlinks.
    await prisma.telegramLink.delete({ where: { userId: winner } });
    await expect(repository.consumeCodeAndLink({ codeHash, control: control(), now: LATER, target: target(telegramUserId) }))
      .resolves.toEqual({ code: "telegram_link_code_invalid", kind: "refused" });
  });

  it("keeps one unused code per user and unlinks only the named link", async () => {
    const { code, control, session, target, telegramUser, user } = fixture();
    const userId = await user();
    const sessionId = await session(userId);
    const replaced = await code(userId, sessionId);
    const current = await code(userId, sessionId);
    await expect(prisma.telegramLinkCode.count({ where: { codeHash: replaced } })).resolves.toBe(0);
    const linked = await repository.consumeCodeAndLink({ codeHash: current, control: control(), now: LATER, target: target(telegramUser()) });
    if (linked.kind !== "linked") throw new Error("link refused");
    await expect(repository.unlinkLink({ linkId: randomUUID(), userId })).resolves.toBeNull();
    await expect(repository.unlinkLink({ linkId: linked.link.id, userId })).resolves.toEqual({
      botId: linked.link.botId, telegramChatId: linked.link.telegramChatId
    });
    await expect(repository.unlink(userId)).resolves.toBeNull();
  });

  it("enforces hashed codes, ordered expiry and private chats in the database", async () => {
    const { botId, session, user } = fixture();
    const userId = await user();
    const authSessionId = await session(userId);
    await expect(prisma.telegramLinkCode.create({
      data: { authSessionId, botId: BigInt(botId), codeHash: "x".repeat(64), createdAt: NOW, expiresAt: EXPIRES, userId }
    })).rejects.toThrow();
    await expect(prisma.telegramLinkCode.create({
      data: { authSessionId, botId: BigInt(botId), codeHash: "a".repeat(64), createdAt: NOW, expiresAt: NOW, userId }
    })).rejects.toThrow();
    await expect(prisma.telegramLink.create({
      data: { botId: BigInt(botId), telegramChatId: -100n, telegramUserId: 5n, userId }
    })).rejects.toThrow();
  });
});

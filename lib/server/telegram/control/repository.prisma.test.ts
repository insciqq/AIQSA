// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { TelegramBotControl } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../prisma";
import { createPrismaTelegramControlRepository, TELEGRAM_CONTROL_ID } from "./repository";

/**
 * The installation's Telegram control row on a disposable database. The row
 * is a singleton the migration creates, so each test starts it from the
 * unconfigured state and puts back exactly what it found.
 */

const repository = createPrismaTelegramControlRepository(prisma);
let saved: Readonly<{ row: TelegramBotControl; groupIds: string[] }> | null = null;
const groupNames: string[] = [];
const admins: string[] = [];

beforeEach(async () => {
  const row = await prisma.telegramBotControl.findUniqueOrThrow({ where: { id: TELEGRAM_CONTROL_ID } });
  const groups = await prisma.telegramBotGroup.findMany({ select: { groupId: true } });
  saved = { groupIds: groups.map((group) => group.groupId), row };
  await prisma.telegramBotGroup.deleteMany({});
  await prisma.telegramBotControl.update({
    data: {
      botId: null, botUsername: null, enabled: false, lastFailureAt: null, lastFailureCode: null, lastPollAt: null, lastSuccessAt: null,
      restricted: false, tokenEnvelope: null, tokenGeneration: 0, updateOffset: null, updatedByUserId: null
    },
    where: { id: TELEGRAM_CONTROL_ID }
  });
});

afterEach(async () => {
  if (saved) {
    const { createdAt: _createdAt, id: _id, updatedAt: _updatedAt, ...row } = saved.row;
    await prisma.telegramBotGroup.deleteMany({});
    await prisma.telegramBotControl.update({ data: row, where: { id: TELEGRAM_CONTROL_ID } });
    if (saved.groupIds.length) await prisma.telegramBotGroup.createMany({ data: saved.groupIds.map((groupId) => ({ groupId })), skipDuplicates: true });
  }
  await prisma.group.deleteMany({ where: { name: { in: groupNames.splice(0) } } });
  await prisma.user.deleteMany({ where: { id: { in: admins.splice(0) } } });
});

async function admin(): Promise<string> {
  const user = await prisma.user.create({ data: { displayName: "Telegram admin", email: `telegram-control-${randomUUID()}@example.test`, role: "admin", status: "active" } });
  admins.push(user.id);
  return user.id;
}

async function group(archived = false): Promise<string> {
  const name = `telegram-control-${randomUUID()}`;
  groupNames.push(name);
  return (await prisma.group.create({ data: { archivedAt: archived ? new Date() : null, name } })).id;
}

const save = (actorUserId: string, expectedVersion: number, botId: number, seals: number[] = []) => repository.saveToken({
  actorUserId, botId, botUsername: "aiqsa_test_bot", expectedVersion, seal: (generation) => { seals.push(generation); return `sealed-${generation}`; }
});

describe("Telegram control repository (stateful)", () => {
  it("stores a proved token for its next generation and restarts the poll offset only for another bot", async () => {
    const actor = await admin();
    const { version } = await repository.read();
    await expect(save(actor, version - 1, 7)).resolves.toEqual({ kind: "stale" });
    const seals: number[] = [];
    const first = await save(actor, version, 7, seals);
    expect(first).toMatchObject({ kind: "ok", record: { botId: 7, botUsername: "aiqsa_test_bot", tokenEnvelope: "sealed-1", tokenGeneration: 1, version: version + 1 } });
    expect(seals).toEqual([1]);
    await prisma.telegramBotControl.update({
      data: { lastFailureAt: new Date(), lastFailureCode: "telegram_poll_conflict", updateOffset: 1_234n }, where: { id: TELEGRAM_CONTROL_ID }
    });
    await expect(save(actor, version + 1, 7)).resolves.toMatchObject({ record: { lastFailureCode: null, tokenGeneration: 2 } });
    await expect(prisma.telegramBotControl.findUniqueOrThrow({ where: { id: TELEGRAM_CONTROL_ID } })).resolves.toMatchObject({ updateOffset: 1_234n });
    await save(actor, version + 2, 8);
    await expect(prisma.telegramBotControl.findUniqueOrThrow({ where: { id: TELEGRAM_CONTROL_ID } }))
      .resolves.toMatchObject({ botId: 8n, tokenGeneration: 3, updateOffset: null, updatedByUserId: actor });
  });

  it("enables only with a stored token, and of two writers naming the same version exactly one wins", async () => {
    const actor = await admin();
    const { version } = await repository.read();
    await expect(repository.setEnabled({ actorUserId: actor, enabled: true, expectedVersion: version })).resolves.toEqual({ kind: "token_missing" });
    await save(actor, version, 7);
    await expect(repository.setEnabled({ actorUserId: actor, enabled: true, expectedVersion: version + 1 }))
      .resolves.toMatchObject({ kind: "ok", record: { enabled: true, version: version + 2 } });
    const outcomes = await Promise.all([
      repository.setEnabled({ actorUserId: actor, enabled: false, expectedVersion: version + 2 }),
      repository.setAccess({ actorUserId: actor, expectedVersion: version + 2, groupIds: [], restricted: true })
    ]);
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["ok", "stale"]);
  });

  it("replaces the access groups with existing, active groups only", async () => {
    const actor = await admin();
    const [first, second, archived] = [await group(), await group(), await group(true)];
    const { version } = await repository.read();
    for (const groupIds of [[randomUUID()], [archived], [first, first]]) {
      await expect(repository.setAccess({ actorUserId: actor, expectedVersion: version, groupIds, restricted: true }))
        .resolves.toEqual({ kind: "groups_invalid" });
    }
    await expect(repository.setAccess({ actorUserId: actor, expectedVersion: version, groupIds: [second, first], restricted: true }))
      .resolves.toMatchObject({ record: { groupIds: [first, second].sort(), restricted: true } });
    await expect(repository.setAccess({ actorUserId: actor, expectedVersion: version + 1, groupIds: [second], restricted: false }))
      .resolves.toMatchObject({ record: { groupIds: [second], restricted: false } });
    await prisma.group.delete({ where: { id: second } });
    await expect(repository.read()).resolves.toMatchObject({ groupIds: [] });
  });

  it("records poll health for the current bot only, without changing the version", async () => {
    const actor = await admin();
    const { version } = await repository.read();
    await save(actor, version, 7);
    const at = new Date("2026-10-19T08:00:00.000Z");
    await repository.recordPollHealth({ at, botId: 7, failureCode: "telegram_poll_conflict", success: false });
    await repository.recordPollHealth({ at: new Date(at.getTime() + 1_000), botId: 9, failureCode: null, success: true });
    await expect(repository.read()).resolves.toMatchObject({
      lastFailureAt: at, lastFailureCode: "telegram_poll_conflict", lastPollAt: at, lastSuccessAt: null, version: version + 1
    });
    await repository.recordPollHealth({ at: new Date(at.getTime() + 2_000), botId: 7, failureCode: null, success: true });
    await expect(repository.read()).resolves.toMatchObject({ lastSuccessAt: new Date(at.getTime() + 2_000), version: version + 1 });
  });

  it("keeps the row a singleton and the token, generation, bot and switch consistent in the database", async () => {
    await expect(prisma.telegramBotControl.create({ data: { id: "other" } })).rejects.toThrow();
    const write = (data: Parameters<typeof prisma.telegramBotControl.update>[0]["data"]) =>
      prisma.telegramBotControl.update({ data, where: { id: TELEGRAM_CONTROL_ID } });
    await expect(write({ enabled: true })).rejects.toThrow();
    await expect(write({ tokenEnvelope: "sealed", tokenGeneration: 1 })).rejects.toThrow();
    await expect(write({ botId: 7n, botUsername: "aiqsa_test_bot", tokenEnvelope: "sealed", tokenGeneration: 0 })).rejects.toThrow();
    await expect(write({ updateOffset: 5n })).rejects.toThrow();
    await expect(write({ lastFailureCode: "telegram_unreachable" })).rejects.toThrow();
    await expect(write({ version: 0 })).rejects.toThrow();
  });
});

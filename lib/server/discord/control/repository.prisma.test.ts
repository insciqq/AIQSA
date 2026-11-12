// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { DiscordBotControl } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServiceAccount } from "../../auth/serviceAccounts";
import { prisma } from "../../prisma";
import { createPrismaDiscordControlRepository, DISCORD_CONTROL_ID } from "./repository";

/**
 * The installation's Discord control row on a disposable database. The row is
 * a singleton the migration creates, so each test starts it from the
 * unconfigured state and puts back exactly what it found.
 */

const repository = createPrismaDiscordControlRepository(prisma);
let saved: DiscordBotControl | null = null;
const users: string[] = [];

const UNCONFIGURED = {
  applicationId: null, assistantId: null, botRoleId: null, botUserId: null, botUsername: null, channelIds: [], channelMode: "only_listed" as const,
  dmEnabled: false, enabled: false, enabledAt: null, guildId: null, guildName: null, identifyAt: [], lastConnectedAt: null, lastEventAt: null,
  lastFailureAt: null, lastFailureCode: null, resumeGatewayUrl: null, serviceUserId: null, sessionGeneration: null, sessionId: null, sessionSeq: null,
  testAuthorIds: [], testChannelIds: [], tokenEnvelope: null, tokenGeneration: 0, updatedByUserId: null
};

beforeEach(async () => {
  saved = await prisma.discordBotControl.findUniqueOrThrow({ where: { id: DISCORD_CONTROL_ID } });
  await prisma.discordBotControl.update({ data: UNCONFIGURED, where: { id: DISCORD_CONTROL_ID } });
});

afterEach(async () => {
  if (saved) {
    const { createdAt: _createdAt, id: _id, updatedAt: _updatedAt, ...row } = saved;
    // The users this test made go first; put back what was there before.
    await prisma.discordBotControl.update({ data: { ...UNCONFIGURED }, where: { id: DISCORD_CONTROL_ID } });
    await prisma.user.deleteMany({ where: { id: { in: users.splice(0) } } });
    await prisma.discordBotControl.update({ data: row, where: { id: DISCORD_CONTROL_ID } });
  }
});

async function admin(): Promise<string> {
  const user = await prisma.user.create({
    data: { displayName: "Discord admin", email: `discord-control-${randomUUID()}@example.test`, role: "admin", status: "active" }
  });
  users.push(user.id);
  return user.id;
}

const save = (actorUserId: string, expectedVersion: number, botUserId = "1100000000000000001") => repository.saveToken({
  actorUserId, applicationId: "1100000000000000002", botUserId, botUsername: "aiqsa-test", expectedVersion,
  seal: (generation) => `sealed-${generation}`
});

describe("Discord control repository (stateful)", () => {
  it("bumps the version on every administrator write and refuses a stale one", async () => {
    const actor = await admin();
    const start = (await repository.read()).version;
    const saved = await save(actor, start);
    expect(saved).toMatchObject({ kind: "ok", record: { botUserId: "1100000000000000001", tokenEnvelope: "sealed-1", tokenGeneration: 1, version: start + 1 } });
    expect(await save(actor, start)).toEqual({ kind: "stale" });
    const enabled = await repository.setEnabled({ actorUserId: actor, enabled: true, expectedVersion: start + 1, now: new Date("2026-11-12T09:00:00.000Z") });
    expect(enabled).toMatchObject({ kind: "ok", record: { enabled: true, enabledAt: new Date("2026-11-12T09:00:00.000Z"), version: start + 2 } });
    const again = await repository.setEnabled({ actorUserId: actor, enabled: true, expectedVersion: start + 2, now: new Date("2026-11-12T10:00:00.000Z") });
    // Already on: the time it went on stays.
    expect(again.kind === "ok" && again.record.enabledAt).toEqual(new Date("2026-11-12T09:00:00.000Z"));
  });

  it("refuses Enable without a token, in the repository and in the database", async () => {
    const actor = await admin();
    const { version } = await repository.read();
    expect(await repository.setEnabled({ actorUserId: actor, enabled: true, expectedVersion: version, now: new Date() })).toEqual({ kind: "token_missing" });
    await expect(prisma.discordBotControl.update({ data: { enabled: true, enabledAt: new Date() }, where: { id: DISCORD_CONTROL_ID } })).rejects.toThrow();
  });

  it("keeps the session, sequence and health of the current token only, without bumping the version", async () => {
    const actor = await admin();
    const first = await save(actor, (await repository.read()).version);
    if (first.kind !== "ok") throw new Error("save failed");
    const version = first.record.version;
    const session = { resumeGatewayUrl: "wss://gateway-test.discord.gg/?v=10&encoding=json", seq: 3, sessionId: "session-a" };
    await repository.saveSession({ generation: 1, session });
    await repository.saveProgress({ generation: 1, lastEventAt: new Date("2026-11-12T09:00:05.000Z"), seq: 9, sessionId: "session-a" });
    // Another session's progress, or a replaced token's, writes nothing.
    await repository.saveProgress({ generation: 1, lastEventAt: new Date(), seq: 99, sessionId: "session-b" });
    await repository.saveSession({ generation: 7, session: { ...session, sessionId: "stale" } });
    await repository.recordHealth({ connectedAt: new Date("2026-11-12T09:00:00.000Z"), failure: null, generation: 1 });
    let read = await repository.read();
    expect(read).toMatchObject({
      lastConnectedAt: new Date("2026-11-12T09:00:00.000Z"), lastEventAt: new Date("2026-11-12T09:00:05.000Z"),
      session: { ...session, generation: 1, seq: 9 }, version
    });
    await repository.recordHealth({ failure: { at: new Date("2026-11-12T09:10:00.000Z"), code: "discord_disconnected", keepEarlier: true }, generation: 1 });
    await repository.recordHealth({ failure: { at: new Date("2026-11-12T09:20:00.000Z"), code: "discord_disconnected", keepEarlier: true }, generation: 1 });
    read = await repository.read();
    expect(read).toMatchObject({ lastFailureAt: new Date("2026-11-12T09:10:00.000Z"), lastFailureCode: "discord_disconnected", version });
    // A stale process giving up another session, or one of a replaced token, leaves the stored one alone.
    await repository.forgetSession({ generation: 1, sessionId: "session-b" });
    await repository.forgetSession({ generation: 7, sessionId: "session-a" });
    expect((await repository.read()).session?.sessionId).toBe("session-a");
    await repository.forgetSession({ generation: 1, sessionId: "session-a" });
    expect(await repository.read()).toMatchObject({ session: null, version });
    // A new token starts without the old one's session and health.
    const second = await save(actor, version, "1100000000000000009");
    expect(second).toMatchObject({ kind: "ok", record: { lastFailureCode: null, session: null, tokenGeneration: 2 } });
  });

  it("grants at most the limit of IDENTIFY permits within the window, whichever process asks", async () => {
    const now = new Date("2026-11-12T12:00:00.000Z");
    const results = await Promise.all(Array.from({ length: 5 }, () => repository.reserveIdentify({ limit: 3, now, windowMs: 86_400_000 })));
    expect(results.filter((result) => result.ok)).toHaveLength(3);
    const refused = results.find((result) => !result.ok);
    expect(refused).toMatchObject({ count: 3, ok: false, retryAt: new Date("2026-11-13T12:00:00.000Z") });
    expect(await repository.reserveIdentify({ limit: 3, now: new Date("2026-11-13T12:00:01.000Z"), windowMs: 86_400_000 })).toMatchObject({ ok: true });
    expect((await repository.read()).identifyAt).toHaveLength(1);
  });

  it("binds one service account and keeps it on a second click, until the account is deleted", async () => {
    const actor = await admin();
    const { version } = await repository.read();
    const create = async (tx: Parameters<Parameters<typeof repository.bindServiceAccount>[0]["create"]>[0]) => {
      const created = await createServiceAccount(tx, { createdByUserId: actor, displayName: "Discord" });
      if (created.kind !== "created") return { kind: "actor_forbidden" as const };
      users.push(created.account.id);
      return { kind: "created" as const, userId: created.account.id };
    };
    const first = await repository.bindServiceAccount({ actorUserId: actor, create, expectedVersion: version });
    expect(first).toMatchObject({ created: true, kind: "ok", record: { version: version + 1 } });
    const again = await repository.bindServiceAccount({ actorUserId: actor, create, expectedVersion: version + 1 });
    expect(again).toMatchObject({ created: false, kind: "ok", record: { version: version + 1 } });
    const account = await prisma.user.findUniqueOrThrow({ where: { id: first.kind === "ok" ? first.record.serviceUserId! : "" } });
    expect(account).toMatchObject({ email: null, kind: "service", role: "user", status: "active" });
    // Deleting the account leaves the control row without one.
    await prisma.user.delete({ where: { id: account.id } });
    expect((await repository.read()).serviceUserId).toBeNull();
  });

  it("forgets the old server's channels and the bot's role when another server is chosen", async () => {
    const actor = await admin();
    await save(actor, (await repository.read()).version);
    let { version } = await repository.read();
    await repository.setGuild({ actorUserId: actor, expectedVersion: version, guildId: "1100000000000000100", guildName: "Example server" });
    ({ version } = await repository.read());
    await repository.setChannels({ actorUserId: actor, channelIds: ["1100000000000000101"], channelMode: "all_except", expectedVersion: version });
    ({ version } = await repository.read());
    await repository.setTestAccess({ actorUserId: actor, expectedVersion: version, testAuthorIds: ["1100000000000000200"], testChannelIds: ["1100000000000000101"] });
    await repository.recordBotRole({ generation: 1, guildId: "1100000000000000100", roleId: "1100000000000000300" });
    await repository.recordBotRole({ generation: 1, guildId: "1100000000000000999", roleId: "1100000000000000301" });
    let read = await repository.read();
    expect(read).toMatchObject({
      botRoleId: "1100000000000000300", channelIds: ["1100000000000000101"], channelMode: "all_except", testAuthorIds: ["1100000000000000200"],
      testChannelIds: ["1100000000000000101"]
    });
    await repository.setGuild({ actorUserId: actor, expectedVersion: read.version, guildId: "1100000000000000400", guildName: "Second server" });
    read = await repository.read();
    expect(read).toMatchObject({
      botRoleId: null, channelIds: [], guildId: "1100000000000000400", guildName: "Second server", testAuthorIds: ["1100000000000000200"], testChannelIds: []
    });
  });
});

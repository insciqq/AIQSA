// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { UsageLimitValues } from "../../contracts/usageLimits";
import { decideUsageAdmission, USAGE_DAY_MS, USAGE_HOUR_MS } from "../../domain/usageLimits";
import { prisma } from "../prisma";
import { createUsageLimitsRepository } from "./repository";

const repository = createUsageLimitsRepository(prisma);
const unset: UsageLimitValues = { messagesPerDay: null, messagesPerHour: null, monthlyBudgetMicros: null };
// A month no other fixture writes usage into, so installation-wide sums stay exact.
const now = new Date("2033-03-15T12:00:00.000Z");
const minutes = (count: number) => count * 60_000;
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

const cleanups: Array<() => Promise<void>> = [];
let originalPolicy: Prisma.UsageLimitPolicyUncheckedUpdateInput | null = null;

beforeAll(async () => {
  const policy = await prisma.usageLimitPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  originalPolicy = {
    messagesPerDay: policy.messagesPerDay,
    messagesPerHour: policy.messagesPerHour,
    monthlyBudgetMicros: policy.monthlyBudgetMicros,
    monthlyCapMicros: policy.monthlyCapMicros,
    updatedByUserId: policy.updatedByUserId,
    version: policy.version
  };
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

afterAll(async () => {
  if (originalPolicy) await prisma.usageLimitPolicy.update({ data: originalPolicy, where: { id: "installation" } });
  await prisma.$disconnect();
});

async function setPolicy(values: Partial<UsageLimitValues> & { monthlyCapMicros?: number | null }) {
  await prisma.usageLimitPolicy.update({
    data: { ...unset, monthlyCapMicros: null, ...values },
    where: { id: "installation" }
  });
}

async function people(count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, () => randomUUID());
  await prisma.user.createMany({ data: ids.map((id, index) => ({
    displayName: `Usage limit fixture ${index}`,
    email: `usage-limit-${id}@example.test`,
    id,
    status: "active" as const
  })) });
  cleanups.push(async () => {
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });
  return ids;
}

async function group(name: string, limits: Partial<UsageLimitValues> | null, archived = false) {
  const row = await prisma.group.create({ data: { archivedAt: archived ? now : null, name: `${name} ${randomUUID()}` } });
  cleanups.push(async () => {
    await prisma.group.deleteMany({ where: { id: row.id } });
  });
  if (limits) await prisma.usageLimit.create({ data: { ...unset, ...limits, groupId: row.id } });
  return row;
}

async function runs(userId: string, offsets: readonly number[], scheduled = false) {
  const chat = await prisma.chat.create({ data: { memoryMode: "EXCLUDED", title: "Usage limit fixture", userId } });
  const question = await prisma.message.create({
    data: { chatId: chat.id, content: "Synthetic question", role: "user", status: "complete" }
  });
  cleanups.push(async () => {
    await prisma.modelRun.deleteMany({ where: { chatId: chat.id } });
    await prisma.message.deleteMany({ where: { chatId: chat.id } });
    await prisma.chat.deleteMany({ where: { id: chat.id } });
    await prisma.memoryDeletionOutbox.deleteMany({ where: { targetId: chat.id, userId } });
  });
  await prisma.modelRun.createMany({ data: offsets.map((offset) => ({
    chatId: chat.id,
    createdAt: at(offset),
    modelId: "usage-limit-fixture",
    normalizedRequest: {},
    provider: "fake",
    status: "complete" as const,
    userId,
    userMessageId: question.id,
    ...(scheduled ? { scheduledOccurrenceId: randomUUID(), scheduledTaskGeneration: 1, scheduledTaskId: randomUUID() } : {})
  })) });
}

function usage(userId: string, createdAt: string, estimatedCostMicros: number | null) {
  return { createdAt: new Date(createdAt), estimatedCostMicros, modelId: "usage-limit-fixture", provider: "fake", userId };
}

describe("usage limit persistence", () => {
  it("resolves overrides, the most generous active group and defaults, ignoring archived groups", async () => {
    const [admin, grouped, archivedOnly, overridden, exempt] = await people(5) as [string, string, string, string, string];
    await setPolicy({ messagesPerDay: 50, monthlyBudgetMicros: 1_000_000 });
    const low = await group("Usage limit low", { messagesPerHour: 10, monthlyBudgetMicros: 5_000_000 });
    const high = await group("Usage limit high", { monthlyBudgetMicros: 20_000_000 });
    const archived = await group("Usage limit archived", { messagesPerDay: 9_000, monthlyBudgetMicros: 900_000_000 }, true);
    const plain = await group("Usage limit plain", null);
    await prisma.userGroup.createMany({ data: [
      ...[low, high, archived, plain].map(({ id }) => ({ groupId: id, userId: grouped })),
      { groupId: archived.id, userId: archivedOnly },
      { groupId: high.id, userId: overridden },
      { groupId: high.id, userId: exempt }
    ] });
    expect(await repository.putUserLimits({
      limits: { ...unset, exempt: false, monthlyBudgetMicros: 2_000_000 }, targetUserId: overridden, userId: admin
    })).toBe(true);
    expect(await repository.putUserLimits({ limits: { ...unset, exempt: true }, targetUserId: exempt, userId: admin })).toBe(true);

    const view = await repository.readAdminUsageLimits(now);
    const row = (userId: string) => view.users.find((user) => user.userId === userId)!;
    expect(view.installation).toMatchObject({ messagesPerDay: 50, messagesPerHour: null, monthlyBudgetMicros: 1_000_000, monthlyCapMicros: null });
    expect(row(grouped).effective).toEqual({
      exempt: false,
      messagesPerDay: { source: { kind: "installation" }, value: 50 },
      messagesPerHour: { source: { groupId: low.id, kind: "group", name: low.name }, value: 10 },
      monthlyBudgetMicros: { source: { groupId: high.id, kind: "group", name: high.name }, value: 20_000_000 }
    });
    expect(row(archivedOnly).effective).toEqual({
      exempt: false,
      messagesPerDay: { source: { kind: "installation" }, value: 50 },
      messagesPerHour: { source: null, value: null },
      monthlyBudgetMicros: { source: { kind: "installation" }, value: 1_000_000 }
    });
    expect(row(overridden).effective.monthlyBudgetMicros).toEqual({ source: { kind: "user" }, value: 2_000_000 });
    expect(row(overridden).override).toEqual({ ...unset, exempt: false, monthlyBudgetMicros: 2_000_000, userId: overridden });
    expect(row(exempt).effective).toEqual({
      exempt: true,
      messagesPerDay: { source: null, value: null },
      messagesPerHour: { source: null, value: null },
      monthlyBudgetMicros: { source: null, value: null }
    });
    expect(row(grouped)).toMatchObject({ displayName: "Usage limit fixture 1", override: null, status: "active" });
    for (const userId of [grouped, archivedOnly, overridden, exempt]) {
      expect((await repository.loadUsageLimitStatus(userId, now)).effective).toEqual(row(userId).effective);
    }
    const mine = new Set([low.id, high.id, archived.id, plain.id]);
    expect(view.groups.filter(({ groupId }) => mine.has(groupId))).toEqual([
      { archivedAt: now.toISOString(), groupId: archived.id, memberCount: 2, messagesPerDay: 9_000, messagesPerHour: null,
        monthlyBudgetMicros: 900_000_000, name: archived.name },
      { ...unset, archivedAt: null, groupId: high.id, memberCount: 3, monthlyBudgetMicros: 20_000_000, name: high.name },
      { archivedAt: null, groupId: low.id, memberCount: 1, messagesPerDay: null, messagesPerHour: 10,
        monthlyBudgetMicros: 5_000_000, name: low.name },
      { ...unset, archivedAt: null, groupId: plain.id, memberCount: 1, name: plain.name }
    ]);
  });

  it("counts known cost of the UTC month and interactive runs of the trailing windows", async () => {
    const [admin, member, other] = await people(3) as [string, string, string];
    await setPolicy({ monthlyCapMicros: 100_000_000 });
    await repository.putUserLimits({
      limits: { exempt: false, messagesPerDay: 5, messagesPerHour: 3, monthlyBudgetMicros: 10_000_000 },
      targetUserId: member,
      userId: admin
    });
    await prisma.usageEvent.createMany({ data: [
      usage(member, "2033-02-28T23:59:59.999Z", 7_000_000),
      usage(member, "2033-03-01T00:00:00.000Z", 1_500_000),
      usage(member, "2033-03-10T08:00:00.000Z", null),
      usage(member, "2033-03-15T11:00:00.000Z", 2_500_000),
      usage(other, "2033-03-02T00:00:00.000Z", 3_000_000)
    ] });
    await runs(member, [
      -USAGE_DAY_MS - minutes(60), -USAGE_DAY_MS, -USAGE_DAY_MS + minutes(1),
      -minutes(120), -minutes(50), -minutes(40), -minutes(10), 0, minutes(1)
    ]);
    await runs(member, [-minutes(5), -minutes(180)], true);

    const status = await repository.loadUsageLimitStatus(member, now);
    expect(status).toMatchObject({ installationCapMicros: 100_000_000, installationSpentMicros: 7_000_000, userSpentMicros: 4_000_000 });
    // (now - 1h, now]: four interactive runs; the second oldest leaves the window first under a limit of 3.
    expect(status.lastHour).toEqual({ count: 4, freesAt: at(-minutes(40) + USAGE_HOUR_MS) });
    expect(status.lastDay).toEqual({ count: 6, freesAt: at(-minutes(120) + USAGE_DAY_MS) });
    expect(decideUsageAdmission({ ...status, interactive: true, now })).toMatchObject({
      code: "message_rate_limited",
      facts: { limit: 3, resetsAt: at(minutes(20)).toISOString(), used: 4, window: "hour" }
    });
    expect(decideUsageAdmission({ ...status, interactive: false, now })).toEqual({ ok: true });

    const view = await repository.readAdminUsageLimits(now);
    expect(view).toMatchObject({
      installationSpentMicros: 7_000_000,
      periodStart: "2033-03-01T00:00:00.000Z",
      resetsAt: "2033-04-01T00:00:00.000Z"
    });
    expect(view.users.find(({ userId }) => userId === member)).toMatchObject({
      messagesLastDay: 6, messagesLastHour: 4, monthSpentMicros: 4_000_000
    });
    expect(view.users.find(({ userId }) => userId === other)).toMatchObject({
      messagesLastDay: 0, messagesLastHour: 0, monthSpentMicros: 3_000_000
    });

    // The next UTC month starts from zero.
    expect((await repository.loadUsageLimitStatus(member, new Date("2033-04-01T00:00:00.000Z"))).userSpentMicros).toBe(0);
    // Without a cap nothing reads the pooled sum; a zero limit never names a time.
    await setPolicy({});
    await repository.putUserLimits({ limits: { ...unset, exempt: false, messagesPerHour: 0 }, targetUserId: member, userId: admin });
    const capless = await repository.loadUsageLimitStatus(member, now);
    expect(capless).toMatchObject({ installationCapMicros: null, installationSpentMicros: 0, lastHour: { count: 4, freesAt: null } });
    expect(capless.lastDay).toEqual({ count: 6, freesAt: null });
  });

  it("stores one row per target, removes rows that set nothing and guards the installation version", async () => {
    const [admin, target] = await people(2) as [string, string];
    const team = await group("Usage limit team", null);
    expect(await repository.putGroupLimits({ groupId: team.id, limits: { ...unset, messagesPerHour: 7 }, userId: admin })).toBe(true);
    expect(await prisma.usageLimit.findUnique({ where: { groupId: team.id } }))
      .toMatchObject({ exempt: false, messagesPerHour: 7, updatedByUserId: admin, userId: null });
    expect(await repository.putGroupLimits({ groupId: team.id, limits: { ...unset, monthlyBudgetMicros: 3 }, userId: admin })).toBe(true);
    expect(await prisma.usageLimit.findUnique({ where: { groupId: team.id } }))
      .toMatchObject({ messagesPerHour: null, monthlyBudgetMicros: 3n });
    expect(await repository.putGroupLimits({ groupId: team.id, limits: unset, userId: admin })).toBe(true);
    expect(await prisma.usageLimit.count({ where: { groupId: team.id } })).toBe(0);
    expect(await repository.putGroupLimits({ groupId: randomUUID(), limits: { ...unset, messagesPerDay: 1 }, userId: admin })).toBe(false);

    expect(await repository.putUserLimits({ limits: { ...unset, exempt: true }, targetUserId: target, userId: admin })).toBe(true);
    expect(await prisma.usageLimit.findUnique({ where: { userId: target } })).toMatchObject({ exempt: true, groupId: null });
    expect(await repository.putUserLimits({ limits: { ...unset, exempt: false }, targetUserId: target, userId: admin })).toBe(true);
    expect(await prisma.usageLimit.count({ where: { userId: target } })).toBe(0);
    expect(await repository.deleteUserLimits({ targetUserId: target })).toBe(true);
    expect(await repository.deleteUserLimits({ targetUserId: randomUUID() })).toBe(false);
    expect(await repository.putUserLimits({ limits: { ...unset, exempt: true }, targetUserId: randomUUID(), userId: admin })).toBe(false);

    const { version } = (await repository.readAdminUsageLimits(now)).installation;
    const values = { ...unset, monthlyCapMicros: 1_000_000_000_000 };
    const results = await Promise.all([1, 2].map((messagesPerHour) =>
      repository.updateInstallation({ ...values, expectedVersion: version, messagesPerHour, userId: admin })));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)).toMatchObject({ monthlyCapMicros: 1_000_000_000_000, version: version + 1 });
    expect(await prisma.usageLimitPolicy.findUniqueOrThrow({ where: { id: "installation" } }))
      .toMatchObject({ monthlyCapMicros: 1_000_000_000_000n, updatedByUserId: admin, version: version + 1 });
    expect(await repository.updateInstallation({ ...values, expectedVersion: version, userId: admin })).toBeNull();
  });

  it("enforces one target, user-only exemption, non-empty rows and bounds in the database", async () => {
    const [user] = await people(1) as [string];
    const team = await group("Usage limit checks", null);
    const rejects = (pattern: RegExp, data: Prisma.UsageLimitUncheckedCreateInput) =>
      expect(prisma.usageLimit.create({ data })).rejects.toThrow(pattern);
    await rejects(/UsageLimit_target_check/u, { ...unset, groupId: team.id, messagesPerDay: 1, userId: user });
    await rejects(/UsageLimit_target_check/u, { ...unset, messagesPerDay: 1 });
    await rejects(/UsageLimit_exempt_check/u, { ...unset, exempt: true, groupId: team.id });
    await rejects(/UsageLimit_present_check/u, { ...unset, userId: user });
    await rejects(/UsageLimit_values_check/u, { ...unset, messagesPerHour: 10_001, userId: user });
    await rejects(/UsageLimit_values_check/u, { ...unset, monthlyBudgetMicros: -1, userId: user });
    await rejects(/UsageLimit_values_check/u, { ...unset, monthlyBudgetMicros: 1_000_000_000_001, userId: user });
    await prisma.usageLimit.create({ data: { ...unset, groupId: team.id, messagesPerDay: 100_000 } });
    await expect(prisma.usageLimit.create({ data: { ...unset, groupId: team.id, messagesPerDay: 1 } }))
      .rejects.toMatchObject({ code: "P2002" });
    await expect(prisma.usageLimitPolicy.create({ data: { id: "other" } })).rejects.toThrow(/UsageLimitPolicy_singleton_check/u);
    await expect(prisma.usageLimitPolicy.update({ data: { messagesPerDay: -1 }, where: { id: "installation" } }))
      .rejects.toThrow(/UsageLimitPolicy_values_check/u);
    // Group and user deletion take their limit rows along.
    await prisma.usageLimit.create({ data: { ...unset, exempt: true, userId: user } });
    await prisma.group.delete({ where: { id: team.id } });
    await prisma.user.delete({ where: { id: user } });
    expect(await prisma.usageLimit.count({ where: { OR: [{ groupId: team.id }, { userId: user }] } })).toBe(0);
  });
});

// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SmtpProductMessage } from "../email/definitions";
import { prisma } from "../prisma";
import { createUsageLimitAlertCheck } from "./alerts";
import {
  createUsageLimitAlertStore,
  USAGE_LIMIT_ALERT_MAX_ATTEMPTS,
  USAGE_LIMIT_ALERT_RETRY_MS
} from "./alertsRepository";
import { createUsageLimitsRepository } from "./repository";

const store = createUsageLimitAlertStore(prisma);
// Months no other fixture writes usage or alerts into, so installation-wide sums stay exact.
const now = new Date("2034-05-15T12:00:00.000Z");
const periodStart = new Date("2034-05-01T00:00:00.000Z");
const later = (ms: number) => new Date(now.getTime() + ms);

const cleanups: Array<() => Promise<void>> = [];
let originalPolicy: Prisma.UsageLimitPolicyUncheckedUpdateInput | null = null;

beforeAll(async () => {
  const policy = await prisma.usageLimitPolicy.findUniqueOrThrow({ where: { id: "installation" } });
  originalPolicy = { monthlyCapMicros: policy.monthlyCapMicros, version: policy.version };
});

afterEach(async () => {
  await prisma.usageLimitAlert.deleteMany({ where: { periodStart } });
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

afterAll(async () => {
  if (originalPolicy) await prisma.usageLimitPolicy.update({ data: originalPolicy, where: { id: "installation" } });
  await prisma.$disconnect();
});

type Person = Readonly<{ email: string; id: string }>;

async function person(input: Readonly<{ role?: "admin" | "user"; status?: "active" | "disabled"; verified?: boolean }> = {}): Promise<Person> {
  const id = randomUUID();
  const email = `usage-alert-${id}@example.test`;
  await prisma.user.create({ data: {
    displayName: `Usage alert fixture ${id.slice(0, 8)}`, email, id, role: input.role ?? "user", status: input.status ?? "active"
  } });
  cleanups.push(async () => {
    await prisma.user.deleteMany({ where: { id } });
  });
  await prisma.authIdentity.create({ data: {
    emailVerifiedAt: input.verified === false ? null : now, normalizedEmail: email, provider: "password", providerAccountId: email, userId: id
  } });
  return { email, id };
}

async function spend(userId: string, estimatedCostMicros: number) {
  await prisma.usageEvent.create({ data: {
    createdAt: later(-60_000), estimatedCostMicros, modelId: "usage-alert-fixture", provider: "fake", purpose: "chat_answer", userId
  } });
}

describe("usage limit alert persistence", () => {
  it("claims each key once across concurrent checks, the pooled key without a user included", async () => {
    const user = await person();
    const keys = [
      { kind: "installation_cap_near" as const, userId: null },
      { kind: "user_budget_reached" as const, userId: user.id }
    ];
    const results = await Promise.all(Array.from({ length: 4 }, () => store.claim({ keys, now, periodStart })));
    const claimed = results.flat();
    expect(claimed.map(({ kind, userId }) => `${kind}:${userId ?? ""}`).sort())
      .toEqual([`installation_cap_near:`, `user_budget_reached:${user.id}`]);
    expect(await prisma.usageLimitAlert.count({ where: { periodStart } })).toBe(2);
    // A later check of the month claims nothing more, while the alerts are in flight or after delivery.
    await expect(store.claim({ keys, now: later(USAGE_LIMIT_ALERT_RETRY_MS * 10), periodStart })).resolves.toEqual([]);
    await store.settle(claimed.map(({ id }) => id), "delivered", now);
    await expect(store.claim({ keys, now: later(USAGE_LIMIT_ALERT_RETRY_MS * 10), periodStart })).resolves.toEqual([]);
  });

  it("claims an undelivered alert again only after the retry delay and a bounded number of times", async () => {
    const keys = [{ kind: "installation_cap_reached" as const, userId: null }];
    let [claim] = await store.claim({ keys, now, periodStart });
    let at = now;
    for (let attempt = 2; attempt <= USAGE_LIMIT_ALERT_MAX_ATTEMPTS; attempt += 1) {
      await store.settle([claim!.id], "undelivered", at);
      await expect(store.claim({ keys, now: new Date(at.getTime() + USAGE_LIMIT_ALERT_RETRY_MS - 1), periodStart })).resolves.toEqual([]);
      at = new Date(at.getTime() + USAGE_LIMIT_ALERT_RETRY_MS);
      const again = await Promise.all([store.claim({ keys, now: at, periodStart }), store.claim({ keys, now: at, periodStart })]);
      expect(again.flat()).toHaveLength(1);
      [claim] = again.flat();
    }
    await store.settle([claim!.id], "undelivered", at);
    await expect(store.claim({ keys, now: new Date(at.getTime() + USAGE_LIMIT_ALERT_RETRY_MS), periodStart })).resolves.toEqual([]);
    expect(await prisma.usageLimitAlert.findFirst({ select: { attempts: true, state: true }, where: { periodStart } }))
      .toEqual({ attempts: USAGE_LIMIT_ALERT_MAX_ATTEMPTS, state: "undelivered" });
  });

  it("skips users deleted since the status read and drops their alerts with them", async () => {
    const kept = await person();
    const deleted = await person();
    await prisma.user.delete({ where: { id: deleted.id } });
    const claimed = await store.claim({ keys: [
      { kind: "user_budget_reached", userId: kept.id }, { kind: "user_budget_reached", userId: deleted.id }
    ], now, periodStart });
    expect(claimed.map(({ userId }) => userId)).toEqual([kept.id]);
    await prisma.user.delete({ where: { id: kept.id } });
    expect(await prisma.usageLimitAlert.count({ where: { periodStart } })).toBe(0);
  });

  it("lists active administrators with their verified address only", async () => {
    const verified = await person({ role: "admin" });
    const unverified = await person({ role: "admin", verified: false });
    const disabled = await person({ role: "admin", status: "disabled" });
    const member = await person();
    const fixtures = new Set([verified.id, unverified.id, disabled.id, member.id]);
    const recipients = (await store.listRecipients()).filter(({ userId }) => fixtures.has(userId));
    expect(recipients.sort((a, b) => a.userId.localeCompare(b.userId))).toEqual([
      { email: verified.email, userId: verified.id },
      { email: null, userId: unverified.id }
    ].sort((a, b) => a.userId.localeCompare(b.userId)));
  });

  it("sends the pooled cap and the users alerts once when two checks run at the same time", async () => {
    const admin = await person({ role: "admin" });
    const spender = await person();
    await prisma.usageLimitPolicy.update({ data: { monthlyCapMicros: 10_000_000 }, where: { id: "installation" } });
    await prisma.usageLimit.create({ data: { monthlyBudgetMicros: 4_000_000, userId: spender.id } });
    await spend(spender.id, 9_000_000);
    const emails: SmtpProductMessage[] = [];
    const pushes: string[] = [];
    const repository = createUsageLimitsRepository(prisma);
    const check = () => createUsageLimitAlertCheck({
      appBaseUrl: "https://aiqsa.example",
      readLimits: (at) => repository.readAdminUsageLimits(at),
      sendEmail: async (message) => {
        emails.push(message);
        return { kind: "accepted" };
      },
      sendPush: async (userId, message) => {
        pushes.push(`${userId}:${message.tag}`);
        return 0;
      },
      store
    })(now);
    await Promise.all([check(), check()]);
    await check();
    const toFixtureAdmin = emails.filter(({ to }) => to === admin.email).map(({ subject }) => subject).sort();
    expect(toFixtureAdmin).toEqual(["AIQSA monthly cap almost used", "AIQSA user reached their monthly budget"]);
    // Every administrator of the installation got each alert once.
    const perRecipient = new Map<string, number>();
    for (const email of emails) perRecipient.set(`${email.to}:${email.subject}`, (perRecipient.get(`${email.to}:${email.subject}`) ?? 0) + 1);
    expect([...perRecipient.values()].every((count) => count === 1)).toBe(true);
    expect(pushes.filter((push) => push.startsWith(admin.id)).sort()).toEqual([`${admin.id}:aiqsa-usage-budgets`, `${admin.id}:aiqsa-usage-cap`]);
    expect(await prisma.usageLimitAlert.findMany({ orderBy: { kind: "asc" }, select: { kind: true, state: true, userId: true }, where: { periodStart } }))
      .toEqual([
        { kind: "installation_cap_near", state: "delivered", userId: null },
        { kind: "user_budget_reached", state: "delivered", userId: spender.id }
      ]);
  });
});

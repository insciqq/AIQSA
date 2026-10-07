// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminUsageLimits } from "../../contracts/usageLimits";
import type { SmtpProductMessage } from "../email/definitions";
import type { EmailDispatchResult } from "../email/dispatcher";
import { createUsageLimitAlertCheck, createUsageLimitAlertWorker, type UsageLimitAlertCheckDeps } from "./alerts";
import type { UsageLimitAlertKind } from "./alertsPolicy";
import {
  USAGE_LIMIT_ALERT_MAX_ATTEMPTS,
  USAGE_LIMIT_ALERT_RETRY_MS,
  type UsageLimitAlertClaim,
  type UsageLimitAlertRecipient,
  type UsageLimitAlertStore
} from "./alertsRepository";
import { usageLimitsFixture, usageUserRow } from "./alertsTestFixtures";

const observability = vi.hoisted(() => ({ failures: [] as unknown[], healthy: [] as unknown[] }));
vi.mock("../observability", async (importOriginal) => ({
  ...await importOriginal<typeof import("../observability")>(),
  logEvent: () => undefined,
  reportSubsystemFailure: (failure: unknown) => { observability.failures.push(failure); },
  reportSubsystemHealthy: (...args: unknown[]) => { observability.healthy.push(args); }
}));

type Row = { attempts: number; id: string; kind: UsageLimitAlertKind; periodStart: number; settledAt: number | null;
  state: "claimed" | "delivered" | "undelivered"; userId: string | null };

/** The claim rules of the PostgreSQL store, in memory. */
function memoryStore(recipients: readonly UsageLimitAlertRecipient[]) {
  const rows = new Map<string, Row>();
  let sequence = 0;
  const store: UsageLimitAlertStore = {
    async claim({ keys, now, periodStart }) {
      const claimed: UsageLimitAlertClaim[] = [];
      for (const key of keys) {
        const id = `${periodStart.toISOString()}:${key.kind}:${key.userId ?? ""}`;
        const row = rows.get(id);
        if (!row) {
          sequence += 1;
          rows.set(id, { attempts: 1, id: `alert-${sequence}`, kind: key.kind, periodStart: periodStart.getTime(),
            settledAt: null, state: "claimed", userId: key.userId });
        } else if (row.state === "undelivered" && row.attempts < USAGE_LIMIT_ALERT_MAX_ATTEMPTS &&
          row.settledAt !== null && row.settledAt <= now.getTime() - USAGE_LIMIT_ALERT_RETRY_MS) {
          Object.assign(row, { attempts: row.attempts + 1, settledAt: null, state: "claimed" });
        } else continue;
        const current = rows.get(id)!;
        claimed.push({ id: current.id, kind: current.kind, userId: current.userId });
      }
      return claimed;
    },
    async settle(ids, state, now) {
      for (const row of rows.values()) {
        if (ids.includes(row.id) && row.state === "claimed") Object.assign(row, { settledAt: now.getTime(), state });
      }
    },
    listRecipients: async () => recipients,
    pruneBefore: vi.fn(async (periodStart: Date) => {
      for (const [key, row] of rows) if (row.periodStart < periodStart.getTime()) rows.delete(key);
    })
  };
  return { rows, store };
}

const admins: UsageLimitAlertRecipient[] = [
  { email: "first-admin@example.test", userId: "admin-1" },
  { email: null, userId: "admin-2" }
];

function harness(options: Readonly<{
  email?: (message: SmtpProductMessage) => Promise<EmailDispatchResult>;
  push?: UsageLimitAlertCheckDeps["sendPush"];
  recipients?: readonly UsageLimitAlertRecipient[];
}> = {}) {
  let limits: AdminUsageLimits = usageLimitsFixture();
  const memory = memoryStore(options.recipients ?? admins);
  const emails: SmtpProductMessage[] = [];
  const pushes: Array<{ title: string; userId: string }> = [];
  const check = createUsageLimitAlertCheck({
    appBaseUrl: "https://aiqsa.example",
    readLimits: async () => limits,
    sendEmail: options.email ?? (async (message) => {
      emails.push(message);
      return { kind: "accepted" };
    }),
    sendPush: options.push ?? (async (userId, message) => {
      pushes.push({ title: message.title, userId });
      return 1;
    }),
    store: memory.store
  });
  return {
    check,
    emails,
    memory,
    pushes,
    setLimits(next: AdminUsageLimits) {
      limits = next;
    }
  };
}

const october = new Date("2026-10-15T12:00:00.000Z");
const minutes = (count: number) => count * 60_000;
const later = (from: Date, ms: number) => new Date(from.getTime() + ms);

afterEach(() => {
  observability.failures.length = 0;
  observability.healthy.length = 0;
  vi.useRealTimers();
});

describe("usage limit alert check", () => {
  it("sends each threshold once per month to every administrator by email and push", async () => {
    const test = harness();
    test.setLimits(usageLimitsFixture({ cap: 100_000_000, now: october, spent: 85_000_000 }));
    await expect(test.check(october)).resolves.toEqual({ delivered: 1, undelivered: 0 });
    // Only the administrator with a verified address gets the email; both get the push.
    expect(test.emails.map(({ kind, subject, to }) => ({ kind, subject, to }))).toEqual([
      { kind: "usage_limit_alert", subject: "AIQSA monthly cap almost used", to: "first-admin@example.test" }
    ]);
    expect(test.pushes).toEqual([
      { title: "Monthly cap almost used", userId: "admin-1" },
      { title: "Monthly cap almost used", userId: "admin-2" }
    ]);

    // Restarts and later checks of the same month repeat nothing.
    await expect(test.check(later(october, minutes(5)))).resolves.toEqual({ delivered: 0, undelivered: 0 });
    test.setLimits(usageLimitsFixture({ cap: 100_000_000, now: october, spent: 101_000_000 }));
    await test.check(later(october, minutes(10)));
    await test.check(later(october, minutes(15)));
    expect(test.emails.map(({ subject }) => subject)).toEqual(["AIQSA monthly cap almost used", "AIQSA monthly cap reached"]);
    expect(test.pushes).toHaveLength(4);
  });

  it("sends the thresholds again in a new UTC month and prunes months before the previous one", async () => {
    const test = harness({ recipients: [admins[0]!] });
    test.setLimits(usageLimitsFixture({ cap: 10_000_000, now: october, spent: 10_000_000 }));
    await test.check(october);
    const november = new Date("2026-11-01T00:00:30.000Z");
    test.setLimits(usageLimitsFixture({ cap: 10_000_000, now: november, spent: 10_000_000 }));
    await test.check(november);
    await test.check(later(november, minutes(5)));
    expect(test.emails.map(({ subject }) => subject)).toEqual(["AIQSA monthly cap reached", "AIQSA monthly cap reached"]);
    expect(test.memory.store.pruneBefore).toHaveBeenLastCalledWith(new Date("2026-10-01T00:00:00.000Z"));
    expect(test.memory.rows.size).toBe(2);
  });

  it("batches the users reached in one check into one message and alerts each user once a month", async () => {
    const test = harness({ recipients: [admins[0]!] });
    const ada = usageUserRow({ budget: 5_000_000, displayName: "Ada", spent: 5_000_000, userId: "ada" });
    const grace = usageUserRow({ budget: 2_000_000, displayName: "Grace", spent: 3_000_000, userId: "grace" });
    const linus = usageUserRow({ budget: 1_000_000, displayName: "Linus", spent: 1_000_000, userId: "linus" });
    test.setLimits(usageLimitsFixture({ now: october, users: [ada, grace] }));
    await test.check(october);
    test.setLimits(usageLimitsFixture({ now: october, users: [ada, grace, linus] }));
    await test.check(later(october, minutes(5)));
    await test.check(later(october, minutes(10)));
    expect(test.emails).toHaveLength(2);
    expect(test.emails[0]!.text).toContain("- Ada: $5.00 of $5.00\n- Grace: $3.00 of $2.00");
    expect(test.emails[1]!.subject).toBe("AIQSA user reached their monthly budget");
    expect(test.emails[1]!.text).toContain("- Linus: $1.00 of $1.00");
    expect(test.emails[1]!.text).not.toContain("Ada");
  });

  it("sends the pooled cap and the users as separate messages from one check", async () => {
    const test = harness({ recipients: [admins[0]!] });
    test.setLimits(usageLimitsFixture({ cap: 10_000_000, now: october, spent: 10_000_000, users: [
      usageUserRow({ budget: 1_000_000, displayName: "Ada", spent: 1_000_000, userId: "ada" })
    ] }));
    await expect(test.check(october)).resolves.toEqual({ delivered: 2, undelivered: 0 });
    expect(test.emails.map(({ subject }) => subject)).toEqual(["AIQSA monthly cap reached", "AIQSA user reached their monthly budget"]);
  });

  it("claims once when checks run concurrently", async () => {
    const test = harness();
    test.setLimits(usageLimitsFixture({ cap: 10_000_000, now: october, spent: 9_000_000 }));
    const results = await Promise.all([test.check(october), test.check(october), test.check(october)]);
    expect(results.reduce((sum, result) => sum + result.delivered, 0)).toBe(1);
    expect(test.emails).toHaveLength(1);
    expect(test.pushes).toHaveLength(2);
  });

  it("delivers by push alone when SMTP is not configured", async () => {
    const email = vi.fn(async (): Promise<EmailDispatchResult> => ({ kind: "unavailable" }));
    const test = harness({ email, recipients: [
      { email: "first-admin@example.test", userId: "admin-1" }, { email: "second-admin@example.test", userId: "admin-2" }
    ] });
    test.setLimits(usageLimitsFixture({ cap: 10_000_000, now: october, spent: 9_000_000 }));
    await expect(test.check(october)).resolves.toEqual({ delivered: 1, undelivered: 0 });
    // SMTP reported unavailable once; the other administrator is not tried by email in this check.
    expect(email).toHaveBeenCalledTimes(1);
    expect(test.pushes).toHaveLength(2);
    await test.check(later(october, USAGE_LIMIT_ALERT_RETRY_MS));
    expect(test.pushes).toHaveLength(2);
  });

  it("delivers by email alone when push is unavailable or fails", async () => {
    for (const push of [async () => 0, async () => { throw new Error("push down"); }]) {
      const test = harness({ push });
      test.setLimits(usageLimitsFixture({ cap: 10_000_000, now: october, spent: 9_000_000 }));
      await expect(test.check(october)).resolves.toEqual({ delivered: 1, undelivered: 0 });
      expect(test.emails).toHaveLength(1);
      expect([...test.memory.rows.values()].map(({ state }) => state)).toEqual(["delivered"]);
    }
  });

  it("retries an alert that reached nobody after the retry delay, a bounded number of times", async () => {
    let emailResult: EmailDispatchResult = { code: "smtp_connection_failed", kind: "failed" };
    const email = vi.fn(async () => emailResult);
    const test = harness({ email, push: async () => 0, recipients: [admins[0]!] });
    test.setLimits(usageLimitsFixture({ cap: 10_000_000, now: october, spent: 9_000_000 }));
    await expect(test.check(october)).resolves.toEqual({ delivered: 0, undelivered: 1 });
    expect([...test.memory.rows.values()][0]).toMatchObject({ attempts: 1, state: "undelivered" });

    // Not before the retry delay.
    await expect(test.check(later(october, USAGE_LIMIT_ALERT_RETRY_MS - 1))).resolves.toEqual({ delivered: 0, undelivered: 0 });
    let at = october;
    for (let attempt = 2; attempt <= USAGE_LIMIT_ALERT_MAX_ATTEMPTS; attempt += 1) {
      at = later(at, USAGE_LIMIT_ALERT_RETRY_MS);
      await expect(test.check(at)).resolves.toEqual({ delivered: 0, undelivered: 1 });
    }
    at = later(at, USAGE_LIMIT_ALERT_RETRY_MS);
    emailResult = { kind: "accepted" };
    await expect(test.check(at)).resolves.toEqual({ delivered: 0, undelivered: 0 });
    expect(email).toHaveBeenCalledTimes(USAGE_LIMIT_ALERT_MAX_ATTEMPTS);
  });

  it("succeeds on a retry once a channel works", async () => {
    let emailResult: EmailDispatchResult = { kind: "unavailable" };
    const test = harness({ email: async (message) => {
      if (emailResult.kind === "accepted") test.emails.push(message);
      return emailResult;
    }, push: async () => 0, recipients: [admins[0]!] });
    test.setLimits(usageLimitsFixture({ cap: 10_000_000, now: october, spent: 9_000_000 }));
    await test.check(october);
    emailResult = { kind: "accepted" };
    await expect(test.check(later(october, USAGE_LIMIT_ALERT_RETRY_MS))).resolves.toEqual({ delivered: 1, undelivered: 0 });
    await test.check(later(october, 2 * USAGE_LIMIT_ALERT_RETRY_MS));
    expect(test.emails).toHaveLength(1);
  });

  it("never resends an ambiguous email", async () => {
    const email = vi.fn(async (): Promise<EmailDispatchResult> => ({ kind: "ambiguous_after_data" }));
    const test = harness({ email, push: async () => 0, recipients: [admins[0]!] });
    test.setLimits(usageLimitsFixture({ cap: 10_000_000, now: october, spent: 9_000_000 }));
    await expect(test.check(october)).resolves.toEqual({ delivered: 1, undelivered: 0 });
    await test.check(later(october, USAGE_LIMIT_ALERT_RETRY_MS));
    expect(email).toHaveBeenCalledTimes(1);
  });

  it("keeps sending when the email configuration cannot be read", async () => {
    const test = harness({ email: async () => { throw new Error("database down"); } });
    test.setLimits(usageLimitsFixture({ cap: 10_000_000, now: october, spent: 9_000_000 }));
    await expect(test.check(october)).resolves.toEqual({ delivered: 1, undelivered: 0 });
    expect(test.pushes).toHaveLength(2);
  });

  it("claims nothing without alerts or administrators", async () => {
    const quiet = harness();
    quiet.setLimits(usageLimitsFixture({ cap: 10_000_000, now: october, spent: 1_000_000 }));
    await expect(quiet.check(october)).resolves.toEqual({ delivered: 0, undelivered: 0 });
    const nobody = harness({ recipients: [] });
    nobody.setLimits(usageLimitsFixture({ cap: 10_000_000, now: october, spent: 10_000_000 }));
    await expect(nobody.check(october)).resolves.toEqual({ delivered: 0, undelivered: 0 });
    expect(quiet.memory.rows.size + nobody.memory.rows.size).toBe(0);
  });

  it("still sends the users alert when settling the pooled alert fails, then reports the failure", async () => {
    const test = harness({ recipients: [admins[0]!] });
    const settle = test.memory.store.settle;
    let calls = 0;
    (test.memory.store as { settle: typeof settle }).settle = async (...args) => {
      calls += 1;
      if (calls === 1) throw new Error("database down");
      return settle(...args);
    };
    test.setLimits(usageLimitsFixture({ cap: 10_000_000, now: october, spent: 10_000_000, users: [
      usageUserRow({ budget: 1_000_000, spent: 1_000_000, userId: "ada" })
    ] }));
    await expect(test.check(october)).rejects.toThrow("database down");
    expect(test.emails).toHaveLength(2);
    // The unsettled pooled alert stays claimed: ambiguous, never resent.
    await test.check(later(october, USAGE_LIMIT_ALERT_RETRY_MS));
    expect(test.emails).toHaveLength(2);
  });
});

describe("usage limit alert worker", () => {
  it("checks within the jitter of start, then every interval plus jitter, one at a time", async () => {
    vi.useFakeTimers();
    const check = vi.fn(async () => undefined);
    const worker = createUsageLimitAlertWorker({ check, intervalMs: 300_000, jitterMs: 60_000, random: () => 0.5 });
    worker.start();
    worker.start();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(330_000);
    expect(check).toHaveBeenCalledTimes(2);
    expect(observability.healthy).toContainEqual(["usage_alerts", "reconcile"]);
    await worker.stop();
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("degrades health on a failed check and tries again at the next interval", async () => {
    vi.useFakeTimers();
    const check = vi.fn().mockRejectedValueOnce(new Error("database down")).mockResolvedValue(undefined);
    const worker = createUsageLimitAlertWorker({ check, intervalMs: 1_000, jitterMs: 0 });
    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(observability.failures).toEqual([expect.objectContaining({
      action: "retry", code: "usage_alert_check_failed", stage: "reconcile", subsystem: "usage_alerts"
    })]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(check).toHaveBeenCalledTimes(2);
    expect(observability.healthy).toContainEqual(["usage_alerts", "reconcile"]);
    await worker.stop();
  });

  it("joins a check already in progress", async () => {
    let finish: () => void = () => undefined;
    const check = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const worker = createUsageLimitAlertWorker({ check, intervalMs: 1_000, jitterMs: 0 });
    const first = worker.runNow();
    const second = worker.runNow();
    finish();
    await Promise.all([first, second]);
    expect(check).toHaveBeenCalledTimes(1);
    await worker.stop();
  });
});

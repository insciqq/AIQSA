// @vitest-environment node
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { PERSONAL_USAGE_PURPOSES } from "../../domain/usagePurpose";
import { createUsageLimitsRepository } from "./repository";

type Gate = Readonly<{
  limited: boolean;
  messagesPerDay: number | null;
  messagesPerHour: number | null;
  monthlyBudgetMicros: bigint | null;
  monthlyCapMicros: bigint | null;
  version: number | null;
}>;

const NO_LIMITS: Gate = {
  limited: false, messagesPerDay: null, messagesPerHour: null, monthlyBudgetMicros: null, monthlyCapMicros: null, version: 1
};

/**
 * A database that records every call the repository makes and answers like
 * an installation whose stored state is `gate`: a user without an override
 * or a limited group, and no usage or admitted messages.
 */
function countingDatabase(gate: Gate) {
  const calls: string[] = [];
  const statements: Prisma.Sql[] = [];
  const answers: Record<string, (...args: unknown[]) => unknown> = {
    "$queryRaw": (strings, ...values) => {
      statements.push(Prisma.sql(strings as TemplateStringsArray, ...values));
      const sql = (strings as TemplateStringsArray).join("?");
      if (sql.includes("\"limited\"")) return [gate];
      return [{ spent: 0n }];
    },
    "usageLimitPolicy.findUnique": () => gate.version === null ? null : {
      messagesPerDay: gate.messagesPerDay,
      messagesPerHour: gate.messagesPerHour,
      monthlyBudgetMicros: gate.monthlyBudgetMicros,
      monthlyCapMicros: gate.monthlyCapMicros,
      version: gate.version
    },
    "usageMessageAdmission.count": () => 0,
    "usageMessageAdmission.findFirst": () => null,
    "user.findUnique": () => ({ groups: [], usageLimit: null })
  };
  const method = (name: string) => async (...args: unknown[]) => {
    calls.push(name);
    const answer = answers[name];
    if (!answer) throw new Error(`unexpected database call ${name}`);
    return answer(...args);
  };
  const model = (prefix: string) => new Proxy({}, { get: (_target, key) => method(`${prefix}.${String(key)}`) });
  const database = new Proxy({}, {
    get: (_target, key) => String(key).startsWith("$") ? method(String(key)) : model(String(key))
  });
  return { calls, database: database as Parameters<typeof createUsageLimitsRepository>[0], statements };
}

const now = new Date("2033-03-15T12:00:00.000Z");

describe("loadUsageLimitStatus database reads", () => {
  it("admits an installation without limits after one read: no spend sums, no message counts", async () => {
    const { calls, database } = countingDatabase(NO_LIMITS);
    const status = await createUsageLimitsRepository(database).loadUsageLimitStatus("user-1", now);
    // Before the fast path this was 5 calls: the policy, the user with groups,
    // the month spend sum and both message counts.
    expect(calls).toEqual(["$queryRaw"]);
    expect(status).toEqual({
      effective: {
        exempt: false,
        messagesPerDay: { source: null, value: null },
        messagesPerHour: { source: null, value: null },
        monthlyBudgetMicros: { source: null, value: null }
      },
      installationCapMicros: null,
      installationSpentMicros: 0,
      lastDay: { count: 0, freesAt: null },
      lastHour: { count: 0, freesAt: null },
      userSpentMicros: 0
    });
  });

  it("reads a missing installation singleton as no limits", async () => {
    const { calls, database } = countingDatabase({ ...NO_LIMITS, version: null });
    const status = await createUsageLimitsRepository(database).loadUsageLimitStatus("user-1", now);
    expect(calls).toEqual(["$queryRaw"]);
    expect(status.installationCapMicros).toBeNull();
  });

  it.each([
    ["a pooled cap", { monthlyCapMicros: 0n }],
    ["a per-user default budget", { monthlyBudgetMicros: 5n }],
    ["a per-user default message limit", { messagesPerHour: 3 }],
    ["a zero per-user default", { messagesPerDay: 0 }],
    ["an override or a limited group", { limited: true }]
  ])("reads spend and counts when %s applies", async (_name, change) => {
    const { calls, database } = countingDatabase({ ...NO_LIMITS, ...change });
    await createUsageLimitsRepository(database).loadUsageLimitStatus("user-1", now);
    expect(calls).toContain("usageMessageAdmission.count");
    expect(calls.filter((call) => call === "$queryRaw").length).toBeGreaterThanOrEqual(2);
    // The gate's policy read is reused, never repeated.
    expect(calls).not.toContain("usageLimitPolicy.findUnique");
  });

  it("sums only personal purposes for the user and every purpose for the pooled cap", async () => {
    const { database, statements } = countingDatabase({ ...NO_LIMITS, limited: true, monthlyCapMicros: 1_000_000n });
    await createUsageLimitsRepository(database).loadUsageLimitStatus("user-1", now);
    const sums = statements.filter(({ sql }) => sql.includes("SUM(\"estimatedCostMicros\")"));
    expect(sums).toHaveLength(2);
    const [personal, pooled] = [sums.find(({ values }) => values.includes("user-1")), sums.find(({ values }) => !values.includes("user-1"))];
    expect(personal?.sql).toContain("\"purpose\" IN");
    expect(personal?.values).toEqual(expect.arrayContaining([...PERSONAL_USAGE_PURPOSES]));
    expect(pooled?.sql).not.toContain("purpose");
  });
});

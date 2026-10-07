import type { AdminUsageLimits, AdminUsageLimitUserRow } from "../../contracts/usageLimits";

const NONE = { source: null, value: null } as const;

/** One user row as `readAdminUsageLimits` returns it; `budget` is the effective monthly budget. */
export function usageUserRow(input: Readonly<{
  budget: number | null; displayName?: string; spent: number; status?: string; userId: string;
}>): AdminUsageLimitUserRow {
  return {
    displayName: input.displayName ?? `Person ${input.userId}`,
    effective: {
      exempt: false,
      messagesPerDay: NONE,
      messagesPerHour: NONE,
      monthlyBudgetMicros: input.budget === null ? NONE : { source: { kind: "installation" }, value: input.budget }
    },
    email: `${input.userId}@example.test`,
    messagesLastDay: 0,
    messagesLastHour: 0,
    monthSpentMicros: input.spent,
    override: null,
    status: input.status ?? "active",
    userId: input.userId
  };
}

/** Usage limit status of the UTC month containing `now`. */
export function usageLimitsFixture(input: Readonly<{
  cap?: number | null; now?: Date; spent?: number; users?: readonly AdminUsageLimitUserRow[];
}> = {}): AdminUsageLimits {
  const now = input.now ?? new Date("2026-10-15T12:00:00.000Z");
  return {
    groups: [],
    installation: {
      messagesPerDay: null, messagesPerHour: null, monthlyBudgetMicros: null, monthlyCapMicros: input.cap ?? null, version: 1
    },
    installationSpentMicros: input.spent ?? 0,
    periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    resetsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
    users: [...(input.users ?? [])]
  };
}

import type { UserUsageLimitStatus, UserUsageLimitStatusResponse } from "../../contracts/usageLimits";
import { utcMonthPeriod } from "../../domain/usageLimits";
import type { RequestAuthResolver } from "../auth/requestAuth";
import type { UsageLimitsRepository, UsageLimitStatus } from "./repository";

type UserUsageLimitStatusErrorCode = "forbidden" | "unauthorized" | "usage_limits_unavailable";

const ERROR_STATUS: Readonly<Record<UserUsageLimitStatusErrorCode, number>> = {
  forbidden: 403,
  unauthorized: 401,
  usage_limits_unavailable: 503
};

/**
 * What the user may see about their own limits: their effective allowance and
 * own counts. The pooled installation cap is disclosed only as reached or not.
 */
export function projectUserUsageLimitStatus(status: UsageLimitStatus, now: Date): UserUsageLimitStatus {
  const { periodStart, resetsAt } = utcMonthPeriod(now);
  return {
    installationExhausted: status.installationCapMicros !== null &&
      status.installationSpentMicros >= status.installationCapMicros,
    messages: {
      dayFreesAt: status.lastDay.freesAt?.toISOString() ?? null,
      hourFreesAt: status.lastHour.freesAt?.toISOString() ?? null,
      lastDay: status.lastDay.count,
      lastHour: status.lastHour.count,
      perDay: status.effective.messagesPerDay.value,
      perHour: status.effective.messagesPerHour.value
    },
    monthlyBudgetMicros: status.effective.monthlyBudgetMicros.value,
    monthSpentMicros: status.userSpentMicros,
    periodStart: periodStart.toISOString(),
    resetsAt: resetsAt.toISOString()
  };
}

function reply(body: UserUsageLimitStatusResponse | { error: UserUsageLimitStatusErrorCode }, status = 200): Response {
  return Response.json(body, { headers: { "cache-control": "private, no-store" }, status });
}

/** `GET /api/me/usage-limits`: the signed-in active user's own limit status. */
export function createUserUsageLimitStatusHandler(input: Readonly<{
  now?: () => Date;
  repository: Pick<UsageLimitsRepository, "loadUsageLimitStatus">;
  resolveAuth: RequestAuthResolver;
}>) {
  const now = input.now ?? (() => new Date());
  const failure = (code: UserUsageLimitStatusErrorCode) => reply({ error: code }, ERROR_STATUS[code]);

  return async function GET(request: Request): Promise<Response> {
    const session = await input.resolveAuth(request);
    if (!session) return failure("unauthorized");
    if (session.user.status !== "active") return failure("forbidden");
    const at = now();
    try {
      const status = await input.repository.loadUsageLimitStatus(session.userId, at);
      return reply({ usageLimits: projectUserUsageLimitStatus(status, at) });
    } catch {
      console.error("usage_limits_unavailable");
      return failure("usage_limits_unavailable");
    }
  };
}

import {
  ADMIN_SIGN_IN_REFUSAL_LIMIT,
  isSignInRefusalCode,
  isSignInRefusalMethod,
  type AdminSignInRefusal,
  type AdminSignInRefusalAccount,
  type AdminSignInRefusalsErrorResponse,
  type AdminSignInRefusalsResponse,
  type AdminSignInRefusalSubject
} from "@/lib/contracts/adminSignInRefusals";
import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import type { RequestAuthResolver } from "./requestAuth";
import {
  SIGN_IN_REFUSAL_RETENTION_MS,
  type SignInRefusalAccountRow,
  type SignInRefusalListRow
} from "./signInRefusals";

export type AdminSignInRefusalsReader = (input: Readonly<{ from: Date; limit: number }>) =>
  Promise<Readonly<{ rows: readonly SignInRefusalListRow[]; total: number }>>;

function account(row: SignInRefusalAccountRow): AdminSignInRefusalAccount {
  return { displayName: row.displayName, email: row.email, id: row.id, status: row.status };
}

function subject(row: SignInRefusalListRow): AdminSignInRefusalSubject | null {
  if (row.subjectKey === "overflow") return { kind: "overflow" };
  if (row.subjectKey === "no_verified_email") return { kind: "no_verified_email" };
  if (row.email !== null) {
    return { account: row.account ? account(row.account) : null, email: row.email, kind: "email" };
  }
  // An account row whose account is gone (deleted meanwhile) names nobody worth listing.
  return row.userId !== null && row.account ? { account: account(row.account), kind: "account" } : null;
}

/** One row as the Users page lists it; null for a row this version cannot name. */
export function projectAdminSignInRefusal(row: SignInRefusalListRow): AdminSignInRefusal | null {
  const named = subject(row);
  if (!named || !isSignInRefusalMethod(row.method) || !isSignInRefusalCode(row.code)) return null;
  return {
    attempts: row.attempts,
    code: row.code,
    firstSeenAt: row.firstSeenAt.toISOString(),
    id: row.id,
    lastSeenAt: row.lastSeenAt.toISOString(),
    method: row.method,
    subject: named
  };
}

function json(body: AdminSignInRefusalsResponse | AdminSignInRefusalsErrorResponse, status = 200): Response {
  const response = Response.json(body, { status });
  response.headers.set("cache-control", "private, no-store, max-age=0");
  response.headers.set("vary", "Cookie");
  return response;
}

/**
 * `GET /api/admin/sign-in/refusals`: the refused sign-ins of the last 30 days, newest first and
 * bounded, for active administrators only.
 */
export function createAdminSignInRefusalsHandler(input: Readonly<{
  now?: () => Date;
  read: AdminSignInRefusalsReader;
  resolveAuth: RequestAuthResolver;
}>) {
  const clock = input.now ?? (() => new Date());
  return async function GET(request: Request): Promise<Response> {
    const session = await input.resolveAuth(request);
    if (!session) return json({ error: "unauthorized" }, 401);
    if (session.user.status !== "active" || session.user.role !== "admin") return json({ error: "forbidden" }, 403);
    const now = clock();
    try {
      const { rows, total } = await input.read({
        from: new Date(now.getTime() - SIGN_IN_REFUSAL_RETENTION_MS),
        limit: ADMIN_SIGN_IN_REFUSAL_LIMIT
      });
      const listed = rows.slice(0, ADMIN_SIGN_IN_REFUSAL_LIMIT);
      const refusals = listed.flatMap((row) => projectAdminSignInRefusal(row) ?? []);
      return json({
        signInRefusals: {
          generatedAt: now.toISOString(),
          refusals,
          total: Math.max(total - (listed.length - refusals.length), refusals.length),
          truncated: total > listed.length
        }
      });
    } catch (error) {
      logEvent("service_operation", { code: "sign_in_refusals_failed", error, outcome: "failed",
        prisma_code: databaseFailureCode(error), stage: "read", subsystem: "admin" });
      return json({ error: "sign_in_refusals_failed" }, 503);
    }
  };
}

import { randomUUID } from "node:crypto";
import { Prisma, type AuthIdentityProvider, type PrismaClient, type UserStatus } from "@prisma/client";
import {
  isSignInRefusalCode,
  isSignInRefusalMethod,
  SIGN_IN_REFUSAL_RETENTION_DAYS,
  type SignInRefusalCode,
  type SignInRefusalMethod
} from "@/lib/contracts/adminSignInRefusals";
import { logEvent } from "../observability";
import { databaseFailureCode, retainDatabaseFailure } from "../observability/databaseFailure";
import { isPlausibleEmail, normalizeAuthEmail } from "./password";

/**
 * The refused sign-in journal (Sign-in owns the rule): one `SignInRefusal` row per UTC day,
 * method, refusal code and subject, counting attempts. A subject is an email the method verified
 * or trusts, the existing account a password or second-factor refusal resolved to, or nobody.
 * Writing never changes or fails a sign-in.
 */

/** Rows one UTC day itemizes; later subjects count in their method and code's overflow row. */
export const SIGN_IN_REFUSAL_DAY_ROWS = 500;
export const SIGN_IN_REFUSAL_RETENTION_MS = SIGN_IN_REFUSAL_RETENTION_DAYS * 24 * 3_600_000;
const PRUNE_BATCH_ROWS = 500;
const PRUNE_MAX_BATCHES = 20;
const USER_ID_MAX = 128;

/** Who a refusal names: an email the method vouches for, an existing account, or nobody. */
export type SignInRefusalSubject = Readonly<{ email: string }> | Readonly<{ userId: string }> | null;

export type SignInRefusalInput = Readonly<{
  code: SignInRefusalCode;
  method: SignInRefusalMethod;
  /** When the attempt was refused; its UTC day is the row's. */
  now: Date;
  subject: SignInRefusalSubject;
}>;

/** Records one refused attempt. Never rejects. */
export type SignInRefusalRecorder = (input: SignInRefusalInput) => Promise<void>;

export type SignInRefusalDatabase = Pick<PrismaClient, "$executeRaw" | "$queryRaw">;

type SubjectColumns = Readonly<{ email: string | null; key: string; userId: string | null }>;

const utc = (date: Date): Prisma.Sql => Prisma.sql`(${date}::timestamptz AT TIME ZONE 'UTC')`;

/**
 * The email an external method's refusal may name: one the source verified or the method is
 * configured to trust (the settlement's own rule), normalized; otherwise nobody.
 */
export function trustedRefusalSubject(input: Readonly<{
  email: string | null;
  emailVerified: boolean;
  trustUnverifiedEmail: boolean;
}>): SignInRefusalSubject {
  if (input.email === null || !(input.emailVerified || input.trustUnverifiedEmail)) return null;
  const email = normalizeAuthEmail(input.email);
  return isPlausibleEmail(email) ? { email } : null;
}

/** The journal code of a settlement that admitted no session. */
export function settlementRefusalCode(
  status: "account_conflict" | "email_missing" | "not_allowed" | "pending" | "source_changed"
): SignInRefusalCode {
  return status === "pending" ? "account_pending" : status;
}

function subjectColumns(subject: SignInRefusalSubject): SubjectColumns | null {
  if (subject === null) return { email: null, key: "no_verified_email", userId: null };
  if ("email" in subject) {
    const email = normalizeAuthEmail(subject.email);
    return email === subject.email && isPlausibleEmail(email) ? { email, key: `email:${email}`, userId: null } : null;
  }
  return subject.userId && subject.userId.length <= USER_ID_MAX && subject.userId.trim() === subject.userId
    ? { email: null, key: `user:${subject.userId}`, userId: subject.userId }
    : null;
}

/**
 * Counts the attempt on its subject's row for the day, creating the row while the day has fewer
 * than `SIGN_IN_REFUSAL_DAY_ROWS`. False when the day is full and the subject has no row yet.
 * Concurrent writers of one key sum through the unique key; concurrent new keys may pass the
 * limit by the number of writers.
 */
async function countOnSubject(db: SignInRefusalDatabase, input: SignInRefusalInput, columns: SubjectColumns): Promise<boolean> {
  const day = input.now.toISOString().slice(0, 10);
  const at = utc(input.now);
  const rows = await db.$queryRaw<Array<{ recorded: bigint | number }>>(Prisma.sql`
    WITH updated AS (
      UPDATE "SignInRefusal"
      SET "attempts" = "attempts" + 1,
        "firstSeenAt" = LEAST("firstSeenAt", ${at}),
        "lastSeenAt" = GREATEST("lastSeenAt", ${at})
      WHERE "day" = ${day}::date AND "method" = ${input.method}::"AuthIdentityProvider"
        AND "code" = ${input.code}::varchar AND "subjectKey" = ${columns.key}::varchar
      RETURNING 1
    ), inserted AS (
      INSERT INTO "SignInRefusal" (
        "id", "day", "method", "code", "subjectKey", "email", "userId", "attempts", "firstSeenAt", "lastSeenAt"
      )
      SELECT ${randomUUID()}::text, ${day}::date, ${input.method}::"AuthIdentityProvider", ${input.code}::varchar,
        ${columns.key}::varchar, ${columns.email}::varchar, ${columns.userId}::text, 1, ${at}, ${at}
      WHERE NOT EXISTS (SELECT 1 FROM updated)
        AND (SELECT count(*) FROM "SignInRefusal" WHERE "day" = ${day}::date) < ${SIGN_IN_REFUSAL_DAY_ROWS}::integer
      ON CONFLICT ("day", "method", "code", "subjectKey") DO UPDATE SET
        "attempts" = "SignInRefusal"."attempts" + 1,
        "firstSeenAt" = LEAST("SignInRefusal"."firstSeenAt", EXCLUDED."firstSeenAt"),
        "lastSeenAt" = GREATEST("SignInRefusal"."lastSeenAt", EXCLUDED."lastSeenAt")
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM updated) + (SELECT count(*) FROM inserted) AS "recorded"
  `);
  return Number(rows[0]?.recorded ?? 0) > 0;
}

/** An attempt past the day's itemized limit: counted per method and code, naming nobody. */
async function countOnOverflow(db: SignInRefusalDatabase, input: SignInRefusalInput): Promise<void> {
  const day = input.now.toISOString().slice(0, 10);
  const at = utc(input.now);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "SignInRefusal" (
      "id", "day", "method", "code", "subjectKey", "email", "userId", "attempts", "firstSeenAt", "lastSeenAt"
    )
    VALUES (${randomUUID()}::text, ${day}::date, ${input.method}::"AuthIdentityProvider", ${input.code}::varchar,
      'overflow', NULL, NULL, 1, ${at}, ${at})
    ON CONFLICT ("day", "method", "code", "subjectKey") DO UPDATE SET
      "attempts" = "SignInRefusal"."attempts" + 1,
      "firstSeenAt" = LEAST("SignInRefusal"."firstSeenAt", EXCLUDED."firstSeenAt"),
      "lastSeenAt" = GREATEST("SignInRefusal"."lastSeenAt", EXCLUDED."lastSeenAt")
  `);
}

function reportRecordFailure(error: unknown): void {
  try {
    logEvent("service_operation", {
      action: "skip", code: "sign_in_refusal_record_failed", error, outcome: "failed",
      prisma_code: databaseFailureCode(error), stage: "write", subsystem: "database"
    });
  } catch { /* Reporting never changes a sign-in. */ }
}

/**
 * Records one refused sign-in attempt. A failure is reported content-free (never the email) and
 * dropped: the journal never changes or fails the sign-in.
 */
export async function recordSignInRefusal(db: SignInRefusalDatabase, input: SignInRefusalInput): Promise<void> {
  try {
    const columns = subjectColumns(input.subject);
    if (!columns || !isSignInRefusalMethod(input.method) || !isSignInRefusalCode(input.code) ||
      !Number.isFinite(input.now.getTime())) {
      throw new Error("sign_in_refusal_invalid");
    }
    if (!(await countOnSubject(db, input, columns))) await countOnOverflow(db, input);
  } catch (error) {
    reportRecordFailure(error);
  }
}

export function createPrismaSignInRefusalRecorder(db: SignInRefusalDatabase): SignInRefusalRecorder {
  return (input) => recordSignInRefusal(db, input);
}

/**
 * Starts recording without waiting for it, for a step whose response time must not depend on
 * whether the typed email belongs to an account (the password form) or that has no reason to wait.
 */
export function noteSignInRefusal(recorder: SignInRefusalRecorder | undefined, input: SignInRefusalInput): void {
  if (!recorder) return;
  try {
    void recorder(input).catch(() => undefined);
  } catch { /* The journal never changes a sign-in. */ }
}

export type SignInRefusalAccountRow = Readonly<{
  displayName: string;
  email: string | null;
  id: string;
  status: UserStatus;
}>;

export type SignInRefusalListRow = Readonly<{
  /** For an account row its account; for an email row the account that has the email now. */
  account: SignInRefusalAccountRow | null;
  attempts: number;
  code: string;
  email: string | null;
  firstSeenAt: Date;
  id: string;
  lastSeenAt: Date;
  method: AuthIdentityProvider;
  subjectKey: string;
  userId: string | null;
}>;

const accountSelect = { displayName: true, email: true, id: true, status: true } satisfies Prisma.UserSelect;

/** The newest rows whose last attempt is not before `from`, and how many there are. */
export async function listSignInRefusals(
  db: Pick<PrismaClient, "signInRefusal" | "user">,
  input: Readonly<{ from: Date; limit: number }>
): Promise<Readonly<{ rows: SignInRefusalListRow[]; total: number }>> {
  try {
    const where = { lastSeenAt: { gte: input.from } } satisfies Prisma.SignInRefusalWhereInput;
    const [rows, total] = await Promise.all([
      db.signInRefusal.findMany({
        orderBy: [{ lastSeenAt: "desc" }, { id: "desc" }],
        select: {
          attempts: true, code: true, email: true, firstSeenAt: true, id: true, lastSeenAt: true, method: true,
          subjectKey: true, user: { select: accountSelect }, userId: true
        },
        take: input.limit,
        where
      }),
      db.signInRefusal.count({ where })
    ]);
    const emails = [...new Set(rows.flatMap((row) => row.email === null ? [] : [row.email]))];
    const holders = emails.length === 0
      ? []
      : await db.user.findMany({ select: accountSelect, where: { email: { in: emails } } });
    const byEmail = new Map(holders.map((holder) => [holder.email, holder]));
    return {
      rows: rows.map(({ user, ...row }) => ({
        ...row,
        account: user ?? (row.email === null ? null : byEmail.get(row.email) ?? null)
      })),
      total
    };
  } catch (error) {
    return retainDatabaseFailure(error);
  }
}

/** Deletes rows whose last attempt is more than 30 days old, in bounded batches. */
export async function deleteExpiredSignInRefusals(db: Pick<PrismaClient, "signInRefusal">, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - SIGN_IN_REFUSAL_RETENTION_MS);
  let deleted = 0;
  try {
    for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch += 1) {
      const expired = await db.signInRefusal.findMany({
        orderBy: [{ lastSeenAt: "asc" }, { id: "asc" }], select: { id: true }, take: PRUNE_BATCH_ROWS,
        where: { lastSeenAt: { lt: cutoff } }
      });
      if (expired.length === 0) break;
      // The cutoff is rechecked so a row counted again meanwhile stays.
      const result = await db.signInRefusal.deleteMany({
        where: { id: { in: expired.map((row) => row.id) }, lastSeenAt: { lt: cutoff } }
      });
      deleted += result.count;
      if (expired.length < PRUNE_BATCH_ROWS) break;
    }
    return deleted;
  } catch (error) {
    return retainDatabaseFailure(error);
  }
}

/**
 * Inside an account deletion: removes the rows naming the account's emails. Rows naming the
 * account itself go with it (cascade).
 */
export async function deleteSignInRefusalsOfEmails(
  tx: Pick<Prisma.TransactionClient, "signInRefusal">,
  emails: readonly (string | null)[]
): Promise<void> {
  const normalized = [...new Set(emails.flatMap((email) => email === null ? [] : [normalizeAuthEmail(email)]))];
  if (normalized.length === 0) return;
  await tx.signInRefusal.deleteMany({ where: { email: { in: normalized } } });
}

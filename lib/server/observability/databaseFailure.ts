import {
  describeDatabaseFailure,
  rememberDatabaseFailure as rememberProjection,
  type DatabaseFailureKind
} from "./databaseCause.cjs";

export type { DatabaseFailureKind } from "./databaseCause.cjs";

// Error payloads never enter the writer. Repository boundaries retain only a
// proven code and preserve the original exception for the existing policy.
// A Prisma error, or a wrapper keeping it in `cause`, projects its code
// directly; a wrapper without a cause carries what its boundary remembered.

export function rememberDatabaseFailure(error: unknown, code: string): void {
  rememberProjection(error, { prisma_code: code });
}

/** Gives `wrapper` the database projection of `cause` it replaces. */
export function retainDatabaseCause(wrapper: unknown, cause: unknown): void {
  rememberProjection(wrapper, describeDatabaseFailure(cause));
}

export function databaseFailureCode(error: unknown): string {
  return describeDatabaseFailure(error).prisma_code ?? "unknown";
}

/** Expired transaction, unavailable transaction start, lock or statement
 * timeout, serialization conflict or deadlock; undefined otherwise. */
export function databaseFailureKind(error: unknown): DatabaseFailureKind | undefined {
  return describeDatabaseFailure(error).db_failure;
}

/** Call at an actual database boundary, before policy mapping. */
export function retainDatabaseFailure(error: unknown): never {
  retainDatabaseCause(error, error);
  throw error;
}

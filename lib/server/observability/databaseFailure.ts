import { Prisma } from "@prisma/client";

// Error payloads never enter the writer. Repository boundaries retain only a
// proven code and preserve the original exception for the existing policy.
const databaseFailureCodes = new WeakMap<object, string>();

export function rememberDatabaseFailure(error: unknown, code: string): void {
  if (error !== null && typeof error === "object" && /^P\d{4}$/.test(code)) {
    databaseFailureCodes.set(error, code);
  }
}

export function databaseFailureCode(error: unknown): string {
  return error !== null && typeof error === "object" ? databaseFailureCodes.get(error) ?? "unknown" : "unknown";
}

/** Call at an actual database boundary, before policy mapping. */
export function retainDatabaseFailure(error: unknown): never {
  try {
    const code = error instanceof Prisma.PrismaClientKnownRequestError ? error.code
      : error instanceof Prisma.PrismaClientInitializationError ? error.errorCode : undefined;
    if (typeof code === "string") rememberDatabaseFailure(error, code);
  } catch { /* Diagnostics cannot replace the database rejection. */ }
  throw error;
}

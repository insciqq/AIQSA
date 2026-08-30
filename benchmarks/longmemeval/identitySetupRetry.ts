import { randomInt } from "node:crypto";
import { Prisma } from "@prisma/client";

const IDENTITY_SETUP_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 25;
const RETRY_MAX_DELAY_MS = 100;

type IdentitySetupRetryOptions = Readonly<{
  retryDelay?: (retryOrdinal: number) => Promise<void>;
}>;

function serializationConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034") return true;
  return error.code === "P2010" &&
    typeof error.meta === "object" &&
    error.meta !== null &&
    "code" in error.meta &&
    (error.meta.code === "40001" || error.meta.code === "40P01");
}

async function waitForRetry(retryOrdinal: number): Promise<void> {
  const ceiling = Math.min(
    RETRY_MAX_DELAY_MS,
    RETRY_BASE_DELAY_MS * (2 ** Math.max(0, retryOrdinal - 1))
  );
  const milliseconds = randomInt(1, ceiling + 1);
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Identity bootstrap is rollback-safe and occurs before case ingestion. Retry
 * only PostgreSQL serialization/deadlock aborts; every other failure remains
 * immediately terminal and preserves the existing fail-closed behavior.
 */
export async function withLongMemEvalIdentitySetupRetry<T>(
  operation: () => Promise<T>,
  options: IdentitySetupRetryOptions = {}
): Promise<T> {
  for (let attempt = 0; attempt < IDENTITY_SETUP_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!serializationConflict(error)) throw error;
      if (attempt === IDENTITY_SETUP_ATTEMPTS - 1) {
        throw new Error("longmemeval_identity_setup_serialization_conflict");
      }
      await (options.retryDelay ?? waitForRetry)(attempt + 1);
    }
  }
  throw new Error("longmemeval_identity_setup_serialization_conflict");
}

import { S3ServiceException } from "@aws-sdk/client-s3";
import { bindContext, logEvent, type LifecycleStage } from "../observability";

function ownValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}

/** The object does not exist (filesystem ENOENT, S3 NoSuchKey or 404), as
 * opposed to a transport or service failure that a later read may survive. */
export function isStoredObjectMissingError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return record.code === "ENOENT" || record.name === "NoSuchKey" || record.$metadata?.httpStatusCode === 404;
}

export type StorageOperationOptions = Readonly<{
  signal?: AbortSignal;
  /**
   * The caller reads to learn whether the object exists (a write-once check
   * before writing it): a missing object is its expected answer, recorded as
   * a completed read with the miss code, not as a failure. Any other failure,
   * and every miss of a read that expects the object, stays an error.
   */
  expectMissing?: boolean;
}>;

export function beginStorageOperation(stage: LifecycleStage, options: StorageOperationOptions = {}) {
  const started = performance.now();
  let finished = false;
  return bindContext((outcome: "completed" | "failed" | "cancelled", error?: unknown, signal?: AbortSignal) => {
    if (finished) return;
    finished = true;
    let code = ownValue(error, "code");
    try {
      if (code === undefined && error instanceof S3ServiceException) code = ownValue(error, "name");
    } catch { /* A hostile error cannot alter storage completion. */ }
    const httpStatus = ownValue(ownValue(error, "$metadata"), "httpStatusCode");
    const failureCode = typeof code === "string" ? code : "unknown";
    if (outcome === "failed" && options.expectMissing === true && isStoredObjectMissingError(error)) {
      logEvent("service_operation", {
        subsystem: "object_storage", stage, outcome: "completed", duration_ms: performance.now() - started,
        code: failureCode, httpStatus: typeof httpStatus === "number" ? httpStatus : undefined
      });
      return;
    }
    logEvent("service_operation", {
      subsystem: "object_storage", stage,
      outcome: outcome === "failed" && signal?.aborted && error === signal.reason ? "cancelled" : outcome,
      duration_ms: performance.now() - started,
      ...(outcome === "failed" ? {
        code: failureCode,
        httpStatus: typeof httpStatus === "number" ? httpStatus : undefined,
        error
      } : {})
    });
  });
}

/** Observe completion of the existing operation without touching its payload. */
export async function observeStorageOperation<T>(
  stage: LifecycleStage,
  operation: () => Promise<T>,
  options: AbortSignal | StorageOperationOptions = {}
): Promise<T> {
  const { signal, ...rest } = options instanceof AbortSignal ? { signal: options } : options;
  const finish = beginStorageOperation(stage, rest);
  try {
    const result = await operation();
    finish("completed");
    return result;
  } catch (error) {
    finish("failed", error, signal);
    throw error;
  }
}

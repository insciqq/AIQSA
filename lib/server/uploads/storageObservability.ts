import { S3ServiceException } from "@aws-sdk/client-s3";
import { bindContext, logEvent, type LifecycleStage } from "../observability";

function ownValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}

export function beginStorageOperation(stage: LifecycleStage) {
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
    logEvent("service_operation", {
      subsystem: "object_storage", stage,
      outcome: outcome === "failed" && signal?.aborted && error === signal.reason ? "cancelled" : outcome,
      duration_ms: performance.now() - started,
      ...(outcome === "failed" ? {
        code: typeof code === "string" ? code : "unknown",
        httpStatus: typeof httpStatus === "number" ? httpStatus : undefined
      } : {})
    });
  });
}

/** Observe completion of the existing operation without touching its payload. */
export async function observeStorageOperation<T>(stage: LifecycleStage, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const finish = beginStorageOperation(stage);
  try {
    const result = await operation();
    finish("completed");
    return result;
  } catch (error) {
    finish("failed", error, signal);
    throw error;
  }
}

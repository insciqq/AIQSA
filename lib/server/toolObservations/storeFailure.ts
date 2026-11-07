import { Prisma } from "@prisma/client";
import { McpToolAccessDeniedError } from "../mcp/toolAccess";
import { databaseFailureCode, databaseFailureKind } from "../observability/databaseFailure";
import type { ToolObservationFailureClass, ToolObservationStoreStep } from "../observability/events";
import { ObservationReadError } from "./byteReader";
import { ObservationEncodingError } from "./codec";
import { ObservationStoreError } from "./contract";

export type { ToolObservationAgentKind, ToolObservationFailureClass, ToolObservationStoreStep } from "../observability/events";

/** Failures thrown by a source owner's authorization while a write held its row (`repository.ts`). One table per
 * process: several bundles may load this module, and the repository and the service must share it. */
const SOURCE_AUTHORITY_FAILURES = Symbol.for("aiqsa.tool-observations.source-authority-failures.v1");
function sourceAuthorityFailures(): WeakSet<object> {
  const holder = globalThis as typeof globalThis & { [SOURCE_AUTHORITY_FAILURES]?: WeakSet<object> };
  return holder[SOURCE_AUTHORITY_FAILURES] ??= new WeakSet();
}

/** Marks a failure of the source authorization a write rechecks, then rethrows it unchanged. */
export function sourceAuthorityFailure(error: unknown): never {
  if (typeof error === "object" && error !== null) sourceAuthorityFailures().add(error);
  throw error;
}

/** The step a failure belongs to: a source authority refusal names itself, whichever write rechecked it. */
export function observationStoreFailureStep(error: unknown, step: ToolObservationStoreStep): ToolObservationStoreStep {
  return typeof error === "object" && error !== null && sourceAuthorityFailures().has(error) ? "source_authority" : step;
}

function aborted(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}

function database(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError || error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Prisma.PrismaClientInitializationError || error instanceof Prisma.PrismaClientRustPanicError ||
    error instanceof Prisma.PrismaClientValidationError || databaseFailureCode(error) !== "unknown" || databaseFailureKind(error) !== undefined;
}

const storageSteps = new Set<ToolObservationStoreStep>(["object_put", "read_back"]);
const authoritySteps = new Set<ToolObservationStoreStep>(["outcome_record", "begin_write", "source_authority", "finish_write",
  "unretained_close", "search_receipt"]);

/**
 * The closed class of a store failure, from the error's type or code and the step that threw it, never from its
 * message. Within a write, `tool_observation_unavailable` is the repository's authority refusal (run, producer row or
 * source); in object I/O, an untyped error is the storage adapter's.
 */
export function observationStoreFailureClass(error: unknown, step: ToolObservationStoreStep): ToolObservationFailureClass {
  if (aborted(error)) return "abort";
  if (database(error)) return "database";
  if (error instanceof McpToolAccessDeniedError) return "authority";
  if (error instanceof ObservationStoreError) {
    switch (error.code) {
      case "tool_observation_conflict": return "conflict";
      case "tool_observation_busy": return "limit";
      case "tool_observation_storage_unavailable": return "storage";
      case "tool_observation_not_started": return "authority";
      case "tool_observation_unavailable":
        return step === "projection_limit" ? "limit" : storageSteps.has(step) ? "storage" : authoritySteps.has(step) ? "authority"
          : step === "measure" || step === "preview" ? "invalid" : "unknown";
    }
  }
  if (error instanceof ObservationEncodingError) return error.code === "tool_observation_too_large" ? "limit" : "invalid";
  if (storageSteps.has(step)) return "storage";
  if (error instanceof ObservationReadError) return "invalid";
  return "unknown";
}

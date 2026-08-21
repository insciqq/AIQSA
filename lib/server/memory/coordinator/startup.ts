import type { PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import { getSecretEncryptionKey } from "../../secrets/envelope";
import {
  loadMemorySuppressionKeyring,
  preflightMemorySuppressionKeys
} from "../suppressionKeyring";
import {
  preflightDefaultMemoryCoordinator,
  startDefaultMemoryCoordinator
} from "./defaultCoordinator";
import {
  ensureDefaultMemoryPurgeHandlerRegistered,
  reconcileDefaultCompletedMemoryDeletionAudits
} from "../purge/defaultPurge";

export type MemoryCoordinatorStartupBlockCode =
  | "memory_coordinator_startup_failed"
  | "memory_coordinator_preflight_failed"
  | "memory_coordinator_registry_incomplete"
  | "memory_suppression_historical_key_missing"
  | "memory_suppression_keyring_invalid"
  | "memory_suppression_required_key_ids_invalid";

export type MemoryCoordinatorStartupResult =
  | Readonly<{ status: "ready" }>
  | Readonly<{
      code: MemoryCoordinatorStartupBlockCode;
      missingKeyIds: readonly string[];
      status: "blocked";
    }>;

export type MemoryCoordinatorRuntimeStatus =
  | Readonly<{ status: "not_started" | "starting" }>
  | MemoryCoordinatorStartupResult;

type MemoryCoordinatorStartupGlobal = typeof globalThis & {
  __aiqsaMemoryCoordinatorStartupPromise?: Promise<MemoryCoordinatorStartupResult>;
  __aiqsaMemoryCoordinatorStartupStatus?: MemoryCoordinatorRuntimeStatus;
};

const noMissingKeys = Object.freeze([]) as readonly string[];

/** Content-free startup failure that may safely cross the process boundary. */
export class MemoryCoordinatorStartupError extends Error {
  constructor(readonly code: MemoryCoordinatorStartupBlockCode) {
    super(code);
    this.name = "MemoryCoordinatorStartupError";
  }
}

export async function listRequiredMemorySuppressionKeyIds(
  client: PrismaClient = prisma
): Promise<readonly string[]> {
  const rows = await client.memorySuppression.findMany({
    distinct: ["fingerprintKeyVersion"],
    orderBy: { fingerprintKeyVersion: "asc" },
    select: { fingerprintKeyVersion: true }
  });
  return Object.freeze(rows.map((row) => row.fingerprintKeyVersion));
}

export async function startMemoryCoordinatorFeatureLocally(input: Readonly<{
  env?: Record<string, string | undefined>;
  listRequiredKeyIds: () => Promise<readonly string[]>;
  preflight?: () => Promise<void>;
  reconcileDeletionAudits?: () => Promise<void>;
  start: () => void;
}>): Promise<MemoryCoordinatorStartupResult> {
  try {
    const requiredKeyIds = await input.listRequiredKeyIds();
    const preflight = preflightMemorySuppressionKeys(
      loadMemorySuppressionKeyring(input.env),
      requiredKeyIds,
      "resume"
    );
    if (preflight.status === "blocked") {
      return Object.freeze({
        code: preflight.code,
        missingKeyIds: preflight.missingKeyIds,
        status: "blocked"
      });
    }
    await input.preflight?.();
    await input.reconcileDeletionAudits?.();
    input.start();
    return Object.freeze({ status: "ready" });
  } catch (error) {
    if (error instanceof MemoryCoordinatorStartupError) {
      return Object.freeze({
        code: error.code,
        missingKeyIds: noMissingKeys,
        status: "blocked"
      });
    }
    return Object.freeze({
      code: "memory_coordinator_startup_failed",
      missingKeyIds: noMissingKeys,
      status: "blocked"
    });
  }
}

export function startDefaultMemoryCoordinatorFeatureLocally(): Promise<MemoryCoordinatorStartupResult> {
  const scope = globalThis as MemoryCoordinatorStartupGlobal;
  const current = scope.__aiqsaMemoryCoordinatorStartupStatus;
  if (current?.status === "ready") return Promise.resolve(current);
  if (scope.__aiqsaMemoryCoordinatorStartupPromise) {
    return scope.__aiqsaMemoryCoordinatorStartupPromise;
  }

  scope.__aiqsaMemoryCoordinatorStartupStatus = Object.freeze({ status: "starting" });
  ensureDefaultMemoryPurgeHandlerRegistered();
  const pending = startMemoryCoordinatorFeatureLocally({
    listRequiredKeyIds: () => listRequiredMemorySuppressionKeyIds(prisma),
    preflight: async () => {
      try {
        // Provider credentials used by extraction, consolidation, and rerank
        // are encrypted with the installation envelope key.  Validate the
        // worker's role-specific environment before it starts claiming work.
        const encryptionKey = getSecretEncryptionKey();
        await preflightDefaultMemoryCoordinator({ encryptionKey });
      } catch (error) {
        if (error instanceof Error &&
            error.message === "memory_job_registry_incomplete") {
          throw new MemoryCoordinatorStartupError(
            "memory_coordinator_registry_incomplete"
          );
        }
        throw new MemoryCoordinatorStartupError(
          "memory_coordinator_preflight_failed"
        );
      }
    },
    reconcileDeletionAudits: reconcileDefaultCompletedMemoryDeletionAudits,
    start: startDefaultMemoryCoordinator
  });
  scope.__aiqsaMemoryCoordinatorStartupPromise = pending;

  return pending.then((result) => {
    scope.__aiqsaMemoryCoordinatorStartupStatus = result;
    if (scope.__aiqsaMemoryCoordinatorStartupPromise === pending) {
      delete scope.__aiqsaMemoryCoordinatorStartupPromise;
    }
    return result;
  });
}

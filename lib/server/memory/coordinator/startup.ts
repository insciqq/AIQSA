import type { PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import {
  loadMemorySuppressionKeyring,
  preflightMemorySuppressionKeys
} from "../suppressionKeyring";
import { startDefaultMemoryCoordinator } from "./defaultCoordinator";

export type MemoryCoordinatorStartupBlockCode =
  | "memory_coordinator_startup_failed"
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
const notStarted: Readonly<{ status: "not_started" }> = Object.freeze({
  status: "not_started"
});

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
    input.start();
    return Object.freeze({ status: "ready" });
  } catch {
    return Object.freeze({
      code: "memory_coordinator_startup_failed",
      missingKeyIds: noMissingKeys,
      status: "blocked"
    });
  }
}

export function getMemoryCoordinatorRuntimeStatus(): MemoryCoordinatorRuntimeStatus {
  const scope = globalThis as MemoryCoordinatorStartupGlobal;
  return scope.__aiqsaMemoryCoordinatorStartupStatus ?? notStarted;
}

export function startDefaultMemoryCoordinatorFeatureLocally(): Promise<MemoryCoordinatorStartupResult> {
  const scope = globalThis as MemoryCoordinatorStartupGlobal;
  const current = scope.__aiqsaMemoryCoordinatorStartupStatus;
  if (current?.status === "ready") return Promise.resolve(current);
  if (scope.__aiqsaMemoryCoordinatorStartupPromise) {
    return scope.__aiqsaMemoryCoordinatorStartupPromise;
  }

  scope.__aiqsaMemoryCoordinatorStartupStatus = Object.freeze({ status: "starting" });
  const pending = startMemoryCoordinatorFeatureLocally({
    listRequiredKeyIds: () => listRequiredMemorySuppressionKeyIds(prisma),
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

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

const HEARTBEAT_ID = "installation";

/** Covers the supported maximum 60-second worker interval plus startup jitter. */
export const KNOWLEDGE_SEARCH_WORKER_HEARTBEAT_FRESHNESS_MS = 150_000;
export const KNOWLEDGE_SEARCH_WORKER_HEARTBEAT_INTERVAL_MS = 30_000;

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export type KnowledgeSearchWorkerHeartbeat = Readonly<{
  beat(now?: Date): Promise<void>;
}>;

export function createPrismaKnowledgeSearchWorkerHeartbeat(
  client: Pick<PrismaClient, "knowledgeSearchWorkerHeartbeat">,
  input: Readonly<{
    instanceId?: string;
    startedAt?: Date;
  }> = {}
): KnowledgeSearchWorkerHeartbeat {
  const instanceId = input.instanceId ?? randomUUID();
  const startedAt = input.startedAt ?? new Date();
  if (!instanceId || instanceId.length > 128 || !validDate(startedAt)) {
    throw new Error("knowledge_search_worker_heartbeat_identity_invalid");
  }

  return Object.freeze({
    async beat(now = new Date()) {
      if (!validDate(now) || now.getTime() < startedAt.getTime()) {
        throw new Error("knowledge_search_worker_heartbeat_clock_invalid");
      }
      await client.knowledgeSearchWorkerHeartbeat.upsert({
        create: {
          id: HEARTBEAT_ID,
          instanceId,
          lastSeenAt: now,
          startedAt
        },
        update: {
          instanceId,
          lastSeenAt: now,
          startedAt
        },
        where: { id: HEARTBEAT_ID }
      });
    }
  });
}

/**
 * Keeps an already-established worker heartbeat fresh while one projection
 * pass is in flight. The worker deliberately establishes its first heartbeat
 * only after a successful pass, so a crash-looping startup never looks ready.
 */
export async function runWithKnowledgeSearchWorkerHeartbeat<T>(
  heartbeat: KnowledgeSearchWorkerHeartbeat,
  operation: () => Promise<T>,
  intervalMs = KNOWLEDGE_SEARCH_WORKER_HEARTBEAT_INTERVAL_MS
): Promise<T> {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 ||
    intervalMs >= KNOWLEDGE_SEARCH_WORKER_HEARTBEAT_FRESHNESS_MS) {
    throw new Error("knowledge_search_worker_heartbeat_interval_invalid");
  }
  let heartbeatFailure: unknown;
  let inFlight: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (inFlight || heartbeatFailure !== undefined) return;
    inFlight = heartbeat.beat()
      .catch((error: unknown) => {
        heartbeatFailure = error;
      })
      .finally(() => {
        inFlight = null;
      });
  }, intervalMs);
  timer.unref?.();

  let result: T;
  try {
    result = await operation();
  } finally {
    clearInterval(timer);
    const pending = inFlight;
    if (pending) await pending;
  }
  if (heartbeatFailure !== undefined) throw heartbeatFailure;
  return result;
}

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";

const HEARTBEAT_ID = "installation";
export const MEMORY_WORKER_HEARTBEAT_FRESHNESS_MS = 150_000;

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export type MemoryWorkerHeartbeat = Readonly<{
  beat(now?: Date): Promise<void>;
}>;

export function createPrismaMemoryWorkerHeartbeat(
  client: PrismaClient,
  input: Readonly<{
    instanceId?: string;
    startedAt?: Date;
  }> = {}
): MemoryWorkerHeartbeat {
  const instanceId = input.instanceId ?? randomUUID();
  const startedAt = input.startedAt ?? new Date();
  if (!instanceId || instanceId.length > 128 || !validDate(startedAt)) {
    throw new Error("memory_worker_heartbeat_identity_invalid");
  }

  return Object.freeze({
    async beat(now = new Date()) {
      if (!validDate(now) || now.getTime() < startedAt.getTime()) {
        throw new Error("memory_worker_heartbeat_clock_invalid");
      }
      await client.memoryWorkerHeartbeat.upsert({
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

export const defaultMemoryWorkerHeartbeat =
  createPrismaMemoryWorkerHeartbeat(prisma);

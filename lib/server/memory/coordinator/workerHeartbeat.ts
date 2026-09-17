import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";

const HEARTBEAT_ID = "installation";
export const MEMORY_WORKER_HEARTBEAT_FRESHNESS_MS = 150_000;

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export type MemoryWorkerHeartbeat = Readonly<{
  begin(now?: Date): Promise<void>;
  beat(now?: Date): Promise<void>;
  stop(): Promise<void>;
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

  async function write(ready: boolean, now: Date) {
    if (!validDate(now) || now.getTime() < startedAt.getTime()) {
      throw new Error("memory_worker_heartbeat_clock_invalid");
    }
    await client.memoryWorkerHeartbeat.upsert({
      create: { id: HEARTBEAT_ID, instanceId, lastSeenAt: now, ready, startedAt },
      update: { instanceId, lastSeenAt: now, ready, startedAt },
      where: { id: HEARTBEAT_ID }
    });
  }
  return Object.freeze({
    begin: (now = new Date()) => write(false, now),
    beat: (now = new Date()) => write(true, now),
    async stop() {
      await client.memoryWorkerHeartbeat.updateMany({
        data: { ready: false }, where: { id: HEARTBEAT_ID, instanceId }
      });
    }
  });
}

export const defaultMemoryWorkerHeartbeat =
  createPrismaMemoryWorkerHeartbeat(prisma);

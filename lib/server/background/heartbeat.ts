import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

const HEARTBEAT_ID = "installation";
export const BACKGROUND_WORKER_HEARTBEAT_INTERVAL_MS = 30_000;

type HeartbeatClient = Pick<PrismaClient, "backgroundWorkerHeartbeat">;

export type BackgroundWorkerHeartbeat = Readonly<{
  /** Claims the row for this instance as not ready, clearing a predecessor's readiness. */
  begin(now?: Date): Promise<void>;
  beat(now?: Date): Promise<void>;
  /** Clears readiness, only if this instance still owns the row. */
  stop(): Promise<void>;
}>;

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export function createPrismaBackgroundWorkerHeartbeat(
  client: HeartbeatClient,
  input: Readonly<{ instanceId?: string; startedAt?: Date }> = {}
): BackgroundWorkerHeartbeat {
  const instanceId = input.instanceId ?? randomUUID();
  const startedAt = input.startedAt ?? new Date();
  if (!instanceId || instanceId.length > 128 || !validDate(startedAt)) {
    throw new Error("background_worker_heartbeat_identity_invalid");
  }
  async function write(ready: boolean, now: Date): Promise<void> {
    if (!validDate(now) || now.getTime() < startedAt.getTime()) {
      throw new Error("background_worker_heartbeat_clock_invalid");
    }
    await client.backgroundWorkerHeartbeat.upsert({
      create: { id: HEARTBEAT_ID, instanceId, lastSeenAt: now, ready, startedAt },
      update: { instanceId, lastSeenAt: now, ready, startedAt },
      where: { id: HEARTBEAT_ID }
    });
  }
  return Object.freeze({
    begin: (now = new Date()) => write(false, now),
    beat: (now = new Date()) => write(true, now),
    async stop() {
      await client.backgroundWorkerHeartbeat.updateMany({
        data: { ready: false },
        where: { id: HEARTBEAT_ID, instanceId }
      });
    }
  });
}

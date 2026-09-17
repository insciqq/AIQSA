import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  decodeThreadWorkspaceActivity,
  decodeThreadWorkspaceActivityEntry,
  type ThreadWorkspaceActivity,
  type ThreadWorkspaceActivityEntry
} from "@/lib/contracts/workspace";
import { mergeWorkspaceActivity } from "@/lib/domain/workspaceActivity";

export const WORKSPACE_ACTIVITY_SNAPSHOT = "workspace_activity_snapshot";
export const WORKSPACE_ACTIVITY_RECEIPT = "workspace_activity_receipt";
// Public event sequences start at zero. This private, mutable row does not
// consume their ordering or advance a reconnect cursor.
const SNAPSHOT_SEQUENCE = -1;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function workspaceActivityFingerprint(entry: ThreadWorkspaceActivityEntry): string {
  const { sequence: _sequence, firstSequence: _firstSequence, updateId: _updateId, ...facts } = entry;
  return createHash("sha256").update(JSON.stringify(facts, (_key, value: unknown) =>
    record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value
  )).digest("hex");
}

export function workspaceActivitySnapshot(payload: unknown): ThreadWorkspaceActivity | null {
  return record(payload) && payload.artifactType === WORKSPACE_ACTIVITY_SNAPSHOT
    ? decodeThreadWorkspaceActivity(payload.payload) : null;
}

/** Called under the existing ModelRun row lock; the snapshot is never raw JSONL. */
export async function loadWorkspaceActivitySnapshot(tx: Prisma.TransactionClient, runId: string): Promise<ThreadWorkspaceActivity | null> {
  const row = await tx.modelRunEvent.findUnique({
    where: { modelRunId_sequence: { modelRunId: runId, sequence: SNAPSHOT_SEQUENCE } }, select: { payload: true }
  });
  if (row) {
    const snapshot = workspaceActivitySnapshot(row.payload);
    if (!snapshot) throw new Error("workspace_activity_snapshot_invalid");
    return snapshot;
  }
  // Older stored projections remain readable without a VM or a migration.
  const legacy = await tx.modelRunEvent.findMany({ where: {
    modelRunId: runId, eventType: "artifact", payload: { path: ["artifactType"], equals: "workspace_activity" }
  }, orderBy: { sequence: "asc" }, select: { payload: true } });
  const entries = legacy.flatMap(({ payload }) => {
    const entry = record(payload) ? decodeThreadWorkspaceActivityEntry(payload.payload) : null;
    return entry ? [entry] : [];
  });
  return mergeWorkspaceActivity(null, { entries });
}

export async function saveWorkspaceActivitySnapshot(tx: Prisma.TransactionClient, runId: string, activity: ThreadWorkspaceActivity): Promise<void> {
  const payload = JSON.parse(JSON.stringify({ artifactType: WORKSPACE_ACTIVITY_SNAPSHOT, payload: activity })) as Prisma.InputJsonValue;
  await tx.modelRunEvent.upsert({
    where: { modelRunId_sequence: { modelRunId: runId, sequence: SNAPSHOT_SEQUENCE } },
    create: { eventType: WORKSPACE_ACTIVITY_SNAPSHOT, modelRunId: runId, payload, sequence: SNAPSHOT_SEQUENCE },
    update: { payload }
  });
}

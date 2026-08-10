import {
  Prisma,
  type MemoryToolEgressMode,
  type PrismaClient
} from "@prisma/client";
import { prisma } from "../../prisma";
import { memorySha256 } from "../persistence/lexical";

const DESTINATION_SNAPSHOT_MAX_BYTES = 32 * 1024;

export type MemoryToolEgressDispatch = Readonly<{
  id: string;
  requestOrdinal: number;
}>;

export type MemoryToolEgressReceiptService = Readonly<{
  beginDispatch(input: Readonly<{
    destinationKind: string;
    destinationSnapshot: Readonly<Record<string, unknown>>;
    mode: MemoryToolEgressMode;
    modelRunToolCallId?: string;
    requestEvidence: unknown;
    requestPreview?: unknown;
    runId: string;
    userId: string;
  }>): Promise<MemoryToolEgressDispatch>;
  recordBlockedDispatch(input: Readonly<{
    destinationKind: string;
    destinationSnapshot: Readonly<Record<string, unknown>>;
    errorCode: string;
    mode: MemoryToolEgressMode;
    modelRunToolCallId?: string;
    requestEvidence: unknown;
    requestPreview?: unknown;
    runId: string;
    userId: string;
  }>): Promise<MemoryToolEgressDispatch>;
  settleRecoveredProviderDispatch(input: Readonly<{
    errorCode?: string;
    outcome: "COMPLETED" | "FAILED";
    runId: string;
    userId: string;
  }>): Promise<boolean>;
  completeDispatch(receiptId: string): Promise<boolean>;
  failDispatch(receiptId: string, errorCode: string): Promise<boolean>;
}>;

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function boundedDestination(value: Readonly<Record<string, unknown>>): Prisma.InputJsonValue {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > DESTINATION_SNAPSHOT_MAX_BYTES) {
    throw new Error("memory_egress_destination_too_large");
  }
  return json(JSON.parse(encoded));
}

function safeCode(value: string): string {
  return /^[A-Za-z0-9._-]{1,128}$/u.test(value)
    ? value
    : "memory_egress_dispatch_failed";
}

async function createReceipt(
  client: PrismaClient,
  input: Readonly<{
    blocked?: boolean;
    destinationKind: string;
    destinationSnapshot: Readonly<Record<string, unknown>>;
    errorCode?: string;
    mode: MemoryToolEgressMode;
    modelRunToolCallId?: string;
    requestEvidence: unknown;
    requestPreview?: unknown;
    runId: string;
    userId: string;
  }>
): Promise<MemoryToolEgressDispatch> {
  const destinationSnapshot = boundedDestination(input.destinationSnapshot);
  return client.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "ModelRun"
      WHERE "id" = ${input.runId} AND "userId" = ${input.userId}
      FOR UPDATE
    `);
    if (!rows[0]) throw new Error("memory_egress_run_not_found");
    if (input.modelRunToolCallId) {
      const call = await tx.modelRunToolCall.findFirst({
        select: { id: true },
        where: { id: input.modelRunToolCallId, modelRunId: input.runId }
      });
      if (!call) throw new Error("memory_egress_tool_call_not_found");
      const existing = await tx.memoryToolEgressReceipt.findFirst({
        select: { id: true, requestOrdinal: true },
        where: {
          modelRunId: input.runId,
          modelRunToolCallId: input.modelRunToolCallId
        }
      });
      if (existing) return existing;
    }
    const count = await tx.memoryToolEgressReceipt.count({
      where: { modelRunId: input.runId }
    });
    if (count >= 64) throw new Error("memory_egress_receipt_limit");
    const blocked = input.blocked === true;
    const now = new Date();
    const created = await tx.memoryToolEgressReceipt.create({
      data: {
        destinationFingerprint: memorySha256(input.destinationSnapshot),
        destinationKind: input.destinationKind,
        destinationSnapshot,
        requestEvidenceHash: memorySha256(input.requestEvidence),
        dispatchState: blocked ? "BLOCKED" : "DISPATCHED",
        ...(blocked ? { dispatchCompletedAt: now } : { dispatchStartedAt: now }),
        ...(blocked ? { errorCode: safeCode(input.errorCode ?? "memory_egress_blocked") } : {}),
        mode: input.mode,
        ...(input.modelRunToolCallId
          ? { modelRunToolCallId: input.modelRunToolCallId }
          : {}),
        modelRunId: input.runId,
        requestOrdinal: count + 1,
        ...(input.requestPreview !== undefined
          ? { requestPreviewHash: memorySha256(input.requestPreview) }
          : {}),
        userId: input.userId
      },
      select: { id: true, requestOrdinal: true }
    });
    return created;
  });
}

export function createMemoryToolEgressReceiptService(
  client: PrismaClient = prisma
): MemoryToolEgressReceiptService {
  return Object.freeze({
    beginDispatch(input) {
      return createReceipt(client, input);
    },
    recordBlockedDispatch(input) {
      return createReceipt(client, {
        ...input,
        blocked: true
      });
    },
    async settleRecoveredProviderDispatch(input) {
      return client.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id"
          FROM "ModelRun"
          WHERE "id" = ${input.runId} AND "userId" = ${input.userId}
          FOR UPDATE
        `);
        if (!rows[0]) return false;
        const receipt = await tx.memoryToolEgressReceipt.findFirst({
          orderBy: { requestOrdinal: "desc" },
          select: { dispatchState: true, id: true },
          where: {
            mode: "PROVIDER_REQUEST",
            modelRunId: input.runId,
            userId: input.userId
          }
        });
        if (!receipt) return false;
        if (receipt.dispatchState === input.outcome) return true;
        if (receipt.dispatchState !== "DISPATCHED") return false;
        const updated = await tx.memoryToolEgressReceipt.updateMany({
          data: {
            dispatchCompletedAt: new Date(),
            dispatchState: input.outcome,
            ...(input.outcome === "FAILED"
              ? { errorCode: safeCode(input.errorCode ?? "provider_dispatch_failed") }
              : { errorCode: null })
          },
          where: { dispatchState: "DISPATCHED", id: receipt.id }
        });
        return updated.count === 1;
      });
    },
    async completeDispatch(receiptId) {
      const updated = await client.memoryToolEgressReceipt.updateMany({
        data: {
          dispatchCompletedAt: new Date(),
          dispatchState: "COMPLETED"
        },
        where: { dispatchState: "DISPATCHED", id: receiptId }
      });
      return updated.count === 1;
    },
    async failDispatch(receiptId, errorCode) {
      const updated = await client.memoryToolEgressReceipt.updateMany({
        data: {
          dispatchCompletedAt: new Date(),
          dispatchState: "FAILED",
          errorCode: safeCode(errorCode)
        },
        where: { dispatchState: "DISPATCHED", id: receiptId }
      });
      return updated.count === 1;
    }
  });
}

export const defaultMemoryToolEgressReceiptService =
  createMemoryToolEgressReceiptService(prisma);

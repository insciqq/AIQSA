import { createHash, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { COMPUTER_ATTACH_FILE_LIMITS } from "@/lib/contracts/computer";
import type { ThreadGeneratedFile } from "@/lib/contracts/workspace";
import { mimeTypeForFileName } from "@/lib/domain/fileTypes";
import { uploadFormatForExtension } from "@/lib/domain/uploadFormats";
import { resolveChatAccess } from "../chats/access";
import { activeModelRunStatuses } from "../runs/prismaRepositoryShared";
import type { StorageAdapter } from "../uploads/storage";

/**
 * The files the agent attaches to its answer from the user's computer (`computer_attach_file`): each is an ordinary
 * chat attachment of the run's answer with origin `COMPUTER_OUTPUT`, in private object storage, downloaded through the
 * owner-checked attachment route and shown with the answer's generated files. Branch deletion releases it into orphan
 * retention and chat deletion deletes it, as for Workspace outputs (`agent_docs/ARCHITECTURE.md`).
 *
 * Publication follows the image outputs' (`lib/server/images/service.ts`): the bytes go to storage under a leased
 * deletion obligation, then one transaction under the run's row lock checks that the run is still active, its chat
 * still the user's and the answer's cap not reached, creates the row and drops the obligation. Anything that stops
 * short releases the lease, and retention deletes the unreferenced object. One tool call publishes at most one file:
 * its row id is kept in the attachment's server-only metadata, so a retry of the call returns the file it already
 * attached; and the same file under the same name attached again in the run returns the earlier attachment.
 */

export type ComputerOutputCall = Readonly<{ runId: string; userId: string; toolCallId: string }>;

export type ComputerOutputPublishInput = ComputerOutputCall & Readonly<{
  bytes: Buffer;
  /** A safe upload name (`isSafeUploadFileName`); the type and kind come from its extension. */
  fileName: string;
  /** Stop or the turn's deadline: nothing is published once it fires. */
  signal: AbortSignal;
}>;

/**
 * `computer_output_limit`: the answer already holds `COMPUTER_ATTACH_FILE_LIMITS.filesPerRun` files;
 * `computer_output_closed`: the run is no longer active, or its chat is gone, so the answer takes no more files.
 */
export type ComputerOutputRefusal = "computer_output_closed" | "computer_output_limit";

export type ComputerOutputPublication =
  | Readonly<{ ok: true; file: ThreadGeneratedFile; reused: boolean }>
  | Readonly<{ ok: false; code: ComputerOutputRefusal }>;

export type ComputerOutputStore = Readonly<{
  /** The file this call already attached, if any. */
  find(input: ComputerOutputCall): Promise<ThreadGeneratedFile | null>;
  /** Stores and attaches the file; throws for a storage or database failure, the lease then released. */
  publish(input: ComputerOutputPublishInput): Promise<ComputerOutputPublication>;
}>;

type Row = Readonly<{ byteSize: number; checksum: string | null; fileName: string; id: string; metadata: unknown; mimeType: string }>;
type Reader = Pick<Prisma.TransactionClient, "attachment">;

const ROW_SELECT = { byteSize: true, checksum: true, fileName: true, id: true, metadata: true, mimeType: true } as const;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function toolCallIdOf(metadata: unknown): string | null {
  const output = record(record(metadata)?.computerOutput);
  return typeof output?.toolCallId === "string" ? output.toolCallId : null;
}

/** The answer's projection of a computer file: its name stands for its path, never the path on the computer. */
export function computerOutputFile(row: Pick<Row, "byteSize" | "fileName" | "id" | "mimeType">): ThreadGeneratedFile {
  return { attachmentId: row.id, byteSize: row.byteSize, fileName: row.fileName, mimeType: row.mimeType, relativePath: row.fileName,
    source: "computer" };
}

/** This call's file, else one of the run with the same name and bytes. */
async function earlier(db: Reader, input: ComputerOutputCall & Readonly<{ checksum?: string; fileName?: string }>): Promise<Row | null> {
  const rows = await db.attachment.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: ROW_SELECT,
    take: COMPUTER_ATTACH_FILE_LIMITS.filesPerRun + 1,
    where: { origin: "COMPUTER_OUTPUT", producerModelRunId: input.runId, status: "ready", userId: input.userId }
  });
  return rows.find((row) => toolCallIdOf(row.metadata) === input.toolCallId) ??
    rows.find((row) => input.checksum !== undefined && row.checksum === input.checksum && row.fileName === input.fileName) ?? null;
}

export function createPrismaComputerOutputStore(prisma: PrismaClient, storage: StorageAdapter): ComputerOutputStore {
  return {
    async find(input) {
      const row = await earlier(prisma, input);
      return row && toolCallIdOf(row.metadata) === input.toolCallId ? computerOutputFile(row) : null;
    },
    async publish(input) {
      const checksum = sha256(input.bytes);
      const known = await earlier(prisma, { ...input, checksum });
      if (known) return { file: computerOutputFile(known), ok: true, reused: true };
      input.signal.throwIfAborted();
      const attachmentId = randomUUID();
      const token = randomUUID();
      const storageKey = `${input.userId}/computer-outputs/${input.runId}/${attachmentId}`;
      const mimeType = mimeTypeForFileName(input.fileName);
      const release = () => prisma.attachmentDeletionJob.updateMany({ data: { claimToken: null, claimedAt: null },
        where: { claimToken: token, storageKey } }).catch(() => undefined);
      // The leased obligation owns the object until the row does: a crash after the upload leaves it to retention.
      await prisma.attachmentDeletionJob.create({ data: { claimToken: token, claimedAt: new Date(), storageKey } });
      try {
        const signal = AbortSignal.any([input.signal, AbortSignal.timeout(COMPUTER_ATTACH_FILE_LIMITS.uploadMs)]);
        if (storage.putObjectStream) {
          const bytes = input.bytes;
          await storage.putObjectStream({ body: new ReadableStream({ start(controller) {
            controller.enqueue(bytes);
            controller.close();
          } }), byteSize: bytes.byteLength, checksum, contentType: mimeType, signal, storageKey });
        } else {
          await storage.putObject({ body: input.bytes, contentType: mimeType, storageKey });
        }
        input.signal.throwIfAborted();
        const outcome = await prisma.$transaction(async (tx): Promise<ComputerOutputPublication> => {
          const runs = await tx.$queryRaw<Array<{ assistantMessageId: string | null; chatId: string; status: string; userId: string }>>`
            SELECT "assistantMessageId", "chatId", "status"::text AS "status", "userId" FROM "ModelRun" WHERE "id" = ${input.runId} FOR UPDATE`;
          const run = runs[0];
          if (!run || run.userId !== input.userId || !run.assistantMessageId ||
            !(activeModelRunStatuses as readonly string[]).includes(run.status)) return { code: "computer_output_closed", ok: false };
          const jobs = await tx.$queryRaw<Array<{ claimToken: string | null }>>`
            SELECT "claimToken" FROM "AttachmentDeletionJob" WHERE "storageKey" = ${storageKey} FOR UPDATE`;
          if (jobs[0]?.claimToken !== token) throw new Error("computer_output_publication_stale");
          if (!await resolveChatAccess(tx, { chatId: run.chatId, userId: input.userId })) return { code: "computer_output_closed", ok: false };
          // Under the run's lock: a retry or a concurrent call of the same file that published meanwhile wins.
          const raced = await earlier(tx, { ...input, checksum });
          if (raced) return { file: computerOutputFile(raced), ok: true, reused: true };
          const count = await tx.attachment.count({ where: { origin: "COMPUTER_OUTPUT", producerModelRunId: input.runId } });
          if (count >= COMPUTER_ATTACH_FILE_LIMITS.filesPerRun) return { code: "computer_output_limit", ok: false };
          const row = await tx.attachment.create({
            data: {
              byteSize: input.bytes.byteLength, chatId: run.chatId, checksum, fileName: input.fileName, id: attachmentId,
              kind: uploadFormatForExtension(input.fileName, "workspace")?.kind ?? "file", messageId: run.assistantMessageId,
              metadata: { computerOutput: { toolCallId: input.toolCallId } } satisfies Prisma.InputJsonValue, mimeType,
              origin: "COMPUTER_OUTPUT", producerModelRunId: input.runId, status: "ready", storageKey, userId: input.userId
            },
            select: ROW_SELECT
          });
          await tx.attachmentDeletionJob.delete({ where: { storageKey } });
          return { file: computerOutputFile(row), ok: true, reused: false };
        });
        // Not published: retention deletes the object the released obligation still names.
        if (!outcome.ok || outcome.reused) await release();
        return outcome;
      } catch (error) {
        await release();
        throw error;
      }
    }
  };
}

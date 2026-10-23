import { Prisma, type PrismaClient } from "@prisma/client";
import { MCP_APPROVAL_CONTINUATION_KIND } from "../../contracts/mcpApprovals";
import { json } from "../runs/prismaRepositoryShared";
import { decodeTranscriptItem, encodeTranscriptItem } from "./transcriptCodec";
import type { TranscriptItem } from "./transcript";

/** One native run, named with the owner and chat every read and write carries. */
export type TranscriptRunScope = Readonly<{ chatId: string; runId: string; userId: string }>;

type TranscriptClient = Pick<PrismaClient, "message" | "modelRun" | "runTranscriptItem">;

/** Runs one transcript load may read: a branch longer than this is beyond any context window. */
export const TRANSCRIPT_LOAD_RUN_LIMIT = 2_000;

/**
 * Durable transcript of native runs (`RunTranscriptItem`). Every query names
 * the run's owner and chat, and the composite foreign key makes a row of
 * another user's or another chat's run unwritable, so a transcript is only
 * ever read and written inside its own chat.
 */
export function createTranscriptRepository(client: TranscriptClient) {
  return {
    /** The sequence the run's next item takes: 0 for a run without items. */
    async nextSequence(scope: TranscriptRunScope): Promise<number> {
      const last = await client.runTranscriptItem.findFirst({
        orderBy: { sequence: "desc" },
        select: { sequence: true },
        where: { chatId: scope.chatId, modelRunId: scope.runId, userId: scope.userId }
      });
      return last ? last.sequence + 1 : 0;
    },

    /**
     * Appends items in order from sequence `from`; a taken sequence refuses the
     * whole batch. Repeating a batch that committed already (its outcome was
     * lost) finds exactly its own rows and succeeds without a second copy.
     */
    async append(scope: TranscriptRunScope, from: number, items: readonly TranscriptItem[]): Promise<void> {
      if (items.length === 0) return;
      if (!Number.isSafeInteger(from) || from < 0) throw new Error("transcript_sequence_invalid");
      const rows = items.map((item, index) => {
        const fields = encodeTranscriptItem(item);
        return {
          body: json(fields.body),
          callId: fields.callId,
          chatId: scope.chatId,
          id: item.id,
          kind: fields.kind,
          modelRunId: scope.runId,
          sequence: from + index,
          userId: scope.userId
        };
      });
      try {
        await client.runTranscriptItem.createMany({ data: rows });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
        const written = await client.runTranscriptItem.count({ where: { chatId: scope.chatId, modelRunId: scope.runId,
          OR: rows.map((row) => ({ id: row.id, sequence: row.sequence })), userId: scope.userId } });
        if (written !== rows.length) throw error;
      }
    },

    /** The items of these runs of one chat and owner, by run, each in sequence order. */
    async loadRuns(input: Readonly<{ chatId: string; runIds: readonly string[]; userId: string }>): Promise<Map<string, TranscriptItem[]>> {
      const runIds = [...new Set(input.runIds)];
      const loaded = new Map<string, TranscriptItem[]>(runIds.map((runId) => [runId, []]));
      if (runIds.length === 0) return loaded;
      if (runIds.length > TRANSCRIPT_LOAD_RUN_LIMIT) throw new Error("transcript_load_too_large");
      const rows = await client.runTranscriptItem.findMany({
        orderBy: [{ modelRunId: "asc" }, { sequence: "asc" }],
        select: { body: true, callId: true, id: true, kind: true, modelRunId: true },
        where: { chatId: input.chatId, modelRunId: { in: runIds }, userId: input.userId }
      });
      for (const row of rows) loaded.get(row.modelRunId)?.push(decodeTranscriptItem(row));
      return loaded;
    },

    /**
     * The native run that answered each of these assistant messages of one
     * chat and owner. A message answered by the old core has none: its text
     * is its history.
     */
    async nativeRunsForAnswers(input: Readonly<{ assistantMessageIds: readonly string[]; chatId: string; userId: string }>):
      Promise<Map<string, string>> {
      const ids = [...new Set(input.assistantMessageIds)];
      if (ids.length === 0) return new Map();
      if (ids.length > TRANSCRIPT_LOAD_RUN_LIMIT) throw new Error("transcript_load_too_large");
      const runs = await client.modelRun.findMany({
        orderBy: { createdAt: "asc" },
        select: { assistantMessageId: true, id: true },
        where: { assistantMessageId: { in: ids }, chatId: input.chatId, engine: "native", userId: input.userId }
      });
      // An answer has one run; the newest wins should a message ever carry more.
      return new Map(runs.flatMap((run) => run.assistantMessageId ? [[run.assistantMessageId, run.id] as const] : []));
    },

    /** Which of these user messages of the chat are approval continuation turns the server wrote. */
    async approvalContinuationTurns(input: Readonly<{ chatId: string; messageIds: readonly string[] }>): Promise<Set<string>> {
      const ids = [...new Set(input.messageIds)];
      if (ids.length === 0) return new Set();
      const rows = await client.message.findMany({
        select: { id: true },
        where: { chatId: input.chatId, id: { in: ids }, role: "user", systemTurnKind: MCP_APPROVAL_CONTINUATION_KIND }
      });
      return new Set(rows.map((row) => row.id));
    }
  };
}

export type TranscriptRepository = ReturnType<typeof createTranscriptRepository>;

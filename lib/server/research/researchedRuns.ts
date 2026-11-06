import type { Prisma } from "@prisma/client";
import { MCP_APPROVAL_CONTINUATION_KIND } from "../../contracts/mcpApprovals";
import { CONTINUE_TURN_TEXT } from "../../contracts/runs";
import { textFromContentBlocks } from "../../domain/modelRunEvents";

/**
 * Whether a main-agent run researched (operator decision 2026-11-06), read from stored rows alone and never from what a model wrote: its answer
 * never offers Regenerate, and its failure offers Continue whatever failed it (`ChatMessageWire.researchAnswer`, `ResearchResumeStore.interrupted`).
 *
 * A run researched when it was admitted with Deep research or has its own frame row, which only a research writes: the plan's window opens it,
 * and a Continue that picks research up links it. Two runs of a research have neither. The server's turn after an Allow works on the rows of
 * the run that started the research (`researchRunOf`), so a run whose message is that turn researched when the run that answered the turn
 * before it on its branch did. A Continue can fail before its own start, so a run whose message is the user's exact Continue researched when
 * that run did and ended unfinished, since a Continue goes on only from an interrupted run. The walk back is bounded.
 *
 * This decides what an answer shows and offers, never authority: `RunResearch.authorized` still needs a run of the chain sent with Deep
 * research, so an ordinary chat's approval turn or Continue authorizes nothing.
 */

/** How many turns back the walk goes: far past the approvals and Continues one research takes, as `researchAuthorityChain` looks. */
export const RESEARCHED_RUN_TURNS = 32;

/** A main-agent run as the predicate reads it. */
export type ResearchedRunRow = Readonly<{
  id: string;
  /** Admitted with Deep research, or has its own research frame row. */
  ownResearch: boolean;
  /** The main run that answered the message its own message follows on its branch; null for none. */
  previousRunId: string | null;
  /** What its message is: the server's turn after an Allow, a message of the user's, or another turn the server wrote. */
  turn: "approval" | "server" | "user";
  /** A native run that ended in error with its answer never published, which a Stop and a finished answer never are. */
  unfinished: boolean;
  userMessageId: string;
}>;

export type ResearchedRunsReader = Readonly<{
  /** The main-agent runs among these, of the reader's owner and chat. */
  rows(runIds: readonly string[]): Promise<readonly ResearchedRunRow[]>;
  /** Of these messages of the user's, those whose words are exactly the Continue button's. */
  continues(messageIds: readonly string[]): Promise<ReadonlySet<string>>;
}>;

/** A stored message's content is the user's Continue: the button's exact word, read as `researchAuthorityChain` reads it. */
export function isContinueContent(content: unknown): boolean {
  return typeof content === "object" && content !== null && !Array.isArray(content) &&
    textFromContentBlocks(content as { blocks?: unknown[] }).trim() === CONTINUE_TURN_TEXT;
}

/**
 * Which of these runs researched. `known` says whether a message is the user's Continue where the caller already holds its content, as a page
 * does; the reader is asked of the rest, and only where the answer matters. The walk follows only a run whose message could go on from the turn
 * before, and from a Continue only to a run that ended unfinished, so an ordinary chat costs one more read at most.
 */
export async function researchedRuns(reader: ResearchedRunsReader, runIds: Iterable<string>,
  known: (messageId: string) => boolean | undefined = () => undefined): Promise<ReadonlySet<string>> {
  const targets = [...new Set(runIds)];
  const rows = new Map<string, ResearchedRunRow>();
  const asked = new Set<string>();
  /** The runs whose answer is needed: the targets, and each run one of them goes on from. */
  const needed = new Set(targets);
  const goesOn = (row: ResearchedRunRow) => !row.ownResearch && row.previousRunId !== null &&
    (row.turn === "approval" || row.turn === "user" && known(row.userMessageId) !== false);
  let load = targets;
  for (let hop = 0; load.length > 0 && hop <= RESEARCHED_RUN_TURNS; hop += 1) {
    for (const id of load) asked.add(id);
    for (const row of await reader.rows(load)) rows.set(row.id, row);
    const next = new Set<string>();
    // A set visits what is added while it is walked, so a chain already read resolves in this pass.
    for (const id of needed) {
      const row = rows.get(id);
      if (!row || !goesOn(row)) continue;
      const previous = rows.get(row.previousRunId!);
      if (!previous) {
        if (!asked.has(row.previousRunId!)) next.add(row.previousRunId!);
      } else if (row.turn === "approval" || previous.unfinished) needed.add(previous.id);
    }
    load = [...next];
  }

  const researched = (isContinue: (row: ResearchedRunRow) => boolean) => {
    const of = (id: string, depth: number): boolean => {
      const row = rows.get(id);
      if (!row) return false;
      if (row.ownResearch) return true;
      if (row.previousRunId === null || depth >= RESEARCHED_RUN_TURNS || row.turn === "server" || row.turn === "user" && !isContinue(row)) return false;
      const previous = rows.get(row.previousRunId);
      return previous !== undefined && (row.turn === "approval" || previous.unfinished) && of(previous.id, depth + 1);
    };
    return (id: string) => of(id, 0);
  };
  // Read generously first, every message of the user's a Continue: only those that would then count need their words read.
  const generous = researched((row) => known(row.userMessageId) ?? true);
  const unknown = [...rows.values()].filter((row) => row.turn === "user" && !row.ownResearch && known(row.userMessageId) === undefined &&
    row.previousRunId !== null && rows.get(row.previousRunId)?.unfinished === true && generous(row.previousRunId)).map((row) => row.userMessageId);
  const continues = unknown.length > 0 ? await reader.continues([...new Set(unknown)]) : new Set<string>();
  const exact = researched((row) => known(row.userMessageId) ?? continues.has(row.userMessageId));
  return new Set(targets.filter(exact));
}

/** The reader over the database, every query naming the owner and chat. */
export function prismaResearchedRunsReader(client: Pick<Prisma.TransactionClient, "message" | "modelRun">,
  { chatId, userId }: Readonly<{ chatId: string; userId: string }>): ResearchedRunsReader {
  return {
    async rows(runIds) {
      if (runIds.length === 0) return [];
      const where = { chatId, id: { in: [...runIds] }, subagentTurnId: null, userId };
      const [runs, chosen] = await Promise.all([
        client.modelRun.findMany({ select: { answerCompletedAt: true, engine: true, id: true, researchFrame: { select: { modelRunId: true } }, status: true,
          userMessage: { select: { id: true, parent: { select: { assistantModelRuns: { orderBy: { createdAt: "desc" }, select: { id: true }, take: 1,
            where: { chatId, subagentTurnId: null, userId } }, role: true } }, systemTurnKind: true } } }, where }),
        // The frozen field alone, read in the database: a request holds the whole branch's context, which this never loads.
        client.modelRun.findMany({ select: { id: true }, where: { ...where, normalizedRequest: { equals: true, path: ["deepResearch"] } } })
      ]);
      const sentWith = new Set(chosen.map((run) => run.id));
      return runs.map((run): ResearchedRunRow => {
        const kind = run.userMessage.systemTurnKind;
        const parent = run.userMessage.parent;
        return { id: run.id, ownResearch: sentWith.has(run.id) || run.researchFrame !== null,
          previousRunId: parent?.role === "assistant" ? parent.assistantModelRuns[0]?.id ?? null : null,
          turn: kind === MCP_APPROVAL_CONTINUATION_KIND ? "approval" : kind === null ? "user" : "server",
          unfinished: run.engine === "native" && run.status === "error" && run.answerCompletedAt === null, userMessageId: run.userMessage.id };
      });
    },
    async continues(messageIds) {
      if (messageIds.length === 0) return new Set();
      const messages = await client.message.findMany({ select: { content: true, id: true },
        where: { chatId, id: { in: [...messageIds] }, role: "user", systemTurnKind: null } });
      return new Set(messages.filter((message) => isContinueContent(message.content)).map((message) => message.id));
    }
  };
}

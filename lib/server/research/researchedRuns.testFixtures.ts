import { MCP_APPROVAL_CONTINUATION_KIND } from "../../contracts/mcpApprovals";
import { CONTINUE_TURN_TEXT } from "../../contracts/runs";
import { SUBAGENT_CALLBACK_TURN_KIND } from "../../contracts/subagents";

/**
 * One turn of a chat's branch, as the database holds it: its question `q-<run>`, which follows the answer of `previous`, and its answer `a-<run>`,
 * which the main-agent run `<run>` wrote.
 */
export type StoredTurn = Readonly<{
  /** Admitted with Deep research. */
  chosen?: true;
  errorPayload?: unknown;
  /** Has its own research frame row. */
  frame?: true;
  /** What its question is: the user's message (by default), the user's Continue, the server's turn after an Allow, or a wake-up turn. */
  message?: "approval" | "callback" | "continue" | "message";
  /** The run whose answer the question follows. */
  previous?: string;
  /** Its answer was published. */
  published?: true;
  status: "cancelled" | "complete" | "error";
}>;

const question = (runId: string) => `q-${runId}`;
const answer = (runId: string) => `a-${runId}`;
const text = (words: string) => ({ blocks: [{ text: words, type: "text" }] });

type Where = Readonly<Record<string, unknown>>;

/**
 * A database of these turns that answers the queries `researchedRuns`, `loadDeepResearchMarks` and the resume store send, by their filters: the
 * owner and chat, a run's status and whether its answer was published, its frozen choice and its frame. It counts the predicate's reads.
 */
export function researchDatabase(turns: Readonly<Record<string, StoredTurn>>, options: Readonly<{ chatId?: string; frameRow?: unknown; userId?: string }> = {}) {
  const { chatId = "chat", userId = "user" } = options;
  const reads = { continues: 0, rows: 0 };
  const scoped = (where: Where) => where.chatId === chatId && where.userId === userId;
  const ids = (where: Where) => typeof where.id === "string" ? [where.id] : [...(where.id as { in: readonly string[] }).in];
  const runOf = (messageId: string) => Object.keys(turns).find((runId) => question(runId) === messageId);
  const kindOf = (turn: StoredTurn) => turn.message === "approval" ? MCP_APPROVAL_CONTINUATION_KIND : turn.message === "callback" ? SUBAGENT_CALLBACK_TURN_KIND : null;
  const failed = (where: Where, turn: StoredTurn) => (where.status === undefined || where.status === turn.status) &&
    (where.answerCompletedAt === undefined || !turn.published);
  const modelRun = {
    findFirst: async ({ where }: { where: Where }) => {
      if (!scoped(where)) return null;
      const id = ids(where).find((candidate) => turns[candidate] !== undefined && failed(where, turns[candidate]!) &&
        (where.normalizedRequest === undefined || turns[candidate]!.chosen === true));
      return id === undefined ? null : { errorPayload: turns[id]!.errorPayload ?? null, id };
    },
    findMany: async ({ where }: { where: Where }) => {
      if (!scoped(where)) return [];
      if (where.userMessageId !== undefined) {
        const asked = (where.userMessageId as { in: readonly string[] }).in;
        return asked.flatMap((messageId) => {
          const runId = runOf(messageId);
          return runId !== undefined && turns[runId]!.chosen ? [{ userMessageId: messageId }] : [];
        });
      }
      const found = ids(where).filter((id) => turns[id] !== undefined);
      if (where.normalizedRequest !== undefined) return found.filter((id) => turns[id]!.chosen).map((id) => ({ id }));
      reads.rows += 1;
      return found.map((id) => {
        const turn = turns[id]!;
        return { answerCompletedAt: turn.published ? new Date(0) : null, engine: "native", id, researchFrame: turn.frame ? { modelRunId: id } : null,
          status: turn.status, userMessage: { id: question(id), parent: turn.previous === undefined ? null
            : { assistantModelRuns: turns[turn.previous] === undefined ? [] : [{ id: turn.previous }], role: "assistant" }, systemTurnKind: kindOf(turn) } };
      });
    }
  };
  const message = {
    findMany: async ({ where }: { where: Where }) => {
      reads.continues += 1;
      if (where.chatId !== chatId) return [];
      return ids(where).flatMap((id) => {
        const runId = runOf(id);
        const turn = runId === undefined ? undefined : turns[runId];
        if (!turn || kindOf(turn) !== null) return [];
        return [{ content: text(turn.message === "continue" ? CONTINUE_TURN_TEXT : "Choose a mattress."), id }];
      });
    }
  };
  const researchFrame = { create: async () => ({}), findFirst: async ({ where }: { where: { modelRunId: string } }) =>
    turns[where.modelRunId]?.frame ? options.frameRow ?? null : null };
  const researchEvidence = { findFirst: async () => ({ id: "record-1" }) };
  return { client: { message, modelRun, researchEvidence, researchFrame }, reads };
}

/** The messages of these runs as a page holds them, its question's content included, oldest first. */
export function pageOf(turns: Readonly<Record<string, StoredTurn>>) {
  return Object.entries(turns).flatMap(([runId, turn]) => [
    { content: text(turn.message === "continue" ? CONTINUE_TURN_TEXT : "Choose a mattress."), id: question(runId), role: "user",
      systemTurnKind: turn.message === "approval" ? MCP_APPROVAL_CONTINUATION_KIND : turn.message === "callback" ? SUBAGENT_CALLBACK_TURN_KIND : null },
    { content: text("Answer."), id: answer(runId), role: "assistant", runId }
  ]);
}

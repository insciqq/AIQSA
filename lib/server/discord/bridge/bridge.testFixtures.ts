import type { ThreadArtifactSummary, ThreadCitation } from "../../../contracts/chats";
import { encodeSseEvent, type ModelRunSseEvent } from "../../../domain/modelRunEvents";
import type { ConnectorChatRecord, ConnectorRunAnswer, ConnectorRunGateway } from "../../connectors/runGateway";
import type { DiscordConversationRecord, DiscordConversationStore } from "../store/conversations";
import { DISCORD_DAY_MS, DISCORD_HOUR_MS, DISCORD_LIMIT_NOTICE_INTERVAL_MS, type DiscordLimitStore, type DiscordLimitWindow } from "../store/limits";
import type { DiscordReplyPatch, DiscordReplyRecord, DiscordReplyStore } from "../store/replies";
import type { DiscordRunFacts, DiscordRunSummary } from "./runFacts";

/**
 * In-memory doubles of the bridge's stores and of the shared run gateway, with
 * the semantics of their Prisma and in-process implementations: one claim per
 * question, conditional updates, limit windows over the same rows, and a run
 * gateway that admits a turn on its expected leaf, refuses a second run of a
 * chat, streams the run's frames as the send handler does and serves its
 * persisted answer.
 */

export function createMemoryDiscordReplyStore(): DiscordReplyStore & Readonly<{ rows: Map<string, DiscordReplyRecord> }> {
  const rows = new Map<string, DiscordReplyRecord>();
  return Object.freeze({
    rows,
    async claim(input) {
      if (rows.has(input.questionMessageId)) return "duplicate" as const;
      rows.set(input.questionMessageId, {
        ackAt: null, admittedAt: null, answerMessageId: null, authorName: input.authorName.slice(0, 100) || "Discord user", channelId: input.channelId,
        code: null, compactions: null, conversationId: input.conversationId ?? null, deliveredAt: null, discordUserId: input.discordUserId,
        expectedLeafId: input.expectedLeafId ?? null, failureKind: null, firstStatusAt: null, guildId: input.guildId, kind: input.kind ?? "answer",
        limitKind: null, mcpByServer: null, plannedChatId: null, questionMessageId: input.questionMessageId, receivedAt: input.receivedAt,
        runId: null, sendClaimedAt: null, sources: null, state: "claimed", statusMessageId: null, subagents: null, test: input.test
      });
      return "claimed" as const;
    },
    async find(id) {
      return rows.get(id) ?? null;
    },
    async findByAnswerMessage(id) {
      return [...rows.values()].find((row) => row.answerMessageId === id) ?? null;
    },
    async update(id, patch: DiscordReplyPatch, whenState) {
      const row = rows.get(id);
      if (!row || (whenState && !whenState.includes(row.state))) return false;
      const changes = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
      if (Object.keys(changes).length === 0) return false;
      rows.set(id, { ...row, ...changes } as DiscordReplyRecord);
      return true;
    },
    async listUnsettled(input) {
      return [...rows.values()]
        .filter((row) => (row.state === "claimed" || row.state === "admitted") && row.receivedAt.getTime() < input.before.getTime())
        .sort((left, right) => left.receivedAt.getTime() - right.receivedAt.getTime()).slice(0, input.limit);
    },
    async fixAdmissionTarget(id, target) {
      const row = rows.get(id);
      if (!row || row.state !== "claimed") return null;
      const fixed: DiscordReplyRecord = "plannedChatId" in target
        ? { ...row, plannedChatId: row.plannedChatId ?? target.plannedChatId }
        : { ...row, expectedLeafId: row.expectedLeafId ?? target.expectedLeafId };
      rows.set(id, fixed);
      return fixed;
    },
    async claimSend(id, at) {
      const row = rows.get(id);
      if (!row || row.state !== "claimed" || row.runId !== null || row.sendClaimedAt !== null) return false;
      rows.set(id, { ...row, sendClaimedAt: at });
      return true;
    }
  });
}

export function createMemoryDiscordConversationStore(): DiscordConversationStore & Readonly<{ records: Map<string, DiscordConversationRecord> }> {
  const records = new Map<string, DiscordConversationRecord>();
  let next = 1;
  return Object.freeze({
    records,
    async findByChannel(channelId) {
      return records.get(channelId) ?? null;
    },
    async findByChat(chatId) {
      return [...records.values()].find((record) => record.chatId === chatId) ?? null;
    },
    async create(input) {
      const existing = records.get(input.discordChannelId);
      if (existing) return { created: false, record: existing };
      const record: DiscordConversationRecord = {
        botOpened: input.botOpened, chatId: input.chatId, createdAt: input.now, discordChannelId: input.discordChannelId, guildId: input.guildId,
        id: `conversation-${next++}`, kind: input.kind, lastActivityAt: input.now, lastIncludedMessageId: input.lastIncludedMessageId ?? null,
        parentChannelId: input.parentChannelId, userId: input.userId
      };
      records.set(input.discordChannelId, record);
      return { created: true, record };
    },
    async touch(input) {
      for (const [key, record] of records) {
        if (record.id !== input.id) continue;
        records.set(key, { ...record, lastActivityAt: input.at, ...(input.lastIncludedMessageId ? { lastIncludedMessageId: input.lastIncludedMessageId } : {}) });
      }
    },
    async listForBackfill(input) {
      return [...records.values()].filter((record) => record.kind === "dm" || record.lastActivityAt.getTime() >= input.since.getTime()).slice(0, input.limit);
    }
  });
}

/** The Prisma limit store's counting over the memory rows. */
export function createMemoryDiscordLimitStore(replies: Readonly<{ rows: Map<string, DiscordReplyRecord> }>): DiscordLimitStore {
  function window(match: (row: DiscordReplyRecord) => boolean, now: Date, length: number, limit: number): DiscordLimitWindow {
    const counted = [...replies.rows.values()]
      .filter((row) => (row.kind === "answer" || row.kind === "follow_up") && match(row) && row.receivedAt.getTime() > now.getTime() - length)
      .sort((left, right) => left.receivedAt.getTime() - right.receivedAt.getTime());
    const agingOut = counted.length >= limit ? counted[counted.length - limit] : undefined;
    return { count: counted.length, freesAt: agingOut ? new Date(agingOut.receivedAt.getTime() + length) : null, limit };
  }
  return Object.freeze({
    async usage(input) {
      const author = (row: DiscordReplyRecord) => row.discordUserId === input.discordUserId;
      return {
        authorDay: window(author, input.now, DISCORD_DAY_MS, input.limits.perAuthorDaily),
        authorHour: window(author, input.now, DISCORD_HOUR_MS, input.limits.perAuthorHourly),
        threadHour: input.conversationId
          ? window((row) => row.conversationId === input.conversationId, input.now, DISCORD_HOUR_MS, input.limits.perThreadHourly) : null
      };
    },
    async noticeSent(input) {
      return [...replies.rows.values()].some((row) => row.kind === "refused" && row.limitKind === input.kind &&
        (input.kind === "author" ? row.discordUserId === input.discordUserId : row.conversationId === input.conversationId) &&
        (row.statusMessageId !== null || row.answerMessageId !== null) && row.receivedAt.getTime() > input.now.getTime() - DISCORD_LIMIT_NOTICE_INTERVAL_MS);
    }
  });
}

export function createMemoryDiscordRunFacts(replies: Readonly<{ rows: Map<string, DiscordReplyRecord> }>, runs: Readonly<{
  /** The runs of the fake run gateway, oldest first. */
  list(): readonly Readonly<{ runId: string; chatId: string }>[];
}> = { list: () => [] }): DiscordRunFacts & Readonly<{
  summaries: Map<string, DiscordRunSummary>;
}> {
  const summaries = new Map<string, DiscordRunSummary>();
  return Object.freeze({
    summaries,
    async summary(runId) {
      return summaries.get(runId) ?? { compactions: 0, errorCode: null, mcpByServer: {}, subagents: 0 };
    },
    async aiqsaMessages(ids) {
      const found = new Map<string, string | null>();
      for (const row of replies.rows.values()) {
        for (const id of [row.answerMessageId, row.statusMessageId]) if (id && ids.includes(id)) found.set(id, row.conversationId);
      }
      return found;
    },
    async questionsOfRun(runId) {
      return [...replies.rows.values()].filter((row) => row.runId === runId).map((row) => row.questionMessageId);
    },
    async firstRunOfChat(chatId) {
      return runs.list().find((run) => run.chatId === chatId)?.runId ?? null;
    }
  });
}

export type FakeRunFinish = Readonly<{
  text?: string;
  status?: "complete" | "cancelled" | "error";
  code?: string;
  citations?: readonly ThreadCitation[];
}>;

export type FakeRun = {
  readonly runId: string;
  readonly chatId: string;
  readonly assistantMessageId: string;
  readonly userId: string;
  readonly body: Record<string, unknown>;
  readonly followups: { nonce: string; text: string }[];
  status: "streaming" | "complete" | "cancelled" | "error";
  /** Sends one more frame on the run's stream. */
  emit(event: ModelRunSseEvent): void;
  /** Settles the run: its answer is persisted and its stream ends with the terminal frame. */
  finish(input?: FakeRunFinish): void;
};

type FakeChat = { id: string; activeLeafMessageId: string | null; assistantId: string | null };

export function createFakeDiscordRunGateway(options: Readonly<{
  /** Settles every new run at once with this answer (null keeps it running). */
  autoFinish?: ((run: FakeRun) => FakeRunFinish | null) | null;
  /** Streams nothing for a settled run here (a lost stream): the bridge then follows its state. */
  silent?: boolean;
}> = {}) {
  const runs: FakeRun[] = [];
  const chats = new Map<string, FakeChat>();
  const answers = new Map<string, ConnectorRunAnswer>();
  const refusals: { code: string; status: number; extra?: Record<string, unknown> }[] = [];
  let nextRun = 1;

  function terminal(run: FakeRun, input: FakeRunFinish): ConnectorRunAnswer {
    const summary: ThreadArtifactSummary = { citations: [...(input.citations ?? [])], reasoningText: [], sources: [] };
    return {
      artifactSummary: summary, assistantMessageId: run.assistantMessageId, chatId: run.chatId, errorMessage: input.status === "error" ? "failed" : null,
      status: input.status ?? "complete", text: input.text ?? ""
    };
  }

  const gateway: ConnectorRunGateway = Object.freeze({
    async chat(userId: string, chatId: string): Promise<ConnectorChatRecord | null> {
      const chat = chats.get(chatId);
      return chat ? {
        activeLeafMessageId: chat.activeLeafMessageId, assistantId: chat.assistantId, id: chat.id, memoryMode: "EXCLUDED",
        model: { modelId: "", provider: "" }, title: "Discord chat"
      } : null;
    },

    async send({ body, chatId, userId }) {
      const refusal = refusals.shift();
      if (refusal) return Response.json({ error: refusal.code, ...refusal.extra }, { status: refusal.status });
      const known = chats.get(chatId);
      if (!known && (!body.personalDraft || body.expectedActiveLeafId !== null)) return Response.json({ error: "chat_not_found" }, { status: 404 });
      const chat: FakeChat = known ?? { activeLeafMessageId: null, assistantId: typeof body.assistantId === "string" ? body.assistantId : null, id: chatId };
      chats.set(chatId, chat);
      const running = runs.find((run) => run.chatId === chatId && run.status === "streaming");
      if (running) return Response.json({ error: "active_run_in_progress", run: { id: running.runId, status: "streaming" } }, { status: 409 });
      if (body.expectedActiveLeafId !== chat.activeLeafMessageId) return Response.json({ error: "active_leaf_changed" }, { status: 409 });
      const index = nextRun++;
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start: (value) => { controller = value; } });
      const encoder = new TextEncoder();
      let open = true;
      const send = (event: ModelRunSseEvent) => { if (open && !options.silent) controller.enqueue(encoder.encode(encodeSseEvent(event))); };
      const close = () => { if (open) { open = false; controller.close(); } };
      const run: FakeRun = {
        assistantMessageId: `answer-${index}`, body, chatId, followups: [], runId: `run-${index}`, status: "streaming", userId,
        emit: send,
        finish(input = {}) {
          if (run.status !== "streaming") return;
          run.status = input.status ?? "complete";
          answers.set(run.runId, terminal(run, input));
          chat.activeLeafMessageId = run.assistantMessageId;
          if (input.text && run.status === "complete") send({ data: { delta: input.text }, type: "token" });
          if (run.status === "error") send({ data: { code: input.code ?? "run_failed", message: "failed" }, type: "error" });
          else send({ data: { runId: run.runId, status: run.status === "cancelled" ? "cancelled" : "complete" }, type: "done" });
          close();
        }
      };
      runs.push(run);
      chat.activeLeafMessageId = `question-${index}`;
      answers.set(run.runId, { ...terminal(run, {}), status: "streaming" });
      // The admission frames go out even when the rest of the stream is lost.
      controller.enqueue(encoder.encode(encodeSseEvent({ data: { modelId: "m", provider: "fake", runId: run.runId, status: "streaming" }, type: "run_start" })));
      controller.enqueue(encoder.encode(encodeSseEvent({ data: { assistantMessageId: run.assistantMessageId, userMessageId: `question-${index}` }, type: "message_start" })));
      if (options.silent) close();
      const auto = options.autoFinish?.(run);
      if (auto) queueMicrotask(() => run.finish(auto));
      return new Response(stream, { headers: { "content-type": "text/event-stream" }, status: 200 });
    },

    async followup({ nonce, runId, text }) {
      const run = runs.find((entry) => entry.runId === runId);
      if (!run) return Response.json({ error: "model_run_not_found" }, { status: 404 });
      if (run.status !== "streaming") return Response.json({ error: "followup_closed" }, { status: 409 });
      if (!run.followups.some((entry) => entry.nonce === nonce)) run.followups.push({ nonce, text });
      return Response.json({ accepted: true }, { status: 200 });
    },

    async stop({ runId }) {
      const run = runs.find((entry) => entry.runId === runId);
      if (!run) return "not_found";
      if (run.status !== "streaming") return "not_cancelable";
      run.finish({ status: "cancelled" });
      return "stopped";
    },

    async runState({ runId }) {
      const run = runs.find((entry) => entry.runId === runId);
      return run ? { status: run.status } : null;
    },

    async answer({ runId }) {
      return answers.get(runId) ?? null;
    },

    async activeRun({ chatId }) {
      const run = runs.find((entry) => entry.chatId === chatId && entry.status === "streaming");
      return run ? { runId: run.runId } : null;
    }
  });

  return {
    gateway, runs, chats,
    /** The next send is refused with this code. */
    refuseNext(code: string, status: number, extra?: Record<string, unknown>): void { refusals.push({ code, extra, status }); }
  };
}

export type FakeDiscordRunGateway = ReturnType<typeof createFakeDiscordRunGateway>;

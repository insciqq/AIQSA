import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeTelegramBotApi, telegramPhotoFixture, validateTelegramRichMessage } from "@/tests/support/fakeTelegramBotApi";
import { captureRunObservation } from "@/tests/support/runObservation";
import failureCodes from "../observability/failureCodes.json";
import { createTelegramBotApi, createTelegramPacer, type TelegramInputRichMessage } from "./botApi";
import type { TelegramAccessDecision, TelegramAccessRefusal } from "./control/access";
import type { TelegramBotSession } from "./dispatcher";
import { TELEGRAM_FILES_EXPORT_POLL_MS, TELEGRAM_FILES_EXPORT_WAIT_MS } from "./files";
import { createTelegramOutbound } from "./outbound";
import {
  TELEGRAM_SCHEDULED_CLAIM_LEASE_MS,
  TELEGRAM_SCHEDULED_CODES,
  TELEGRAM_SCHEDULED_LOG_CODES,
  createTelegramScheduledDeliverySender,
  telegramScheduledParts,
  type TelegramScheduledDeliveryContext,
  type TelegramScheduledDeliveryRow,
  type TelegramScheduledDeliveryStore,
  type TelegramScheduledFile
} from "./scheduledDelivery";
import type { TelegramLinkRecord } from "./store/links";
import type { TelegramMessageRef } from "./store/messageRefs";
import type { TelegramTransport } from "./transport";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

const START = Date.parse("2026-10-19T06:00:00.000Z");
const SENTINEL = "private-result-sentinel";

type StoredRow = {
  id: string; occurrenceId: string; userId: string; attempts: number; nextAttemptAt: Date; lastFailureCode: string | null;
  createdAt: Date; state: "pending" | "sent" | "failed" | "unknown" | "skipped"; sentAt: Date | null;
};

function result(markdown: string, files: readonly TelegramScheduledFile[] = []): NonNullable<TelegramScheduledDeliveryContext["result"]> {
  return { citations: [], files, markdown, messageId: "answer-1", sources: [] };
}

function completed(markdown = `Morning brief\n\n- ${SENTINEL}`): TelegramScheduledDeliveryContext {
  return {
    chat: { id: "chat-1", usable: true },
    occurrence: { reasonCode: null, state: "COMPLETED", trigger: "manual", unavailableSources: [] },
    result: result(markdown),
    task: { pauseReason: null, telegramNotify: true, title: "Morning brief" }
  };
}

/** The outbox as PostgreSQL keeps it, with the store's conditional writes. */
function memoryStore(context: () => TelegramScheduledDeliveryContext | null) {
  const rows = new Map<string, StoredRow>();
  const files = new Map<string, Buffer>();
  const store: TelegramScheduledDeliveryStore = {
    enqueue: vi.fn(async (occurrenceId: string, now: Date) => {
      if ([...rows.values()].some((row) => row.occurrenceId === occurrenceId)) return false;
      const id = `delivery-${rows.size + 1}`;
      rows.set(id, { attempts: 0, createdAt: now, id, lastFailureCode: null, nextAttemptAt: now, occurrenceId, sentAt: null,
        state: "pending", userId: "user-1" });
      return true;
    }),
    listDue: async (now) => [...rows.values()].filter((row) => row.state === "pending" && row.nextAttemptAt <= now)
      .map(({ state: _state, sentAt: _sentAt, ...row }): TelegramScheduledDeliveryRow => row),
    load: async () => context(),
    claim: async ({ attempts, id, leaseUntil }) => {
      const row = rows.get(id);
      if (!row || row.state !== "pending" || row.attempts !== attempts) return false;
      Object.assign(row, { attempts: attempts + 1, lastFailureCode: TELEGRAM_SCHEDULED_CODES.unknown, nextAttemptAt: leaseUntil });
      return true;
    },
    release: async ({ code, id, nextAttemptAt }) => {
      const row = rows.get(id);
      if (row?.state === "pending") Object.assign(row, { lastFailureCode: code, nextAttemptAt });
    },
    settle: async ({ at, code, id, state }) => {
      const row = rows.get(id);
      if (row?.state !== "pending") return false;
      Object.assign(row, { lastFailureCode: code, sentAt: state === "sent" ? at : null, state });
      return true;
    },
    readFile: async ({ attachmentId }) => files.get(attachmentId) ?? null
  };
  return { files, rows, store };
}

function link(telegramChatId: number, botId: number, id = "link-1"): TelegramLinkRecord {
  return {
    botId, currentChatId: null, displayName: null, id, lastSeenAt: new Date(START),
    linkedAt: new Date(START), pendingAssistantId: null, searchEnabled: false, selectedModelId: null, selectedProvider: null,
    telegramChatId, telegramUserId: telegramChatId, telegramUsername: null, userId: "user-1", workspaceEnabled: false
  };
}

function setup(options: Readonly<{
  context?: () => TelegramScheduledDeliveryContext | null;
  transport?: (base: TelegramTransport) => TelegramTransport;
}> = {}) {
  const fake = createFakeTelegramBotApi();
  closers.push(() => fake.close());
  const user = fake.inject.addUser();
  const transport = options.transport ? options.transport(fake.transport) : fake.transport;
  /** Called on every Bot API wait (pacing or a 429's retry_after). */
  const hooks: { onSleep?: (ms: number) => void } = {};
  const api = createTelegramBotApi({
    pacer: createTelegramPacer({ now: () => 0 }), sleep: async (ms) => hooks.onSleep?.(ms), token: fake.token, transport
  });
  const refs: TelegramMessageRef[] = [];
  const outbound = createTelegramOutbound({
    api, botId: fake.bot.id, callbacks: { create: async () => [] },
    messageRefs: { record: async (entries) => { refs.push(...entries); } }
  });
  const session: TelegramBotSession = { api, botId: fake.bot.id, botUsername: fake.bot.username, generation: 1, outbound };
  let now = START;
  let refusal: TelegramAccessRefusal | null = null;
  let linkId = "link-1";
  let bot: TelegramBotSession | null = session;
  let current = options.context ?? (() => completed());
  const memory = memoryStore(() => current());
  const timers: Array<{ ms: number; wake: () => void }> = [];
  const access = {
    resolveTelegramAccess: vi.fn(async (): Promise<TelegramAccessDecision> => refusal
      ? { allowed: false, link: refusal === "telegram_not_linked" ? null : link(user.id, fake.bot.id, linkId), reasonCode: refusal }
      : { allowed: true, control: {} as never, link: link(user.id, fake.bot.id, linkId) })
  };
  const sender = createTelegramScheduledDeliverySender({
    access, now: () => new Date(now), sessions: { current: async () => bot }, setTimer: (ms, wake) => { timers.push({ ms, wake }); },
    store: memory.store
  });
  return {
    access, fake, hooks, memory, refs, sender, session, timers, user,
    advance(ms: number) { now += ms; },
    at(instant: Date) { now = instant.getTime(); },
    refuse(code: TelegramAccessRefusal | null) { refusal = code; },
    /** The user linked anew: access allows, through another link. */
    relink(id: string) { linkId = id; },
    setBot(value: TelegramBotSession | null) { bot = value; },
    setContext(next: () => TelegramScheduledDeliveryContext | null) { current = next; },
    row() { return [...memory.rows.values()][0]!; },
    /** A second sender over the same outbox: the application after a restart. */
    restarted() {
      return createTelegramScheduledDeliverySender({
        access, now: () => new Date(now), sessions: { current: async () => bot }, setTimer: () => {}, store: memory.store
      });
    }
  };
}

function richText(message: TelegramInputRichMessage): string {
  return JSON.stringify(message.blocks);
}

describe("Telegram scheduled delivery", () => {
  it("sends a result as one message: the heading and the rendered result, with no button, referenced to the run's chat", async () => {
    const capture = await captureRunObservation();
    const h = setup();
    await h.sender.queue("occurrence-1");
    await h.sender.idle();
    expect(h.memory.store.enqueue).toHaveBeenCalledWith("occurrence-1", new Date(START));
    const [sent, ...more] = h.fake.calls("sendRichMessage");
    expect(more).toHaveLength(0);
    const message = sent!.params.rich_message as TelegramInputRichMessage;
    expect(validateTelegramRichMessage(message)).toMatchObject({ ok: true });
    expect(message.blocks[0]).toEqual({ type: "paragraph", text: [{ type: "bold", text: "Morning brief" }, "\nAutomation finished"] });
    expect(richText(message)).toContain(SENTINEL);
    // No link back to AIQSA (operator decision 2026-10-25): the result carries no button at all.
    expect(sent!.params).not.toHaveProperty("reply_markup");
    // A reply to it continues the run's chat from its answer.
    expect(h.refs).toEqual([{ botId: h.fake.bot.id, chatId: "chat-1", linkId: "link-1", messageId: "answer-1",
      telegramChatId: h.user.id, telegramMessageId: 1, userId: "user-1" }]);
    expect(h.row()).toMatchObject({ attempts: 1, lastFailureCode: null, sentAt: new Date(START), state: "sent" });
    // A second notification of the same occurrence records nothing more and sends nothing.
    await h.sender.queue("occurrence-1");
    await h.sender.sweep();
    expect(h.fake.calls("sendRichMessage")).toHaveLength(1);
    expect(JSON.stringify(capture.records())).not.toContain(SENTINEL);
    expect(capture.records()).toContainEqual(expect.objectContaining({ job_id: "delivery-1", outcome: "completed", subsystem: "telegram" }));
  });

  it("sends a pausing failure as its heading and reason only, still continuing the task's chat", async () => {
    const h = setup({ context: () => ({
      chat: { id: "chat-1", usable: true },
      occurrence: { reasonCode: "model_unavailable", state: "FAILED", trigger: "schedule", unavailableSources: [] },
      result: null,
      task: { pauseReason: "model_unavailable", telegramNotify: true, title: "Morning brief" }
    }) });
    await h.sender.queue("occurrence-1");
    await h.sender.idle();
    expect(h.fake.calls("sendRichMessage")).toHaveLength(0);
    const [sent] = h.fake.calls("sendMessage");
    expect(sent!.params.text).toMatch(/^Morning brief\nAutomation paused\n\S/u);
    expect(sent!.params).not.toHaveProperty("reply_markup");
    expect(h.refs).toEqual([expect.objectContaining({ chatId: "chat-1", messageId: null })]);
    expect(h.row().state).toBe("sent");
  });

  it("sends a settlement whose chat waits for deletion without referencing that chat", async () => {
    const h = setup({ context: () => ({
      chat: { id: "chat-1", usable: false },
      occurrence: { reasonCode: "skill_unavailable", state: "FAILED", trigger: "schedule", unavailableSources: [] },
      result: null,
      task: { pauseReason: "skill_unavailable", telegramNotify: true, title: "Brief" }
    }) });
    await h.sender.queue("occurrence-1");
    await h.sender.idle();
    expect(h.fake.lastCall("sendMessage")!.params).not.toHaveProperty("reply_markup");
    expect(h.refs).toEqual([]);
    expect(h.row().state).toBe("sent");
  });

  it.each([
    ["the task's switch was turned off", { task: { pauseReason: null, telegramNotify: false, title: "Brief" } }, TELEGRAM_SCHEDULED_CODES.off],
    ["the result's chat was deleted", { chat: null, result: null }, TELEGRAM_SCHEDULED_CODES.chatUnavailable],
    ["the result's chat waits for permanent deletion", { chat: { id: "chat-1", usable: false } }, TELEGRAM_SCHEDULED_CODES.chatUnavailable],
    ["a check without news is hidden", {
      occurrence: { reasonCode: "no_update", state: "COMPLETED", trigger: "schedule", unavailableSources: [] }
    }, TELEGRAM_SCHEDULED_CODES.notNews]
  ] as const)("skips with a recorded state when %s", async (_case, change, code) => {
    const h = setup({ context: () => ({ ...completed(), ...change }) as TelegramScheduledDeliveryContext });
    await h.sender.queue("occurrence-1");
    await h.sender.idle();
    expect(h.fake.calls()).toHaveLength(0);
    expect(h.row()).toMatchObject({ attempts: 0, lastFailureCode: code, state: "skipped" });
  });

  it.each(["telegram_not_linked", "telegram_access_off", "telegram_bot_changed"] as const)(
    "skips with the access reason when %s", async (reason) => {
      const h = setup();
      h.refuse(reason);
      await h.sender.queue("occurrence-1");
      await h.sender.idle();
      expect(h.fake.calls()).toHaveLength(0);
      expect(h.row()).toMatchObject({ lastFailureCode: reason, state: "skipped" });
    }
  );

  it("skips when the bot is off or another bot now runs", async () => {
    const off = setup();
    off.setBot(null);
    await off.sender.queue("occurrence-1");
    await off.sender.idle();
    expect(off.row()).toMatchObject({ lastFailureCode: "telegram_access_off", state: "skipped" });
    const changed = setup();
    changed.setBot({ ...changed.session, botId: changed.session.botId + 1 });
    await changed.sender.queue("occurrence-1");
    await changed.sender.idle();
    expect(changed.row()).toMatchObject({ lastFailureCode: "telegram_bot_changed", state: "skipped" });
  });

  it("retries a 429 after Telegram's delay and then sends once", async () => {
    const h = setup();
    // The client waits out one 429 itself; the second reaches the outbox.
    h.fake.failNext("sendRichMessage", { retryAfter: 7, status: 429 }, 2);
    await h.sender.queue("occurrence-1");
    await h.sender.idle();
    expect(h.row()).toMatchObject({ attempts: 1, lastFailureCode: "telegram_rate_limited", nextAttemptAt: new Date(START + 7_000),
      state: "pending" });
    expect(h.timers.map((timer) => timer.ms)).toEqual([7_000]);
    // Not due yet: nothing goes out early.
    await h.sender.sweep();
    expect(h.row().attempts).toBe(1);
    h.advance(7_000);
    h.timers[0]!.wake();
    await h.sender.idle();
    expect(h.row()).toMatchObject({ attempts: 2, lastFailureCode: null, state: "sent" });
    expect(h.fake.botMessages(h.user.id)).toHaveLength(1);
  });

  it("retries a send that never reached Telegram and then sends once", async () => {
    let refusals = 2;
    const h = setup({ transport: (base) => ({
      ...base,
      call: async (input) => input.method === "sendRichMessage" && refusals-- > 0
        ? { category: "connect", kind: "network_before_send", ok: false }
        : base.call(input)
    }) });
    await h.sender.queue("occurrence-1");
    await h.sender.idle();
    expect(h.row()).toMatchObject({ attempts: 1, lastFailureCode: "telegram_network_before_send", state: "pending" });
    h.advance(30_000);
    await h.sender.sweep();
    expect(h.row().state).toBe("sent");
    expect(h.fake.botMessages(h.user.id)).toHaveLength(1);
  });

  it("never repeats an ambiguous send: it settles unknown", async () => {
    const h = setup({ transport: (base) => ({
      ...base,
      call: async (input) => input.method === "sendRichMessage" ? { kind: "timeout", ok: false } : base.call(input)
    }) });
    await h.sender.queue("occurrence-1");
    await h.sender.idle();
    expect(h.row()).toMatchObject({ attempts: 1, lastFailureCode: "telegram_delivery_unknown", state: "unknown" });
    h.advance(60 * 60_000);
    await h.sender.sweep();
    expect(h.row().attempts).toBe(1);
  });

  it("fails after five attempts or once the 30-minute window is over", async () => {
    const h = setup({ transport: (base) => ({
      ...base,
      call: async (input) => input.method === "sendRichMessage" ? { category: "connect", kind: "network_before_send", ok: false }
        : base.call(input)
    }) });
    await h.sender.queue("occurrence-1");
    await h.sender.idle();
    for (let attempt = 0; attempt < 6 && h.row().state === "pending"; attempt += 1) {
      h.at(h.row().nextAttemptAt);
      await h.sender.sweep();
    }
    expect(h.row()).toMatchObject({ lastFailureCode: "telegram_network_before_send", state: "failed" });
    expect(h.row().attempts).toBeLessThanOrEqual(5);
  });

  it("fails without retrying when Telegram refuses the chat", async () => {
    const h = setup({ context: () => ({ ...completed(), occurrence: {
      reasonCode: "budget_spent", state: "SKIPPED", trigger: "schedule", unavailableSources: [] }, result: null }) });
    h.fake.failNext("sendMessage", { status: 403 });
    await h.sender.queue("occurrence-1");
    await h.sender.idle();
    expect(h.row()).toMatchObject({ lastFailureCode: "telegram_api_error", state: "failed" });
  });

  it("after a restart sends pending rows once and settles an attempt that never finished as unknown", async () => {
    const h = setup();
    await h.memory.store.enqueue("occurrence-1", new Date(START));
    await h.memory.store.enqueue("occurrence-2", new Date(START));
    // The previous process claimed the second row and ended while sending it.
    await h.memory.store.claim({ attempts: 0, id: "delivery-2", leaseUntil: new Date(START + TELEGRAM_SCHEDULED_CLAIM_LEASE_MS) });
    const restarted = h.restarted();
    await restarted.sweep();
    await restarted.sweep();
    expect(h.memory.rows.get("delivery-1")).toMatchObject({ attempts: 1, state: "sent" });
    expect(h.memory.rows.get("delivery-2")).toMatchObject({ attempts: 1, state: "pending" });
    expect(h.fake.botMessages(h.user.id)).toHaveLength(1);
    h.advance(TELEGRAM_SCHEDULED_CLAIM_LEASE_MS);
    await restarted.sweep();
    expect(h.memory.rows.get("delivery-2")).toMatchObject({ lastFailureCode: "telegram_delivery_unknown", state: "unknown" });
    expect(h.fake.botMessages(h.user.id)).toHaveLength(1);
  });

  it("goes on after a partly sent result without sending its first part again, and never resends it elsewhere", async () => {
    const LONG = `${"word ".repeat(7_000)}\n\n${"tail ".repeat(7_000)}`;
    const expected = telegramScheduledParts(completed(LONG)).length;
    expect(expected).toBeGreaterThanOrEqual(2);
    const flakySecond = (counter: { calls: number }) => (base: TelegramTransport): TelegramTransport => ({
      ...base,
      call: async (input) => {
        if (input.method !== "sendRichMessage") return base.call(input);
        counter.calls += 1;
        // The second message is refused twice: the client waits out one 429 itself.
        return counter.calls === 2 || counter.calls === 3
          ? { errorCode: 429, kind: "telegram", ok: false, retryAfter: 3, status: 429 } : base.call(input);
      }
    });
    const h = setup({ context: () => completed(LONG), transport: flakySecond({ calls: 0 }) });
    await h.sender.queue("occurrence-1");
    await h.sender.idle();
    // Only this process knows how far it got: the row stays claimed until it goes on.
    expect(h.row()).toMatchObject({ attempts: 1, lastFailureCode: "telegram_delivery_unknown", nextAttemptAt: new Date(START + 3_000),
      state: "pending" });
    expect(h.fake.botMessages(h.user.id)).toHaveLength(1);
    h.advance(3_000);
    h.timers[0]!.wake();
    await h.sender.idle();
    expect(h.row()).toMatchObject({ attempts: 2, state: "sent" });
    const sent = h.fake.botMessages(h.user.id).map((message) => JSON.stringify(message));
    expect(sent).toHaveLength(expected);
    expect(sent.filter((text) => text.includes("Morning brief"))).toHaveLength(1);

    // A process that does not know how far the attempt got settles it unknown instead of sending it again.
    const other = setup({ context: () => completed(LONG), transport: flakySecond({ calls: 0 }) });
    await other.sender.queue("occurrence-1");
    await other.sender.idle();
    other.advance(3_000);
    await other.restarted().sweep();
    expect(other.row()).toMatchObject({ lastFailureCode: "telegram_delivery_unknown", state: "unknown" });
    expect(other.fake.botMessages(other.user.id)).toHaveLength(1);
  });

  it.each([
    ["Telegram access ends", (h: ReturnType<typeof setup>) => h.refuse("telegram_access_off"), "telegram_access_off"],
    ["the user unlinks", (h: ReturnType<typeof setup>) => h.refuse("telegram_not_linked"), "telegram_not_linked"],
    ["the user links another Telegram account", (h: ReturnType<typeof setup>) => h.relink("link-2"), "telegram_not_linked"]
  ] as const)("sends nothing more of a long result once %s after its first message, failing the row with that reason", async (
    _case, change, code
  ) => {
    // The sentinel closes the result, so only its last message carries it.
    const LONG = `${"x".repeat(40_000)}\n\n${SENTINEL}`;
    expect(telegramScheduledParts(completed(LONG)).length).toBeGreaterThanOrEqual(2);
    let afterSend: () => void = () => undefined;
    const h = setup({
      context: () => completed(LONG),
      transport: (base) => ({
        ...base,
        call: async (input) => {
          const outcome = await base.call(input);
          if (input.method === "sendRichMessage") afterSend();
          return outcome;
        }
      })
    });
    afterSend = () => change(h);
    await h.sender.queue("occurrence-1");
    await h.sender.idle();
    expect(h.fake.calls()).toHaveLength(1);
    expect(JSON.stringify(h.fake.calls())).not.toContain(SENTINEL);
    expect(h.row()).toMatchObject({ attempts: 1, lastFailureCode: code, sentAt: null, state: "failed" });
  });

  it("sends nothing more once the user unlinks while the client waits out a 429, failing the row with that reason", async () => {
    const LONG = `${"x".repeat(40_000)}\n\n${SENTINEL}`;
    expect(telegramScheduledParts(completed(LONG)).length).toBeGreaterThanOrEqual(2);
    let richSends = 0;
    const h = setup({
      context: () => completed(LONG),
      transport: (base) => ({
        ...base,
        // The second message is rate limited: the client waits out Telegram's 60 s itself.
        call: async (input) => input.method === "sendRichMessage" && (richSends += 1) === 2
          ? { errorCode: 429, kind: "telegram", ok: false, retryAfter: 60, status: 429 } : base.call(input)
      })
    });
    h.hooks.onSleep = (ms) => { if (ms === 60_000) h.refuse("telegram_not_linked"); };
    await h.sender.queue("occurrence-1");
    await h.sender.idle();
    expect(richSends).toBe(2);
    expect(h.fake.botMessages(h.user.id)).toHaveLength(1);
    expect(JSON.stringify(h.fake.botMessages(h.user.id))).not.toContain(SENTINEL);
    expect(h.row()).toMatchObject({ attempts: 1, lastFailureCode: "telegram_not_linked", sentAt: null, state: "failed" });
  });

  it("uploads no file whose recipient lost access while its bytes were read", async () => {
    const report = { attachmentId: "report-1", byteSize: 18, fileName: "report.pdf", mimeType: "application/pdf" };
    const h = setup({ context: () => ({ ...completed("Done."), result: result("Done.", [report]) }) });
    vi.spyOn(h.memory.store, "readFile").mockImplementation(async () => {
      h.refuse("telegram_access_off");
      return Buffer.from("%PDF-1.7 synthetic");
    });
    await h.sender.queue("occurrence-1");
    await h.sender.idle();
    expect(h.fake.calls("sendRichMessage")).toHaveLength(1);
    expect(h.fake.calls("sendDocument")).toHaveLength(0);
    expect(h.fake.calls("sendMessage")).toHaveLength(0);
    expect(h.row()).toMatchObject({ lastFailureCode: "telegram_access_off", state: "failed" });
  });

  it("sends the run's files after the text: images as photos, the rest as documents, too many or too large left in AIQSA", async () => {
    const files = [
      { attachmentId: "image-1", byteSize: 305, fileName: "chart.jpg", mimeType: "image/jpeg" },
      { attachmentId: "report-1", byteSize: 18, fileName: "report.pdf", mimeType: "application/pdf" },
      { attachmentId: "huge-1", byteSize: 60 * 1024 * 1024, fileName: "dump.bin", mimeType: "application/octet-stream" }
    ];
    const h = setup({ context: () => ({ ...completed("Done."), result: result("Done.", files) }) });
    h.memory.files.set("image-1", telegramPhotoFixture());
    h.memory.files.set("report-1", Buffer.from("%PDF-1.7 synthetic"));
    await h.sender.queue("occurrence-1");
    await h.sender.idle();
    expect(JSON.stringify(h.fake.lastCall("sendRichMessage")!.params.rich_message)).toContain("1 more file is in AIQSA.");
    expect(h.fake.lastCall("sendPhoto")).toMatchObject({ file: { field: "photo", filename: "chart.jpg" } });
    expect(h.fake.lastCall("sendDocument")).toMatchObject({ file: { field: "document", filename: "report.pdf" } });
    expect(h.refs.map((ref) => ref.chatId)).toEqual(["chat-1", "chat-1", "chat-1"]);
    expect(h.row().state).toBe("sent");
  });

  it("sends files under cleaned names, a refused photo as a document, and names a file Telegram did not get once, last", async () => {
    const files = [
      { attachmentId: "image-1", byteSize: 305, fileName: "plots/wide chart.png", mimeType: "image/png" },
      { attachmentId: "gone-1", byteSize: 10, fileName: "gone.csv", mimeType: "text/csv" },
      { attachmentId: "report-1", byteSize: 18, fileName: "report‮.pdf", mimeType: "application/pdf" }
    ];
    const h = setup({ context: () => ({ ...completed("Done."), result: result("Done.", files) }) });
    h.memory.files.set("image-1", telegramPhotoFixture());
    h.memory.files.set("report-1", Buffer.from("%PDF-1.7 synthetic"));
    h.fake.failNext("sendPhoto", { description: "Bad Request: PHOTO_INVALID_DIMENSIONS", status: 400 });
    await h.sender.queue("occurrence-1");
    await h.sender.idle();
    expect(h.fake.calls("sendPhoto").map((call) => call.status)).toEqual([400]);
    expect(h.fake.calls("sendDocument").map((call) => [call.file?.filename, call.status])).toEqual([
      ["wide chart.png", 200], ["report.pdf", 200]
    ]);
    const last = h.fake.botMessages(h.user.id).at(-1)!;
    expect(last.text).toBe("1 file couldn't be sent here; it's in AIQSA.");
    expect(last.reply_markup).toBeUndefined();
    expect(h.row().state).toBe("sent");
  });

  it("waits for a result's Workspace files to be exported, at most two minutes, then names what is still being prepared", async () => {
    const report = { attachmentId: "report-1", byteSize: 18, fileName: "report.pdf", mimeType: "application/pdf" };
    let loads = 0;
    const h = setup({ context: () => {
      loads += 1;
      return loads < 3
        ? { ...completed("Done."), result: { ...result("Done."), outputs: "pending" as const } }
        : { ...completed("Done."), result: result("Done.", [report]) };
    } });
    h.memory.files.set("report-1", Buffer.from("%PDF-1.7 synthetic"));
    await h.sender.queue("occurrence-1");
    await h.sender.idle();
    expect(h.fake.botMessages(h.user.id)).toHaveLength(0);
    expect(h.timers.map((timer) => timer.ms)).toEqual([TELEGRAM_FILES_EXPORT_POLL_MS]);
    expect(h.row()).toMatchObject({ attempts: 0, state: "pending" });
    h.advance(TELEGRAM_FILES_EXPORT_POLL_MS);
    h.timers[0]!.wake();
    await h.sender.idle();
    expect(h.timers).toHaveLength(2);
    h.advance(TELEGRAM_FILES_EXPORT_POLL_MS);
    h.timers[1]!.wake();
    await h.sender.idle();
    expect(h.fake.lastCall("sendDocument")).toMatchObject({ file: { filename: "report.pdf" } });
    expect(h.fake.botMessages(h.user.id).filter((message) => message.kind === "text")).toHaveLength(0);
    expect(h.row()).toMatchObject({ attempts: 1, state: "sent" });

    const slow = setup({ context: () => ({ ...completed("Done."), result: { ...result("Done."), outputs: "pending" as const } }) });
    await slow.sender.queue("occurrence-1");
    await slow.sender.idle();
    slow.advance(TELEGRAM_FILES_EXPORT_WAIT_MS);
    slow.timers[0]!.wake();
    await slow.sender.idle();
    const prepared = slow.fake.botMessages(slow.user.id).at(-1)!;
    expect(prepared.text).toBe("More files are still being prepared in AIQSA.");
    expect(prepared.reply_markup).toBeUndefined();
    expect(slow.row().state).toBe("sent");
  });

  it("puts a long result's heading alone when the first message has no room for it, every message within Telegram's limits", () => {
    const parts = telegramScheduledParts(completed("x".repeat(40_000)));
    const messages = parts.flatMap((part) => part.kind === "content" ? [part.message] : []);
    expect(messages.length).toBeGreaterThanOrEqual(2);
    for (const message of messages) expect(validateTelegramRichMessage(message)).toMatchObject({ ok: true });
    expect(parts.at(-1)).toMatchObject({ kind: "content" });
  });

  it("registers its codes among the sorted failure codes", () => {
    const registry = failureCodes as string[];
    for (const code of [...TELEGRAM_SCHEDULED_LOG_CODES, TELEGRAM_SCHEDULED_CODES.unknown]) {
      const index = registry.indexOf(code);
      expect(index, code).toBeGreaterThan(0);
      expect(registry[index - 1]! < code && code < registry[index + 1]!, code).toBe(true);
    }
  });
});

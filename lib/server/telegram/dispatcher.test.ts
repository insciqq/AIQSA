import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeTelegramBotApi, type FakeTelegramBotApi, type FakeTelegramUser } from "@/tests/support/fakeTelegramBotApi";
import { captureRunObservation } from "@/tests/support/runObservation";
import { createTelegramBotApi, createTelegramPacer, decodeTelegramUpdate, type TelegramUpdate } from "./botApi";
import { createTelegramAccessResolver, type TelegramAccessUser } from "./control/access";
import type { TelegramEffectiveControl } from "./control/state";
import { TELEGRAM_COPY, telegramReasonText } from "./copy";
import {
  createTelegramDispatcher, createTelegramHandlerRegistry, createTelegramTestUpdateHandler, parseTelegramCommand,
  type TelegramBotSession, type TelegramDispatcher, type TelegramHandlerRegistry
} from "./dispatcher";
import { createTelegramLinkCommands } from "./linking/commands";
import type { TelegramLinkingService } from "./linking/service";
import { createTelegramOutbound } from "./outbound";
import { createPrismaTelegramCallbackStore } from "./store/callbacks";
import type { TelegramLinkRecord, TelegramLinkStore } from "./store/links";
import type { TelegramReceiptStore } from "./store/receipts";

const HOUR = 3_600_000;
const SECRET_TEXT = "private-question-sentinel";
const USERNAME = "sentinel_username";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

/** Receipts shared by every dispatcher of one test, like one database. */
function memoryReceipts() {
  const states = new Map<string, "claimed" | "done" | "failed">();
  const receipts: Pick<TelegramReceiptStore, "claim" | "finish"> = {
    async claim({ botId, update }) {
      const key = `${botId}:${update.updateId}`;
      if (states.has(key)) return false;
      states.set(key, "claimed");
      return true;
    },
    async finish({ botId, state, updateId }) {
      const key = `${botId}:${updateId}`;
      if (states.get(key) === "claimed") states.set(key, state);
    }
  };
  return { receipts, states };
}

function setup(options: Readonly<{
  control?: Partial<TelegramEffectiveControl>; user?: TelegramAccessUser; queueLimit?: number; concurrency?: number;
  receipts?: ReturnType<typeof memoryReceipts>; fake?: FakeTelegramBotApi; registry?: TelegramHandlerRegistry;
}> = {}) {
  const fake = options.fake ?? createFakeTelegramBotApi();
  closers.push(() => fake.close());
  let clock = Date.parse("2026-10-19T08:00:00.000Z");
  const links = new Map<string, TelegramLinkRecord>();
  const control: TelegramEffectiveControl = {
    bot: { generation: 1, id: fake.bot.id, token: fake.token, username: fake.bot.username },
    enabled: true, groupIds: new Set(), restricted: false, tokenState: "ready", version: 1, ...options.control
  };
  let user: TelegramAccessUser = options.user ?? { activeGroupIds: [], scimDeactivatedAt: null, status: "active" };
  const touched: string[] = [];
  const linkStore: Pick<TelegramLinkStore, "findByChat" | "findByTelegramUser" | "findByUserId" | "touch"> = {
    findByChat: async (botId, chatId) => [...links.values()].find((link) => link.botId === botId && link.telegramChatId === chatId) ?? null,
    findByTelegramUser: async (botId, telegramUserId) =>
      [...links.values()].find((link) => link.botId === botId && link.telegramUserId === telegramUserId) ?? null,
    findByUserId: async (userId) => [...links.values()].find((link) => link.userId === userId) ?? null,
    touch: async (linkId) => { touched.push(linkId); }
  };
  type CallbackRow = { consumedAt: Date | null; expiresAt: Date; id: string; kind: string; linkId: string; payload: unknown };
  const rows = new Map<string, CallbackRow>();
  const callbacks = createPrismaTelegramCallbackStore({
    telegramCallback: {
      createMany: async ({ data }: { data: CallbackRow[] }) => {
        for (const row of data) rows.set(row.id, { ...row, consumedAt: null });
        return { count: data.length };
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = rows.get(where.id);
        const link = row ? [...links.values()].find((candidate) => candidate.id === row.linkId) : undefined;
        return row && link ? {
          ...row, link: { botId: BigInt(link.botId), telegramChatId: BigInt(link.telegramChatId), telegramUserId: BigInt(link.telegramUserId), userId: link.userId }
        } : null;
      },
      updateMany: async ({ data, where }: { data: { consumedAt: Date }; where: { id: string; expiresAt: { gt: Date } } }) => {
        const row = rows.get(where.id);
        if (!row || row.consumedAt || row.expiresAt <= where.expiresAt.gt) return { count: 0 };
        row.consumedAt = data.consumedAt;
        return { count: 1 };
      }
    }
  } as never);
  const access = createTelegramAccessResolver({ control: async () => control, links: linkStore, users: async () => user });
  const linking = {
    linkFromStart: vi.fn(async () => ({ code: "telegram_link_code_invalid", kind: "refused" }) as const),
    unlinkFromBot: vi.fn(async ({ linkId }: { linkId: string }) => {
      const link = [...links.values()].find((candidate) => candidate.id === linkId);
      if (link) links.delete(link.userId);
      return Boolean(link);
    })
  } as unknown as TelegramLinkingService;
  const api = createTelegramBotApi({ pacer: createTelegramPacer({ now: () => 0 }), sleep: async () => {}, token: fake.token, transport: fake.transport });
  const outbound = createTelegramOutbound({
    api, appBaseUrl: "https://aiqsa.example", botId: fake.bot.id, callbacks, messageRefs: { record: async () => {} }, now: () => new Date(clock)
  });
  const session: TelegramBotSession = { api, botId: fake.bot.id, botUsername: fake.bot.username, generation: 1, outbound };
  const registry = options.registry ?? createTelegramHandlerRegistry();
  const shared = options.receipts ?? memoryReceipts();
  const dispatcher = createTelegramDispatcher({
    access, callbacks, commands: createTelegramLinkCommands({ linking }), concurrency: options.concurrency, links: linkStore,
    now: () => clock, queueLimit: options.queueLimit, receipts: shared.receipts, registry
  });
  function link(telegramUser: FakeTelegramUser, userId = `user-${telegramUser.id}`): TelegramLinkRecord {
    const record: TelegramLinkRecord = {
      agentEnabled: false, botId: fake.bot.id, currentChatId: null, displayName: telegramUser.first_name, id: `link-${telegramUser.id}`,
      lastSeenAt: new Date(clock), linkedAt: new Date(clock), pendingAssistantId: null, searchEnabled: true, selectedModelId: null,
      selectedProvider: null, telegramChatId: telegramUser.id, telegramUserId: telegramUser.id, telegramUsername: telegramUser.username ?? null,
      userId, workspaceEnabled: false
    };
    links.set(userId, record);
    return record;
  }
  async function deliver(raw: Record<string, unknown>, target: TelegramDispatcher = dispatcher): Promise<Readonly<{ claimed: boolean }>> {
    const update = decodeTelegramUpdate(raw) as TelegramUpdate;
    const injected = await target.inject(update, session);
    await injected.settled;
    return injected;
  }
  return {
    advance: (ms: number) => { clock += ms; }, control, deliver, dispatcher, fake, link, linking, links, registry, rows, session,
    setUser: (next: TelegramAccessUser) => { user = next; }, shared, touched
  };
}

const textsTo = (fake: FakeTelegramBotApi, chatId: number) => fake.botMessages(chatId).map((message) => message.text);

describe("Telegram dispatcher: who the bot answers", () => {
  it("answers a stranger once an hour with the same text for everyone, never naming an account", async () => {
    const { advance, deliver, fake } = setup();
    const stranger = fake.inject.addUser({ username: USERNAME });
    const other = fake.inject.addUser();
    await deliver(fake.inject.text(stranger, SECRET_TEXT));
    await deliver(fake.inject.text(stranger, "again"));
    await deliver(fake.inject.command(stranger, "help"));
    await deliver(fake.inject.text(other, "hello"));
    expect(textsTo(fake, stranger.id)).toEqual([TELEGRAM_COPY.notLinked]);
    expect(textsTo(fake, other.id)).toEqual([TELEGRAM_COPY.notLinked]);
    advance(HOUR);
    await deliver(fake.inject.text(stranger, "later"));
    expect(textsTo(fake, stranger.id)).toEqual([TELEGRAM_COPY.notLinked, TELEGRAM_COPY.notLinked]);
  });

  it("ignores groups and bots and leaves every group or channel it is added to", async () => {
    const { deliver, fake, link, registry } = setup();
    const owner = fake.inject.addUser();
    link(owner);
    const handler = vi.fn(async () => true);
    registry.registerMessage(handler);
    const group = fake.inject.addedToGroup(owner);
    const groupChat = (group.my_chat_member as { chat: { id: number } }).chat;
    await deliver(group);
    await deliver(fake.inject.addedToGroup(owner, { type: "channel" }));
    expect(fake.leftChats()).toEqual([groupChat.id, groupChat.id - 1]);
    await deliver(fake.inject.raw({
      message: { chat: { id: groupChat.id, title: "Group", type: "group" }, date: 0, from: { first_name: "A", id: owner.id, is_bot: false },
        message_id: 5, text: "/start AAAA" }
    }));
    await deliver(fake.inject.raw({
      message: { chat: { first_name: "B", id: owner.id, type: "private" }, date: 0, from: { first_name: "Bot", id: owner.id, is_bot: true },
        message_id: 6, text: "hello" }
    }));
    await deliver(fake.inject.raw({
      my_chat_member: { chat: { id: groupChat.id, type: "group" }, date: 0, from: { first_name: "A", id: owner.id, is_bot: false },
        new_chat_member: { status: "left", user: { first_name: "Bot", id: fake.bot.id, is_bot: true } },
        old_chat_member: { status: "member", user: { first_name: "Bot", id: fake.bot.id, is_bot: true } } }
    }));
    expect(fake.leftChats()).toHaveLength(2);
    expect(handler).not.toHaveBeenCalled();
    expect(fake.calls("sendMessage")).toHaveLength(0);
  });

  it("hands linked users with access to the registered handlers, the fallback answering what none took", async () => {
    const { deliver, fake, link, registry, touched } = setup();
    const owner = fake.inject.addUser();
    const record = link(owner);
    const seen: unknown[] = [];
    registry.registerMessage(async (context) => {
      seen.push({ command: context.command, link: context.link.id, text: context.message.text });
      return context.message.text === "handled";
    });
    await deliver(fake.inject.text(owner, "handled"));
    await deliver(fake.inject.command(owner, "new"));
    expect(seen).toEqual([
      { command: null, link: record.id, text: "handled" },
      { command: { args: "", name: "new" }, link: record.id, text: "/new" }
    ]);
    expect(textsTo(fake, owner.id)).toEqual([telegramReasonText("telegram_unsupported_message")]);
    expect(touched).toEqual([record.id, record.id]);
  });

  it("refuses with the reason while access is off and keeps the link for when it returns", async () => {
    const group = "8a4f2a8e-5a8b-4c55-9c1e-0d4a1f6f9b10";
    const { deliver, fake, link, links, registry, setUser } = setup({
      control: { groupIds: new Set([group]), restricted: true }, user: { activeGroupIds: [], scimDeactivatedAt: null, status: "active" }
    });
    const owner = fake.inject.addUser();
    link(owner);
    const handler = vi.fn(async () => true);
    registry.registerMessage(handler);
    await deliver(fake.inject.text(owner, SECRET_TEXT));
    await deliver(fake.inject.command(owner, "help"));
    expect(textsTo(fake, owner.id)).toEqual([
      "Telegram access is off for your account. Ask your AIQSA administrator.",
      "Telegram access is off for your account. Ask your AIQSA administrator."
    ]);
    expect(handler).not.toHaveBeenCalled();
    expect(links.size).toBe(1);
    setUser({ activeGroupIds: [group], scimDeactivatedAt: null, status: "active" });
    await deliver(fake.inject.text(owner, "back"));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("routes /start with a code to linking for anyone, and answers /help and a bare /start with the command list", async () => {
    const { deliver, fake, link, linking } = setup();
    const stranger = fake.inject.addUser();
    await deliver(fake.inject.command(stranger, "start", "A".repeat(43)));
    expect(linking.linkFromStart).toHaveBeenCalledWith(expect.objectContaining({ code: "A".repeat(43) }));
    expect(textsTo(fake, stranger.id)).toEqual(["This link has expired. Create a new one in AIQSA → Settings → Connections."]);
    const owner = fake.inject.addUser();
    link(owner);
    await deliver(fake.inject.command(owner, "help"));
    await deliver(fake.inject.command(owner, "start"));
    expect(textsTo(fake, owner.id)).toEqual([TELEGRAM_COPY.help, TELEGRAM_COPY.help]);
  });

  it("notices an edited message once and applies nothing", async () => {
    const { deliver, fake, link, registry } = setup();
    const owner = fake.inject.addUser();
    link(owner);
    const handler = vi.fn(async () => true);
    registry.registerMessage(handler);
    await deliver(fake.inject.text(owner, "first"));
    await deliver(fake.inject.editedMessage(owner, 1, "first, edited"));
    await deliver(fake.inject.editedMessage(owner, 1, "first, edited again"));
    expect(textsTo(fake, owner.id)).toEqual([TELEGRAM_COPY.editsNotApplied]);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("passes the Stop of a streamed draft to the stop handlers for a linked chat only", async () => {
    const { deliver, fake, link, registry } = setup();
    const owner = fake.inject.addUser();
    const stranger = fake.inject.addUser();
    link(owner);
    const stop = vi.fn(async () => {});
    registry.registerStop(stop);
    await deliver(fake.inject.stopGeneration(owner, 77));
    await deliver(fake.inject.stopGeneration(stranger, 78));
    expect(stop).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith(expect.objectContaining({ chatId: owner.id, draftId: 77, link: expect.objectContaining({ userId: `user-${owner.id}` }) }));
  });
});

describe("Telegram dispatcher: buttons", () => {
  async function menu(context: ReturnType<typeof setup>, owner: FakeTelegramUser, kind: "select_chat" | "toggle_search", ttlMs?: number) {
    const record = [...context.links.values()].find((link) => link.telegramUserId === owner.id)!;
    await context.session.outbound.sendText({
      chatId: owner.id, keyboard: [[{ callback: { kind, payload: { chatId: "chat-1" }, ttlMs }, text: "Press" }]], linkId: record.id, text: "Menu"
    });
    const message = context.fake.botMessages(owner.id).at(-1)!;
    const data = (message.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0]![0]!.callback_data;
    return { data, messageId: message.message_id };
  }

  it("refuses forged, foreign, expired and reused buttons, always answering the press", async () => {
    const context = setup();
    const { advance, deliver, fake, link, registry } = context;
    const owner = fake.inject.addUser();
    const intruder = fake.inject.addUser();
    link(owner);
    link(intruder);
    const handler = vi.fn(async () => ({ text: "Done" }));
    registry.registerCallback("select_chat", handler);
    const { data, messageId } = await menu(context, owner, "select_chat", 60_000);

    const forged = fake.inject.callback(owner, messageId, `c:${"Z".repeat(22)}`);
    await deliver(forged);
    const malformed = fake.inject.callback(owner, messageId, "approve:run-1");
    await deliver(malformed);
    const foreign = fake.inject.callback(intruder, messageId, data);
    await deliver(foreign);
    const pressed = fake.inject.callback(owner, messageId, data);
    await deliver(pressed);
    const reused = fake.inject.callback(owner, messageId, data);
    await deliver(reused);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ callback: expect.objectContaining({ kind: "select_chat", payload: { chatId: "chat-1" } }) }));

    const second = await menu(context, owner, "select_chat", 60_000);
    advance(60_000);
    const expired = fake.inject.callback(owner, second.messageId, second.data);
    await deliver(expired);
    expect(handler).toHaveBeenCalledOnce();

    const answers = [forged, malformed, foreign, pressed, reused, expired]
      .map((update) => fake.callbackAnswer((update.callback_query as { id: string }).id));
    expect(answers.map((answer) => answer?.answered)).toEqual([true, true, true, true, true, true]);
    expect(answers.map((answer) => answer?.text)).toEqual([
      TELEGRAM_COPY.buttonExpired, TELEGRAM_COPY.buttonExpired, TELEGRAM_COPY.buttonExpired, "Done", TELEGRAM_COPY.buttonExpired,
      TELEGRAM_COPY.buttonExpired
    ]);
  });

  it("lets reusable buttons be pressed again, checks access first and answers even when the handler fails", async () => {
    const context = setup();
    const { deliver, fake, link, registry, setUser, shared } = context;
    const owner = fake.inject.addUser();
    link(owner);
    const toggle = vi.fn(async () => {});
    registry.registerCallback("toggle_search", toggle, { singleUse: false });
    const { data, messageId } = await menu(context, owner, "toggle_search");
    await deliver(fake.inject.callback(owner, messageId, data));
    await deliver(fake.inject.callback(owner, messageId, data));
    expect(toggle).toHaveBeenCalledTimes(2);

    setUser({ activeGroupIds: [], scimDeactivatedAt: null, status: "disabled" });
    const refused = fake.inject.callback(owner, messageId, data);
    await deliver(refused);
    expect(toggle).toHaveBeenCalledTimes(2);
    expect(fake.callbackAnswer((refused.callback_query as { id: string }).id)?.text)
      .toBe("Telegram access is off for your account. Ask your AIQSA administrator.");

    setUser({ activeGroupIds: [], scimDeactivatedAt: null, status: "active" });
    toggle.mockRejectedValueOnce(new Error("handler failed"));
    const failing = fake.inject.callback(owner, messageId, data);
    await deliver(failing);
    const failingId = (failing.callback_query as { id: string }).id;
    expect(fake.callbackAnswer(failingId)).toEqual({ answered: true, show_alert: undefined, text: TELEGRAM_COPY.buttonFailed });
    expect([...shared.states.values()]).toContain("failed");
  });

  it("disconnects from /unlink and its single-use button, even while access is off", async () => {
    const context = setup({ control: { enabled: true, restricted: true } });
    const { deliver, fake, link, links, linking } = context;
    const owner = fake.inject.addUser();
    link(owner);
    await deliver(fake.inject.command(owner, "unlink"));
    const question = fake.botMessages(owner.id).at(-1)!;
    expect(question.text).toBe(TELEGRAM_COPY.unlinkQuestion);
    const data = (question.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0]![0]!.callback_data;
    await deliver(fake.inject.callback(owner, question.message_id, data));
    expect(linking.unlinkFromBot).toHaveBeenCalledOnce();
    expect(links.size).toBe(0);
    expect(fake.botMessages(owner.id).at(-1)).toMatchObject({ message_id: question.message_id, text: TELEGRAM_COPY.disconnected });
    expect(() => context.registry.registerCallback("unlink_confirm", async () => {})).toThrow("telegram_callback_kind_reserved");
  });
});

describe("Telegram dispatcher: order, bounds and claims", () => {
  it("handles one chat strictly in order and at most the configured number of chats at a time", async () => {
    const { dispatcher, fake, link, registry, session } = setup({ concurrency: 2 });
    const users = [fake.inject.addUser(), fake.inject.addUser(), fake.inject.addUser()];
    for (const user of users) link(user);
    const order: string[] = [];
    let running = 0;
    let peak = 0;
    registry.registerMessage(async (context) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, context.message.text === "slow" ? 30 : 5));
      order.push(`${context.message.chat.id}:${context.message.text}`);
      running -= 1;
      return true;
    });
    const updates = [
      fake.inject.text(users[0]!, "slow"), fake.inject.text(users[0]!, "second"), fake.inject.text(users[1]!, "a"),
      fake.inject.text(users[2]!, "b"), fake.inject.text(users[0]!, "third")
    ].map((raw) => decodeTelegramUpdate(raw) as TelegramUpdate);
    const settled = await Promise.all(updates.map((update) => dispatcher.inject(update, session)));
    await Promise.all(settled.map((entry) => entry.settled));
    await dispatcher.idle();
    expect(order.filter((entry) => entry.startsWith(`${users[0]!.id}:`))).toEqual([
      `${users[0]!.id}:slow`, `${users[0]!.id}:second`, `${users[0]!.id}:third`
    ]);
    expect(order).toHaveLength(5);
    expect(peak).toBe(2);
  });

  it("answers a chat whose queue is full once that it is busy and keeps going", async () => {
    const { dispatcher, fake, link, registry, session, shared } = setup({ queueLimit: 2 });
    const owner = fake.inject.addUser();
    link(owner);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const handled: string[] = [];
    registry.registerMessage(async (context) => {
      if (context.message.text === "first") await gate;
      handled.push(context.message.text!);
      return true;
    });
    const updates = ["first", "two", "three", "four", "five"].map((text) => decodeTelegramUpdate(fake.inject.text(owner, text)) as TelegramUpdate);
    const injected = [];
    for (const update of updates) injected.push(await dispatcher.inject(update, session));
    release();
    await Promise.all(injected.map((entry) => entry.settled));
    await dispatcher.idle();
    expect(handled).toEqual(["first", "two", "three"]);
    expect(textsTo(fake, owner.id)).toEqual(["AIQSA is busy, try again in a minute."]);
    expect([...shared.states.values()].filter((state) => state === "failed")).toHaveLength(2);
  });

  it("handles a duplicate update once, even from two dispatchers sharing one database", async () => {
    const shared = memoryReceipts();
    const fake = createFakeTelegramBotApi();
    const first = setup({ fake, receipts: shared });
    const second = setup({ fake, receipts: shared });
    const owner = fake.inject.addUser();
    first.link(owner);
    second.link(owner);
    const handled = vi.fn(async () => true);
    first.registry.registerMessage(handled);
    second.registry.registerMessage(handled);
    const raw = fake.inject.text(owner, "once");
    const [a, b] = await Promise.all([first.deliver(raw), second.deliver(raw)]);
    expect([a.claimed, b.claimed].sort()).toEqual([false, true]);
    expect(await first.deliver(raw)).toEqual(expect.objectContaining({ claimed: false }));
    expect(handled).toHaveBeenCalledOnce();
    expect([...shared.states.values()]).toEqual(["done"]);
  });

  it("logs codes only: no message text, username, chat id or token", async () => {
    const capture = await captureRunObservation();
    const { deliver, fake, link, registry } = setup();
    const owner = fake.inject.addUser({ username: USERNAME });
    link(owner);
    registry.registerMessage(async () => { throw new Error(`${SECRET_TEXT} ${USERNAME} ${owner.id}`); });
    await deliver(fake.inject.text(owner, SECRET_TEXT));
    await deliver(fake.inject.callback(owner, 1, `c:${"Q".repeat(22)}`));
    const logged = JSON.stringify(capture.records());
    expect(logged).toContain("telegram_update_failed");
    for (const secret of [SECRET_TEXT, USERNAME, String(owner.id), fake.token.split(":")[1]!]) expect(logged).not.toContain(secret);
  });
});

describe("Telegram commands", () => {
  it("parses a leading command for this bot only", () => {
    expect(parseTelegramCommand("/start ABC", "aiqsa_test_bot")).toEqual({ args: "ABC", name: "start" });
    expect(parseTelegramCommand("/Help@AIQSA_test_bot", "aiqsa_test_bot")).toEqual({ args: "", name: "help" });
    expect(parseTelegramCommand("/help@other_bot", "aiqsa_test_bot")).toBeNull();
    expect(parseTelegramCommand("hello /help", "aiqsa_test_bot")).toBeNull();
    expect(parseTelegramCommand(undefined, "aiqsa_test_bot")).toBeNull();
  });
});

describe("test-mode update injection", () => {
  it("does not exist outside test mode and never reads the body there", async () => {
    const load = vi.fn();
    const POST = createTelegramTestUpdateHandler({ enabled: () => false, load });
    const request = new Request("http://app.local/api/test/telegram/updates", { body: "{", headers: { "content-type": "application/json" }, method: "POST" });
    const response = await POST(request);
    expect(response.status).toBe(404);
    expect(request.bodyUsed).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it("feeds a decoded update to the dispatcher once, as if polled", async () => {
    const { dispatcher, fake, link, registry, session } = setup();
    const owner = fake.inject.addUser();
    link(owner);
    const handled = vi.fn(async () => true);
    registry.registerMessage(handled);
    let current: TelegramBotSession | null = null;
    const POST = createTelegramTestUpdateHandler({ enabled: () => true, load: async () => ({ dispatcher, sessions: { current: async () => current } }) });
    const post = (body: unknown, type = "application/json") => POST(new Request("http://app.local/api/test/telegram/updates", {
      body: JSON.stringify(body), headers: { "content-type": type }, method: "POST"
    }));
    const raw = fake.inject.text(owner, "injected");
    expect((await post(raw, "text/plain")).status).toBe(415);
    expect((await post({ message: {} })).status).toBe(400);
    expect((await post(raw)).status).toBe(409);
    current = session;
    const accepted = await post(raw);
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toEqual({ claimed: true, settled: true });
    await expect((await post(raw)).json()).resolves.toEqual({ claimed: false, settled: true });
    expect(handled).toHaveBeenCalledOnce();
  });
});

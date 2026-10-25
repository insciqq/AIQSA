import { afterEach, expect, it } from "vitest";
import { createBridgeHarness } from "@/tests/support/telegramChatBridge";
import { createTelegramBotApi, createTelegramPacer, type TelegramMessage } from "../botApi";
import { TELEGRAM_BRIDGE_COPY } from "../copy";
import type { TelegramCallbackContext, TelegramMessageContext } from "../dispatcher";
import { createTelegramOutbound } from "../outbound";
import type { TelegramCallbackRecord } from "../store/callbacks";
import { createTelegramBridgeMenus } from "./menus";

/**
 * A menu names the owner's chats, assistants and models, so it never reaches
 * a chat whose link ended while the Bot API client waited (per-chat pacing or
 * a 429 retry): the link's authority is asked again right before the dispatch
 * of every menu send, edit and fallback.
 */

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

function setup(wait: "pacing" | "429") {
  const h = createBridgeHarness();
  closers.push(h.close);
  const user = h.fake.inject.addUser();
  const link = h.link(user);
  let unlinkOnWait = false;
  const api = createTelegramBotApi({
    token: h.fake.token, transport: h.fake.transport,
    pacer: createTelegramPacer({ now: () => 0 }),
    // The link ends while the client waits.
    sleep: async () => { if (unlinkOnWait) h.links.records.delete(link.userId); }
  });
  const outbound = createTelegramOutbound({
    api, botId: h.fake.bot.id,
    callbacks: { create: async ({ buttons }) => buttons.map((_, index) => `c:${index}`) },
    messageRefs: { record: async () => undefined }
  });
  const bot = { ...h.session, api, outbound };
  const menus = createTelegramBridgeMenus({
    access: h.access, conversation: h.bridge.conversation, gateway: h.aiqsa.gateway, links: h.links.store,
    messageRefs: h.messageRefs.store, sessions: { current: async () => bot }
  });
  h.aiqsa.addChat({ id: "chat-private", title: "PRIVATE_TITLE_AFTER_UNLINK", userId: link.userId });
  const message = {
    chat: { id: user.id, type: "private" }, date: 0, from: { first_name: "Alex", id: user.id, is_bot: false },
    has_other_content: false, message_id: 1, text: "/chats"
  } as TelegramMessage;
  const messageContext: TelegramMessageContext = { bot, command: { args: "", name: "chats" }, link, message, updateId: 1 };
  const callbackContext = (callback: Pick<TelegramCallbackRecord, "kind" | "payload">): TelegramCallbackContext => ({
    bot, callback: callback as TelegramCallbackRecord, chatId: user.id, link, messageId: 5, query: {} as TelegramCallbackContext["query"], updateId: 2
  });
  /** Arms the wait: the link ends during the next one. */
  async function armWait(method: string) {
    unlinkOnWait = false;
    // A send just before keeps the next one waiting for the chat's slot.
    if (wait === "pacing") await api.sendMessage({ chat_id: user.id, text: "earlier" });
    else h.fake.failNext(method, { retryAfter: 60, status: 429 });
    unlinkOnWait = true;
  }
  const sent = () => JSON.stringify(h.fake.botMessages(user.id));
  return { armWait, callbackContext, h, menus, messageContext, sent, user };
}

it.each(["pacing", "429"] as const)("a /chats menu is not sent after the link ends during the client's %s wait", async (wait) => {
  const { armWait, menus, messageContext, sent } = setup(wait);
  await menus.chats(messageContext);
  expect(sent()).toContain("PRIVATE_TITLE_AFTER_UNLINK");

  const before = sent();
  await armWait("sendMessage");
  await menus.chats(messageContext);
  expect(sent().split("PRIVATE_TITLE_AFTER_UNLINK")).toHaveLength(before.split("PRIVATE_TITLE_AFTER_UNLINK").length);
});

it.each(["pacing", "429"] as const)("an edited menu and its fallback are not sent after the link ends during the client's %s wait", async (wait) => {
  const { armWait, callbackContext, h, menus, user } = setup(wait);
  const sends = () => h.fake.calls("sendMessage").length;
  await armWait("editMessageText");
  const sentBefore = sends();
  await menus.callbacks.model_page!(callbackContext({ kind: "model_page", payload: { page: 0 } }));
  expect(h.links.records.size).toBe(0);
  // Only the 429-refused first attempt reached Telegram; its retry was never dispatched.
  expect(h.fake.calls("editMessageText").map((call) => call.status)).toEqual(wait === "429" ? [429] : []);
  expect(h.fake.botMessages(user.id).map((message) => message.text)).not.toContain(TELEGRAM_BRIDGE_COPY.modelsTitle);
  expect(sends()).toBe(sentBefore);
});

import { expect, it } from "vitest";
import { createBridgeHarness } from "@/tests/support/telegramChatBridge";
import { createTelegramApprovals } from "./approvals";
import { createTelegramBotApi, createTelegramPacer } from "./botApi";
import { createTelegramOutbound } from "./outbound";

/**
 * An approval's request details never reach a chat whose link ended while
 * the Bot API client waited (per-chat pacing or a 429 retry): the authority
 * is asked again right before the dispatch.
 */
it.each(["pacing", "429"])("an approval request is not sent after the link ends during the client's %s wait", async (wait) => {
  const h = createBridgeHarness();
  try {
    const user = h.fake.inject.addUser();
    const link = h.link(user);
    const api = createTelegramBotApi({
      token: h.fake.token, transport: h.fake.transport,
      pacer: createTelegramPacer({ now: () => 0 }),
      // The link ends while the client waits.
      sleep: async () => { h.links.records.delete(link.userId); }
    });
    const outbound = createTelegramOutbound({
      api, botId: h.fake.bot.id, appBaseUrl: "https://aiqsa.example",
      callbacks: { create: async ({ buttons }) => buttons.map((_, index) => `c:${index}`) },
      messageRefs: { record: async () => undefined }
    });
    const bot = { ...h.session, api, outbound };
    const approvals = createTelegramApprovals({
      access: h.access, sessions: { current: async () => bot },
      conversation: h.bridge.conversation,
      gateway: {
        details: async () => "PRIVATE_REQUEST_AFTER_UNLINK",
        card: async () => null,
        decide: async () => ({ kind: "not_found" })
      }
    });
    if (wait === "pacing") await api.sendMessage({ chat_id: user.id, text: "earlier" });
    else h.fake.failNext("sendRichMessage", { retryAfter: 60, status: 429 });
    approvals.listener({
      type: "approvalRequested",
      card: { approvalId: "approval-1", canDecide: true, state: "pending", source: "model",
        serverName: "Jira", toolName: "create_issue", details: { ordinal: 0, roundIndex: 1 } }
    }, { bot, chatId: "chat-1", linkId: link.id, runId: "run-1", source: "live", telegramChatId: user.id, userId: link.userId });
    await approvals.idle();
    expect(h.links.records.size).toBe(0);
    expect(JSON.stringify(h.fake.botMessages(user.id))).not.toContain("PRIVATE_REQUEST_AFTER_UNLINK");
  } finally {
    await h.close();
  }
});

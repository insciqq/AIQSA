import { afterEach, describe, expect, it, vi } from "vitest";
import { captureRunObservation } from "@/tests/support/runObservation";
import type { FakeTelegramUser } from "@/tests/support/fakeTelegramBotApi";
import {
  TELEGRAM_BRIDGE_COPY, TELEGRAM_COPY, TELEGRAM_RUN_REFUSAL_COPY, telegramAssistantSelectedText, telegramCurrentChatText,
  telegramModelLabel, telegramReasonText
} from "../copy";
import { renderTelegramAnswer } from "../render";
import {
  buttonData, createBridgeHarness, createFakeGateway, fakeCatalog, fakeCatalogModel, SEARCH_OPTION, type BridgeHarness, type FakeGateway
} from "@/tests/support/telegramChatBridge";
import type { TelegramRunEvent, TelegramRunEventContext } from "./events";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  while (closers.length) await closers.pop()!();
});

function harness(options: Parameters<typeof createBridgeHarness>[0] = {}) {
  const h = createBridgeHarness(options);
  closers.push(h.close);
  const user = h.fake.inject.addUser({ firstName: "Alex" });
  const linkRecord = h.link(user);
  return { ...h, linkRecord, user };
}

function texts(h: BridgeHarness, user: FakeTelegramUser): string[] {
  return h.fake.botMessages(user.id).flatMap((message) => message.text === undefined ? [] : [message.text]);
}

function messageId(raw: Record<string, unknown>): number {
  return (raw.message as { message_id: number }).message_id;
}

/** Hands a message to the bot and lets its merge window close. */
async function say(h: BridgeHarness, raw: Record<string, unknown>): Promise<void> {
  await h.deliver(raw);
  h.bridge.conversation.flush();
}

async function runStarted(gateway: FakeGateway, count: number) {
  await vi.waitFor(() => expect(gateway.runs).toHaveLength(count));
  return gateway.runs[count - 1]!;
}

function draftCalls(h: BridgeHarness) {
  return [...h.fake.calls("sendMessageDraft"), ...h.fake.calls("sendRichMessageDraft")];
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Telegram chat bridge: a message becomes an ordinary chat", () => {
  it("starts a new personal chat with explicit catalog values, streams a draft and delivers the rendered answer once", async () => {
    const h = harness();
    const raw = h.fake.inject.text(h.user, "Compare X and Y as a table");
    await say(h, raw);
    await h.settle();

    const [send] = h.aiqsa.sent;
    expect(send!.userId).toBe("user-1");
    expect(send!.body).toEqual({
      admissionId: `tg-${h.fake.bot.id}-${raw.update_id}`,
      content: { blocks: [{ text: "Compare X and Y as a table", type: "text" }] },
      controlDefaults: {},
      expectedActiveLeafId: null,
      mcp: { mode: "auto" },
      modelId: "model-fake",
      params: { maxOutputTokens: 1_024, reasoning: { effort: "none" }, temperature: 0.7 },
      personalDraft: { folderId: null, memoryMode: "NORMAL" },
      provider: "connection-fake",
      searchPlan: { mode: "all_selected", optionIds: [SEARCH_OPTION.strategyId] },
      skills: { mode: "auto" },
      workspace: { enabled: false }
    });
    const chatId = send!.chatId;
    expect(h.links.records.get("user-1")!.currentChatId).toBe(chatId);

    const [thinking] = h.fake.calls("sendMessageDraft");
    expect(thinking!.params).toEqual({ can_stop: true, chat_id: h.user.id, draft_id: expect.any(Number), keep_on_stop: false, text: "" });
    const [answer] = h.fake.botMessages(h.user.id);
    expect(answer).toMatchObject({ kind: "rich", rich_message: renderTelegramAnswer("Answer: Compare X and Y as a table").messages[0] });
    expect(answer!.reply_markup).toEqual({ inline_keyboard: [[{ text: TELEGRAM_COPY.openInAiqsa, url: `https://aiqsa.example/c/${chatId}` }]] });
    expect(h.fake.calls("sendRichMessage")).toHaveLength(1);

    const run = h.aiqsa.runs[0]!;
    expect(h.runLinks.rows.get(run.id)).toMatchObject({
      deliveryState: "delivered", draftId: thinking!.params.draft_id, linkId: h.linkRecord.id, telegramChatId: h.user.id, userId: "user-1"
    });
    expect(h.messageRefs.refs).toContainEqual(expect.objectContaining({
      chatId, linkId: h.linkRecord.id, messageId: run.assistantMessageId, telegramMessageId: answer!.message_id
    }));
  });

  it("continues the current chat, starts another after /new, and follows a reply to an older answer into its chat", async () => {
    const h = harness();
    await say(h, h.fake.inject.text(h.user, "first question"));
    await h.settle();
    const chatA = h.aiqsa.sent[0]!.chatId;
    const answerA = h.fake.botMessages(h.user.id).at(-1)!;

    await say(h, h.fake.inject.text(h.user, "second question"));
    await h.settle();
    expect(h.aiqsa.sent[1]).toMatchObject({ body: { expectedActiveLeafId: h.aiqsa.runs[0]!.assistantMessageId }, chatId: chatA });
    expect(h.aiqsa.sent[1]!.body).not.toHaveProperty("personalDraft");

    await h.deliver(h.fake.inject.command(h.user, "new"));
    await h.settle();
    expect(texts(h, h.user).at(-1)).toBe(TELEGRAM_COPY.newChat);
    expect(h.links.records.get("user-1")!.currentChatId).toBeNull();
    await say(h, h.fake.inject.text(h.user, "third question"));
    await h.settle();
    const chatB = h.aiqsa.sent[2]!.chatId;
    expect(chatB).not.toBe(chatA);
    expect(h.aiqsa.sent[2]!.body).toHaveProperty("personalDraft");

    await say(h, h.fake.inject.text(h.user, "back to the first one", { replyTo: answerA.message_id }));
    await h.settle();
    expect(h.aiqsa.sent[3]).toMatchObject({ body: { expectedActiveLeafId: h.aiqsa.runs[1]!.assistantMessageId }, chatId: chatA });
    expect(h.links.records.get("user-1")!.currentChatId).toBe(chatA);
  });

  it("carries the time zone the user's browser last reported, and sends none when it is unknown or unreadable", async () => {
    const h = harness();
    h.aiqsa.setTimeZone("Europe/Moscow");
    await say(h, h.fake.inject.text(h.user, "Remind me every day at 9"));
    await h.settle();
    expect(h.aiqsa.sent[0]!.body.timeZone).toBe("Europe/Moscow");

    h.aiqsa.setTimeZone(null);
    await say(h, h.fake.inject.text(h.user, "And what time is it?"));
    await h.settle();
    expect(h.aiqsa.sent[1]!.body).not.toHaveProperty("timeZone");

    // A failed read is only a missing hint: the message still runs, on the UTC fallback.
    const read = vi.spyOn(h.aiqsa.gateway, "timeZone").mockRejectedValueOnce(new Error("database unavailable"));
    await say(h, h.fake.inject.text(h.user, "Still there?"));
    await h.settle();
    expect(read).toHaveBeenCalledWith("user-1");
    expect(h.aiqsa.sent).toHaveLength(3);
    expect(h.aiqsa.sent[2]!.body).not.toHaveProperty("timeZone");
  });

  it("merges messages sent within 1.5 s of each other into one request", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-19T08:00:00.000Z") });
    const h = harness();
    await h.deliver(h.fake.inject.text(h.user, "part one of a long paste"));
    await vi.advanceTimersByTimeAsync(1_000);
    await h.deliver(h.fake.inject.text(h.user, "part two"));
    await vi.advanceTimersByTimeAsync(1_499);
    expect(h.aiqsa.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await h.settle();
    expect(h.aiqsa.sent).toHaveLength(1);
    expect(h.aiqsa.sent[0]!.body.content).toEqual({ blocks: [{ text: "part one of a long paste\npart two", type: "text" }] });

    await vi.advanceTimersByTimeAsync(2_000);
    await h.deliver(h.fake.inject.text(h.user, "a separate question"));
    await vi.advanceTimersByTimeAsync(1_500);
    await h.settle();
    expect(h.aiqsa.sent).toHaveLength(2);
    expect(h.aiqsa.sent[1]!.body.content).toEqual({ blocks: [{ text: "a separate question", type: "text" }] });
  });

  it("leaves media and other content to their handlers and answers unsupported content", async () => {
    const h = harness();
    await say(h, h.fake.inject.sticker(h.user));
    await say(h, h.fake.inject.photo(h.user, { caption: "what is on this diagram?" }));
    await h.settle();
    expect(h.aiqsa.sent).toHaveLength(0);
    expect(texts(h, h.user)).toEqual([
      telegramReasonText("telegram_unsupported_message"), telegramReasonText("telegram_unsupported_message")
    ]);
  });
});

describe("Telegram chat bridge: a run in progress", () => {
  it("records the run's Telegram origin as soon as it starts and publishes its events, then delivers", async () => {
    const events: Array<Readonly<{ event: TelegramRunEvent; context: TelegramRunEventContext }>> = [];
    const gateway = createFakeGateway({ autoAnswer: null });
    const h = harness({ bridge: { publish: async (event, context) => { events.push({ context, event }); } }, gateway });
    await say(h, h.fake.inject.text(h.user, "use the tools"));
    const run = await runStarted(gateway, 1);
    await vi.waitFor(() => expect(h.runLinks.rows.get(run.id)).toMatchObject({ deliveryState: "pending", linkId: h.linkRecord.id }));
    run.emit({ data: { artifactType: "mcp_approval", payload: { approvalId: "approval-1" } }, type: "artifact" });
    run.emit({ data: { artifactType: "workspace_activity", payload: { summary: "Running tests" } }, type: "artifact" });
    run.emit({ data: { artifactType: "search", payload: {} }, type: "artifact" });
    run.token("Done.");
    run.complete();
    await h.settle();
    expect(events.map(({ event }) => event)).toEqual([
      { card: { approvalId: "approval-1" }, type: "approvalRequested" },
      { entry: { summary: "Running tests" }, type: "workspaceActivity" },
      { delta: "Done.", type: "answerDelta" },
      { status: "complete", type: "done" },
      { messageIds: [h.fake.botMessages(h.user.id)[0]!.message_id], sent: true, status: "complete", type: "delivered" }
    ]);
    expect(events[0]!.context).toMatchObject({
      chatId: run.chatId, linkId: h.linkRecord.id, runId: run.id, source: "live", telegramChatId: h.user.id, userId: "user-1"
    });
  });

  it("adds text sent during a run as a follow-up, and runs what the run no longer takes after it settles", async () => {
    const gateway = createFakeGateway({ autoAnswer: null });
    const h = harness({ gateway });
    await say(h, h.fake.inject.text(h.user, "a long task"));
    const run = await runStarted(gateway, 1);
    run.token("Working");

    const follow = h.fake.inject.text(h.user, "also check Z");
    await say(h, follow);
    await vi.waitFor(() => expect(gateway.followups).toEqual([{ nonce: `tg-${follow.update_id}`, runId: run.id, text: "also check Z" }]));
    await vi.waitFor(() => expect(texts(h, h.user)).toContain(TELEGRAM_COPY.followupAdded));
    const ack = h.fake.botMessages(h.user.id).find((message) => message.text === TELEGRAM_COPY.followupAdded)!;
    expect(ack.reply_to_message_id).toBe(messageId(follow));
    expect(gateway.sent).toHaveLength(1);

    gateway.setFollowupResponse(() => Response.json({ error: "followup_closed" }, { status: 409 }));
    await say(h, h.fake.inject.text(h.user, "and then this"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gateway.sent).toHaveLength(1);
    gateway.setAutoAnswer(() => "Second answer");
    run.token(" finished");
    run.complete();
    await h.settle();
    expect(gateway.sent).toHaveLength(2);
    expect(gateway.sent[1]).toMatchObject({
      body: { content: { blocks: [{ text: "and then this", type: "text" }] }, expectedActiveLeafId: run.assistantMessageId },
      chatId: run.chatId
    });
    expect(h.fake.botMessages(h.user.id).filter((message) => message.kind === "rich")).toHaveLength(2);
  });

  it("runs a message sent after the answer was delivered as a new request while the answer's files still wait", async () => {
    const gateway = createFakeGateway({ autoAnswer: null });
    let releaseFiles: () => void = () => undefined;
    const filesWait = new Promise<void>((resolve) => { releaseFiles = resolve; });
    // A Workspace answer's files wait for their export after the final message went out.
    const h = harness({ bridge: { publish: async (event) => { if (event.type === "delivered") await filesWait; } }, gateway });
    await say(h, h.fake.inject.text(h.user, "run a hello world"));
    const run = await runStarted(gateway, 1);
    run.token("Hello from Workspace.");
    run.complete();
    await vi.waitFor(() => expect(h.fake.botMessages(h.user.id).filter((message) => message.kind === "rich")).toHaveLength(1));

    gateway.setAutoAnswer(() => "Node.js version");
    await say(h, h.fake.inject.text(h.user, "and try it in nodejs"));
    await vi.waitFor(() => expect(gateway.sent).toHaveLength(2));
    expect(gateway.followups).toEqual([]);
    expect(texts(h, h.user)).not.toContain(TELEGRAM_COPY.followupAdded);
    expect(gateway.sent[1]).toMatchObject({ body: { content: { blocks: [{ text: "and try it in nodejs", type: "text" }] } }, chatId: run.chatId });
    releaseFiles();
    await h.settle();
  });

  it("runs a server-prepared continuation after the active run, in its chat, observed and delivered like a message", async () => {
    const gateway = createFakeGateway({ autoAnswer: null });
    const h = harness({ gateway });
    await say(h, h.fake.inject.text(h.user, "create the issue"));
    const run = await runStarted(gateway, 1);
    h.bridge.conversation.submit(h.links.records.get("user-1")!, h.session, {
      chatId: run.chatId, contentBlocks: [], systemTurn: { approvalId: "approval-1", kind: "mcp_approval_continuation" }, updateId: 9_001
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gateway.sent).toHaveLength(1);
    gateway.setAutoAnswer(() => "Issue created.");
    run.token("Waiting for your approval.");
    run.complete();
    await h.settle();
    expect(gateway.sent[1]).toMatchObject({
      body: {
        admissionId: `tg-${h.fake.bot.id}-9001`, expectedActiveLeafId: run.assistantMessageId,
        systemTurn: { approvalId: "approval-1", kind: "mcp_approval_continuation" }
      },
      chatId: run.chatId
    });
    expect(h.fake.botMessages(h.user.id).at(-1)).toMatchObject({ rich_message: renderTelegramAnswer("Issue created.").messages[0] });
  });

  it("lets a request for another chat wait behind a run at most the wait bound, never holding the chat's lane", async () => {
    const gateway = createFakeGateway({ autoAnswer: null });
    const h = harness({ bridge: { runWaitMs: 300 }, gateway });
    await say(h, h.fake.inject.text(h.user, "a run that does not end"));
    const stuck = await runStarted(gateway, 1);
    await h.deliver(h.fake.inject.command(h.user, "new"));
    await vi.waitFor(() => expect(texts(h, h.user)).toContain(TELEGRAM_COPY.newChat));
    gateway.setAutoAnswer(() => "Answer in the new chat");
    await say(h, h.fake.inject.text(h.user, "a new topic"));
    // Commands of the same chat answer at once while the request waits.
    await h.deliver(h.fake.inject.command(h.user, "chats"));
    expect(texts(h, h.user).at(-1)).toBe(TELEGRAM_BRIDGE_COPY.chatsTitle);
    expect(gateway.sent).toHaveLength(1);
    await vi.waitFor(() => expect(gateway.sent).toHaveLength(2));
    expect(gateway.sent[1]!.chatId).not.toBe(stuck.chatId);
    expect(stuck.status).toBe("streaming");
    await h.settle();
    stuck.complete();
    await vi.waitFor(() => expect(h.runLinks.rows.get(stuck.id)?.deliveryState).toBe("delivered"));
  });

  it("stops the run from the draft's own Stop and from /stop, sending what it wrote and Stopped", async () => {
    const gateway = createFakeGateway({ autoAnswer: null });
    const h = harness({ gateway });
    await say(h, h.fake.inject.text(h.user, "write a long story"));
    const first = await runStarted(gateway, 1);
    first.token("Once upon a time");
    await vi.waitFor(() => expect(h.fake.calls("sendMessageDraft").length).toBeGreaterThan(0));
    const draftId = h.fake.calls("sendMessageDraft")[0]!.params.draft_id as number;
    await h.deliver(h.fake.inject.stopGeneration(h.user, draftId));
    await h.settle();
    expect(first.status).toBe("cancelled");
    const [partial, stopped] = h.fake.botMessages(h.user.id);
    expect(partial).toMatchObject({ kind: "rich", rich_message: renderTelegramAnswer("Once upon a time").messages[0] });
    expect(partial!.reply_markup).toBeUndefined();
    expect(stopped).toMatchObject({
      reply_markup: { inline_keyboard: [[{ text: TELEGRAM_COPY.openInAiqsa, url: `https://aiqsa.example/c/${first.chatId}` }]] },
      text: TELEGRAM_COPY.stopped
    });

    await say(h, h.fake.inject.text(h.user, "another one"));
    const second = await runStarted(gateway, 2);
    await h.deliver(h.fake.inject.command(h.user, "stop"));
    await h.settle();
    expect(second.status).toBe("cancelled");
    expect(texts(h, h.user).at(-1)).toBe(TELEGRAM_COPY.stopped);

    await h.deliver(h.fake.inject.command(h.user, "stop"));
    expect(texts(h, h.user).at(-1)).toBe(TELEGRAM_BRIDGE_COPY.nothingRunning);
  });

  it("follows a deferred admission and a stream lost before its end through the run's state", async () => {
    const gateway = createFakeGateway({ autoAnswer: null });
    const h = harness({ gateway });
    gateway.deferNext();
    await say(h, h.fake.inject.text(h.user, "read this PDF"));
    const deferred = await runStarted(gateway, 1);
    await vi.waitFor(() => expect(h.runLinks.rows.get(deferred.id)?.deliveryState).toBe("pending"));
    deferred.text = "The PDF says hello.";
    deferred.status = "complete";
    await h.settle();
    expect(h.fake.botMessages(h.user.id).at(-1)).toMatchObject({ rich_message: renderTelegramAnswer("The PDF says hello.").messages[0] });

    await say(h, h.fake.inject.text(h.user, "next"));
    const lost = await runStarted(gateway, 2);
    lost.token("Partial ");
    lost.drop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    lost.token("and the rest");
    lost.status = "complete";
    await h.settle();
    expect(h.fake.botMessages(h.user.id).at(-1)).toMatchObject({ rich_message: renderTelegramAnswer("Partial and the rest").messages[0] });
    expect(h.fake.calls("sendRichMessage")).toHaveLength(2);
    expect(h.runLinks.rows.get(lost.id)?.deliveryState).toBe("delivered");
  });

  it.each([
    ["the user unlinks (the link and its run links go)", (h: ReturnType<typeof harness>, runId: string) => {
      h.links.records.delete("user-1");
      h.runLinks.rows.delete(runId);
    }],
    ["Telegram access ends for the user", (h: ReturnType<typeof harness>) => {
      h.setUser({ activeGroupIds: [], scimDeactivatedAt: null, status: "disabled" });
    }],
    ["the bot is switched off", (h: ReturnType<typeof harness>) => { h.setSessionOn(false); }]
  ])("stops streaming the answer into Telegram once %s, while the run goes on in AIQSA", async (_case, revoke) => {
    const gateway = createFakeGateway({ autoAnswer: null });
    const h = harness({ bridge: { draftThrottleMs: 5 }, gateway });
    await say(h, h.fake.inject.text(h.user, "write a long answer"));
    const run = await runStarted(gateway, 1);
    run.token("PUBLIC_BEFORE_UNLINK");
    await vi.waitFor(() => expect(JSON.stringify(h.fake.calls("sendRichMessageDraft"))).toContain("PUBLIC_BEFORE_UNLINK"));
    const before = draftCalls(h).length;

    revoke(h, run.id);
    run.token(" PRIVATE_AFTER_UNLINK");
    await pause(50);
    run.token(" and more");
    await pause(50);
    // No draft after the change, the text it would have carried included; the run itself keeps going.
    expect(draftCalls(h)).toHaveLength(before);
    expect(run.status).toBe("streaming");
    run.complete();
    await h.settle();
    expect(draftCalls(h)).toHaveLength(before);
    expect(JSON.stringify(h.fake.calls())).not.toContain("PRIVATE_AFTER_UNLINK");
  });
});

describe("Telegram chat bridge: refusals", () => {
  it("shows a usage limit with its retry time, keeping the message's chat", async () => {
    const h = harness();
    h.aiqsa.respondNext(() => Response.json({
      error: "message_rate_limited", usageLimit: { limit: 20, resetsAt: "2026-10-19T09:00:00.000Z", scope: "user", used: 20, window: "hour" }
    }, { headers: { "retry-after": "720" }, status: 429 }));
    const raw = h.fake.inject.text(h.user, "one more");
    await say(h, raw);
    await h.settle();
    const [refusal] = h.fake.botMessages(h.user.id);
    expect(refusal).toMatchObject({
      reply_to_message_id: messageId(raw), text: "You've reached your limit of 20 messages per hour. You can send again in 12 min."
    });
    expect(h.aiqsa.runs).toHaveLength(0);
  });

  it("names a reply already running from the web, retries once when the web moved the chat on, and asks for a model that left", async () => {
    const h = harness();
    const web = h.aiqsa.addChat({ activeLeafMessageId: "web-answer-1", id: "chat-web", title: "Trip plan", userId: "user-1" });
    await h.links.store.updatePreferences(h.linkRecord.id, { currentChatId: web.id });
    h.aiqsa.respondNext(() => Response.json({ error: "active_run_in_progress", run: { id: "run-web", status: "streaming" } }, { status: 409 }));
    await say(h, h.fake.inject.text(h.user, "and also"));
    await h.settle();
    expect(h.fake.botMessages(h.user.id).at(-1)).toMatchObject({
      reply_markup: { inline_keyboard: [[{ text: TELEGRAM_COPY.openInAiqsa, url: "https://aiqsa.example/c/chat-web" }]] },
      text: TELEGRAM_RUN_REFUSAL_COPY.replyRunning
    });

    h.aiqsa.respondNext(() => {
      web.activeLeafMessageId = "web-answer-2";
      return Response.json({ error: "active_leaf_changed" }, { status: 409 });
    });
    await say(h, h.fake.inject.text(h.user, "continue"));
    await h.settle();
    expect(h.aiqsa.sent.slice(-2).map((send) => send.body.expectedActiveLeafId)).toEqual(["web-answer-1", "web-answer-2"]);
    expect(h.fake.botMessages(h.user.id).at(-1)).toMatchObject({ kind: "rich" });

    await h.links.store.updatePreferences(h.linkRecord.id, { selectedModel: { modelId: "model-gone", provider: "connection-fake" } });
    const sends = h.aiqsa.sent.length;
    await say(h, h.fake.inject.text(h.user, "with my model"));
    await h.settle();
    expect(h.aiqsa.sent).toHaveLength(sends);
    const refusal = h.fake.botMessages(h.user.id).at(-1)!;
    expect(refusal.text).toBe(TELEGRAM_RUN_REFUSAL_COPY.modelUnavailable);
    expect(buttonData(refusal, TELEGRAM_BRIDGE_COPY.chooseModel)).toMatch(/^c:/u);
  });

  it("refuses the next message without touching the link when access is revoked between messages", async () => {
    const h = harness();
    await say(h, h.fake.inject.text(h.user, "first"));
    await h.settle();
    h.setUser({ activeGroupIds: [], scimDeactivatedAt: null, status: "disabled" });
    await say(h, h.fake.inject.text(h.user, "second"));
    await h.settle();
    expect(h.aiqsa.sent).toHaveLength(1);
    expect(texts(h, h.user).at(-1)).toBe(telegramReasonText("telegram_access_off"));
    expect(h.links.records.get("user-1")).toMatchObject({ currentChatId: h.aiqsa.sent[0]!.chatId, id: h.linkRecord.id });

    // Revoked while the message waited: the send handler's resolver refuses it the same way.
    h.setUser({ activeGroupIds: [], scimDeactivatedAt: null, status: "active" });
    h.aiqsa.respondNext(() => Response.json({ error: "unauthorized" }, { status: 401 }));
    await say(h, h.fake.inject.text(h.user, "third"));
    await h.settle();
    expect(texts(h, h.user).at(-1)).toBe(telegramReasonText("telegram_access_off"));
  });

  it("does not run messages Telegram kept while the bot was off, answering once, while commands still work", async () => {
    const capture = await captureRunObservation();
    const h = harness();
    const old = Math.floor(Date.now() / 1_000) - 20 * 60;
    const stale = (id: number, text: string) => h.fake.inject.raw({ message: {
      chat: { first_name: "Alex", id: h.user.id, type: "private" }, date: old, from: { first_name: "Alex", id: h.user.id, is_bot: false },
      message_id: id, text
    } });
    await say(h, stale(900, "an old question"));
    await say(h, stale(901, "another old one"));
    await h.deliver(h.fake.inject.command(h.user, "help"));
    await say(h, h.fake.inject.text(h.user, "a fresh question"));
    await h.settle();
    expect(h.aiqsa.sent.map((send) => send.body.content)).toEqual([{ blocks: [{ text: "a fresh question", type: "text" }] }]);
    expect(texts(h, h.user)).toEqual([TELEGRAM_BRIDGE_COPY.staleMessage, TELEGRAM_COPY.help]);
    expect(capture.records().filter((record) => record.code === "telegram_stale_message")).toHaveLength(2);
    expect(JSON.stringify(capture.records())).not.toContain("old question");
  });
});

describe("Telegram chat bridge: commands", () => {
  it("lists recent chats and continues the chosen web chat", async () => {
    const h = harness();
    for (let index = 0; index < 12; index += 1) h.aiqsa.addChat({ id: `chat-${index}`, title: `Chat ${index}`, userId: "user-1" });
    const web = h.aiqsa.addChat({ activeLeafMessageId: "web-answer", id: "chat-web", title: "Trip plan", userId: "user-1" });
    await h.deliver(h.fake.inject.command(h.user, "chats"));
    const menu = h.fake.botMessages(h.user.id).at(-1)!;
    expect(menu.text).toBe(TELEGRAM_BRIDGE_COPY.chatsTitle);
    const rows = (menu.reply_markup as { inline_keyboard: Array<Array<{ text: string }>> }).inline_keyboard;
    expect(rows).toHaveLength(10);
    expect(rows[0]![0]!.text).toBe("Trip plan");

    await h.deliver(h.fake.inject.callback(h.user, menu.message_id, buttonData(menu, "Trip plan")));
    await h.settle();
    expect(h.fake.botMessages(h.user.id).find((message) => message.message_id === menu.message_id)).toMatchObject({
      reply_markup: undefined, text: telegramCurrentChatText("Trip plan")
    });
    expect(h.links.records.get("user-1")!.currentChatId).toBe(web.id);
    await say(h, h.fake.inject.text(h.user, "what about hotels?"));
    await h.settle();
    expect(h.aiqsa.sent.at(-1)).toMatchObject({ body: { expectedActiveLeafId: "web-answer" }, chatId: web.id });

    // A reply to "Current chat: …" continues that chat too.
    await h.deliver(h.fake.inject.command(h.user, "new"));
    await say(h, h.fake.inject.text(h.user, "and flights?", { replyTo: menu.message_id }));
    await h.settle();
    expect(h.aiqsa.sent.at(-1)!.chatId).toBe(web.id);
  });

  it("starts the next chat with the chosen assistant, sending none of the rows it governs", async () => {
    const h = harness({ gateway: createFakeGateway({ assistants: [{ id: "assistant-1", name: "Travel helper" }] }) });
    await h.deliver(h.fake.inject.command(h.user, "assistant"));
    const menu = h.fake.botMessages(h.user.id).at(-1)!;
    expect(menu.text).toBe(TELEGRAM_BRIDGE_COPY.assistantsTitle);
    await h.deliver(h.fake.inject.callback(h.user, menu.message_id, buttonData(menu, "Travel helper")));
    await h.settle();
    expect(h.fake.botMessages(h.user.id).find((message) => message.message_id === menu.message_id)?.text)
      .toBe(telegramAssistantSelectedText("Travel helper"));
    expect(h.links.records.get("user-1")).toMatchObject({ currentChatId: null, pendingAssistantId: "assistant-1" });

    await say(h, h.fake.inject.text(h.user, "plan a trip"));
    await h.settle();
    const body = h.aiqsa.sent.at(-1)!.body;
    expect(body).toMatchObject({ assistantId: "assistant-1", personalDraft: { folderId: null, memoryMode: "NORMAL" } });
    for (const key of ["modelId", "provider", "searchPlan", "mcp", "skills", "params", "agentEnabled"]) expect(body).not.toHaveProperty(key);
    expect(h.links.records.get("user-1")).toMatchObject({ currentChatId: h.aiqsa.sent.at(-1)!.chatId, pendingAssistantId: null });
  });

  it("pages the catalog models by eight and stores the chosen model for the next run", async () => {
    const models = Array.from({ length: 10 }, (_, index) => fakeCatalogModel({
      displayName: `Model ${index + 1}`, modelId: `model-${index + 1}`, provider: "connection-fake"
    }));
    const h = harness({ gateway: createFakeGateway({ catalog: fakeCatalog({ models }) }) });
    await h.deliver(h.fake.inject.command(h.user, "model"));
    let menu = h.fake.botMessages(h.user.id).at(-1)!;
    const labels = () => (h.fake.botMessages(h.user.id).find((message) => message.message_id === menu.message_id)!.reply_markup as {
      inline_keyboard: Array<Array<{ text: string }>>;
    }).inline_keyboard.map((row) => row.map((button) => button.text));
    expect(labels()).toEqual([["✓ Model 1"], ...models.slice(1, 8).map((model) => [model.displayName]), [TELEGRAM_BRIDGE_COPY.nextPage]]);
    await h.deliver(h.fake.inject.callback(h.user, menu.message_id, buttonData(menu, TELEGRAM_BRIDGE_COPY.nextPage)));
    menu = h.fake.botMessages(h.user.id).find((message) => message.message_id === menu.message_id)!;
    expect(labels()).toEqual([["Model 9"], ["Model 10"], [TELEGRAM_BRIDGE_COPY.previousPage]]);
    await h.deliver(h.fake.inject.callback(h.user, menu.message_id, buttonData(menu, "Model 10")));
    expect(h.fake.botMessages(h.user.id).find((message) => message.message_id === menu.message_id)?.text).toBe(telegramModelLabel("Model 10"));
    expect(h.links.records.get("user-1")).toMatchObject({ selectedModelId: "model-10", selectedProvider: "connection-fake" });

    await say(h, h.fake.inject.text(h.user, "hello"));
    await h.settle();
    expect(h.aiqsa.sent.at(-1)!.body).toMatchObject({ modelId: "model-10", provider: "connection-fake" });
  });

  it("toggles Search and Workspace in one settings menu that edits itself", async () => {
    const gateway = createFakeGateway({ catalog: fakeCatalog({ models: [fakeCatalogModel()] }) });
    const h = harness({ gateway });
    await h.deliver(h.fake.inject.command(h.user, "settings"));
    const menu = h.fake.botMessages(h.user.id).at(-1)!;
    const current = () => h.fake.botMessages(h.user.id).find((message) => message.message_id === menu.message_id)!;
    const labels = () => (current().reply_markup as { inline_keyboard: Array<Array<{ text: string }>> }).inline_keyboard.flat()
      .map((button) => button.text);
    expect(menu.text).toBe(TELEGRAM_BRIDGE_COPY.settingsTitle);
    expect(labels()).toEqual(["Search: on", "Workspace: off", "Model: Fake QSA"]);

    await h.deliver(h.fake.inject.callback(h.user, menu.message_id, buttonData(current(), "Search: on")));
    expect(labels()).toEqual(["Search: off", "Workspace: off", "Model: Fake QSA"]);
    expect(h.fake.botMessages(h.user.id)).toHaveLength(1);
    await say(h, h.fake.inject.text(h.user, "no search please"));
    await h.settle();
    expect(gateway.sent.at(-1)!.body.searchPlan).toEqual({ mode: "all_selected", optionIds: [] });

    await h.deliver(h.fake.inject.callback(h.user, menu.message_id, buttonData(current(), "Workspace: off")));
    expect(labels()).toEqual(["Search: off", "Workspace: on", "Model: Fake QSA"]);
    await say(h, h.fake.inject.text(h.user, "fix the build"));
    await h.settle();
    expect(gateway.sent.at(-1)!.body).toMatchObject({ workspace: { enabled: true } });
    expect(gateway.sent.at(-1)!.body).not.toHaveProperty("agentEnabled");
    await h.deliver(h.fake.inject.callback(h.user, menu.message_id, buttonData(current(), "Workspace: on")));
    expect(labels()).toEqual(["Search: off", "Workspace: off", "Model: Fake QSA"]);
    // The Model button opens the model list in the same message.
    await h.deliver(h.fake.inject.callback(h.user, menu.message_id, buttonData(current(), "Model: Fake QSA")));
    expect(current().text).toBe(TELEGRAM_BRIDGE_COPY.modelsTitle);
  });

  it("answers an unknown command and lists nothing it has no data for", async () => {
    const h = harness();
    await h.deliver(h.fake.inject.command(h.user, "frobnicate"));
    await h.deliver(h.fake.inject.command(h.user, "chats"));
    await h.deliver(h.fake.inject.command(h.user, "assistant"));
    expect(texts(h, h.user)).toEqual([TELEGRAM_BRIDGE_COPY.unknownCommand, TELEGRAM_BRIDGE_COPY.noChats, TELEGRAM_BRIDGE_COPY.noAssistants]);
  });
});

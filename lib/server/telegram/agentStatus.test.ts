import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeTelegramBotApi, type FakeTelegramCall } from "@/tests/support/fakeTelegramBotApi";
import {
  buttonData, createBridgeHarness, createFakeGateway, memoryMessageRefStore, memoryRunLinkStore
} from "@/tests/support/telegramChatBridge";
import type { ThreadWorkspaceActivityEntry, WorkspaceActivityPhase } from "../../contracts/workspace";
import failureCodes from "../observability/failureCodes.json";
import {
  createTelegramAgentStatus, TELEGRAM_STATUS_LOG_CODES, telegramWorkActivity, type TelegramAgentStatus
} from "./agentStatus";
import { createTelegramBotApi, createTelegramPacer } from "./botApi";
import type { TelegramRunEvent, TelegramRunEventContext } from "./bridge/events";
import type { TelegramAccessDecision } from "./control/access";
import { TELEGRAM_COPY } from "./copy";
import type { TelegramBotSession } from "./dispatcher";
import { createTelegramOutbound } from "./outbound";
import type { TelegramLinkRecord } from "./store/links";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  while (closers.length) await closers.pop()!();
});

const START = Date.parse("2026-10-19T08:00:00.000Z");

function command(id: string, phase: WorkspaceActivityPhase, preview: string): ThreadWorkspaceActivityEntry {
  return { command: { preview }, id, kind: "command", phase };
}

function fileRead(id: string, phase: WorkspaceActivityPhase, displayPath: string): ThreadWorkspaceActivityEntry {
  return { file: { displayPath }, id, kind: "file_read", phase };
}

function activity(entry: ThreadWorkspaceActivityEntry): TelegramRunEvent {
  return { entry, type: "workspaceActivity" };
}

/** The status against the fake Bot API on a fake clock, for runs linked at START. */
async function setup() {
  vi.useFakeTimers({ now: START });
  const fake = createFakeTelegramBotApi({ now: () => Date.now() });
  closers.push(() => fake.close());
  const user = fake.inject.addUser();
  /** Called on every Bot API wait (pacing or a 429's retry_after). */
  const hooks: { onSleep?: (ms: number) => void } = {};
  const api = createTelegramBotApi({
    pacer: createTelegramPacer({ now: () => 0 }), sleep: async (ms) => hooks.onSleep?.(ms), token: fake.token, transport: fake.transport
  });
  let rows = 0;
  const outbound = createTelegramOutbound({
    api, appBaseUrl: "https://aiqsa.example", botId: fake.bot.id,
    callbacks: { create: async ({ buttons }) => buttons.map(() => `c:${String(rows += 1).padStart(22, "B")}`) },
    messageRefs: { record: async () => undefined }
  });
  const session: TelegramBotSession = { api, botId: fake.bot.id, botUsername: fake.bot.username, generation: 1, outbound };
  const runLinks = memoryRunLinkStore();
  const refs = memoryMessageRefStore();
  for (const runId of ["run-1", "run-2"]) {
    await runLinks.store.create({ draftId: 7, linkId: "link-1", now: new Date(START), runId, telegramChatId: user.id, userId: "user-1" });
  }
  const link: TelegramLinkRecord = {
    botId: fake.bot.id, currentChatId: "chat-1", displayName: null, id: "link-1", lastSeenAt: new Date(START),
    linkedAt: new Date(START), pendingAssistantId: null, searchEnabled: false, selectedModelId: null, selectedProvider: null,
    telegramChatId: user.id, telegramUserId: user.id, telegramUsername: null, userId: "user-1", workspaceEnabled: false
  };
  let decision: TelegramAccessDecision = { allowed: true, control: {} as never, link };
  const access = { resolveTelegramAccess: vi.fn(async () => decision) };
  const status = createTelegramAgentStatus({
    access, messageRefs: refs.store, runLinks: runLinks.store, sessions: { current: async () => session }
  });
  const context: TelegramRunEventContext = {
    bot: session, chatId: "chat-1", linkId: "link-1", runId: "run-1", source: "live", telegramChatId: user.id, userId: "user-1"
  };
  return {
    access, fake, hooks, refs, runLinks, session, status, user,
    /** The user unlinks: the run's link no longer reaches its chat. */
    unlink() { decision = { allowed: false, link: null, reasonCode: "telegram_not_linked" }; },
    emit(event: TelegramRunEvent, runId = "run-1") {
      void status.listener(event, { ...context, runId });
    },
    context,
    sends: (): FakeTelegramCall[] => [...fake.calls("sendMessage")],
    edits: (): FakeTelegramCall[] => [...fake.calls("editMessageText")]
  };
}

/** Lets due work run: a 0 ms timer set during a fake tick runs 1 ms later. */
async function settle(status: TelegramAgentStatus): Promise<void> {
  await vi.advanceTimersByTimeAsync(1);
  await status.idle();
}

describe("Telegram Workspace status", () => {
  it("sends one status with Stop at the first activity, then edits it at most every 5 s and only when its text changed", async () => {
    const h = await setup();
    await vi.advanceTimersByTimeAsync(1_000);
    h.emit(activity(command("cmd-1", "running", "npm test")));
    await settle(h.status);
    const [sent] = h.sends();
    expect(sent!.params).toMatchObject({
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ callback_data: expect.stringMatching(/^c:/u), text: TELEGRAM_COPY.stop }]] },
      text: "Working in Workspace · 1 min — Running npm test"
    });
    const status = h.fake.botMessages(h.user.id)[0]!;
    expect(h.runLinks.rows.get("run-1")?.statusMessageId).toBe(status.message_id);
    expect(h.refs.refs).toContainEqual(expect.objectContaining({ chatId: "chat-1", linkId: "link-1", telegramMessageId: status.message_id }));

    // A newer step waits until 5 s passed since the message was last written.
    h.emit(activity(fileRead("read-1", "running", "src/app.ts")));
    await vi.advanceTimersByTimeAsync(4_900);
    expect(h.edits()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    await settle(h.status);
    expect(h.edits().map((call) => call.params.text)).toEqual(["Working in Workspace · 1 min — Reading src/app.ts"]);
    expect(h.edits()[0]!.params.reply_markup).toEqual(sent!.params.reply_markup);

    // Several changes in the next 5 s make one edit, with the newest step still running.
    h.emit(activity(fileRead("read-1", "succeeded", "src/app.ts")));
    h.emit(activity(command("cmd-2", "running", "npm run build")));
    h.emit(activity(command("cmd-1", "succeeded", "npm test")));
    await vi.advanceTimersByTimeAsync(5_000);
    await settle(h.status);
    expect(h.edits().map((call) => call.params.text)).toEqual([
      "Working in Workspace · 1 min — Reading src/app.ts", "Working in Workspace · 1 min — Running npm run build"
    ]);

    // Nothing new: no edit until the minutes change.
    h.emit(activity(command("cmd-2", "running", "npm run build")));
    await vi.advanceTimersByTimeAsync(20_000);
    await settle(h.status);
    expect(h.edits()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle(h.status);
    expect(h.edits().at(-1)!.params.text).toBe("Working in Workspace · 2 min — Running npm run build");

    h.emit({ status: "complete", type: "done" });
    await settle(h.status);
    const last = h.edits().at(-1)!;
    expect(last.params.text).toBe("Finished in 2 min");
    expect(last.params).not.toHaveProperty("reply_markup");
    expect(h.fake.botMessages(h.user.id)).toHaveLength(1);

    // One status per run: nothing after it ended changes or adds a message.
    const edits = h.edits().length;
    h.emit(activity(command("cmd-3", "running", "late")));
    await vi.advanceTimersByTimeAsync(30_000);
    await settle(h.status);
    expect(h.sends()).toHaveLength(1);
    expect(h.edits()).toHaveLength(edits);
  });

  it("says the run is working in Workspace, Stopped when it is stopped and that it failed when it fails", async () => {
    const h = await setup();
    h.emit(activity(command("cmd-0", "running", "ls")));
    await settle(h.status);
    expect(h.sends()[0]!.params.text).toBe("Working in Workspace · 1 min — Running ls");
    h.emit({ status: "cancelled", type: "done" });
    await settle(h.status);
    expect(h.edits().at(-1)!.params).toMatchObject({ text: TELEGRAM_COPY.stopped });
    expect(h.edits().at(-1)!.params).not.toHaveProperty("reply_markup");

    h.emit(activity(command("cmd-1", "running", "pytest")), "run-2");
    await settle(h.status);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    h.emit({ code: "workspace_turn_time_limit", message: "The run ran out of time", type: "failed" }, "run-2");
    await settle(h.status);
    expect(h.edits().at(-1)!.params.text).toBe("Failed after 3 min");
  });

  it("shows how a run ended in its one message when it ended before the status could be sent", async () => {
    const h = await setup();
    h.emit(activity(command("cmd-1", "running", "make")));
    h.emit({ status: "complete", type: "done" });
    await settle(h.status);
    expect(h.sends()).toHaveLength(1);
    expect(h.sends()[0]!.params.text).toBe("Finished in 1 min");
    expect(h.sends()[0]!.params).not.toHaveProperty("reply_markup");
    expect(h.edits()).toHaveLength(0);
  });

  it("stops its edits and timers once the run's chat may no longer receive it, while the run goes on", async () => {
    const h = await setup();
    h.emit(activity(command("cmd-1", "running", "npm test")));
    await settle(h.status);
    expect(h.sends()).toHaveLength(1);

    h.unlink();
    // A newer step, the minutes going on and the run's end: none of it reaches the chat any more.
    h.emit(activity(fileRead("read-1", "running", "PRIVATE_AFTER_UNLINK.ts")));
    await vi.advanceTimersByTimeAsync(5_000);
    await settle(h.status);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await settle(h.status);
    expect(vi.getTimerCount()).toBe(0);
    h.emit({ status: "complete", type: "done" });
    // Nor does a status for another run of the link.
    h.emit(activity(command("cmd-2", "running", "PRIVATE_AFTER_UNLINK")), "run-2");
    await settle(h.status);
    expect(h.sends()).toHaveLength(1);
    expect(h.edits()).toHaveLength(0);
    expect(JSON.stringify(h.fake.calls())).not.toContain("PRIVATE_AFTER_UNLINK");
  });

  it("asks again after a 429's wait and edits nothing once the run's chat may no longer receive it", async () => {
    const h = await setup();
    h.emit(activity(command("cmd-1", "running", "npm test")));
    await settle(h.status);
    expect(h.sends()).toHaveLength(1);

    // The user unlinks while the client waits out Telegram's retry_after for the next edit.
    h.hooks.onSleep = (ms) => { if (ms === 60_000) h.unlink(); };
    h.fake.failNext("editMessageText", { retryAfter: 60, status: 429 });
    h.emit(activity(fileRead("read-1", "running", "PRIVATE_AFTER_UNLINK.ts")));
    await vi.advanceTimersByTimeAsync(5_000);
    await settle(h.status);
    expect(h.edits()).toHaveLength(1);
    // Ended for good: no timer, no closing edit.
    expect(vi.getTimerCount()).toBe(0);
    h.emit({ status: "complete", type: "done" });
    await settle(h.status);
    expect(h.edits()).toHaveLength(1);
    expect(h.sends()).toHaveLength(1);
  });

  it("ends a status a previous process left working when recovery delivers its run", async () => {
    const h = await setup();
    const left = await h.session.api.sendMessage({ chat_id: h.user.id, text: "Working in Workspace · 2 min" });
    if (!left.ok) throw new Error("fake send failed");
    await h.runLinks.store.setStatusMessage({ runId: "run-1", statusMessageId: left.result.message_id });
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    void h.status.listener({ messageIds: [9], sent: true, status: "complete", type: "delivered" }, h.context);
    await settle(h.status);
    expect(h.edits()).toHaveLength(0);
    void h.status.listener({ messageIds: [9], sent: true, status: "complete", type: "delivered" }, { ...h.context, source: "recovery" });
    await settle(h.status);
    expect(h.edits().map((call) => [call.params.message_id, call.params.text])).toEqual([[left.result.message_id, "Finished in 6 min"]]);
  });

  it("names the newest running step, else the newest step worth naming", () => {
    expect(telegramWorkActivity([
      command("cmd-1", "running", "npm test"), fileRead("read-1", "succeeded", "a.ts"),
      { id: "plan-1", items: [{ completed: true, text: "Look" }, { completed: false, text: "Fix" }], kind: "plan", phase: "running" }
    ])).toBe("Running npm test");
    expect(telegramWorkActivity([command("cmd-1", "succeeded", "npm test"), { id: "exec-1", kind: "execution_status", phase: "closed" }]))
      .toBe("Ran npm test");
    expect(telegramWorkActivity([{ id: "plan-1", items: [{ completed: true, text: "Look" }], kind: "plan", phase: "succeeded" }]))
      .toBe("Plan · 1 of 1 done");
    expect(telegramWorkActivity([{ id: "start-1", kind: "workspace_start", phase: "succeeded" }])).toBeNull();
  });

  it("registers its codes among the sorted failure codes", () => {
    const registry = failureCodes as string[];
    for (const code of TELEGRAM_STATUS_LOG_CODES) {
      const index = registry.indexOf(code);
      expect(index, code).toBeGreaterThan(0);
      expect(registry[index - 1]! < code && code < registry[index + 1]!, code).toBe(true);
    }
  });
});

describe("Telegram Agent and Workspace status in the chat bridge", () => {
  it("stops the run from the status's Stop button and ends the status as Stopped", async () => {
    const gateway = createFakeGateway({ autoAnswer: null });
    let status: TelegramAgentStatus | null = null;
    const h = createBridgeHarness({ bridge: { publish: async (event, context) => { await status?.listener(event, context); } }, gateway });
    closers.push(h.close);
    status = createTelegramAgentStatus({
      access: h.access, messageRefs: h.messageRefs.store, runLinks: h.runLinks.store, sessions: h.sessions
    });
    const user = h.fake.inject.addUser({ firstName: "Alex" });
    h.link(user, "user-1", { workspaceEnabled: true });
    await h.deliver(h.fake.inject.text(user, "[AIQSA_WORKSPACE_E2E:long_command]"));
    h.bridge.conversation.flush();
    await vi.waitFor(() => expect(gateway.runs).toHaveLength(1));
    const run = gateway.runs[0]!;
    expect(gateway.sent[0]!.body).toMatchObject({ workspace: { enabled: true } });
    run.emit({ data: { artifactType: "workspace_activity", payload: command("cmd-1", "running", "sleep 300") }, type: "artifact" });
    await vi.waitFor(() => expect(h.fake.botMessages(user.id).some((message) => message.text?.startsWith("Working in Workspace"))).toBe(true));
    const message = h.fake.botMessages(user.id).find((entry) => entry.text?.startsWith("Working in Workspace"))!;
    expect(message.text).toBe("Working in Workspace · 1 min — Running sleep 300");

    await h.deliver(h.fake.inject.callback(user, message.message_id, buttonData(message, TELEGRAM_COPY.stop)));
    await h.settle();
    await status.idle();
    expect(run.status).toBe("cancelled");
    const ended = h.fake.botMessages(user.id).find((entry) => entry.message_id === message.message_id)!;
    expect(ended).toMatchObject({ reply_markup: undefined, text: TELEGRAM_COPY.stopped });
    expect(h.runLinks.rows.get(run.id)?.statusMessageId).toBe(message.message_id);
  });
});

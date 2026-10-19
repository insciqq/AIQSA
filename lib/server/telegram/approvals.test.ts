import { afterEach, describe, expect, it, vi } from "vitest";
import type { FakeTelegramMessage } from "@/tests/support/fakeTelegramBotApi";
import {
  buttonData, createBridgeHarness, createFakeGateway, type BridgeHarness, type FakeGateway, type FakeRun
} from "@/tests/support/telegramChatBridge";
import type { McpApprovalCard, McpApprovalDecision } from "../../contracts/mcpApprovals";
import failureCodes from "../observability/failureCodes.json";
import {
  boundedTelegramApprovalDetails, createTelegramApprovals, TELEGRAM_APPROVAL_CALLBACK_KINDS, TELEGRAM_APPROVAL_DETAILS_MAX_CHARS,
  TELEGRAM_APPROVAL_LOG_CODES, TELEGRAM_APPROVAL_WINDOW_MS, telegramApprovalMessage, type TelegramApprovalGateway, type TelegramApprovals
} from "./approvals";
import { TELEGRAM_APPROVAL_COPY, TELEGRAM_COPY } from "./copy";
import { renderTelegramAnswer } from "./render";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const DETAILS = JSON.stringify({ project: "SYN", summary: "Synthetic issue", description: "x".repeat(2_000) }, null, 2);

type StoredApproval = { card: McpApprovalCard; runId: string; userId: string; decision: McpApprovalDecision | null; nonce: string | null };

/** The approval rows as `decideMcpApproval` keeps them: nonce-idempotent, one decision, refused while the run still settles. */
function approvalStore(aiqsa: FakeGateway) {
  const rows = new Map<string, StoredApproval>();
  const decisions: Array<Readonly<{ approvalId: string; decision: McpApprovalDecision; nonce: string }>> = [];
  let failures = 0;
  const view = (row: StoredApproval): McpApprovalCard => {
    const state = row.decision === "allow_once" ? "allowed_once" : row.decision === "allow_server" ? "allowed_server"
      : row.decision === "deny" ? "denied" : "pending";
    const { canDecide: _canDecide, ...card } = row.card;
    return { ...card, ...(state === "pending" ? { canDecide: true as const } : {}), state };
  };
  const gateway: TelegramApprovalGateway = {
    async decide(input) {
      decisions.push({ approvalId: input.approvalId, decision: input.decision, nonce: input.nonce });
      if (failures > 0) {
        failures -= 1;
        throw new Error("synthetic write failure");
      }
      const row = rows.get(input.approvalId);
      if (!row || row.runId !== input.runId || row.userId !== input.userId) return { kind: "not_found" };
      if (row.decision !== null) {
        return row.decision === input.decision && row.nonce === input.nonce
          ? { card: view(row), continuation: row.decision !== "deny", kind: "decided" }
          : { card: view(row), kind: "conflict" };
      }
      if (aiqsa.runs.find((run) => run.id === row.runId)?.status === "streaming") return { kind: "run_active" };
      row.decision = input.decision;
      row.nonce = input.nonce;
      return { card: view(row), continuation: input.decision !== "deny", kind: "decided" };
    },
    async card(input) {
      const row = rows.get(input.approvalId);
      return row && row.runId === input.runId && row.userId === input.userId ? view(row) : null;
    },
    details: vi.fn(async () => DETAILS)
  };
  return {
    decisions, gateway, rows,
    add(run: FakeRun, overrides: Partial<McpApprovalCard> = {}): McpApprovalCard {
      const card: McpApprovalCard = {
        approvalId: `approval-${rows.size + 1}`, canDecide: true, details: { ordinal: 0, roundIndex: 1 }, serverName: "Jira", source: "model",
        state: "pending", toolName: "create_issue", ...overrides
      };
      rows.set(card.approvalId, { card, decision: null, nonce: null, runId: run.id, userId: run.userId });
      return card;
    },
    /** A decision the initiator made in AIQSA first. */
    decideInWeb(approvalId: string, decision: McpApprovalDecision) {
      Object.assign(rows.get(approvalId)!, { decision, nonce: "web-nonce-0001" });
    },
    failNextDecisions(count: number) {
      failures = count;
    }
  };
}

function harness() {
  const aiqsa = createFakeGateway({ autoAnswer: null });
  let approvals: TelegramApprovals | null = null;
  const h = createBridgeHarness({ bridge: { publish: async (event, context) => { await approvals?.listener(event, context); } }, gateway: aiqsa });
  closers.push(h.close);
  const user = h.fake.inject.addUser({ firstName: "Alex" });
  const linkRecord = h.link(user);
  const store = approvalStore(aiqsa);
  /** The approvals' own clock: waiting moves it instead of real time. */
  const clock = { now: Date.now(), onSleep: (): void => undefined };
  approvals = createTelegramApprovals({
    access: h.access, conversation: h.bridge.conversation, gateway: store.gateway, now: () => clock.now, sessions: h.sessions,
    sleep: async (ms) => {
      clock.now += ms;
      clock.onSleep();
    }
  });
  for (const kind of TELEGRAM_APPROVAL_CALLBACK_KINDS) h.registry.registerCallback(kind, approvals.callbacks[kind]);
  return { ...h, approvals, clock, linkRecord, store, user };
}

type Harness = ReturnType<typeof harness>;

async function runStarted(aiqsa: FakeGateway, count: number): Promise<FakeRun> {
  await vi.waitFor(() => expect(aiqsa.runs).toHaveLength(count));
  return aiqsa.runs[count - 1]!;
}

/** A message from the user, its merge window closed, and the run it starts. */
async function ask(h: Harness, text: string, count: number): Promise<FakeRun> {
  await h.deliver(h.fake.inject.text(h.user, text));
  h.bridge.conversation.flush();
  return runStarted(h.aiqsa, count);
}

function approvalMessages(h: BridgeHarness, chat: number): FakeTelegramMessage[] {
  return h.fake.botMessages(chat).filter((message) => JSON.stringify(message.rich_message ?? message.text ?? "").includes("Jira · "));
}

function message(h: BridgeHarness, chat: number, id: number): FakeTelegramMessage {
  return h.fake.botMessages(chat).find((entry) => entry.message_id === id)!;
}

function keyboardTexts(entry: FakeTelegramMessage): string[][] {
  return ((entry.reply_markup as { inline_keyboard?: Array<Array<{ text: string }>> } | undefined)?.inline_keyboard ?? [])
    .map((row) => row.map((button) => button.text));
}

/** Presses a button of a bot message and waits for its decision (and, unless a run is meant to keep going, for what it started). */
async function press(h: Harness, target: FakeTelegramMessage, text: string, options: Readonly<{ settle?: boolean }> = {}) {
  const data = buttonData(target, text);
  const update = h.fake.inject.callback(h.user, target.message_id, data);
  await h.deliver(update);
  await h.approvals.idle();
  if (options.settle !== false) {
    await h.settle();
    await h.approvals.idle();
  }
  return { data, queryId: (update.callback_query as { id: string }).id, update };
}

/** A run that asked for approval live and then settled. */
async function settledApproval(h: Harness, overrides: Partial<McpApprovalCard> = {}) {
  const run = await ask(h, "create the issue", h.aiqsa.runs.length + 1);
  const card = h.store.add(run, overrides);
  run.emit({ data: { artifactType: "mcp_approval", payload: card }, type: "artifact" });
  run.summary = { citations: [], mcpApprovals: [card], reasoningText: [], sources: [] };
  run.token("I need your approval to create the issue.");
  run.complete();
  await h.settle();
  await h.approvals.idle();
  const [approval] = approvalMessages(h, h.user.id).slice(-1);
  return { approval: approval!, card, run };
}

describe("Telegram MCP approvals: the message", () => {
  it("turns a live card into one message with the redacted request and three buttons; the settled answer adds no second one", async () => {
    const h = harness();
    const run = await ask(h, "create the issue", 1);
    const card = h.store.add(run);
    run.emit({ data: { artifactType: "mcp_approval", payload: card }, type: "artifact" });
    await vi.waitFor(() => expect(approvalMessages(h, h.user.id)).toHaveLength(1));
    const [approval] = approvalMessages(h, h.user.id);
    expect(approval!.rich_message).toEqual({
      blocks: [
        { text: { text: "Jira · create_issue", type: "bold" }, type: "paragraph" },
        { text: TELEGRAM_APPROVAL_COPY.pendingModel, type: "paragraph" },
        { language: "json", text: boundedTelegramApprovalDetails(DETAILS), type: "pre" }
      ],
      skip_entity_detection: true
    });
    expect(keyboardTexts(approval!)).toEqual([[TELEGRAM_COPY.allowOnce, TELEGRAM_COPY.deny], ["Always allow Jira"]]);
    expect(h.store.gateway.details).toHaveBeenCalledWith({ ordinal: 0, roundIndex: 1, runId: run.id, userId: "user-1" });
    // A reply to the approval continues its chat.
    expect(h.messageRefs.refs).toContainEqual(expect.objectContaining({ chatId: run.chatId, telegramMessageId: approval!.message_id }));

    run.summary = { citations: [], mcpApprovals: [card], reasoningText: [], sources: [] };
    run.token("I need your approval.");
    run.complete();
    await h.settle();
    await h.approvals.idle();
    expect(approvalMessages(h, h.user.id)).toHaveLength(1);
    expect(h.store.decisions).toEqual([]);
  });

  it("sends a pending card the live stream missed from the settled answer, once, after the answer", async () => {
    const h = harness();
    const run = await ask(h, "create the issue", 1);
    const card = h.store.add(run, { details: undefined, source: "agent" });
    run.summary = { citations: [], mcpApprovals: [card, { ...card, approvalId: "decided-1", canDecide: undefined, state: "denied" }],
      reasoningText: [], sources: [] };
    run.token("Agent needs your approval.");
    run.complete();
    await h.settle();
    await h.approvals.idle();
    const messages = h.fake.botMessages(h.user.id);
    expect(approvalMessages(h, h.user.id)).toHaveLength(1);
    expect(messages.at(-1)!.rich_message).toEqual({
      blocks: [
        { text: { text: "Jira · create_issue", type: "bold" }, type: "paragraph" },
        { text: TELEGRAM_APPROVAL_COPY.pendingAgent, type: "paragraph" }
      ],
      skip_entity_detection: true
    });
    expect(messages.at(-2)!.rich_message).toEqual(renderTelegramAnswer("Agent needs your approval.").messages[0]);
  });

  it("bounds the request to 1 500 characters without splitting a character, and words each source and decision", () => {
    const bounded = boundedTelegramApprovalDetails(`${"a".repeat(TELEGRAM_APPROVAL_DETAILS_MAX_CHARS - 2)}😀😀`)!;
    expect(bounded.length).toBeLessThanOrEqual(TELEGRAM_APPROVAL_DETAILS_MAX_CHARS);
    expect(bounded.endsWith("a…")).toBe(true);
    expect(boundedTelegramApprovalDetails("  ")).toBeNull();
    const card: McpApprovalCard = { approvalId: "a-1", serverName: "Jira", source: "code", state: "pending", toolName: "create_issue" };
    const text = (value: McpApprovalCard, expired = false) => JSON.stringify(telegramApprovalMessage({ card: value, details: null, expired }));
    expect(text(card)).toContain(TELEGRAM_APPROVAL_COPY.pendingCode);
    expect(text(card, true)).toContain(TELEGRAM_COPY.approvalExpired);
    expect(text({ ...card, state: "allowed_once" }, true)).toContain(TELEGRAM_COPY.allowedOnce);
    expect(text({ ...card, state: "allowed_server" })).toContain("Always allowed for Jira");
    expect(text({ ...card, state: "denied" })).toContain(TELEGRAM_COPY.denied);
  });
});

describe("Telegram MCP approvals: decisions", () => {
  it("Allow once decides with the button's id as nonce and continues from the chat's leaf, never as the user's message", async () => {
    const h = harness();
    const { approval, card, run } = await settledApproval(h);
    h.aiqsa.setAutoAnswer((body) => body.systemTurn ? "Issue SYN-1 created." : null);
    const pressed = await press(h, approval, TELEGRAM_COPY.allowOnce);

    expect(h.store.decisions).toEqual([{ approvalId: card.approvalId, decision: "allow_once", nonce: pressed.data.slice(2) }]);
    // Answered at once, without a pop-up: the message shows the outcome.
    expect(h.fake.callbackAnswer(pressed.queryId)).toMatchObject({ answered: true, text: undefined });
    const decided = message(h, h.user.id, approval.message_id);
    expect(JSON.stringify(decided.rich_message)).toContain(TELEGRAM_COPY.allowedOnce);
    expect(JSON.stringify(decided.rich_message)).toContain("Jira · create_issue");
    expect(decided.reply_markup).toBeUndefined();
    expect(h.aiqsa.sent).toHaveLength(2);
    expect(h.aiqsa.sent[1]).toMatchObject({
      body: {
        admissionId: `tg-${h.fake.bot.id}-${pressed.update.update_id}`, content: { blocks: [] }, expectedActiveLeafId: run.assistantMessageId,
        systemTurn: { approvalId: card.approvalId, kind: "mcp_approval_continuation" }
      },
      chatId: run.chatId
    });
    expect(h.fake.botMessages(h.user.id).at(-1)).toMatchObject({ rich_message: renderTelegramAnswer("Issue SYN-1 created.").messages[0] });
    expect(JSON.stringify(h.fake.botMessages(h.user.id))).not.toContain("The user approved");

    // The same button again: used up, nothing decided or continued twice.
    const again = h.fake.inject.callback(h.user, approval.message_id, pressed.data);
    await h.deliver(again);
    await h.approvals.idle();
    expect(h.fake.callbackAnswer((again.callback_query as { id: string }).id)).toMatchObject({ text: TELEGRAM_COPY.buttonExpired });
    expect(h.store.decisions).toHaveLength(1);
    expect(h.aiqsa.sent).toHaveLength(2);
  });

  it("Always allow continues and names the server; Deny records the decision and starts nothing", async () => {
    const h = harness();
    const first = await settledApproval(h);
    h.aiqsa.setAutoAnswer((body) => body.systemTurn ? "Done." : null);
    await press(h, first.approval, "Always allow Jira");
    expect(h.store.decisions.at(-1)).toMatchObject({ decision: "allow_server" });
    expect(JSON.stringify(message(h, h.user.id, first.approval.message_id).rich_message)).toContain("Always allowed for Jira");
    expect(h.aiqsa.sent).toHaveLength(2);

    h.aiqsa.setAutoAnswer(null);
    const second = await settledApproval(h, { toolName: "delete_issue" });
    const sent = h.aiqsa.sent.length;
    await press(h, second.approval, TELEGRAM_COPY.deny);
    expect(h.store.decisions.at(-1)).toMatchObject({ approvalId: second.card.approvalId, decision: "deny" });
    const denied = message(h, h.user.id, second.approval.message_id);
    expect(JSON.stringify(denied.rich_message)).toContain(TELEGRAM_COPY.denied);
    expect(denied.reply_markup).toBeUndefined();
    expect(h.aiqsa.sent).toHaveLength(sent);
  });

  it("shows a decision made in AIQSA first as it is and starts nothing from Telegram", async () => {
    const h = harness();
    const { approval, card } = await settledApproval(h);
    h.store.decideInWeb(card.approvalId, "deny");
    const sent = h.aiqsa.sent.length;
    await press(h, approval, TELEGRAM_COPY.allowOnce);
    expect(JSON.stringify(message(h, h.user.id, approval.message_id).rich_message)).toContain(TELEGRAM_COPY.denied);
    expect(h.aiqsa.sent).toHaveLength(sent);

    const next = await settledApproval(h);
    h.store.decideInWeb(next.card.approvalId, "allow_once");
    await press(h, next.approval, TELEGRAM_COPY.deny);
    expect(JSON.stringify(message(h, h.user.id, next.approval.message_id).rich_message)).toContain(TELEGRAM_COPY.allowedOnce);
    // The web started its own continuation; Telegram never starts a second one.
    expect(h.aiqsa.sent).toHaveLength(sent + 1);
  });

  it("waits while the run still settles, and after 30 s asks to try again with buttons that keep the first press's nonce", async () => {
    const h = harness();
    const run = await ask(h, "create the issue", 1);
    const card = h.store.add(run);
    run.emit({ data: { artifactType: "mcp_approval", payload: card }, type: "artifact" });
    await vi.waitFor(() => expect(approvalMessages(h, h.user.id)).toHaveLength(1));
    const [approval] = approvalMessages(h, h.user.id);

    // Pressed while the answer still streams: the decision waits for it, then succeeds.
    let sleeps = 0;
    h.clock.onSleep = () => {
      sleeps += 1;
      if (sleeps === 3) {
        run.token("Waiting for approval.");
        run.complete();
      }
    };
    h.aiqsa.setAutoAnswer((body) => body.systemTurn ? "Created after waiting." : null);
    const waited = await press(h, approval!, TELEGRAM_COPY.allowOnce);
    expect(h.store.decisions.map((entry) => entry.nonce)).toEqual(Array.from({ length: 4 }, () => waited.data.slice(2)));
    expect(JSON.stringify(message(h, h.user.id, approval!.message_id).rich_message)).toContain(TELEGRAM_COPY.allowedOnce);
    expect(h.fake.botMessages(h.user.id).at(-1)).toMatchObject({ rich_message: renderTelegramAnswer("Created after waiting.").messages[0] });

    // A run that settles later than 30 s: try again, with fresh buttons that decide under the first nonce.
    h.clock.onSleep = () => undefined;
    h.aiqsa.setAutoAnswer(null);
    const slow = await ask(h, "create another issue", 3);
    const slowCard = h.store.add(slow);
    slow.emit({ data: { artifactType: "mcp_approval", payload: slowCard }, type: "artifact" });
    await vi.waitFor(() => expect(approvalMessages(h, h.user.id)).toHaveLength(2));
    const slowApproval = approvalMessages(h, h.user.id).at(-1)!;
    const before = h.store.decisions.length;
    const startedAt = h.clock.now;
    const first = await press(h, slowApproval, TELEGRAM_COPY.allowOnce, { settle: false });
    expect(h.clock.now - startedAt).toBeLessThanOrEqual(30_000 + 4_000);
    expect(h.store.decisions.length - before).toBeGreaterThan(3);
    const retry = message(h, h.user.id, slowApproval.message_id);
    expect(JSON.stringify(retry.rich_message)).toContain(TELEGRAM_APPROVAL_COPY.stillRunning);
    expect(keyboardTexts(retry)).toEqual([[TELEGRAM_COPY.allowOnce, TELEGRAM_COPY.deny], ["Always allow Jira"]]);
    expect(buttonData(retry, TELEGRAM_COPY.allowOnce)).not.toBe(first.data);

    slow.token("Still waiting.");
    slow.complete();
    await h.settle();
    h.aiqsa.setAutoAnswer((body) => body.systemTurn ? "Created at last." : null);
    await press(h, retry, TELEGRAM_COPY.allowOnce);
    expect(h.store.decisions.at(-1)).toEqual({ approvalId: slowCard.approvalId, decision: "allow_once", nonce: first.data.slice(2) });
    expect(JSON.stringify(message(h, h.user.id, slowApproval.message_id).rich_message)).toContain(TELEGRAM_COPY.allowedOnce);
    expect(h.fake.botMessages(h.user.id).at(-1)).toMatchObject({ rich_message: renderTelegramAnswer("Created at last.").messages[0] });
  });

  it("asks to try again when the decision cannot be saved, and the retry replays the same nonce", async () => {
    const h = harness();
    const { approval, card } = await settledApproval(h);
    h.store.failNextDecisions(1_000);
    const first = await press(h, approval, TELEGRAM_COPY.deny);
    const retry = message(h, h.user.id, approval.message_id);
    expect(JSON.stringify(retry.rich_message)).toContain(TELEGRAM_APPROVAL_COPY.notSaved);
    h.store.failNextDecisions(0);
    await press(h, retry, TELEGRAM_COPY.deny);
    expect(h.store.decisions.at(-1)).toEqual({ approvalId: card.approvalId, decision: "deny", nonce: first.data.slice(2) });
    expect(JSON.stringify(message(h, h.user.id, approval.message_id).rich_message)).toContain(TELEGRAM_COPY.denied);
  });

  it("past the approval window says it expired and decides nothing; a gone approval says it is no longer available", async () => {
    const h = harness();
    const { approval } = await settledApproval(h);
    h.clock.now += TELEGRAM_APPROVAL_WINDOW_MS;
    await press(h, approval, TELEGRAM_COPY.allowOnce);
    expect(h.store.decisions).toEqual([]);
    const expired = message(h, h.user.id, approval.message_id);
    expect(JSON.stringify(expired.rich_message)).toContain(TELEGRAM_COPY.approvalExpired);
    expect(expired.reply_markup).toBeUndefined();

    const gone = await settledApproval(h);
    h.store.rows.delete(gone.card.approvalId);
    await press(h, gone.approval, TELEGRAM_COPY.allowOnce);
    expect(message(h, h.user.id, gone.approval.message_id)).toMatchObject({ reply_markup: undefined, text: TELEGRAM_APPROVAL_COPY.unavailable });
  });

  it("says the approval expired when the server no longer takes its continuation", async () => {
    const h = harness();
    const { approval } = await settledApproval(h);
    h.aiqsa.respondNext(() => Response.json({ error: "mcp_approval_continuation_unavailable" }, { status: 409 }));
    await press(h, approval, TELEGRAM_COPY.allowOnce);
    expect(JSON.stringify(message(h, h.user.id, approval.message_id).rich_message)).toContain(TELEGRAM_COPY.allowedOnce);
    expect(h.fake.botMessages(h.user.id).at(-1)!.text).toBe(TELEGRAM_COPY.approvalExpired);
  });

  it("does nothing for a forged button or another account's press", async () => {
    const h = harness();
    const { approval } = await settledApproval(h);
    const forged = h.fake.inject.callback(h.user, approval.message_id, `c:${"A".repeat(22)}`);
    await h.deliver(forged);
    expect(h.fake.callbackAnswer((forged.callback_query as { id: string }).id)).toMatchObject({ text: TELEGRAM_COPY.buttonExpired });

    const stranger = h.fake.inject.addUser({ firstName: "Mallory" });
    h.link(stranger, "user-2");
    const foreign = h.fake.inject.callback(stranger, approval.message_id, buttonData(approval, TELEGRAM_COPY.allowOnce));
    await h.deliver(foreign);
    await h.approvals.idle();
    expect(h.fake.callbackAnswer((foreign.callback_query as { id: string }).id)).toMatchObject({ text: TELEGRAM_COPY.buttonExpired });
    expect(h.store.decisions).toEqual([]);
    expect(keyboardTexts(message(h, h.user.id, approval.message_id))).toHaveLength(2);

    // The rightful owner's press still works afterwards.
    await press(h, approval, TELEGRAM_COPY.deny);
    expect(h.store.decisions).toHaveLength(1);
  });

  it("registers its codes among the sorted failure codes", () => {
    const registry = failureCodes as string[];
    for (const code of TELEGRAM_APPROVAL_LOG_CODES) {
      const index = registry.indexOf(code);
      expect(index, code).toBeGreaterThan(0);
      expect(registry[index - 1]! < code && code < registry[index + 1]!, code).toBe(true);
    }
  });
});

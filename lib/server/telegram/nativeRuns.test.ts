// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  memoryNativeEngine, NATIVE_MCP_SNAPSHOT, nativePrepared, nativeRunRepository, scriptedNativeAdapter, type ScriptedStep
} from "@/tests/support/nativeRunExecution";
import { buttonData, createBridgeHarness, createFakeGateway } from "@/tests/support/telegramChatBridge";
import { MCP_APPROVAL_CONTINUATION_KIND, type McpApprovalCard, type McpApprovalDecision } from "../../contracts/mcpApprovals";
import { createNativeRunExecutionResponse } from "../engine/execution";
import { mcpApprovalAdmission } from "../mcp/writeApproval";
import type { RunRepository } from "../runs/runRepositoryContract";
import { createTelegramApprovals, TELEGRAM_APPROVAL_CALLBACK_KINDS, type TelegramApprovalGateway, type TelegramApprovals } from "./approvals";
import type { TelegramRunAnswer, TelegramRunGateway } from "./bridge/gateway";
import { TELEGRAM_COPY } from "./copy";
import { renderTelegramAnswer } from "./render";

/**
 * Telegram turns on the native engine: the bridge follows the run stream the
 * native engine writes (text across tool rounds, an approval card at the
 * approval stop, answer first, then done), delivers the published answer,
 * and an Allow sends the server's continuation turn into the same chat.
 */
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

type NativeTurn = Readonly<{ approval?: McpApprovalCard; steps: readonly ScriptedStep[] }>;
type NativeAnswer = { -readonly [Key in keyof TelegramRunAnswer]: TelegramRunAnswer[Key] } & { userId: string };

/** Telegram's AIQSA where every send is a native run of the next scripted turn. */
function nativeAiqsa(turns: readonly NativeTurn[]) {
  const aiqsa = createFakeGateway({ autoAnswer: null });
  const answers = new Map<string, NativeAnswer>();
  const sends: Array<Record<string, unknown>> = [];
  const callTool = vi.fn(async () => ({ isError: false, text: ["A-1: open"], unsupportedContentTypes: [] }));
  const gateway: TelegramRunGateway = {
    ...aiqsa.gateway,
    async send(input) {
      sends.push(input.body);
      const turn = turns[sends.length - 1];
      if (!turn) return Response.json({ error: "unexpected_send" }, { status: 500 });
      if (!aiqsa.chats.has(input.chatId)) {
        aiqsa.addChat({ id: input.chatId, model: { modelId: String(input.body.modelId ?? ""), provider: String(input.body.provider ?? "") },
          userId: input.userId });
      }
      const index = sends.length;
      const runId = `native-run-${index}`;
      const answer: NativeAnswer = { artifactSummary: null, assistantMessageId: `answer-${index}`, chatId: input.chatId, errorMessage: null,
        status: "streaming", text: "", userId: input.userId };
      answers.set(runId, answer);
      const memory = memoryNativeEngine(turn.approval ? { approvalId: turn.approval.approvalId } : {});
      memory.runs.publishAnswer.mockImplementation(async (_scope, value) => { answer.text = value.text; return true; });
      memory.runs.complete.mockImplementation(async () => {
        answer.status = "complete";
        aiqsa.chats.get(input.chatId)!.activeLeafMessageId = answer.assistantMessageId;
        return true;
      });
      const { adapter } = scriptedNativeAdapter(turn.steps);
      return createNativeRunExecutionResponse({
        adapter, created: { assistantMessageId: answer.assistantMessageId, runId, userMessageId: `question-${index}` },
        engine: memory.engine, mcpRuntime: () => ({ callTool, ensureAcceptedGeneration: async () => true }) as never,
        prepared: nativePrepared({ chatId: input.chatId, mcp: NATIVE_MCP_SNAPSHOT, mcpApproval: mcpApprovalAdmission([]) }),
        repository: nativeRunRepository(turn.approval ? [turn.approval] : []) as unknown as RunRepository, services: {}, userId: input.userId
      });
    },
    async runState({ runId, userId }) {
      const answer = answers.get(runId);
      return answer && answer.userId === userId ? { status: answer.status } : null;
    },
    async answer({ runId, userId }) {
      const answer = answers.get(runId);
      if (!answer || answer.userId !== userId) return null;
      const { userId: _owner, ...published } = answer;
      return published;
    }
  };
  return { aiqsa: { ...aiqsa, gateway }, answers, callTool, sends };
}

function harness(turns: readonly NativeTurn[]) {
  const native = nativeAiqsa(turns);
  let approvals: TelegramApprovals | null = null;
  const h = createBridgeHarness({ bridge: { publish: async (event, context) => { await approvals?.listener(event, context); } },
    gateway: native.aiqsa });
  closers.push(h.close);
  const user = h.fake.inject.addUser({ firstName: "Alex" });
  h.link(user);
  const decisions: Array<Readonly<{ approvalId: string; decision: McpApprovalDecision; runId: string; userId: string }>> = [];
  // The initiator's decision as `decideMcpApproval` stores it for a settled run.
  const decisionGateway: TelegramApprovalGateway = {
    async decide(input) {
      decisions.push({ approvalId: input.approvalId, decision: input.decision, runId: input.runId, userId: input.userId });
      const card = turns.find((turn) => turn.approval?.approvalId === input.approvalId)?.approval;
      if (!card) return { kind: "not_found" };
      const { canDecide: _canDecide, ...decided } = card;
      return { card: { ...decided, state: input.decision === "deny" ? "denied" : "allowed_once" }, continuation: input.decision !== "deny",
        kind: "decided" };
    },
    card: async (input) => turns.find((turn) => turn.approval?.approvalId === input.approvalId)?.approval ?? null,
    details: async () => JSON.stringify({ summary: "Synthetic issue" })
  };
  approvals = createTelegramApprovals({ access: h.access, conversation: h.bridge.conversation, gateway: decisionGateway, sessions: h.sessions });
  for (const kind of TELEGRAM_APPROVAL_CALLBACK_KINDS) h.registry.registerCallback(kind, approvals.callbacks[kind]);
  return { ...h, approvals, decisions, native, user };
}

const richMessages = (h: ReturnType<typeof harness>) => h.fake.botMessages(h.user.id).filter((message) => message.kind === "rich");

describe("Telegram turns on the native engine", () => {
  it("streams a native run across its tool round and delivers its published answer once", async () => {
    const h = harness([{ steps: [
      { calls: [{ arguments: { key: "A-1" }, id: "c1", name: "mcp_jira_get_issue" }], text: "Checking." },
      { text: "A-1 is open." }
    ] }]);
    await h.deliver(h.fake.inject.text(h.user, "Is A-1 open?"));
    h.bridge.conversation.flush();
    await h.settle();
    expect(h.native.sends).toHaveLength(1);
    expect(h.native.callTool).toHaveBeenCalledTimes(1);
    const published = h.native.answers.get("native-run-1")!.text;
    expect(published).toBe("Checking.\n\nA-1 is open.");
    // A draft while it ran, then the rendered answer as the one final message.
    expect(h.fake.calls("sendMessageDraft").length).toBeGreaterThan(0);
    expect(richMessages(h).map((message) => message.rich_message)).toEqual([renderTelegramAnswer(published).messages[0]]);
    expect(h.runLinks.rows.get("native-run-1")).toMatchObject({ deliveryState: "delivered" });
  });

  it("shows a native approval stop's buttons, and Allow continues the same chat with the server's turn", async () => {
    const card: McpApprovalCard = { approvalId: "approval-1", canDecide: true, details: { ordinal: 0, roundIndex: 1 }, serverName: "Jira",
      source: "model", state: "pending", toolName: "create_issue" };
    const h = harness([
      { approval: card, steps: [{ calls: [{ arguments: { summary: "x" }, id: "w1", name: "mcp_jira_create_issue" }], text: "I'll create it." }] },
      { steps: [{ text: "Created A-2." }] }
    ]);
    await h.deliver(h.fake.inject.text(h.user, "Create the issue"));
    h.bridge.conversation.flush();
    await h.settle();
    await h.approvals.idle();
    // The write waits: nothing was sent, the answer so far was published and delivered, and the card asks.
    expect(h.native.callTool).not.toHaveBeenCalled();
    expect(h.native.answers.get("native-run-1")).toMatchObject({ status: "complete", text: "I'll create it." });
    const approval = h.fake.botMessages(h.user.id).find((message) => JSON.stringify(message.rich_message ?? "").includes("Jira · create_issue"));
    expect(approval).toBeTruthy();

    await h.deliver(h.fake.inject.callback(h.user, approval!.message_id, buttonData(approval, TELEGRAM_COPY.allowOnce)));
    await h.approvals.idle();
    await h.settle();
    await h.approvals.idle();
    expect(h.decisions).toEqual([{ approvalId: "approval-1", decision: "allow_once", runId: "native-run-1", userId: "user-1" }]);
    expect(h.native.sends).toHaveLength(2);
    expect(h.native.sends[1]).toMatchObject({ content: { blocks: [] }, expectedActiveLeafId: "answer-1",
      systemTurn: { approvalId: "approval-1", kind: MCP_APPROVAL_CONTINUATION_KIND } });
    expect(h.fake.botMessages(h.user.id).at(-1)).toMatchObject({ rich_message: renderTelegramAnswer("Created A-2.").messages[0] });
    expect(h.runLinks.rows.get("native-run-2")).toMatchObject({ deliveryState: "delivered" });
  });
});

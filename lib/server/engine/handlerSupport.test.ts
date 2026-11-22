// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { BROWSER_SIGN_IN_TURN_KIND } from "../../contracts/browserSignIn";
import { MCP_APPROVAL_CONTINUATION_KIND, type MessageSystemTurnKind } from "../../contracts/mcpApprovals";
import { RUN_INTERRUPTED_FAILURE } from "../../contracts/runs";
import { SUBAGENT_CALLBACK_TURN_KIND } from "../../contracts/subagents";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import { turnProvenance } from "../runs/turnProvenance";
import { SUBAGENT_MANAGEMENT_TOOL_NAMES } from "../subagents/managementTools";
import { selfServiceRunAllowedInTransaction } from "../tools/selfServiceCall";
import { SELF_SERVICE_TOOLS } from "../tools/selfServiceTools";
import { engineAdmissionRefusal, recoverUserNativeRuns, selfServiceToolsFor, type NativeEngineHandlerDeps } from "./handlerSupport";

const prepared = (extra: Record<string, unknown> = {}, request: Record<string, unknown> = {}) =>
  ({ normalizedRequest: { chatId: "chat-1", ...request }, ...extra }) as unknown as MaterializedPreparedRunData;

describe("the self-service tools' chats", () => {
  const all = [...SELF_SERVICE_TOOLS.map((tool) => tool.name), ...SUBAGENT_MANAGEMENT_TOOL_NAMES];
  // The memory note's tool needs the user's Memory frozen with changes (`memory.changes`, operator decision 2026-11-22).
  const withoutMemory = all.filter((name) => name !== "manage_memory");
  const memory = (changes: boolean) => ({ memory: { changes, offers: true, pastChats: true, version: 1 } });
  // The user's own request unless a case says otherwise (`TurnProvenance.userRequest`).
  const offered = (run: MaterializedPreparedRunData, options: Partial<Parameters<typeof selfServiceToolsFor>[1]> = {}) =>
    selfServiceToolsFor(run, { userRequest: true, ...options });

  it("are all of them in interactive personal and temporary chats", () => {
    // Personal Instructions change where every other personal setting does, and nowhere else (operator approval 2026-11-20).
    expect(all).toContain("manage_instructions");
    expect(all).toContain("manage_memory");
    expect(offered(prepared())).toEqual(withoutMemory);
    expect(offered(prepared({ initialChatMode: "TEMPORARY" }))).toEqual(withoutMemory);
    expect(offered(prepared({}, { monitoringVerdictTool: true }))).toEqual([]);
  });

  it("take the memory note's tool only where admission froze the user's Memory with changes", () => {
    expect(offered(prepared({}, memory(true)))).toEqual(all);
    expect(offered(prepared({}, memory(true)), { connectorTurn: "telegram" })).toEqual(all);
    // A task reads the note and may search, but never writes; its admission froze no changes either.
    expect(offered(prepared({}, memory(false)))).toEqual(withoutMemory);
    expect(offered(prepared({}, memory(true)), { scheduled: true })).toEqual([]);
    expect(offered(prepared({}, memory(true)), { connectorTurn: "discord" })).toEqual([]);
    expect(offered(prepared({ assistant: { id: "a" } }, memory(true)))).toEqual(["read_aiqsa_guide", "manage_skill"]);
  });

  it("are the guide and Skill saves in an Assistant chat, whose instructions its author wrote", () => {
    // A Skill save shows its changes with Undo; a replaced secret or an edited Assistant has none (operator decision 2026-10-29).
    for (const chat of [prepared({ assistant: { id: "a" } }), prepared({ chatAssistant: { id: "a" } })]) {
      expect(offered(chat)).toEqual(["read_aiqsa_guide", "manage_skill"]);
    }
  });

  it("never include a scheduled task's occurrence, which changes nothing of its owner's own", () => {
    expect(offered(prepared(), { scheduled: true })).toEqual([]);
    expect(offered(prepared(), { scheduled: false })).toEqual(withoutMemory);
  });

  it("are what the same chat takes on the web in a Telegram turn, whose bot shows each change with its buttons", () => {
    // Operator decision 2026-11-16: Telegram gets every web capability it can show.
    expect(offered(prepared(), { connectorTurn: "telegram" })).toEqual(withoutMemory);
    expect(offered(prepared({ assistant: { id: "a" } }), { connectorTurn: "telegram" })).toEqual(["read_aiqsa_guide", "manage_skill"]);
    expect(offered(prepared({}, { monitoringVerdictTool: true }), { connectorTurn: "telegram" })).toEqual([]);
  });

  it("never include a Discord turn, a service account's run with no one to confirm", () => {
    expect(offered(prepared(), { connectorTurn: "discord" })).toEqual([]);
    expect(offered(prepared({ assistant: { id: "a" } }), { connectorTurn: "discord" })).toEqual([]);
    expect(offered(prepared(), {})).toEqual(withoutMemory);
  });

  it("never include a turn that is not the user's own request, whatever chat it is in", () => {
    for (const options of [{}, { connectorTurn: "telegram" as const }]) {
      expect(selfServiceToolsFor(prepared({}, memory(true)), { ...options, userRequest: false })).toEqual([]);
      expect(selfServiceToolsFor(prepared({ assistant: { id: "a" } }), { ...options, userRequest: false })).toEqual([]);
    }
  });
});

describe("self-service by turn kind: what a turn is offered and whether its change commits", () => {
  const all = [...SELF_SERVICE_TOOLS.map((tool) => tool.name), ...SUBAGENT_MANAGEMENT_TOOL_NAMES];
  const ASSISTANT = ["read_aiqsa_guide", "manage_skill"];
  const occurrence = { occurrenceId: "occurrence-1", previousResult: null, relevantMcpServerIds: null, taskGeneration: 1,
    taskId: "task-1", taskRevision: 1 };
  type StoredMessage = Readonly<{ scheduledTaskPrompt: boolean; systemTurnKind: MessageSystemTurnKind | null }>;
  type Row = Readonly<{
    label: string;
    /** What the entry point gives preparation (`handlers.ts`). */
    input: Parameters<typeof turnProvenance>[0];
    /** The run's stored user message and scheduled task, as the commit-time fence reads them. */
    stored: StoredMessage & Readonly<{ scheduledTaskId: string | null }>;
    assistant?: true;
    connectorTurn?: "telegram";
    offered: readonly string[];
    commits: boolean;
  }>;
  const send = (extra: Readonly<Record<string, unknown>> = {}, source: Readonly<Record<string, unknown>> = {}) =>
    ({ ...extra, source: { chat: { id: "chat-1" }, kind: "send", ...source } }) as unknown as Row["input"];
  const regenerate = (message: StoredMessage) =>
    ({ source: { kind: "regenerate", source: { chat: { id: "chat-1" }, userMessage: { id: "message-1", ...message } } } }) as unknown as Row["input"];
  const own: StoredMessage = { scheduledTaskPrompt: false, systemTurnKind: null };
  const allow: StoredMessage = { scheduledTaskPrompt: false, systemTurnKind: MCP_APPROVAL_CONTINUATION_KIND };
  const wakeUp: StoredMessage = { scheduledTaskPrompt: false, systemTurnKind: SUBAGENT_CALLBACK_TURN_KIND };
  const signIn: StoredMessage = { scheduledTaskPrompt: false, systemTurnKind: BROWSER_SIGN_IN_TURN_KIND };
  const prompt: StoredMessage = { scheduledTaskPrompt: true, systemTurnKind: null };
  const ROWS: readonly Row[] = [
    { label: "the user's own send", input: send(), stored: { ...own, scheduledTaskId: null }, offered: all, commits: true },
    { label: "the continuation after the user's MCP Allow", input: send({ serverAuthoredInput: true,
      systemTurnKind: MCP_APPROVAL_CONTINUATION_KIND }), stored: { ...allow, scheduledTaskId: null }, offered: all, commits: true },
    { label: "a sub-agent wake-up", input: send({ origin: "wake_up", serverAuthoredInput: true, systemTurnKind: SUBAGENT_CALLBACK_TURN_KIND }),
      stored: { ...wakeUp, scheduledTaskId: null }, offered: [], commits: false },
    { label: "a browser sign-in request", input: send({ serverAuthoredInput: true, systemTurnKind: BROWSER_SIGN_IN_TURN_KIND }),
      stored: { ...signIn, scheduledTaskId: null }, offered: [], commits: false },
    { label: "the user's own message regenerated", input: regenerate(own), stored: { ...own, scheduledTaskId: null }, offered: all,
      commits: true },
    { label: "an Allow continuation regenerated", input: regenerate(allow), stored: { ...allow, scheduledTaskId: null }, offered: all,
      commits: true },
    { label: "a wake-up regenerated", input: regenerate(wakeUp), stored: { ...wakeUp, scheduledTaskId: null }, offered: [], commits: false },
    { label: "a sign-in request regenerated", input: regenerate(signIn), stored: { ...signIn, scheduledTaskId: null }, offered: [],
      commits: false },
    { label: "a scheduled task's occurrence", input: send({}, { scheduledOccurrence: occurrence }),
      stored: { ...prompt, scheduledTaskId: "task-1" }, offered: [], commits: false },
    { label: "a scheduled task's prompt regenerated", input: regenerate(prompt), stored: { ...prompt, scheduledTaskId: null }, offered: [],
      commits: false },
    { label: "a Telegram message", input: send({ origin: "telegram" }), stored: { ...own, scheduledTaskId: null },
      connectorTurn: "telegram", offered: all, commits: true },
    { label: "an Assistant chat's own message", input: send(), stored: { ...own, scheduledTaskId: null }, assistant: true,
      offered: ASSISTANT, commits: true },
    { label: "an Assistant chat's wake-up", input: send({ origin: "wake_up", serverAuthoredInput: true,
      systemTurnKind: SUBAGENT_CALLBACK_TURN_KIND }), stored: { ...wakeUp, scheduledTaskId: null }, assistant: true, offered: [],
      commits: false }
  ];

  it.each(ROWS)("$label", async (row) => {
    const provenance = turnProvenance(row.input);
    // Admission freezes the note's changes from the same fact (`runPreparation.ts`), and never in an Assistant chat.
    const changes = provenance.userRequest && row.assistant !== true;
    const run = prepared(row.assistant ? { assistant: { id: "a" } } : {},
      { memory: { changes, offers: true, pastChats: true, version: 1 } });
    // As `nativeRunResponse` passes them from the entry point.
    expect(selfServiceToolsFor(run, { ...(row.connectorTurn ? { connectorTurn: row.connectorTurn } : {}),
      scheduled: provenance.scheduledOccurrence !== undefined, userRequest: provenance.userRequest })).toEqual(row.offered);
    const tx = { $queryRaw: vi.fn(async () => [{ ...row.stored, status: "streaming", userStatus: "active" }]) };
    expect(await selfServiceRunAllowedInTransaction(tx as never, { runId: "run-1", userId: "user-1" })).toBe(row.commits);
  });
});

describe("what the agent engine can run", () => {
  const model = (adapterKind: string, toolCalling: boolean | undefined) => ({
    normalizedRequest: { chatId: "chat-1", modelCapabilities: { toolCalling } },
    providerAdmissionPlan: { answer: { snapshot: { model: { adapterKind } } } }
  }) as unknown as MaterializedPreparedRunData;

  it("admits every answer adapter that renders the agent's conversation, Chat Completions endpoints included", () => {
    for (const kind of ["anthropic_messages", "deepseek_responses_native", "fake", "gemini_interactions_native",
      "openai_chat_completions_compatible", "openai_responses_compatible", "openai_responses_native", "openrouter_chat_completions"]) {
      expect(engineAdmissionRefusal(model(kind, true))).toBeNull();
    }
  });

  it("refuses a model without verified tool calling, and an adapter it cannot render, with a stable code", () => {
    expect(engineAdmissionRefusal(model("fake", false))).toEqual({ code: "model_tool_calling_required", status: 409 });
    expect(engineAdmissionRefusal(model("fake", undefined))).toEqual({ code: "model_tool_calling_required", status: 409 });
    expect(engineAdmissionRefusal(model("retired_adapter", true))).toEqual({ code: "model_adapter_unsupported", status: 409 });
  });
});

describe("before a user's admission", () => {
  it("ends the user's native orphans, and a failure never blocks the message", async () => {
    const failRun = vi.fn(async () => true);
    const native = {
      engine: { runs: { complete: vi.fn(async () => true) } },
      findOrphans: vi.fn(async () => [{ answerCompletedAt: null, assistantMessageId: "answer-native", chatId: "chat-1", id: "native-run",
        normalizedRequest: {}, userId: "user-1" }])
    } as unknown as NativeEngineHandlerDeps;
    await recoverUserNativeRuns(native, { repository: { failRun } }, "user-1");
    expect(native.findOrphans).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1" }));
    expect(failRun).toHaveBeenCalledWith("native-run", "answer-native", RUN_INTERRUPTED_FAILURE, { recoveryTerminal: true });

    vi.mocked(native.findOrphans).mockRejectedValueOnce(new Error("synthetic_read_failure"));
    await expect(recoverUserNativeRuns(native, { repository: { failRun } }, "user-1")).resolves.toBeUndefined();
  });
});

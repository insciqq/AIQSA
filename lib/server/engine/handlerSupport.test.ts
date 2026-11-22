// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { RUN_INTERRUPTED_FAILURE } from "../../contracts/runs";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import { SUBAGENT_MANAGEMENT_TOOL_NAMES } from "../subagents/managementTools";
import { SELF_SERVICE_TOOLS } from "../tools/selfServiceTools";
import { engineAdmissionRefusal, recoverUserNativeRuns, selfServiceToolsFor, type NativeEngineHandlerDeps } from "./handlerSupport";

const prepared = (extra: Record<string, unknown> = {}, request: Record<string, unknown> = {}) =>
  ({ normalizedRequest: { chatId: "chat-1", ...request }, ...extra }) as unknown as MaterializedPreparedRunData;

describe("the self-service tools' chats", () => {
  const all = [...SELF_SERVICE_TOOLS.map((tool) => tool.name), ...SUBAGENT_MANAGEMENT_TOOL_NAMES];
  // The memory note's tool needs the user's Memory frozen with changes (`memory.changes`, operator decision 2026-11-22).
  const withoutMemory = all.filter((name) => name !== "manage_memory");
  const memory = (changes: boolean) => ({ memory: { changes, offers: true, pastChats: true, version: 1 } });

  it("are all of them in interactive personal and temporary chats", () => {
    // Personal Instructions change where every other personal setting does, and nowhere else (operator approval 2026-11-20).
    expect(all).toContain("manage_instructions");
    expect(all).toContain("manage_memory");
    expect(selfServiceToolsFor(prepared())).toEqual(withoutMemory);
    expect(selfServiceToolsFor(prepared({ initialChatMode: "TEMPORARY" }))).toEqual(withoutMemory);
    expect(selfServiceToolsFor(prepared({}, { monitoringVerdictTool: true }))).toEqual([]);
  });

  it("take the memory note's tool only where admission froze the user's Memory with changes", () => {
    expect(selfServiceToolsFor(prepared({}, memory(true)))).toEqual(all);
    expect(selfServiceToolsFor(prepared({}, memory(true)), { connectorTurn: "telegram" })).toEqual(all);
    // A task reads the note and may search, but never writes; its admission froze no changes either.
    expect(selfServiceToolsFor(prepared({}, memory(false)))).toEqual(withoutMemory);
    expect(selfServiceToolsFor(prepared({}, memory(true)), { scheduled: true })).toEqual([]);
    expect(selfServiceToolsFor(prepared({}, memory(true)), { connectorTurn: "discord" })).toEqual([]);
    expect(selfServiceToolsFor(prepared({ assistant: { id: "a" } }, memory(true)))).toEqual(["read_aiqsa_guide", "manage_skill"]);
  });

  it("are the guide and Skill saves in an Assistant chat, whose instructions its author wrote", () => {
    // A Skill save shows its changes with Undo; a replaced secret or an edited Assistant has none (operator decision 2026-10-29).
    for (const chat of [prepared({ assistant: { id: "a" } }), prepared({ chatAssistant: { id: "a" } })]) {
      expect(selfServiceToolsFor(chat)).toEqual(["read_aiqsa_guide", "manage_skill"]);
    }
  });

  it("never include a scheduled task's occurrence, which changes nothing of its owner's own", () => {
    expect(selfServiceToolsFor(prepared(), { scheduled: true })).toEqual([]);
    expect(selfServiceToolsFor(prepared(), { scheduled: false })).toEqual(withoutMemory);
  });

  it("are what the same chat takes on the web in a Telegram turn, whose bot shows each change with its buttons", () => {
    // Operator decision 2026-11-16: Telegram gets every web capability it can show.
    expect(selfServiceToolsFor(prepared(), { connectorTurn: "telegram" })).toEqual(withoutMemory);
    expect(selfServiceToolsFor(prepared({ assistant: { id: "a" } }), { connectorTurn: "telegram" })).toEqual(["read_aiqsa_guide", "manage_skill"]);
    expect(selfServiceToolsFor(prepared({}, { monitoringVerdictTool: true }), { connectorTurn: "telegram" })).toEqual([]);
  });

  it("never include a Discord turn, a service account's run with no one to confirm", () => {
    expect(selfServiceToolsFor(prepared(), { connectorTurn: "discord" })).toEqual([]);
    expect(selfServiceToolsFor(prepared({ assistant: { id: "a" } }), { connectorTurn: "discord" })).toEqual([]);
    expect(selfServiceToolsFor(prepared(), {})).toEqual(withoutMemory);
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

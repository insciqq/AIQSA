// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { RUN_INTERRUPTED_FAILURE } from "../../contracts/runs";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import { SELF_SERVICE_TOOLS } from "../tools/selfServiceTools";
import { engineAdmissionRefusal, recoverUserNativeRuns, selfServiceToolsFor, type NativeEngineHandlerDeps } from "./handlerSupport";

const prepared = (extra: Record<string, unknown> = {}, request: Record<string, unknown> = {}) =>
  ({ normalizedRequest: { chatId: "chat-1", ...request }, ...extra }) as unknown as MaterializedPreparedRunData;

describe("the self-service tools' chats", () => {
  const all = SELF_SERVICE_TOOLS.map((tool) => tool.name);

  it("are all of them in interactive personal and temporary chats", () => {
    expect(selfServiceToolsFor(prepared())).toEqual(all);
    expect(selfServiceToolsFor(prepared({ initialChatMode: "TEMPORARY" }))).toEqual(all);
    expect(selfServiceToolsFor(prepared({}, { monitoringVerdictTool: true }))).toEqual([]);
  });

  it("are the guide and Skill saves in an Assistant chat, whose instructions its author wrote", () => {
    // A Skill save shows its changes with Undo; a replaced secret or an edited Assistant has none (operator decision 2026-10-29).
    for (const chat of [prepared({ assistant: { id: "a" } }), prepared({ chatAssistant: { id: "a" } })]) {
      expect(selfServiceToolsFor(chat)).toEqual(["read_aiqsa_guide", "manage_skill"]);
    }
  });

  it("never include a scheduled task's occurrence, which changes nothing of its owner's own", () => {
    expect(selfServiceToolsFor(prepared(), { scheduled: true })).toEqual([]);
    expect(selfServiceToolsFor(prepared(), { scheduled: false })).toEqual(all);
  });

  it("never include a Telegram turn, whose bridge cannot show their cards", () => {
    expect(selfServiceToolsFor(prepared(), { telegram: true })).toEqual([]);
    expect(selfServiceToolsFor(prepared({ assistant: { id: "a" } }), { telegram: true })).toEqual([]);
    expect(selfServiceToolsFor(prepared(), { telegram: false })).toEqual(all);
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

// Regression (codex review): an old-core run the startup sweep could not end held its chat until a restart.
describe("before a user's admission", () => {
  it("ends the user's old-core runs and then their native orphans, and a failure of either never blocks the message", async () => {
    const order: string[] = [];
    const failRun = vi.fn(async (runId: string) => {
      order.push(runId);
      return true;
    });
    const native = {
      engine: { runs: { complete: vi.fn(async () => true) } },
      findOrphans: vi.fn(async () => [{ answerCompletedAt: null, assistantMessageId: "answer-native", chatId: "chat-1", id: "native-run",
        normalizedRequest: {}, userId: "user-1" }]),
      findRetiredRuns: vi.fn(async () => [{ assistantMessageId: "answer-old", id: "old-run", normalizedRequest: {}, userId: "user-1" }])
    } as unknown as NativeEngineHandlerDeps;
    await recoverUserNativeRuns(native, { repository: { failRun } }, "user-1");
    expect(native.findRetiredRuns).toHaveBeenCalledWith({ limit: 100, skip: [], userId: "user-1" });
    expect(failRun).toHaveBeenCalledWith("old-run", "answer-old", RUN_INTERRUPTED_FAILURE, { recoveryTerminal: true });
    expect(order).toEqual(["old-run", "native-run"]);

    vi.mocked(native.findRetiredRuns).mockRejectedValueOnce(new Error("synthetic_read_failure"));
    vi.mocked(native.findOrphans).mockRejectedValueOnce(new Error("synthetic_read_failure"));
    await expect(recoverUserNativeRuns(native, { repository: { failRun } }, "user-1")).resolves.toBeUndefined();
  });
});

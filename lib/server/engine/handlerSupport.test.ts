// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { RUN_INTERRUPTED_FAILURE } from "../../contracts/runs";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import { engineAdmissionRefusal, recoverUserNativeRuns, selfServiceChat, type NativeEngineHandlerDeps } from "./handlerSupport";

const prepared = (extra: Record<string, unknown> = {}, request: Record<string, unknown> = {}) =>
  ({ normalizedRequest: { chatId: "chat-1", ...request }, ...extra }) as unknown as MaterializedPreparedRunData;

describe("the self-service tools' chats", () => {
  it("are interactive personal and temporary chats only", () => {
    expect(selfServiceChat(prepared())).toBe(true);
    expect(selfServiceChat(prepared({ initialChatMode: "TEMPORARY" }))).toBe(true);
    for (const other of [prepared({ assistant: { id: "a" } }), prepared({ chatAssistant: { id: "a" } }),
      prepared({}, { monitoringVerdictTool: true })]) {
      expect(selfServiceChat(other)).toBe(false);
    }
  });

  it("never include a scheduled task's occurrence, which changes nothing of its owner's own", () => {
    expect(selfServiceChat(prepared(), { scheduled: true })).toBe(false);
    expect(selfServiceChat(prepared(), { scheduled: false })).toBe(true);
  });

  it("never include a Telegram turn, whose bridge cannot show their cards", () => {
    expect(selfServiceChat(prepared(), { telegram: true })).toBe(false);
    expect(selfServiceChat(prepared(), { telegram: false })).toBe(true);
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

// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import { engineAdmissionRefusal, selfServiceChat } from "./handlerSupport";

const prepared = (extra: Record<string, unknown> = {}, request: Record<string, unknown> = {}) =>
  ({ normalizedRequest: { chatId: "chat-1", ...request }, ...extra }) as unknown as MaterializedPreparedRunData;

describe("the self-service tools' chats", () => {
  it("are interactive personal and temporary chats only", () => {
    expect(selfServiceChat(prepared())).toBe(true);
    expect(selfServiceChat(prepared({ initialChatMode: "TEMPORARY" }))).toBe(true);
    for (const other of [prepared({ assistant: { id: "a" } }), prepared({ chatAssistant: { id: "a" } }),
      prepared({}, { answerReviewStep: {} }), prepared({}, { monitoringVerdictTool: true })]) {
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

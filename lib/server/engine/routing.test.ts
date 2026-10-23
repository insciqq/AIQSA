import { describe, expect, it } from "vitest";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import { nativeEngineAllowsUser, nativeEngineRoute, parseNativeEngineUsers } from "./routing";

const user = { email: "Pilot@Example.test", id: "user-1" };

function prepared(overrides: Record<string, unknown> = {}, request: Record<string, unknown> = {}, adapterKind = "openai_responses_compatible") {
  return {
    normalizedRequest: { knowledgePlan: { mode: "none" }, modelCapabilities: { toolCalling: true }, ...request },
    providerAdmissionPlan: { answer: { snapshot: { model: { adapterKind } } } },
    ...overrides
  } as unknown as MaterializedPreparedRunData;
}

const route = (input: Partial<Parameters<typeof nativeEngineRoute>[0]> = {}) => nativeEngineRoute({
  allowlist: parseNativeEngineUsers("user-1"), answerReview: false, prepared: prepared(), scheduled: false, user,
  workspacePredecessor: false, ...input
});

describe("native engine routing", () => {
  it("lists users by id or email, everyone with *, nobody when unset", () => {
    expect(nativeEngineAllowsUser(parseNativeEngineUsers("user-1"), user)).toBe(true);
    expect(nativeEngineAllowsUser(parseNativeEngineUsers(" pilot@example.test ,other"), user)).toBe(true);
    expect(nativeEngineAllowsUser(parseNativeEngineUsers("*"), { email: null, id: "anyone" })).toBe(true);
    expect(nativeEngineAllowsUser(parseNativeEngineUsers(undefined), user)).toBe(false);
    expect(nativeEngineAllowsUser(parseNativeEngineUsers(""), user)).toBe(false);
    expect(nativeEngineAllowsUser(parseNativeEngineUsers("user-2,other@example.test"), user)).toBe(false);
  });

  it("runs a listed user's personal chat natively", () => {
    expect(route()).toEqual({ engine: "native" });
    expect(route({ prepared: prepared({}, {}, "fake") })).toEqual({ engine: "native" });
  });

  it("keeps everything outside the pilot's scope on the old core", () => {
    expect(route({ allowlist: parseNativeEngineUsers("") })).toEqual({ engine: "v1", reason: "not_listed" });
    expect(route({ scheduled: true })).toMatchObject({ reason: "scheduled" });
    expect(route({ answerReview: true })).toMatchObject({ reason: "answer_review" });
    expect(route({ prepared: prepared({ assistant: {} }) })).toMatchObject({ reason: "assistant_chat" });
    expect(route({ prepared: prepared({ chatAssistant: {} }) })).toMatchObject({ reason: "assistant_chat" });
    expect(route({ prepared: prepared({ project: {} }) })).toMatchObject({ reason: "project_chat" });
    expect(route({ prepared: prepared({}, { agent: {} }) })).toMatchObject({ reason: "agent_turn" });
    expect(route({ prepared: prepared({}, { knowledgePlan: { mode: "auto" } }) })).toMatchObject({ reason: "knowledge" });
    expect(route({ prepared: prepared({}, {}, "openai_chat_completions_compatible") })).toMatchObject({ reason: "adapter_without_history" });
    expect(route({ prepared: prepared({}, {}, "anthropic_messages") })).toMatchObject({ reason: "adapter_without_history" });
    expect(route({ prepared: prepared({}, { modelCapabilities: {} }) })).toMatchObject({ reason: "tool_calling_unverified" });
    expect(route({ prepared: prepared({ chatPdfAdmissions: [{ route: "prepared_text" }] }) })).toMatchObject({ reason: "deferred_preparation" });
    expect(route({ prepared: prepared({ chatPdfAdmissions: [{ route: "direct_pdf" }] }) })).toEqual({ engine: "native" });
    expect(route({ workspacePredecessor: true })).toMatchObject({ reason: "workspace_predecessor" });
  });
});

import { describe, expect, it } from "vitest";
import { captureRunObservation } from "@/tests/support/runObservation";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import {
  logNativeEngineAllowlist, nativeEngineAllowlistMode, nativeEngineAllowsUser, nativeEngineRoute, parseNativeEngineUsers
} from "./routing";

const user = { email: "Pilot@Example.test", id: "user-1" };

function prepared(overrides: Record<string, unknown> = {}, request: Record<string, unknown> = {}, adapterKind = "openai_responses_compatible") {
  return {
    normalizedRequest: { modelCapabilities: { toolCalling: true }, ...request },
    providerAdmissionPlan: { answer: { snapshot: { model: { adapterKind } } } },
    ...overrides
  } as unknown as MaterializedPreparedRunData;
}

const route = (input: Partial<Parameters<typeof nativeEngineRoute>[0]> = {}) => nativeEngineRoute({
  allowlist: parseNativeEngineUsers("user-1"), prepared: prepared(), user, ...input
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

  it("names the allowlist's mode and size for the startup line, never an entry", () => {
    expect(nativeEngineAllowlistMode(parseNativeEngineUsers(undefined))).toEqual({ count: 0, mode: "none" });
    expect(nativeEngineAllowlistMode(parseNativeEngineUsers(" , "))).toEqual({ count: 0, mode: "none" });
    expect(nativeEngineAllowlistMode(parseNativeEngineUsers("user-1, Pilot@Example.test,pilot@example.test"))).toEqual({ count: 2, mode: "list" });
    expect(nativeEngineAllowlistMode(parseNativeEngineUsers("*"))).toEqual({ count: 0, mode: "all" });
    expect(nativeEngineAllowlistMode(parseNativeEngineUsers("user-1,*"))).toEqual({ count: 1, mode: "all" });
  });

  it("logs the mode at startup as a content-free line", async () => {
    const observed = await captureRunObservation();
    logNativeEngineAllowlist({ AIQSA_NATIVE_ENGINE_USERS: "user-1, Pilot@Example.test" });
    logNativeEngineAllowlist({ AIQSA_NATIVE_ENGINE_USERS: "*" });
    logNativeEngineAllowlist({});
    const lines = observed.records().filter((record) => String(record.code ?? "").startsWith("native_engine_users_"));
    expect(lines.map((record) => [record.code, record.count])).toEqual([
      ["native_engine_users_list", 2], ["native_engine_users_all", 0], ["native_engine_users_none", 0]
    ]);
    expect(lines[0]).toMatchObject({ event: "runtime_lifecycle", level: "info", outcome: "completed", stage: "startup",
      subsystem: "configuration" });
    expect(JSON.stringify(observed.records())).not.toMatch(/user-1|pilot@example/iu);
  });

  it("runs a listed user's personal chat natively", () => {
    expect(route()).toEqual({ engine: "native" });
    expect(route({ prepared: prepared({}, {}, "fake") })).toEqual({ engine: "native" });
    // Native Anthropic renders the neutral history too (operator decision 2026-10-23).
    expect(route({ prepared: prepared({}, {}, "anthropic_messages") })).toEqual({ engine: "native" });
  });

  it("runs a listed user's Assistant chats, scheduled occurrences, Telegram turns and review steps natively", () => {
    // An Assistant's fixed rows are frozen in the prepared run; the engine is the same.
    expect(route({ prepared: prepared({ assistant: {} }) })).toEqual({ engine: "native" });
    expect(route({ prepared: prepared({ chatAssistant: {} }) })).toEqual({ engine: "native" });
    // A monitoring check and an answer review step report through their reserved tool.
    expect(route({ prepared: prepared({}, { monitoringVerdictTool: true }) })).toEqual({ engine: "native" });
    expect(route({ prepared: prepared({}, { answerReviewStep: { kind: "review" } }) })).toEqual({ engine: "native" });
    // Routing reads the run, never who admitted it: the owner of a scheduled task or a Telegram link is the user.
    expect(route({ allowlist: parseNativeEngineUsers("pilot@example.test") })).toEqual({ engine: "native" });
    expect(route({ allowlist: parseNativeEngineUsers("someone-else") })).toEqual({ engine: "v1", reason: "not_listed" });
  });

  it("keeps everything the native engine cannot run on the old core", () => {
    expect(route({ allowlist: parseNativeEngineUsers("") })).toEqual({ engine: "v1", reason: "not_listed" });
    expect(route({ prepared: prepared({}, {}, "openai_chat_completions_compatible") })).toMatchObject({ reason: "adapter_without_history" });
    expect(route({ prepared: prepared({}, { modelCapabilities: {} }) })).toMatchObject({ reason: "tool_calling_unverified" });
    expect(route({ prepared: prepared({ chatPdfAdmissions: [{ route: "prepared_text" }] }) })).toMatchObject({ reason: "deferred_preparation" });
    expect(route({ prepared: prepared({ chatPdfAdmissions: [{ route: "direct_pdf" }] }) })).toEqual({ engine: "native" });
  });
});

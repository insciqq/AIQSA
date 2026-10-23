// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { secretChangedResult } from "./manageSecret";
import { createToolCallSelfServiceStore } from "./selfServiceCallStore";

const input = { callId: "call_row_1", runId: "run_1", toolName: "manage_secret", userId: "user_1" };
const done = { action: "created" as const, previous: null, valueReplaced: false, secret: { description: "", envNames: [],
  id: "10000000-0000-4000-8000-000000000001", kind: "text" as const, name: "GitLab", versionId: "20000000-0000-4000-8000-000000000001" } };
const result = secretChangedResult({ id: "provider_call_1", name: "manage_secret" }, done);
const allowedRun = { scheduledTaskId: null, scheduledTaskPrompt: false, status: "streaming", userStatus: "active" };

function transaction(options: Readonly<{ run?: unknown; call?: unknown; settled?: number }> = {}) {
  const queries: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray | { strings?: readonly string[] }) => {
      const text = Array.isArray(strings) ? strings.join("?") : (strings as { strings: readonly string[] }).strings.join("?");
      queries.push(text);
      if (text.includes("SELECT r.\"chatId\"")) return [{ chatId: "chat_1", userId: "user_1" }];
      if (text.includes("r.\"scheduledTaskId\", m.\"scheduledTaskPrompt\"")) return options.run === undefined ? [allowedRun] : options.run;
      return [];
    }),
    modelRun: {},
    modelRunEvent: { aggregate: vi.fn(async () => ({ _max: { sequence: 7 } })), createMany: vi.fn(async () => ({ count: 1 })),
      findFirst: vi.fn(async () => null) },
    modelRunToolCall: {
      findFirst: vi.fn(async () => options.call === undefined ? { providerCallId: "provider_call_1", result: null, state: "running", toolName: "manage_secret" }
        : options.call),
      updateMany: vi.fn(async () => ({ count: options.settled ?? 1 }))
    }
  };
  return { queries, tx };
}

describe("the ModelRunToolCall call store of a self-service change", () => {
  it("claims a running call under the run's settlement locks", async () => {
    const { queries, tx } = transaction();
    expect(await createToolCallSelfServiceStore(input).claim(tx as never)).toEqual({ kind: "open" });
    // Owner, then chat, then the run: the order every settlement writer takes.
    expect(queries.findIndex((text) => text.includes("FROM \"User\""))).toBeLessThan(queries.findIndex((text) => text.includes("FROM \"Chat\" WHERE")));
    expect(queries.at(-1)).toContain("FOR UPDATE OF r");
    expect(tx.modelRunToolCall.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "call_row_1", modelRunId: "run_1" } }));
  });

  it("returns a settled call's own result and refuses a call that is not this tool's or no longer running", async () => {
    const settledResult = { callId: "provider_call_1", content: [{ type: "text", text: "done" }], name: "manage_secret", status: "complete" };
    const settled = transaction({ call: { providerCallId: "provider_call_1", result: settledResult, state: "complete", toolName: "manage_secret" } });
    expect(await createToolCallSelfServiceStore(input).claim(settled.tx as never)).toEqual({ kind: "settled", result: settledResult });
    for (const call of [null, { providerCallId: "p", result: null, state: "running", toolName: "save_skill" },
      { providerCallId: "p", result: null, state: "cancelled", toolName: "manage_secret" }]) {
      expect(await createToolCallSelfServiceStore(input).claim(transaction({ call }).tx as never)).toEqual({ kind: "unavailable" });
    }
    const finished = transaction({ run: [{ ...allowedRun, status: "complete" }] });
    expect(await createToolCallSelfServiceStore(input).claim(finished.tx as never)).toEqual({ kind: "unavailable" });
    expect(finished.tx.modelRunToolCall.findFirst).not.toHaveBeenCalled();
  });

  it("settles the running call with the result and appends its card in the same transaction", async () => {
    const { tx } = transaction();
    await createToolCallSelfServiceStore(input).settle(tx as never, result);
    expect(tx.modelRunToolCall.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ state: "complete" }), where: { id: "call_row_1", modelRunId: "run_1", state: "running" } }));
    expect(tx.modelRunEvent.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ eventType: "artifact", modelRunId: "run_1",
      payload: { artifactType: "resource_change", payload: expect.objectContaining({ action: "created", name: "GitLab" }) }, sequence: 8 })] });
    // The engine publishes the same result's card again later; the answer keeps the first.
    expect(tx.modelRunEvent.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { eventType: "artifact", modelRunId: "run_1",
      payload: { equals: { artifactType: "resource_change", payload: expect.objectContaining({ action: "created", name: "GitLab" }) } } } }));
  });

  it("refuses to settle a call another writer settled, so the change rolls back", async () => {
    const { tx } = transaction({ settled: 0 });
    await expect(createToolCallSelfServiceStore(input).settle(tx as never, result)).rejects.toThrow("self_service_call_settle_conflict");
    await expect(createToolCallSelfServiceStore(input).settle(transaction().tx as never, { ...result, status: "error" }))
      .rejects.toThrow("self_service_call_result_invalid");
  });
});

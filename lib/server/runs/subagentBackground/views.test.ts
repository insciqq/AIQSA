import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeSubagentSummaryResponse } from "../../../contracts/subagentViews";
import { createSubagentViews } from "./views";

vi.mock("../../toolObservations/repository", () => ({
  branchPathMessageIds: vi.fn(async () => new Set(["answer-1"]))
}));

const at = new Date("2026-10-30T10:00:00.000Z");

function turn(id: string, state: string, overrides: Record<string, unknown> = {}) {
  return {
    endedAt: state === "running" || state === "waiting" ? null : at, executionRun: { id: `run-${id}`, status: "streaming" }, id, mode: "background",
    modelId: "gpt-raw-id", outcome: state === "done" ? "done" : null, parentRun: { assistantMessageId: "answer-1", status: "complete" },
    parentRunId: "parent-1", parentToolCallId: `call-${id}`, providerModelId: "provider-model-1", reasonCode: null, reasoningEffort: "high",
    result: null, startedAt: at, state, updatedAt: at, ...overrides
  };
}

const thread = (id: string, turns: readonly unknown[]) => ({
  anchorRun: { assistantMessageId: "answer-1" }, createdAt: at, id, name: id, turns, typeName: null, updatedAt: at
});

const runningCall = (turnId: string, overrides: Record<string, unknown> = {}) => ({
  arguments: { query: "private query" }, completedAt: null, id: `tool-${turnId}`, ordinal: 0, providerCallId: `provider-${turnId}`, result: null,
  roundIndex: 1, startedAt: at, state: "running", subagentTurnId: turnId, toolName: "web_search", ...overrides
});

function fakeClient(input: Readonly<{ calls?: readonly unknown[]; threads: readonly unknown[] }>) {
  const tx = {
    chat: { findFirst: vi.fn(async () => ({ activeLeafMessageId: "answer-1" })) },
    modelRun: { findMany: vi.fn(async () => [{ id: "parent-1", normalizedRequest: {} }]) },
    modelRunToolCall: { findMany: vi.fn(async () => input.calls ?? []) },
    providerModel: { findMany: vi.fn(async () => [{ displayName: "GPT-6 Luna", id: "provider-model-1" }]) },
    subagentThread: { findMany: vi.fn(async () => input.threads) }
  };
  const client = {
    $transaction: vi.fn(async (body: (value: typeof tx) => Promise<unknown>) => body(tx)),
    chat: { findMany: vi.fn(async () => [{ id: "chat-1" }, { id: "chat-2" }]) }
  };
  return { client: client as unknown as PrismaClient, tx };
}

describe("the summary's model and current step", () => {
  beforeEach(() => vi.clearAllMocks());

  it("gives an active thread the identity of its latest running call and its turn's model, valid for the decoder", async () => {
    const { client, tx } = fakeClient({
      calls: [runningCall("turn-a", { id: "tool-new", ordinal: 1, toolName: "web_search" }), runningCall("turn-a", { toolName: "old_tool" })],
      threads: [thread("alpha", [turn("turn-a", "running")])]
    });
    const chat = await createSubagentViews(client).chatThreads({ chatId: "chat-1", userId: "user-1" });
    expect(chat!.threads[0]).toMatchObject({ model: { displayName: "GPT-6 Luna", effort: "high" } });
    const step = chat!.threads[0]!.currentStep;
    expect(step).toMatchObject({ toolName: "web_search" });
    // The identity only: never the call's arguments or result, even as a value in the projection.
    expect(JSON.stringify(step)).not.toContain("private query");
    expect(decodeSubagentSummaryResponse({ chats: [chat] })).not.toBeNull();
    const where = tx.modelRunToolCall.findMany.mock.calls[0] as unknown as [{ take: number; where: unknown }];
    expect(where[0].take).toBeLessThanOrEqual(160);
    expect(where[0].where).toMatchObject({ modelRunId: { in: ["run-turn-a"] }, subagentTurnId: { in: ["turn-a"] } });
  });

  it("reads a foreground turn's calls on its parent run", async () => {
    const { client, tx } = fakeClient({ calls: [runningCall("turn-f")],
      threads: [thread("zeta", [turn("turn-f", "running", { executionRun: null, mode: "foreground", parentRun: { assistantMessageId: "answer-1", status: "streaming" } })])] });
    const chat = await createSubagentViews(client).chatThreads({ chatId: "chat-1", userId: "user-1" });
    expect(chat!.threads[0]!.currentStep).toMatchObject({ toolName: "web_search" });
    expect(tx.modelRunToolCall.findMany.mock.calls[0]).toMatchObject([{ where: { modelRunId: { in: ["parent-1"] } } }]);
  });

  it("leaves the step unknown without a running call, and never reads the request for it", async () => {
    const { client, tx } = fakeClient({ threads: [thread("alpha", [turn("turn-a", "running")])] });
    const chat = await createSubagentViews(client).chatThreads({ chatId: "chat-1", userId: "user-1" });
    expect(chat!.threads[0]!.currentStep).toBeNull();
    expect(tx.modelRun.findMany).not.toHaveBeenCalled();
  });

  it("leaves the step unknown for a call whose run already ended", async () => {
    const { client } = fakeClient({ calls: [runningCall("turn-a")],
      threads: [thread("alpha", [turn("turn-a", "running", { executionRun: { id: "run-turn-a", status: "cancelled" } })])] });
    const chat = await createSubagentViews(client).chatThreads({ chatId: "chat-1", userId: "user-1" });
    expect(chat!.threads[0]!.currentStep).toBeNull();
  });

  it("costs an idle chat no step query, keeps the model that ran and falls back to its id for a deleted one", async () => {
    const { client, tx } = fakeClient({ threads: [thread("alpha", [turn("turn-a", "done")]),
      thread("beta", [turn("turn-b", "failed", { providerModelId: "gone", reasoningEffort: null })])] });
    tx.providerModel.findMany.mockResolvedValue([{ displayName: "GPT-6 Luna", id: "provider-model-1" }]);
    const chat = await createSubagentViews(client).chatThreads({ chatId: "chat-1", userId: "user-1" });
    expect(tx.modelRunToolCall.findMany).not.toHaveBeenCalled();
    expect(chat!.threads.map((row) => row.model)).toEqual([{ displayName: "GPT-6 Luna", effort: "high" }, { displayName: "gpt-raw-id", effort: null }]);
    expect(chat!.threads.map((row) => row.currentStep)).toEqual([null, null]);
  });

  it("looks a model's name up once across the chats of one summary", async () => {
    const { client, tx } = fakeClient({ threads: [thread("alpha", [turn("turn-a", "done")])] });
    const { chats } = await createSubagentViews(client).summary({ chatIds: ["chat-1", "chat-2"], userId: "user-1" });
    expect(chats).toHaveLength(2);
    expect(tx.providerModel.findMany).toHaveBeenCalledTimes(1);
  });
});

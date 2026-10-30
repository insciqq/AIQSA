import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createSubagentWakeUpAdmitter, wakeUpOutcomeOf, wakeUpSendBody, type SubagentWakeUpSend } from "./wakeUp";

const request = {
  mcp: { servers: [], tools: [], version: 1 }, mcpDiscovery: { catalog: { servers: [] } }, params: { reasoningEffort: "high" },
  prompt: { baseline: { source: "standard_chat", timeZone: "Europe/Moscow", timeZoneSource: "client" } },
  searchPlan: { mode: "all_selected", options: [{ optionId: "web" }] },
  skills: { available: [], mode: "off", pinned: [{ alias: "a", name: "Report", revisionId: "r1", skillId: "skill-1" }], version: 2 },
  workspace: { enabled: true }
};

describe("sub-agent wake-up turn", () => {
  it("sends what the branch's latest main-agent turn chose, as the composer would", () => {
    const body = wakeUpSendBody({ activeLeafMessageId: "leaf", answerBinding: { connectionId: "conn", providerModelId: "model" },
      assistantChat: false, normalizedRequest: request });
    expect(body).toMatchObject({ expectedActiveLeafId: "leaf", mcp: { mode: "auto" }, modelId: "model", params: { reasoningEffort: "high" },
      provider: "conn", searchPlan: { mode: "all_selected", optionIds: ["web"] }, skills: { mode: "off" }, timeZone: "Europe/Moscow",
      workspace: { enabled: true } });
    expect(body).not.toHaveProperty("systemTurn");
    expect(body).toMatchObject({ skillIds: ["skill-1"] });
    // Load all and Off travel as chosen, never as Auto.
    const { mcpDiscovery: _discovery, ...loadAll } = request;
    expect(wakeUpSendBody({ activeLeafMessageId: "leaf", answerBinding: null, assistantChat: false, normalizedRequest: loadAll }))
      .toMatchObject({ mcp: { mode: "load_all" } });
    const { mcp: _mcp, ...off } = loadAll;
    expect(wakeUpSendBody({ activeLeafMessageId: "leaf", answerBinding: null, assistantChat: false, normalizedRequest: off }))
      .toMatchObject({ mcp: { mode: "off" } });
    // An Assistant governs its own model, tools and Search: only the chat's own choices travel.
    expect(Object.keys(wakeUpSendBody({ activeLeafMessageId: "leaf", answerBinding: null, assistantChat: true,
      normalizedRequest: request })).sort()).toEqual(["admissionId", "content", "expectedActiveLeafId", "timeZone", "workspace"]);
  });

  it("reads usage limits, a user's answer that started first and a lost claim from the refusal", () => {
    expect(wakeUpOutcomeOf(429, "usage_budget_exhausted")).toBe("usage_limited");
    expect(wakeUpOutcomeOf(409, "active_run_in_progress")).toBe("busy");
    expect(wakeUpOutcomeOf(409, "active_leaf_changed")).toBe("stale");
    expect(wakeUpOutcomeOf(409, "subagent_callback_claimed")).toBe("stale");
    expect(wakeUpOutcomeOf(404, "chat_not_found")).toBe("failed");
  });

  it("admits through the send handler as the active owner, with the callbacks it claims", async () => {
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: "leaf" }, { id: "answer-1" }]),
      chat: { findFirst: vi.fn(async () => ({ activeLeafMessageId: "leaf", assistantId: null })) },
      modelRun: { findFirst: vi.fn(async () => ({ normalizedRequest: request,
        providerRunBindings: [{ connectionId: "conn", providerModelId: "model" }] })) }
    };
    const user = { findFirst: vi.fn(async () => ({ displayName: "Owner", email: null, id: "user-1", role: "user", status: "active" })) };
    const client = { $transaction: async (work: (client: unknown) => unknown) => work(tx), chat: tx.chat, modelRun: tx.modelRun, user };
    const send = vi.fn<SubagentWakeUpSend>(async (input) => {
      expect(await input.resolveAuth(new Request("http://localhost"))).toMatchObject({ userId: "user-1" });
      return new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } });
    });
    const admit = createSubagentWakeUpAdmitter({ client: client as unknown as PrismaClient, send });
    expect(await admit({ chatId: "chat-1", text: "callbacks", turnIds: ["t1", "t2"], userId: "user-1" })).toBe("admitted");
    expect(send.mock.calls[0]![0]).toMatchObject({ chatId: "chat-1", wakeUp: { text: "callbacks", turnIds: ["t1", "t2"] } });
    expect(user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "user-1", scimDeactivatedAt: null, status: "active" } }));
    send.mockResolvedValueOnce(Response.json({ error: "usage_budget_exhausted" }, { status: 429 }));
    expect(await admit({ chatId: "chat-1", text: "callbacks", turnIds: ["t1"], userId: "user-1" })).toBe("usage_limited");
    tx.chat.findFirst.mockResolvedValueOnce(null as never);
    expect(await admit({ chatId: "chat-1", text: "callbacks", turnIds: ["t1"], userId: "user-1" })).toBe("failed");
  });
});

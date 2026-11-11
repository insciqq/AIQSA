// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDefaultConnectorRunGateway } from "./defaultRunGateway";

const sendDeps = vi.hoisted(() => vi.fn());
const findOwnedChat = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/server/mcp/defaultRuntime", () => ({ kickDefaultMcpRuntime: vi.fn() }));
vi.mock("@/lib/server/runs/defaultSendMessageDeps", () => ({ createDefaultSendMessageDeps: () => ({ repository: { findOwnedChat } }) }));
vi.mock("@/lib/server/runs/handlers", () => ({
  createGetModelRunHandler: vi.fn(),
  createSendMessageHandler: (deps: unknown) => {
    sendDeps(deps);
    return async () => new Response(null, { status: 202 });
  },
  stopModelRun: vi.fn()
}));

describe("the default connector run gateway", () => {
  it("sends as the connector's turn, through the connector's own resolver for that user", async () => {
    const resolver = vi.fn(async () => null);
    const auth = vi.fn(() => resolver);
    const gateway = createDefaultConnectorRunGateway({ auth, connectorTurn: "discord" });
    const response = await gateway.send({ body: { text: "Hi" }, chatId: "chat-1", userId: "service-1" });
    expect(response.status).toBe(202);
    expect(auth).toHaveBeenCalledWith("service-1");
    expect(sendDeps).toHaveBeenCalledWith(expect.objectContaining({ connectorTurn: "discord", resolveAuth: resolver }));
  });

  it("reads the user's own chat with its Memory mode, so the connector decides which it may continue", async () => {
    const gateway = createDefaultConnectorRunGateway({ auth: () => async () => null, connectorTurn: "discord" });
    findOwnedChat.mockResolvedValueOnce({ activeLeafMessageId: "leaf", defaultModelId: "model", defaultProvider: "provider", id: "chat-1",
      memoryMode: "EXCLUDED", messageCount: 2, projectMemory: null, title: "Thread" });
    await expect(gateway.chat("service-1", "chat-1")).resolves.toEqual({ activeLeafMessageId: "leaf", assistantId: null, id: "chat-1",
      memoryMode: "EXCLUDED", model: { modelId: "model", provider: "provider" }, title: "Thread" });
    expect(findOwnedChat).toHaveBeenCalledWith("chat-1", "service-1");
    // A chat stored without a mode is an ordinary one.
    findOwnedChat.mockResolvedValueOnce({ activeLeafMessageId: null, assistantId: "assistant-1", defaultModelId: "", defaultProvider: "",
      id: "chat-2", messageCount: 0, projectMemory: null, title: "New Chat" });
    await expect(gateway.chat("service-1", "chat-2")).resolves.toMatchObject({ assistantId: "assistant-1", memoryMode: "NORMAL" });
    findOwnedChat.mockResolvedValueOnce(null);
    await expect(gateway.chat("service-1", "chat-3")).resolves.toBeNull();
  });
});

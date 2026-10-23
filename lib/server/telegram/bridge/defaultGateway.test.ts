// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDefaultTelegramRunGateway } from "./defaultGateway";

const sendDeps = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/server/mcp/defaultRuntime", () => ({ kickDefaultMcpRuntime: vi.fn() }));
vi.mock("@/lib/server/runs/defaultSendMessageDeps", () => ({ createDefaultSendMessageDeps: () => ({}) }));
vi.mock("@/lib/server/runs/handlers", () => ({
  createGetModelRunHandler: vi.fn(),
  createSendMessageHandler: (deps: unknown) => {
    sendDeps(deps);
    return async () => new Response(null, { status: 202 });
  },
  stopModelRun: vi.fn()
}));

describe("the default Telegram gateway", () => {
  it("sends a Telegram message as a Telegram turn, whose native run takes no self-service tools", async () => {
    const gateway = createDefaultTelegramRunGateway({ access: { resolveTelegramAccess: vi.fn() } });
    const response = await gateway.send({ body: { text: "Hi" }, chatId: "chat-1", userId: "user-1" });
    expect(response.status).toBe(202);
    expect(sendDeps).toHaveBeenCalledWith(expect.objectContaining({ telegramTurn: true }));
  });
});

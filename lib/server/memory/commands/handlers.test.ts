import { describe, expect, it, vi } from "vitest";
import { createGetChatMemoryCommandsHandler } from "./handlers";

function fixture(authenticated = true) {
  const list = vi.fn().mockResolvedValue({ commands: [] });
  const handler = createGetChatMemoryCommandsHandler({
    list, resolveAuth: vi.fn().mockResolvedValue(authenticated ? { userId: "owner" } : null)
  });
  return { handler, list };
}
const request = (suffix = "") => new Request(`http://test/api/me/chats/chat/memory-commands${suffix}`);
const context = { params: Promise.resolve({ chatId: "chat" }) };

describe("Memory command status handler", () => {
  it("requires authentication before reading command status", async () => {
    const f = fixture(false);
    const response = await f.handler(request(), context);
    expect(response.status).toBe(401);
    expect(f.list).not.toHaveBeenCalled();
  });

  it("binds status reads to the authenticated owner and disables caching", async () => {
    const f = fixture();
    const response = await f.handler(request(), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(f.list).toHaveBeenCalledWith({ chatId: "chat", userId: "owner" });
  });

  it("does not expose repository or provider failures", async () => {
    const f = fixture();
    f.list.mockRejectedValue(new Error("private-provider-secret"));
    const response = await f.handler(request(), context);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-provider-secret");
  });

  it("rejects unknown inputs and presents missing access neutrally", async () => {
    const f = fixture();
    expect((await f.handler(request("?userId=other"), context)).status).toBe(400);
    expect(f.list).not.toHaveBeenCalled();
    f.list.mockResolvedValue(null);
    expect((await f.handler(request(), context)).status).toBe(404);
  });
});

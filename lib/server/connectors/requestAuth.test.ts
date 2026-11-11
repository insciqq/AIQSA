// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { connectorRequestAuth } from "./requestAuth";

const findUnique = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server/prisma", () => ({ prisma: { user: { findUnique } } }));

describe("a connector's request resolver", () => {
  const user = { displayName: "Discord", email: null, id: "service-1", role: "user", status: "active" };
  const request = new Request("http://localhost/api/chats/chat-1/messages");

  it("presents the active user under the connector's session while its access holds, re-read on every call", async () => {
    findUnique.mockResolvedValue(user);
    const allowed = vi.fn(async () => true);
    const resolve = connectorRequestAuth({ allowed, sessionId: "discord", userId: "service-1" });
    await expect(resolve(request)).resolves.toMatchObject({ id: "discord", user, userId: "service-1" });
    await resolve(request);
    expect(allowed).toHaveBeenCalledTimes(2);
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "service-1" } }));
  });

  it("presents nobody once the connector no longer serves the user, or the account is inactive or gone", async () => {
    findUnique.mockResolvedValue(user);
    await expect(connectorRequestAuth({ allowed: async () => false, sessionId: "discord", userId: "service-1" })(request)).resolves.toBeNull();
    findUnique.mockResolvedValue({ ...user, status: "disabled" });
    await expect(connectorRequestAuth({ allowed: async () => true, sessionId: "discord", userId: "service-1" })(request)).resolves.toBeNull();
    findUnique.mockResolvedValue(null);
    await expect(connectorRequestAuth({ allowed: async () => true, sessionId: "discord", userId: "service-1" })(request)).resolves.toBeNull();
  });
});

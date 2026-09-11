import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceSecretHandlers } from "./handlers";
import { WorkspaceSecretError } from "./validation";

function setup() {
  const userId = randomUUID();
  const summary = { id: randomUUID(), versionId: randomUUID(), kind: "text" as const, name: "Synthetic", description: "",
    byteSize: 40, updatedAt: new Date().toISOString(), envNames: [], originalName: null, sshProtected: false };
  const store = { list: vi.fn().mockResolvedValue([summary]), mutate: vi.fn() };
  const resolveAuth = vi.fn().mockResolvedValue({ userId, user: { id: userId, status: "active" } });
  return { userId, summary, store, resolveAuth, handlers: createWorkspaceSecretHandlers({ resolveAuth, store }) };
}

describe("personal Workspace secrets API", () => {
  it("authenticates before consuming a body and does not accept an owner supplied by the browser", async () => {
    const fixture = setup();
    fixture.resolveAuth.mockResolvedValueOnce(null);
    const unauthorized = new Request("http://localhost/api/me/workspace/secrets", { method: "POST", body: "not JSON" });
    expect((await fixture.handlers.POST(unauthorized)).status).toBe(401);
    expect(unauthorized.bodyUsed).toBe(false);
    expect(fixture.store.mutate).not.toHaveBeenCalled();
    const response = await fixture.handlers.POST(new Request(unauthorized.url, { method: "POST", body: JSON.stringify({
      action: "create", userId: randomUUID(), name: "Synthetic", description: "", value: { kind: "text", text: "synthetic-value" }
    }) }));
    expect(response.status).toBe(400);
    expect(fixture.store.mutate).not.toHaveBeenCalled();
  });

  it("returns metadata only after owner-bound writes and keeps failures value-free", async () => {
    const fixture = setup();
    const mutation = { action: "create", name: "Synthetic", description: "", value: { kind: "text", text: "synthetic-value" } };
    const request = () => new Request("http://localhost/api/me/workspace/secrets", { method: "POST", body: JSON.stringify(mutation) });
    const result = await fixture.handlers.POST(request());
    expect(result.status).toBe(200);
    expect(fixture.store.mutate).toHaveBeenCalledWith(fixture.userId, mutation);
    expect(await result.json()).toEqual({ secrets: [fixture.summary] });
    fixture.store.mutate.mockRejectedValueOnce(new WorkspaceSecretError("workspace_secret_conflict"));
    expect((await fixture.handlers.POST(request())).status).toBe(409);
    fixture.store.mutate.mockRejectedValueOnce(new Error("synthetic-value private diagnostic"));
    expect(await (await fixture.handlers.POST(request())).json()).toEqual({ error: "workspace_secret_unavailable" });
    const get = await fixture.handlers.GET(new Request(request().url));
    expect(get.headers.get("cache-control")).toBe("private, no-store");
    expect(await get.text()).not.toContain("synthetic-value");
  });
});

import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WORKSPACE_BROWSER_SESSION_MAX_BYTES } from "@/lib/contracts/workspaceSecrets";
import { createWorkspaceSecretHandlers } from "./handlers";
import { WORKSPACE_SECRET_MUTATION_MAX_BYTES, WorkspaceSecretError } from "./validation";

function setup() {
  const userId = randomUUID();
  const summary = { id: randomUUID(), versionId: randomUUID(), kind: "text" as const, name: "Synthetic", description: "",
    byteSize: 40, updatedAt: new Date().toISOString(), envNames: [], originalName: null, sshProtected: false };
  const store = { list: vi.fn().mockResolvedValue([summary]), mutate: vi.fn(), browserAutosave: vi.fn().mockResolvedValue(null), reveal: vi.fn() };
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

  it("accepts a maximum browser-session import beyond the generic JSON cap and rejects a larger body", async () => {
    const fixture = setup();
    const state = Buffer.from(JSON.stringify({ cookies: [], origins: [] }));
    const bytes = Buffer.concat([state, Buffer.alloc(WORKSPACE_BROWSER_SESSION_MAX_BYTES - state.length, 32)]);
    const mutation = { action: "create", name: "Shop", description: "", value: { kind: "browser_session", originalName: "shop.example.json", base64: bytes.toString("base64") } };
    const url = "http://localhost/api/me/workspace/secrets";
    const accepted = await fixture.handlers.POST(new Request(url, { method: "POST", body: JSON.stringify(mutation) }));
    expect(accepted.status).toBe(200);
    expect(fixture.store.mutate).toHaveBeenCalledOnce();
    const oversized = await fixture.handlers.POST(new Request(url, { method: "POST", body: "x".repeat(WORKSPACE_SECRET_MUTATION_MAX_BYTES + 1) }));
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get("cache-control")).toBe("private, no-store");
    expect(fixture.store.mutate).toHaveBeenCalledOnce();
  });

  it("returns the latest content-free browser autosave outcome with the list", async () => {
    const fixture = setup();
    const report = { saved: 0, unchanged: 1, skipped: { browser_session_too_large: 1 } };
    fixture.store.browserAutosave.mockResolvedValueOnce(report);
    const response = await fixture.handlers.GET(new Request("http://localhost/api/me/workspace/secrets"));
    expect(await response.json()).toEqual({ secrets: [fixture.summary], browserAutosave: report });
    expect(fixture.store.browserAutosave).toHaveBeenCalledWith(fixture.userId);
  });

  describe("reveal", () => {
    const url = "http://localhost/api/me/workspace/secrets";
    const post = (body: unknown) => new Request(url, { method: "POST", body: JSON.stringify(body) });

    it("answers the caller's own value with no-store and without the list", async () => {
      const fixture = setup();
      const revealed = { id: fixture.summary.id, versionId: fixture.summary.versionId, value: { kind: "text", text: "synthetic-value" } };
      fixture.store.reveal.mockResolvedValueOnce(revealed);
      const response = await fixture.handlers.POST(post({ action: "reveal", id: fixture.summary.id }));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual(revealed);
      expect(fixture.store.reveal).toHaveBeenCalledWith(fixture.userId, fixture.summary.id);
      expect(fixture.store.mutate).not.toHaveBeenCalled();
      expect(fixture.store.list).not.toHaveBeenCalled();
    });

    it("refuses a malformed request or a browser-chosen owner before reaching the store", async () => {
      const fixture = setup();
      for (const body of [
        { action: "reveal" }, { action: "reveal", id: "not-an-id" }, { action: "reveal", id: fixture.summary.id, userId: randomUUID() },
        { action: "reveal", id: [fixture.summary.id] }
      ]) {
        const response = await fixture.handlers.POST(post(body));
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "workspace_secret_invalid" });
      }
      expect(fixture.store.reveal).not.toHaveBeenCalled();
      expect(fixture.store.mutate).not.toHaveBeenCalled();
    });

    it("authenticates first and gives a missing secret and another user's the same value-free answer", async () => {
      const fixture = setup();
      fixture.resolveAuth.mockResolvedValueOnce(null);
      const unauthorized = post({ action: "reveal", id: fixture.summary.id });
      const refusedSignedOut = await fixture.handlers.POST(unauthorized);
      expect([refusedSignedOut.status, refusedSignedOut.headers.get("cache-control")]).toEqual([401, "private, no-store"]);
      expect(unauthorized.bodyUsed).toBe(false);
      fixture.resolveAuth.mockResolvedValueOnce({ userId: fixture.userId, user: { id: fixture.userId, status: "disabled" } });
      const refusedDisabled = await fixture.handlers.POST(post({ action: "reveal", id: fixture.summary.id }));
      expect([refusedDisabled.status, refusedDisabled.headers.get("cache-control")]).toEqual([403, "private, no-store"]);
      expect(fixture.store.reveal).not.toHaveBeenCalled();

      fixture.store.reveal.mockRejectedValue(new WorkspaceSecretError("workspace_secret_not_found"));
      const answers = [];
      for (const id of [fixture.summary.id, randomUUID()]) {
        const response = await fixture.handlers.POST(post({ action: "reveal", id }));
        answers.push({ status: response.status, cache: response.headers.get("cache-control"), body: await response.json() });
      }
      expect(answers[0]).toEqual({ status: 404, cache: "private, no-store", body: { error: "workspace_secret_not_found" } });
      expect(answers[1]).toEqual(answers[0]);
    });

    it("keeps refusals and failures value-free", async () => {
      const fixture = setup();
      fixture.store.reveal.mockRejectedValueOnce(new WorkspaceSecretError("workspace_secret_not_revealable"));
      const browser = await fixture.handlers.POST(post({ action: "reveal", id: fixture.summary.id }));
      expect(browser.status).toBe(400);
      expect(await browser.json()).toEqual({ error: "workspace_secret_not_revealable" });
      fixture.store.reveal.mockRejectedValueOnce(new Error("synthetic-value private diagnostic"));
      const failed = await fixture.handlers.POST(post({ action: "reveal", id: fixture.summary.id }));
      expect(failed.status).toBe(503);
      expect(await failed.text()).not.toContain("synthetic-value");
    });
  });
});

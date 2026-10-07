import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedSession } from "../auth/requestAuth";
import { createSpeechToTextAdminHandlers } from "./adminHandlers";
import { SpeechToTextAdminError, type SpeechToTextAdminService } from "./adminService";

const role = { assignment: null, configuredAt: null, connections: [] };

function session(role: string, status = "active"): AuthenticatedSession {
  return { expiresAt: new Date(Date.now() + 60_000), id: "s", user: { displayName: "A", email: null, id: "u", role, status }, userId: "u" };
}

function setup(auth: AuthenticatedSession | null = session("admin")) {
  const service = {
    clear: vi.fn(async () => undefined),
    discover: vi.fn(async () => ["whisper-1"]),
    read: vi.fn(async () => role),
    testAndSave: vi.fn(async () => undefined)
  } satisfies SpeechToTextAdminService;
  const handlers = createSpeechToTextAdminHandlers({ resolveAuth: async () => auth, service });
  const post = (body: unknown, type = "application/json") => handlers.POST(new Request("http://app.test/api/admin/providers/speech-to-text", {
    body: JSON.stringify(body), headers: { "content-type": type }, method: "POST" }));
  return { handlers, post, service };
}

describe("speech to text admin handlers", () => {
  it("serves administrators only", async () => {
    const get = (auth: AuthenticatedSession | null) => setup(auth).handlers.GET(new Request("http://app.test/x"));
    expect((await get(null)).status).toBe(401);
    expect((await get(session("user"))).status).toBe(403);
    expect((await get(session("admin", "suspended"))).status).toBe(403);
    const ok = await get(session("admin"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ speechToText: role });
  });

  it("routes discover, test_and_save and clear with exact bodies", async () => {
    const { post, service } = setup();
    expect(await (await post({ action: "discover", connectionId: "c1" })).json()).toEqual({ models: ["whisper-1"] });
    const saved = await post({ action: "test_and_save", connectionId: "c1", expectedConfiguredAt: null, modelId: "openai/whisper-1" });
    expect(saved.status).toBe(200);
    expect(service.testAndSave).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "c1", expectedConfiguredAt: null,
      modelId: "openai/whisper-1", userId: "u" }));
    expect((await post({ action: "clear", expectedConfiguredAt: "2026-10-08T10:00:00.000Z" })).status).toBe(200);
    expect(service.clear).toHaveBeenCalledWith({ expectedConfiguredAt: "2026-10-08T10:00:00.000Z", userId: "u" });
  });

  it("rejects malformed requests before any provider work", async () => {
    const { post, service } = setup();
    for (const body of [{ action: "discover" }, { action: "discover", connectionId: "c1", extra: 1 },
      { action: "test_and_save", connectionId: "c1", modelId: "w" }, { action: "test_and_save", connectionId: "c1", expectedConfiguredAt: "soon", modelId: "w" },
      { action: "clear" }, { action: "nope" }, []]) {
      expect((await post(body)).status).toBe(400);
    }
    expect((await post({ action: "clear", expectedConfiguredAt: null }, "text/plain")).status).toBe(415);
    expect(service.discover).not.toHaveBeenCalled();
    expect(service.testAndSave).not.toHaveBeenCalled();
  });

  it("maps failures to stable codes", async () => {
    const { handlers, post, service } = setup();
    service.testAndSave.mockRejectedValueOnce(new SpeechToTextAdminError("speech_to_text_test_failed", "unauthorized"));
    const failed = await post({ action: "test_and_save", connectionId: "c1", expectedConfiguredAt: null, modelId: "w" });
    expect(failed.status).toBe(422);
    expect(await failed.json()).toEqual({ error: "speech_to_text_test_failed", reason: "unauthorized" });
    service.clear.mockRejectedValueOnce(new SpeechToTextAdminError("speech_to_text_stale"));
    expect((await post({ action: "clear", expectedConfiguredAt: null })).status).toBe(409);
    service.discover.mockRejectedValueOnce(new SpeechToTextAdminError("speech_to_text_discovery_failed"));
    expect((await post({ action: "discover", connectionId: "c1" })).status).toBe(502);
    service.read.mockRejectedValueOnce(new Error("database down"));
    const broken = await handlers.GET(new Request("http://app.test/x"));
    expect(broken.status).toBe(500);
    expect(await broken.json()).toEqual({ error: "speech_to_text_admin_action_failed" });
  });
});

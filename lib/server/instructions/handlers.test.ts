import { describe, expect, it, vi } from "vitest";
import { createInstructionPresetHandlers } from "./handlers";
import { InstructionPresetError } from "./store";

function fixture() {
  const state = { activePresetId: null, selectionVersion: 0, presets: [] };
  const store = { list: vi.fn().mockResolvedValue(state), get: vi.fn().mockResolvedValue(null),
    mutate: vi.fn(), resolveForRun: vi.fn() };
  const resolveAuth = vi.fn().mockResolvedValue({ userId: "owner", user: { id: "owner", status: "active" } });
  return { state, store, resolveAuth, handlers: createInstructionPresetHandlers({ resolveAuth, store }) };
}
const value = { name: "Work", systemInstructions: "fixture-private-instructions", responseReminder: "fixture-reminder" };
const post = (body: unknown) => new Request("http://localhost/api/me/instructions", { method: "POST", body: JSON.stringify(body) });
describe("personal instructions API", () => {
  it("authenticates before reading a body and rejects caller-supplied owners", async () => {
    const f = fixture(); f.resolveAuth.mockResolvedValueOnce(null);
    const req = post({ action: "create", value });
    expect((await f.handlers.POST(req)).status).toBe(401); expect(req.bodyUsed).toBe(false);
    expect((await f.handlers.POST(post({ action: "create", userId: "other", value }))).status).toBe(400);
    expect(f.store.mutate).not.toHaveBeenCalled();
  });
  it("writes under the authenticated owner, returns metadata, and hides unknown failures", async () => {
    const f = fixture(); const mutation = { action: "create", value };
    const response = await f.handlers.POST(post(mutation));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ instructions: f.state });
    expect(f.store.mutate).toHaveBeenCalledWith("owner", mutation);
    f.store.mutate.mockRejectedValueOnce(new Error(value.systemInstructions));
    const failed = await f.handlers.POST(post(mutation));
    expect(failed.status).toBe(503); expect(await failed.json()).toEqual({ error: "instruction_presets_unavailable" });
  });
  it("preserves version conflicts and keeps detail ownership explicit", async () => {
    const f = fixture();
    f.store.mutate.mockRejectedValueOnce(new InstructionPresetError("instruction_preset_conflict"));
    expect((await f.handlers.POST(post({ action: "update", id: "preset", revision: 1, value }))).status).toBe(409);
    const response = await f.handlers.detail(new Request("http://localhost/api/me/instructions/other"), "other");
    expect(response.status).toBe(404); expect(f.store.get).toHaveBeenCalledWith("owner", "other");
  });
});

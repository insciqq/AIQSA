import { describe, expect, it, vi } from "vitest";
import type { TelegramAdminState } from "../../../contracts/telegram";
import type { AuthenticatedSession } from "../../auth/requestAuth";
import { createAdminTelegramHandlers } from "./handlers";
import type { TelegramControlService } from "./service";

const TOKEN = "100000001:AAFakeTelegramBotTokenForTests_0000000";
const GROUP = "8a4f2a8e-5a8b-4c55-9c1e-0d4a1f6f9b10";
const STATE: TelegramAdminState = {
  botUsername: "aiqsa_test_bot", enabled: false, groupIds: [], restricted: false, tokenConfigured: true, version: 2,
  health: { lastFailureAt: null, lastFailureCode: null, lastPollAt: null, lastSuccessAt: null }
};

function session(role: string, status = "active"): AuthenticatedSession {
  return {
    expiresAt: new Date("2026-10-20T00:00:00.000Z"), id: "session-1", userId: "admin-1",
    user: { displayName: "Admin", email: "admin@example.invalid", id: "admin-1", role, status }
  };
}

function service(overrides: Partial<TelegramControlService> = {}): TelegramControlService {
  return {
    disable: vi.fn(async () => ({ ok: true, state: STATE }) as const),
    enable: vi.fn(async () => ({ ok: true, state: { ...STATE, enabled: true } }) as const),
    read: vi.fn(async () => STATE),
    setAccess: vi.fn(async () => ({ ok: true, state: STATE }) as const),
    testAndSave: vi.fn(async () => ({ ok: true, state: STATE }) as const),
    ...overrides
  };
}

function patch(body: unknown, contentType = "application/json"): Request {
  return new Request("http://app.local/api/admin/telegram", {
    body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": contentType }, method: "PATCH"
  });
}

describe("admin Telegram control routes", () => {
  it("serve active administrators only", async () => {
    const control = service();
    const anonymous = createAdminTelegramHandlers({ resolveAuth: async () => null, service: control });
    expect((await anonymous.GET(new Request("http://app.local/api/admin/telegram"))).status).toBe(401);
    for (const caller of [session("user"), session("admin", "disabled")]) {
      const handlers = createAdminTelegramHandlers({ resolveAuth: async () => caller, service: control });
      expect((await handlers.GET(new Request("http://app.local/api/admin/telegram"))).status).toBe(403);
      expect((await handlers.PATCH(patch({ action: "enable", expectedVersion: 1 }))).status).toBe(403);
    }
    expect(control.read).not.toHaveBeenCalled();
    expect(control.enable).not.toHaveBeenCalled();
  });

  it("returns the token-free state privately and passes each command with the caller and expected version", async () => {
    const control = service();
    const handlers = createAdminTelegramHandlers({ resolveAuth: async () => session("admin"), service: control });
    const read = await handlers.GET(new Request("http://app.local/api/admin/telegram"));
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("private, no-store");
    await expect(read.json()).resolves.toEqual(STATE);

    const saved = await handlers.PATCH(patch({ action: "test_and_save", expectedVersion: 1, token: TOKEN }));
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain(TOKEN.split(":")[1]);
    expect(control.testAndSave).toHaveBeenCalledWith({ actorUserId: "admin-1", expectedVersion: 1, token: TOKEN });
    await handlers.PATCH(patch({ action: "enable", expectedVersion: 2 }));
    await handlers.PATCH(patch({ action: "disable", expectedVersion: 3 }));
    await handlers.PATCH(patch({ action: "set_access", expectedVersion: 4, groupIds: [GROUP], restricted: true }));
    expect(control.enable).toHaveBeenCalledWith({ actorUserId: "admin-1", expectedVersion: 2 });
    expect(control.disable).toHaveBeenCalledWith({ actorUserId: "admin-1", expectedVersion: 3 });
    expect(control.setAccess).toHaveBeenCalledWith({ actorUserId: "admin-1", expectedVersion: 4, groupIds: [GROUP], restricted: true });
  });

  it("refuses bodies the contract does not accept and maps refusals to stable statuses", async () => {
    const control = service({
      disable: vi.fn(async () => ({ code: "telegram_control_stale", ok: false }) as const),
      enable: vi.fn(async () => ({ code: "telegram_token_missing", ok: false }) as const),
      setAccess: vi.fn(async () => ({ code: "telegram_access_groups_invalid", ok: false }) as const),
      testAndSave: vi.fn(async () => ({ code: "telegram_token_rejected", ok: false }) as const)
    });
    const handlers = createAdminTelegramHandlers({ resolveAuth: async () => session("admin"), service: control });
    expect((await handlers.PATCH(patch({ action: "enable", expectedVersion: 1 }, "text/plain"))).status).toBe(415);
    for (const body of ["{", { action: "enable" }, { action: "enable", expectedVersion: 1, token: TOKEN },
      { action: "test_and_save", expectedVersion: 1, token: "bot/../getMe" }, { action: "delete", expectedVersion: 1 }]) {
      const response = await handlers.PATCH(patch(body));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "telegram_command_invalid" });
    }
    const expectations: Array<[unknown, number, string]> = [
      [{ action: "test_and_save", expectedVersion: 1, token: TOKEN }, 422, "telegram_token_rejected"],
      [{ action: "enable", expectedVersion: 1 }, 409, "telegram_token_missing"],
      [{ action: "disable", expectedVersion: 1 }, 409, "telegram_control_stale"],
      [{ action: "set_access", expectedVersion: 1, groupIds: [GROUP], restricted: true }, 400, "telegram_access_groups_invalid"]
    ];
    for (const [body, status, error] of expectations) {
      const response = await handlers.PATCH(patch(body));
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({ error });
    }
  });

  it("answers an unexpected failure with a stable code and no detail", async () => {
    const handlers = createAdminTelegramHandlers({
      resolveAuth: async () => session("admin"),
      service: service({ read: vi.fn(async () => { throw new Error(`database said ${TOKEN}`); }) })
    });
    const response = await handlers.GET(new Request("http://app.local/api/admin/telegram"));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "telegram_control_action_failed" });
  });
});

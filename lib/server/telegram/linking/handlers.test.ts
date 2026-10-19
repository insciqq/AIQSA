import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedSession } from "../../auth/requestAuth";
import { createAdminUserTelegramHandlers, createTelegramLinkCodeHandler, createUserTelegramHandlers } from "./handlers";
import type { TelegramLinkingService } from "./service";

const USER = "22222222-2222-4222-8222-222222222222";

function session(role = "user", status = "active"): AuthenticatedSession {
  return {
    expiresAt: new Date("2026-10-20T00:00:00.000Z"), id: "session-7", userId: USER,
    user: { displayName: "Alex", email: "alex@example.invalid", id: USER, role, status }
  };
}

function service(overrides: Partial<TelegramLinkingService> = {}): TelegramLinkingService {
  return {
    adminUnlink: vi.fn(async () => ({ state: "not_linked" }) as const),
    adminView: vi.fn(async () => ({ linkedAt: "2026-10-18T10:00:00.000Z", state: "linked", telegramUsername: "alex_example" }) as const),
    createLinkCode: vi.fn(async () => ({
      ok: true, value: { deepLink: `https://t.me/aiqsa_test_bot?start=${"A".repeat(43)}`, expiresAt: "2026-10-19T08:10:00.000Z" }
    }) as const),
    linkFromStart: vi.fn(),
    status: vi.fn(async () => ({ available: true, state: "not_linked" }) as const),
    unlink: vi.fn(async () => ({ available: true, state: "not_linked" }) as const),
    unlinkFromBot: vi.fn(),
    ...overrides
  };
}

const request = (path: string, method = "GET") => new Request(`http://app.local${path}`, { method });

describe("the user's Telegram link routes", () => {
  it("require a session and answer private, uncached projections of the caller's own link", async () => {
    const linking = service();
    const anonymous = createUserTelegramHandlers({ resolveAuth: async () => null, service: linking });
    expect((await anonymous.GET(request("/api/me/telegram"))).status).toBe(401);
    expect((await anonymous.DELETE(request("/api/me/telegram", "DELETE"))).status).toBe(401);
    expect((await createTelegramLinkCodeHandler({ resolveAuth: async () => null, service: linking })(request("/api/me/telegram/link-code", "POST"))).status)
      .toBe(401);
    expect(linking.status).not.toHaveBeenCalled();

    const handlers = createUserTelegramHandlers({ resolveAuth: async () => session(), service: linking });
    const status = await handlers.GET(request("/api/me/telegram"));
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(status.headers.get("vary")).toBe("Cookie");
    await expect(status.json()).resolves.toEqual({ available: true, state: "not_linked" });
    expect(linking.status).toHaveBeenCalledWith(USER);
    expect((await handlers.DELETE(request("/api/me/telegram", "DELETE"))).status).toBe(200);
    expect(linking.unlink).toHaveBeenCalledWith(USER);
    expect((await handlers.GET(request("/api/me/telegram?userId=other"))).status).toBe(400);
  });

  it("creates a link code for the caller's own session and maps refusals", async () => {
    const linking = service();
    const handler = createTelegramLinkCodeHandler({ resolveAuth: async () => session(), service: linking });
    const created = await handler(request("/api/me/telegram/link-code", "POST"));
    expect(created.status).toBe(200);
    expect(linking.createLinkCode).toHaveBeenCalledWith({ sessionId: "session-7", userId: USER });

    const limited = createTelegramLinkCodeHandler({
      resolveAuth: async () => session(),
      service: service({ createLinkCode: vi.fn(async () => ({ code: "telegram_link_code_rate_limited", ok: false, retryAfterSeconds: 120 }) as const) })
    });
    const tooMany = await limited(request("/api/me/telegram/link-code", "POST"));
    expect(tooMany.status).toBe(429);
    expect(tooMany.headers.get("retry-after")).toBe("120");
    await expect(tooMany.json()).resolves.toEqual({ error: "telegram_link_code_rate_limited" });

    const off = createTelegramLinkCodeHandler({
      resolveAuth: async () => session(),
      service: service({ createLinkCode: vi.fn(async () => ({ code: "telegram_access_off", ok: false }) as const) })
    });
    const refused = await off(request("/api/me/telegram/link-code", "POST"));
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toEqual({ error: "telegram_access_off" });
  });
});

describe("the administrator's view of a user's link", () => {
  const context = (userId: string) => ({ params: Promise.resolve({ userId }) });

  it("is for active administrators only", async () => {
    const linking = service();
    for (const caller of [null, session("user"), session("admin", "disabled")]) {
      const handlers = createAdminUserTelegramHandlers({ resolveAuth: async () => caller, service: linking });
      expect([401, 403]).toContain((await handlers.GET(request(`/api/admin/telegram/users/${USER}`), context(USER))).status);
      expect([401, 403]).toContain((await handlers.DELETE(request(`/api/admin/telegram/users/${USER}`, "DELETE"), context(USER))).status);
    }
    expect(linking.adminView).not.toHaveBeenCalled();
    expect(linking.adminUnlink).not.toHaveBeenCalled();
  });

  it("reads and unlinks, with one neutral 404 for an unknown account", async () => {
    const linking = service({ adminView: vi.fn(async () => null), adminUnlink: vi.fn(async () => null) });
    const handlers = createAdminUserTelegramHandlers({ resolveAuth: async () => session("admin"), service: linking });
    for (const response of [
      await handlers.GET(request("/api/admin/telegram/users/missing"), context("missing")),
      await handlers.DELETE(request("/api/admin/telegram/users/missing", "DELETE"), context("missing")),
      await handlers.GET(request("/api/admin/telegram/users/x"), context("\u0000"))
    ]) {
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "user_not_found" });
    }
    const known = createAdminUserTelegramHandlers({ resolveAuth: async () => session("admin"), service: service() });
    const view = await known.GET(request(`/api/admin/telegram/users/${USER}`), context(USER));
    await expect(view.json()).resolves.toEqual({ linkedAt: "2026-10-18T10:00:00.000Z", state: "linked", telegramUsername: "alex_example" });
    const unlinked = await known.DELETE(request(`/api/admin/telegram/users/${USER}`, "DELETE"), context(USER));
    await expect(unlinked.json()).resolves.toEqual({ state: "not_linked" });
  });
});

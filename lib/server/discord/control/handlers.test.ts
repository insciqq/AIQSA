import { describe, expect, it, vi } from "vitest";
import { DISCORD_LIMIT_DEFAULTS, type DiscordAdminState } from "../../../contracts/discord";
import type { AuthenticatedSession } from "../../auth/requestAuth";
import { createAdminDiscordHandlers } from "./handlers";
import type { DiscordControlService } from "./service";

const TOKEN = "MTAwMDAwMDAwMDAwMDAwMDAx.FAKE00.fake-discord-bot-token-for-tests-0000";
const STATE: DiscordAdminState = {
  assistant: null, bot: null, channelMode: "only_listed", channels: [], dmEnabled: false, enabled: false, guild: null,
  health: { connected: false, lastConnectedAt: null, lastEventAt: null, lastFailureAt: null, lastFailureCode: null },
  limits: DISCORD_LIMIT_DEFAULTS, serviceAccount: { status: "missing", userId: null },
  setup: { items: [{ action: "enter_token", code: "discord_token_missing", status: "blocking" }], ready: false },
  testAuthorIds: [], testChannelIds: [], tokenConfigured: false, version: 2
};

function session(role: string, status = "active"): AuthenticatedSession {
  return {
    expiresAt: new Date("2026-11-13T00:00:00.000Z"), id: "session-1", userId: "admin-1",
    user: { displayName: "Admin", email: "admin@example.invalid", id: "admin-1", role, status }
  };
}

function service(overrides: Partial<DiscordControlService> = {}): DiscordControlService {
  const ok = vi.fn(async () => ({ ok: true, state: STATE }) as const);
  return {
    createServiceAccount: ok, disable: ok, enable: ok, setAssistant: ok, setChannels: ok, setDirectMessages: ok, setGuild: ok, setLimits: ok,
    setTestAccess: ok, testAndSave: ok,
    health: vi.fn(),
    listAssistants: vi.fn(async () => ({ ok: true, state: { assistants: [] } }) as const),
    listChannels: vi.fn(async () => ({ ok: true, state: { channels: [] } }) as const),
    listGuilds: vi.fn(async () => ({ ok: true, state: { guilds: [] } }) as const),
    read: vi.fn(async () => STATE),
    ...overrides
  };
}

function patch(body: unknown, contentType = "application/json"): Request {
  return new Request("http://app.local/api/admin/discord", {
    body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": contentType }, method: "PATCH"
  });
}

describe("admin Discord control routes", () => {
  it("serve active administrators only, listings included", async () => {
    const control = service();
    const anonymous = createAdminDiscordHandlers({ resolveAuth: async () => null, service: control });
    expect((await anonymous.GET(new Request("http://app.local/api/admin/discord"))).status).toBe(401);
    for (const caller of [session("user"), session("admin", "disabled")]) {
      const handlers = createAdminDiscordHandlers({ resolveAuth: async () => caller, service: control });
      expect((await handlers.GET(new Request("http://app.local/api/admin/discord"))).status).toBe(403);
      expect((await handlers.PATCH(patch({ action: "enable", expectedVersion: 1 }))).status).toBe(403);
      expect((await handlers.guilds(new Request("http://app.local/api/admin/discord/guilds"))).status).toBe(403);
      expect((await handlers.channels(new Request("http://app.local/api/admin/discord/channels?guildId=abc"))).status).toBe(403);
      expect((await handlers.assistants(new Request("http://app.local/api/admin/discord/assistants"))).status).toBe(403);
    }
    expect(control.read).not.toHaveBeenCalled();
    expect(control.enable).not.toHaveBeenCalled();
    expect(control.listGuilds).not.toHaveBeenCalled();
  });

  it("returns the token-free state privately and passes each command with the caller and expected version", async () => {
    const control = service();
    const handlers = createAdminDiscordHandlers({ resolveAuth: async () => session("admin"), service: control });
    const read = await handlers.GET(new Request("http://app.local/api/admin/discord"));
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("private, no-store");
    await expect(read.json()).resolves.toEqual(STATE);
    const commands: Array<[Record<string, unknown>, keyof DiscordControlService, Record<string, unknown>]> = [
      [{ action: "test_and_save", expectedVersion: 2, token: TOKEN }, "testAndSave", { token: TOKEN }],
      [{ action: "set_guild", expectedVersion: 2, guildId: "100000000000000010" }, "setGuild", { guildId: "100000000000000010" }],
      [{ action: "set_channels", channelIds: ["1"], channelMode: "all_except", expectedVersion: 2 }, "setChannels", { channelIds: ["1"], channelMode: "all_except" }],
      [{ action: "set_direct_messages", dmEnabled: true, expectedVersion: 2 }, "setDirectMessages", { dmEnabled: true }],
      [{ action: "set_test_access", expectedVersion: 2, testAuthorIds: ["9"], testChannelIds: ["1"] }, "setTestAccess",
        { testAuthorIds: ["9"], testChannelIds: ["1"] }],
      [{ action: "create_service_account", expectedVersion: 2 }, "createServiceAccount", {}],
      [{ action: "set_assistant", assistantId: "asst_1", expectedVersion: 2 }, "setAssistant", { assistantId: "asst_1" }],
      [{ action: "set_limits", expectedVersion: 2, limits: { ...DISCORD_LIMIT_DEFAULTS, parallelThreads: 4 } }, "setLimits",
        { limits: { ...DISCORD_LIMIT_DEFAULTS, parallelThreads: 4 } }],
      [{ action: "enable", expectedVersion: 2 }, "enable", {}],
      [{ action: "disable", expectedVersion: 2 }, "disable", {}]
    ];
    for (const [body, method, extra] of commands) {
      const methodMock = vi.fn(async () => ({ ok: true, state: STATE }) as const);
      const handlersFor = createAdminDiscordHandlers({ resolveAuth: async () => session("admin"), service: service({ [method]: methodMock } as Partial<DiscordControlService>) });
      const response = await handlersFor.PATCH(patch(body));
      expect(response.status, String(body.action)).toBe(200);
      expect(methodMock).toHaveBeenCalledWith({ actorUserId: "admin-1", expectedVersion: 2, ...extra });
    }
  });

  it("maps refusals to stable codes and statuses, and refuses malformed and non-JSON bodies", async () => {
    const refusals: Array<[string, number]> = [
      ["discord_control_stale", 409], ["discord_setup_incomplete", 409], ["discord_token_rejected", 422], ["discord_guild_missing", 422],
      ["discord_encryption_unavailable", 503], ["forbidden", 403]
    ];
    for (const [code, status] of refusals) {
      const handlers = createAdminDiscordHandlers({
        resolveAuth: async () => session("admin"),
        service: service({ enable: vi.fn(async () => ({ code, ok: false }) as never) })
      });
      const response = await handlers.PATCH(patch({ action: "enable", expectedVersion: 2 }));
      expect(response.status, code).toBe(status);
      await expect(response.json()).resolves.toEqual({ error: code });
    }
    const handlers = createAdminDiscordHandlers({ resolveAuth: async () => session("admin"), service: service() });
    expect((await handlers.PATCH(patch({ action: "create_monitoring_key", expectedVersion: 2 }))).status).toBe(400);
    expect((await handlers.PATCH(patch({ action: "test_and_save", expectedVersion: 2, token: "Bot abc\r\nX: y" }))).status).toBe(400);
    expect((await handlers.PATCH(patch("{}", "text/plain"))).status).toBe(415);
    const thrown = createAdminDiscordHandlers({ resolveAuth: async () => session("admin"), service: service({ read: vi.fn(async () => { throw new Error("boom"); }) }) });
    const failed = await thrown.GET(new Request("http://app.local/api/admin/discord"));
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toEqual({ error: "discord_control_action_failed" });
  });

  it("checks the channel listing's server id before asking Discord", async () => {
    const control = service();
    const handlers = createAdminDiscordHandlers({ resolveAuth: async () => session("admin"), service: control });
    const invalid = await handlers.channels(new Request("http://app.local/api/admin/discord/channels?guildId=abc"));
    expect(invalid.status).toBe(400);
    expect(control.listChannels).not.toHaveBeenCalled();
    const listed = await handlers.channels(new Request("http://app.local/api/admin/discord/channels?guildId=100000000000000010"));
    expect(listed.status).toBe(200);
    expect(control.listChannels).toHaveBeenCalledWith("100000000000000010");
    const missing = createAdminDiscordHandlers({
      resolveAuth: async () => session("admin"),
      service: service({ listAssistants: vi.fn(async () => ({ code: "discord_service_account_missing", ok: false }) as const) })
    });
    expect((await missing.assistants(new Request("http://app.local/api/admin/discord/assistants"))).status).toBe(409);
  });
});

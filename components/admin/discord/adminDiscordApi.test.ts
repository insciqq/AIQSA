import { describe, expect, it, vi } from "vitest";
import {
  ADMIN_DISCORD_STALE,
  adminDiscordErrorMessage,
  createDiscordMonitoringKey,
  requestDiscordChannels,
  revokeDiscordMonitoringKey,
  runAdminDiscordCommand
} from "./adminDiscordApi";

function fetcher(response: Response) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response);
}

describe("adminDiscordApi", () => {
  it("sends commands as PATCH with the expected version and reads a bare 409 as a stale page", async () => {
    const fetch = fetcher(Response.json({}, { status: 409 }));
    const result = await runAdminDiscordCommand({ action: "enable", expectedVersion: 4 }, fetch);
    expect(result).toEqual({ error: ADMIN_DISCORD_STALE, ok: false });
    expect(fetch).toHaveBeenCalledWith("/api/admin/discord", expect.objectContaining({
      body: JSON.stringify({ action: "enable", expectedVersion: 4 }),
      method: "PATCH"
    }));
  });

  it("keeps an actionable 409 code and names its fix", async () => {
    const result = await runAdminDiscordCommand(
      { action: "enable", expectedVersion: 4 },
      fetcher(Response.json({ error: "discord_setup_incomplete" }, { status: 409 }))
    );
    expect(result).toEqual({ error: "discord_setup_incomplete", ok: false });
    expect(adminDiscordErrorMessage("discord_setup_incomplete")).toBe(
      "The setup checklist below has unfinished items. Complete them, then enable the bot."
    );
  });

  it("refuses a malformed answer instead of guessing state", async () => {
    const result = await runAdminDiscordCommand({ action: "disable", expectedVersion: 1 }, fetcher(Response.json({ enabled: false })));
    expect(result).toEqual({ error: "discord_admin_response_invalid", ok: false });
  });

  it("encodes the server id and the key id into their paths", async () => {
    const channels = fetcher(Response.json({ channels: [] }));
    await requestDiscordChannels("123&x=1", channels);
    expect(channels.mock.calls[0]![0]).toBe("/api/admin/discord/channels?guildId=123%26x%3D1");
    const revoke = fetcher(Response.json({ keys: [] }));
    expect(await revokeDiscordMonitoringKey("dmk/1", revoke)).toEqual({ data: { keys: [] }, ok: true });
    expect(revoke.mock.calls[0]).toEqual(["/api/admin/discord/monitoring-keys/dmk%2F1", expect.objectContaining({ method: "DELETE" })]);
  });

  it("accepts a created key only with a well-formed secret", async () => {
    const key = { createdAt: "2026-11-12T10:00:00.000Z", id: "dmk_1", lastUsedAt: null, revokedAt: null };
    expect(await createDiscordMonitoringKey(fetcher(Response.json({ key, secret: "short" })))).toEqual({
      error: "discord_admin_response_invalid", ok: false
    });
    const secret = "aiqsa_dmk_abcdefghijklmnopqrstuvwxyz012345";
    expect(await createDiscordMonitoringKey(fetcher(Response.json({ key, secret })))).toEqual({ data: { key, secret }, ok: true });
  });

  it("reports a network failure without throwing", async () => {
    const result = await runAdminDiscordCommand({ action: "disable", expectedVersion: 1 }, vi.fn(async () => {
      throw new TypeError("offline");
    }));
    expect(result).toEqual({ error: "network_error", ok: false });
  });
});

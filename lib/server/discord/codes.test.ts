import { describe, expect, it } from "vitest";
import { DISCORD_REASON_CODES } from "../../contracts/discord";
import failureCodes from "../observability/failureCodes.json";
import { serializeEvent } from "../observability/runtime.cjs";
import { DISCORD_LOG_CODES } from "./codes";
import { DISCORD_COPY, discordAuthorLimitText, discordReasonText, discordWorkingStatus } from "./copy";

describe("Discord log codes and events", () => {
  it("registers every reason and log code in order among its sorted neighbours", () => {
    const registry = failureCodes as string[];
    for (const code of new Set([...DISCORD_REASON_CODES, ...DISCORD_LOG_CODES])) {
      const index = registry.indexOf(code);
      expect(index, code).toBeGreaterThan(0);
      expect(registry[index - 1]! < code && code < registry[index + 1]!, code).toBe(true);
    }
  });

  it("logs discord records with their codes and snowflake ids, never content", () => {
    const line = serializeEvent("discord_request", {
      stage: "failed", code: "discord_busy", guild_id: "200000000000000001", channel_id: "300000000000000001",
      message_id: "500000000000000001", author_id: "400000000000000001", chat_id: "chat_1", run_id: "run_1", duration_ms: 812.4,
      text: "PRIVATE_TEXT", authorName: "PRIVATE_NAME", url: "https://discord.com/PRIVATE"
    } as never)!;
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(record).toMatchObject({
      event: "discord_request", level: "warn", stage: "failed", code: "discord_busy", guild_id: "200000000000000001",
      message_id: "500000000000000001", chat_id: "chat_1", duration_ms: 812
    });
    expect(line).not.toContain("PRIVATE");
    const invalid = JSON.parse(serializeEvent("discord_intake", { outcome: "ignored", reason: "bot_author", channel_id: "12a", author_id: "1".repeat(21) } as never)!) as Record<string, unknown>;
    expect(invalid.channel_id).toBeUndefined();
    expect(invalid.author_id).toBeUndefined();
    for (const code of ["discord_session_limit", "discord_gateway_zombie", "discord_token_rejected"]) {
      expect(JSON.parse(serializeEvent("discord_gateway", { stage: "close", outcome: "blocked", code, close_code: 4004 })!)).toMatchObject({ code, level: "error" });
    }
    expect(JSON.parse(serializeEvent("discord_rest", { route: "create_message", outcome: "rate_limited", scope: "global", retry_after_ms: 1500, code: "discord_rate_limited" })!))
      .toMatchObject({ route: "create_message", scope: "global", code: "discord_rate_limited", level: "warn" });
    expect(JSON.parse(serializeEvent("service_operation", { subsystem: "discord", stage: "startup", outcome: "failed", action: "degrade", code: "discord_connect_address_invalid" })!))
      .toMatchObject({ subsystem: "discord", code: "discord_connect_address_invalid" });
    expect(JSON.parse(serializeEvent("discord_run_summary", { message_id: "1", mcp_server: "mcp_1", mcp_calls: 3, mcp_errors: 1, sources: 0, not_found: true })!))
      .toMatchObject({ mcp_server: "mcp_1", mcp_calls: 3, not_found: true });
    expect(JSON.parse(serializeEvent("discord_rating", { message_id: "1", chat_id: "chat_1", value: "down", outcome: "added" })!))
      .toMatchObject({ value: "down", outcome: "added" });
  });
});

describe("Discord copy", () => {
  it("formats the status line and limit texts", () => {
    expect(discordWorkingStatus(72_400, "Searching the web")).toBe("Working · 1:12 — Searching the web");
    expect(discordWorkingStatus(5_000)).toBe("Working · 0:05");
    expect(discordAuthorLimitText(20, 0)).toBe("You've reached the limit of 20 questions per hour. Try again in 1 min.");
    expect(discordReasonText("discord_busy")).toBe(DISCORD_COPY.busy);
    expect(discordReasonText("discord_disabled")).toBeNull();
    expect(discordReasonText("discord_delivery_unknown")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { DISCORD_SETUP_CHECK_CODES, discordSetupItemSchema } from "../../../contracts/discord";
import { MCP_RUN_PLAN_LIMITS } from "../../../contracts/mcp";
import { discordSetupCheck, type DiscordSetupFacts } from "./setup";

const READY: DiscordSetupFacts = {
  assistant: { credential: "own", mcp: "granted", mcpToolCount: 12, model: "ok", search: "on", state: "available" },
  assistantId: "asst_1",
  guildId: "100000000000000010",
  monthlyBudget: false,
  serviceAccount: { status: "active", userId: "svc_1" },
  sessionFailureCode: null,
  tokenState: "ready"
};

function failing(facts: DiscordSetupFacts) {
  return discordSetupCheck(facts).items.filter((item) => item.status !== "ok").map((item) => [item.code, item.status, item.action]);
}

describe("Discord setup check", () => {
  it("lists every item as passed for a complete setup, in the contract's order, each a valid wire item", () => {
    const check = discordSetupCheck(READY);
    expect(check.ready).toBe(true);
    expect(check.items.map((item) => item.code)).toEqual([...DISCORD_SETUP_CHECK_CODES]);
    expect(check.items.every((item) => discordSetupItemSchema.safeParse(item).success && item.action === null)).toBe(true);
  });

  it("blocks on the token, Discord's refusals, the server, the service account and the Assistant, each with its action", () => {
    expect(failing({ ...READY, tokenState: "missing" })).toEqual([["discord_token_missing", "blocking", "enter_token"]]);
    expect(failing({ ...READY, tokenState: "unreadable" })).toEqual([["discord_token_missing", "blocking", "enter_token"]]);
    expect(failing({ ...READY, sessionFailureCode: "discord_token_rejected" })).toEqual([["discord_token_rejected", "blocking", "enter_token"]]);
    expect(failing({ ...READY, sessionFailureCode: "discord_intents_disallowed" }))
      .toEqual([["discord_message_content_disabled", "blocking", "enter_token"]]);
    expect(failing({ ...READY, sessionFailureCode: "discord_disconnected" })).toEqual([]);
    expect(failing({ ...READY, guildId: null })).toEqual([["discord_guild_missing", "blocking", "select_guild"]]);
    expect(failing({ ...READY, serviceAccount: { status: "inactive", userId: "svc_1" } }))
      .toEqual([["discord_service_account_inactive", "blocking", "open_service_account"]]);
    expect(failing({ ...READY, assistant: { state: "unavailable" } })).toEqual([["discord_assistant_unavailable", "blocking", "select_assistant"]]);
    expect(failing({ ...READY, assistant: { ...READY.assistant!, model: "inherit" } as DiscordSetupFacts["assistant"] }))
      .toEqual([["discord_model_unavailable", "blocking", "open_assistant"]]);
    expect(failing({ ...READY, assistant: { ...READY.assistant!, credential: "unavailable" } as DiscordSetupFacts["assistant"] }))
      .toEqual([["discord_model_unavailable", "blocking", "open_provider_keys"]]);
    expect(failing({ ...READY, assistant: { ...READY.assistant!, mcp: "not_granted" } as DiscordSetupFacts["assistant"] }))
      .toEqual([["discord_mcp_not_granted", "blocking", "open_mcp_grants"]]);
    expect(failing({ ...READY, assistant: { ...READY.assistant!, search: "unusable" } as DiscordSetupFacts["assistant"] }))
      .toEqual([["discord_search_disabled", "blocking", "open_assistant"]]);
  });

  it("blocks an exact MCP row whose servers publish more tools than one request takes, and only then", () => {
    const withTools = (mcp: "none" | "granted" | "not_granted", mcpToolCount: number) =>
      discordSetupCheck({ ...READY, assistant: { ...READY.assistant!, mcp, mcpToolCount } as DiscordSetupFacts["assistant"] });
    const tooMany = withTools("granted", 157);
    expect(tooMany.ready).toBe(false);
    expect(tooMany.items.filter((item) => item.status !== "ok")).toEqual([
      { action: "open_assistant", code: "discord_mcp_too_many_tools", status: "blocking", toolCount: 157 }
    ]);
    expect(discordSetupItemSchema.safeParse(tooMany.items.find((item) => item.code === "discord_mcp_too_many_tools")).success).toBe(true);
    for (const count of [100, MCP_RUN_PLAN_LIMITS.maxTools]) {
      const fits = withTools("granted", count);
      expect(fits.ready).toBe(true);
      expect(fits.items.find((item) => item.code === "discord_mcp_too_many_tools")).toEqual({ action: null, code: "discord_mcp_too_many_tools", status: "ok" });
    }
    // Auto or inherited MCP loads no fixed set, and ungranted servers fail their own item first.
    expect(withTools("none", 0).items.map((item) => item.code)).not.toContain("discord_mcp_too_many_tools");
    expect(withTools("not_granted", 157).items.map((item) => item.code)).not.toContain("discord_mcp_too_many_tools");
  });

  it("only warns about Search off, the shared key and a monthly budget, which never block Enable", () => {
    const check = discordSetupCheck({
      ...READY, assistant: { ...READY.assistant!, credential: "shared", search: "off" } as DiscordSetupFacts["assistant"], monthlyBudget: true
    });
    expect(check.ready).toBe(true);
    expect(check.items.filter((item) => item.status !== "ok").map((item) => [item.code, item.status, item.action])).toEqual([
      ["discord_search_disabled", "warning", "open_assistant"],
      ["discord_shared_key", "warning", "open_provider_keys"],
      ["discord_monthly_budget", "warning", "open_usage_limits"]
    ]);
  });

  it("leaves out items whose prerequisite failed instead of showing them as passed", () => {
    const missing = discordSetupCheck({ ...READY, assistant: null, assistantId: null, monthlyBudget: null, serviceAccount: { status: "missing" }, tokenState: "missing" });
    expect(missing.items.map((item) => item.code)).toEqual([
      "discord_token_missing", "discord_guild_missing", "discord_service_account_missing", "discord_assistant_missing"
    ]);
    const unavailable = discordSetupCheck({ ...READY, assistant: { state: "unavailable" } });
    expect(unavailable.items.map((item) => item.code)).not.toContain("discord_model_unavailable");
    expect(unavailable.items.map((item) => item.code)).not.toContain("discord_shared_key");
  });
});

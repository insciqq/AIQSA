import type { DiscordSetupItem } from "../../../contracts/discord";
import type { DiscordControlRecord } from "./repository";

/**
 * The setup check (PRD D-10, D-35): one item per condition Discord answers
 * need, each with its code and the action that fixes it. Blocking items keep
 * the bot from being enabled; a broken one on an enabled bot refuses every
 * question and raises an attention item. Warnings (the shared provider key, a
 * monthly budget that can stop every thread at once, Search off) never block.
 * An item whose prerequisite failed is left out, never shown as passed.
 */

export type DiscordAssistantSetupFacts =
  | Readonly<{ state: "unavailable" }>
  | Readonly<{
    state: "available";
    /** `inherit`: the Assistant names no model, and a Discord message picks none. */
    model: "ok" | "inherit" | "unavailable";
    search: "on" | "off" | "unusable";
    mcp: "none" | "granted" | "not_granted";
    /** Which provider key the model's runs resolve for the service account; null without a usable model. */
    credential: "own" | "shared" | "unavailable" | null;
  }>;

export type DiscordSetupFacts = Readonly<{
  tokenState: "missing" | "ready" | "unreadable";
  /** The session's recorded failure, which says whether Discord refused the token or the intents. */
  sessionFailureCode: string | null;
  guildId: string | null;
  serviceAccount: Readonly<{ status: "missing" }> | Readonly<{ status: "active" | "inactive"; userId: string }>;
  assistantId: string | null;
  /** Null while there is no service account or Assistant to check. */
  assistant: DiscordAssistantSetupFacts | null;
  /** Whether a monthly budget applies to the service account; null without one. */
  monthlyBudget: boolean | null;
}>;

export type DiscordSetupCheck = Readonly<{ ready: boolean; items: DiscordSetupItem[] }>;

function item(code: DiscordSetupItem["code"], status: DiscordSetupItem["status"], action: DiscordSetupItem["action"] = null): DiscordSetupItem {
  return { action: status === "ok" ? null : action, code, status };
}

export function discordSetupCheck(facts: DiscordSetupFacts): DiscordSetupCheck {
  const items: DiscordSetupItem[] = [];
  items.push(item("discord_token_missing", facts.tokenState === "ready" ? "ok" : "blocking", "enter_token"));
  if (facts.tokenState === "ready") {
    items.push(item("discord_token_rejected", facts.sessionFailureCode === "discord_token_rejected" ? "blocking" : "ok", "enter_token"));
    items.push(item("discord_message_content_disabled",
      facts.sessionFailureCode === "discord_intents_disallowed" ? "blocking" : "ok", "enter_token"));
  }
  items.push(item("discord_guild_missing", facts.guildId === null ? "blocking" : "ok", "select_guild"));
  items.push(item("discord_service_account_missing", facts.serviceAccount.status === "missing" ? "blocking" : "ok", "create_service_account"));
  if (facts.serviceAccount.status !== "missing") {
    items.push(item("discord_service_account_inactive", facts.serviceAccount.status === "active" ? "ok" : "blocking", "open_service_account"));
  }
  items.push(item("discord_assistant_missing", facts.assistantId === null ? "blocking" : "ok", "select_assistant"));
  const assistant = facts.assistant;
  if (assistant) {
    items.push(item("discord_assistant_unavailable", assistant.state === "available" ? "ok" : "blocking", "select_assistant"));
    if (assistant.state === "available") {
      if (assistant.model !== "ok") items.push(item("discord_model_unavailable", "blocking", "open_assistant"));
      else if (assistant.credential === "unavailable") items.push(item("discord_model_unavailable", "blocking", "open_provider_keys"));
      else items.push(item("discord_model_unavailable", "ok"));
      items.push(item("discord_search_disabled",
        assistant.search === "on" ? "ok" : assistant.search === "off" ? "warning" : "blocking", "open_assistant"));
      items.push(item("discord_mcp_not_granted", assistant.mcp === "not_granted" ? "blocking" : "ok", "open_mcp_grants"));
      if (assistant.credential === "own" || assistant.credential === "shared") {
        items.push(item("discord_shared_key", assistant.credential === "shared" ? "warning" : "ok", "open_provider_keys"));
      }
    }
  }
  if (facts.monthlyBudget !== null) {
    items.push(item("discord_monthly_budget", facts.monthlyBudget ? "warning" : "ok", "open_usage_limits"));
  }
  return { items, ready: !items.some((entry) => entry.status === "blocking") };
}

/** Where the setup check reads what it does not find on the control row. */
export type DiscordSetupSources = Readonly<{
  serviceAccount(userId: string): Promise<Readonly<{ status: "active" | "denied" | "disabled" | "pending" }> | null>;
  assistant(input: Readonly<{ assistantId: string; serviceUserId: string }>): Promise<DiscordAssistantSetupFacts>;
  monthlyBudget(serviceUserId: string): Promise<boolean>;
}>;

export async function loadDiscordSetupFacts(
  record: DiscordControlRecord,
  tokenState: DiscordSetupFacts["tokenState"],
  sources: DiscordSetupSources
): Promise<DiscordSetupFacts> {
  const account = record.serviceUserId ? await sources.serviceAccount(record.serviceUserId) : null;
  const serviceAccount: DiscordSetupFacts["serviceAccount"] = account && record.serviceUserId
    ? { status: account.status === "active" ? "active" : "inactive", userId: record.serviceUserId }
    : { status: "missing" };
  const [assistant, monthlyBudget] = serviceAccount.status === "missing"
    ? [null, null]
    : await Promise.all([
      record.assistantId ? sources.assistant({ assistantId: record.assistantId, serviceUserId: serviceAccount.userId }) : null,
      sources.monthlyBudget(serviceAccount.userId)
    ]);
  return {
    assistant,
    assistantId: record.assistantId,
    guildId: record.guildId,
    monthlyBudget,
    serviceAccount,
    sessionFailureCode: record.lastFailureCode,
    tokenState
  };
}

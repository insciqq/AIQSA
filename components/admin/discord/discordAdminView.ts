import { adminDiscordReasonMessage } from "@/components/admin/discord/adminDiscordApi";
import {
  DISCORD_BOT_TOKEN_MAX_LENGTH,
  DISCORD_BOT_TOKEN_PATTERN,
  DISCORD_SNOWFLAKE_PATTERN,
  DISCORD_TEST_IDS_MAX,
  discordLimitsSchema,
  type DiscordAdminState,
  type DiscordChannelMode,
  type DiscordChannelOptions,
  type DiscordLimits,
  type DiscordSetupItem
} from "@/lib/contracts/discord";

export type DiscordStatusAction = "enter_token" | "review_setup" | null;

export type DiscordBotStatus = Readonly<{
  /** What the administrator can do about it, when there is something to do. */
  action: DiscordStatusAction;
  /** The one-line state under the status word, e.g. "Last event 5 s ago". */
  detail: string;
  label: string;
  tone: "critical" | "neutral" | "ok" | "warning";
}>;

function timeMs(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** "5 s ago", "3 min ago", "2 h ago" or the date for anything older than a day. */
export function discordRelativeTime(value: string, nowMs: number): string {
  const at = timeMs(value);
  if (at === null) return "at an unknown time";
  const seconds = Math.max(0, Math.round((nowMs - at) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `on ${new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(at))}`;
}

/** Off, Connected or Disconnected with its reason; the session's own facts decide, never a guess. */
export function discordBotStatus(state: DiscordAdminState, nowMs: number): DiscordBotStatus {
  if (!state.tokenConfigured) {
    return { action: "enter_token", detail: "Paste the bot token below and use Test & Save.", label: "Not set up", tone: "neutral" };
  }
  if (!state.enabled) {
    return state.setup.ready
      ? { action: null, detail: "The bot reads and answers nothing in Discord until you enable it.", label: "Off", tone: "neutral" }
      : { action: "review_setup", detail: "Finish the setup checklist, then enable the bot.", label: "Off", tone: "neutral" };
  }
  const { connected, lastEventAt, lastFailureAt, lastFailureCode } = state.health;
  if (!connected) {
    const reason = adminDiscordReasonMessage(lastFailureCode ?? "discord_disconnected");
    const since = lastFailureAt ? ` Since ${discordRelativeTime(lastFailureAt, nowMs)}.` : "";
    const action: DiscordStatusAction = lastFailureCode === "discord_token_rejected" || lastFailureCode === "discord_intents_disallowed"
      ? "enter_token"
      : null;
    return { action, detail: `${reason}${since}`, label: "Disconnected", tone: "critical" };
  }
  if (!state.setup.ready) {
    return {
      action: "review_setup",
      detail: "Connected, but a setup item broke: every question is refused until it is fixed.",
      label: "Attention",
      tone: "warning"
    };
  }
  return {
    action: null,
    detail: lastEventAt ? `Last event ${discordRelativeTime(lastEventAt, nowMs)}` : "Waiting for the first event",
    label: "Connected",
    tone: "ok"
  };
}

/** Local check before the token leaves the browser; the server repeats it and asks Discord. */
export function discordTokenError(token: string): string | null {
  const value = token.trim();
  if (!value) return "Paste the bot token from the Discord Developer Portal.";
  if (value.length > DISCORD_BOT_TOKEN_MAX_LENGTH || !DISCORD_BOT_TOKEN_PATTERN.test(value)) {
    return "This is not a bot token. Copy it from Bot → Reset Token in the Discord Developer Portal.";
  }
  return null;
}

export type DiscordSetupItemView = Readonly<{
  /** The button or link that fixes the item; null when there is nothing to do. */
  actionLabel: string | null;
  /** Why it matters or how to fix it; shown for warnings and blockers. */
  reason: string;
  title: string;
}>;

const SETUP_COPY: Readonly<Record<DiscordSetupItem["code"], Readonly<{ ok: string; problem: string; title: string }>>> = {
  discord_token_missing: {
    ok: "A bot token is saved.",
    problem: "No bot token is saved. Paste one and use Test & Save.",
    title: "Bot token"
  },
  discord_token_rejected: {
    ok: "Discord accepts the saved token.",
    problem: "Discord rejected the saved token. Reset it in the Discord Developer Portal and use Test & Save.",
    title: "Token accepted"
  },
  discord_message_content_disabled: {
    ok: "Message Content Intent is on.",
    problem: "Turn on Message Content Intent under Bot → Privileged Gateway Intents in the Discord Developer Portal, then use Test & Save.",
    title: "Message Content"
  },
  discord_guild_missing: {
    ok: "The bot is in the chosen server.",
    problem: "Choose the server the bot answers in. The bot must already be a member.",
    title: "Server"
  },
  discord_service_account_missing: {
    ok: "The service account exists.",
    problem: "Create the service account that Discord runs belong to.",
    title: "Service account"
  },
  discord_service_account_inactive: {
    ok: "The service account is active.",
    problem: "The service account is deactivated. Activate it on its user page.",
    title: "Service account active"
  },
  discord_assistant_missing: {
    ok: "An Assistant is chosen.",
    problem: "Choose the Assistant that answers in Discord.",
    title: "Assistant"
  },
  discord_assistant_unavailable: {
    ok: "The service account can use the Assistant.",
    problem: "The service account cannot use the chosen Assistant. Share it with the service account or one of its groups.",
    title: "Assistant available"
  },
  discord_model_unavailable: {
    ok: "The Assistant's model is in the service account's catalog.",
    problem: "The Assistant's model is not in the service account's catalog. Give its group access to the model.",
    title: "Model"
  },
  discord_search_disabled: {
    ok: "Search is on in the Assistant.",
    problem: "Turn on Search in the Assistant.",
    title: "Web search"
  },
  discord_mcp_not_granted: {
    ok: "The Assistant's MCP servers are granted to the service account.",
    problem: "Grant the Assistant's MCP servers to the service account or its group.",
    title: "MCP servers"
  },
  discord_shared_key: {
    ok: "Discord runs use their own provider key.",
    problem: "Discord runs use the shared key. Assign the service account or its group its own key on the provider connection.",
    title: "Model key"
  },
  discord_monthly_budget: {
    ok: "No monthly budget can stop Discord answers.",
    problem: "A monthly budget applies to the service account. When it is reached, every Discord thread stops answering at once. " +
      "Raise it or exempt the service account under Budgets & limits if that is not intended.",
    title: "Monthly budget"
  }
};

const ACTION_LABELS: Readonly<Record<NonNullable<DiscordSetupItem["action"]>, string>> = {
  create_service_account: "Create service account",
  enter_token: "Enter token",
  open_assistant: "Open Assistant",
  open_mcp_grants: "Open MCP servers",
  open_provider_keys: "Open Providers",
  open_service_account: "Open user page",
  open_usage_limits: "Open Budgets & limits",
  select_assistant: "Choose Assistant",
  select_guild: "Choose server"
};

export function discordSetupItemView(item: DiscordSetupItem): DiscordSetupItemView {
  const copy = SETUP_COPY[item.code];
  return {
    actionLabel: item.status !== "ok" && item.action ? ACTION_LABELS[item.action] : null,
    reason: item.status === "ok" ? copy.ok : copy.problem,
    title: copy.title
  };
}

/** Blocking items first, then warnings, then passed items; each group keeps the server's order. */
export function orderedSetupItems(items: readonly DiscordSetupItem[]): DiscordSetupItem[] {
  const rank = { blocking: 0, warning: 1, ok: 2 } as const;
  return items.map((item, index) => ({ index, item }))
    .sort((left, right) => rank[left.item.status] - rank[right.item.status] || left.index - right.index)
    .map(({ item }) => item);
}

export type DiscordChannelsDraft = Readonly<{ channelIds: readonly string[]; mode: DiscordChannelMode }>;

export function discordChannelsDirty(draft: DiscordChannelsDraft, state: DiscordAdminState): boolean {
  if (draft.mode !== state.channelMode) return true;
  const stored = new Set(state.channels.map((channel) => channel.id));
  return draft.channelIds.length !== stored.size || draft.channelIds.some((id) => !stored.has(id));
}

/** Channels the picker offers: anything a person can write in or under; categories become group headings. */
export type DiscordChannelGroup = Readonly<{
  channels: readonly Readonly<{ id: string; kind: string; name: string }>[];
  id: string | null;
  name: string | null;
}>;

export function discordChannelGroups(options: DiscordChannelOptions["channels"], query: string): DiscordChannelGroup[] {
  const needle = query.trim().replace(/^#/u, "").toLocaleLowerCase("en");
  const categories = new Map(options.filter((channel) => channel.kind === "category").map((channel) => [channel.id, channel.name]));
  const groups = new Map<string | null, { id: string | null; name: string | null; channels: { id: string; kind: string; name: string }[] }>();
  for (const channel of options) {
    if (channel.kind === "category") continue;
    if (needle && !channel.name.toLocaleLowerCase("en").includes(needle)) continue;
    const parent = channel.parentId && categories.has(channel.parentId) ? channel.parentId : null;
    const group = groups.get(parent) ?? { channels: [], id: parent, name: parent ? categories.get(parent)! : null };
    group.channels.push({ id: channel.id, kind: channel.kind, name: channel.name });
    groups.set(parent, group);
  }
  // Uncategorized channels lead, as in Discord's own list; the server's channel order is kept inside a group.
  return [...groups.values()].sort((left, right) => (left.id === null ? -1 : right.id === null ? 1 : 0));
}

export type DiscordLimitsDraft = Readonly<Record<keyof DiscordLimits, string>>;

export function discordLimitsDraft(limits: DiscordLimits): DiscordLimitsDraft {
  return {
    parallelThreads: String(limits.parallelThreads),
    perAuthorDaily: String(limits.perAuthorDaily),
    perAuthorHourly: String(limits.perAuthorHourly),
    perThreadHourly: String(limits.perThreadHourly)
  };
}

/** The limits to save, or which field is wrong; the bounds are the contract's. */
export function parseDiscordLimits(draft: DiscordLimitsDraft):
  | Readonly<{ limits: DiscordLimits; ok: true }>
  | Readonly<{ field: keyof DiscordLimits; message: string; ok: false }> {
  const values: Record<string, number> = {};
  for (const [field, raw] of Object.entries(draft) as [keyof DiscordLimits, string][]) {
    const text = raw.trim();
    if (!/^[0-9]{1,6}$/u.test(text)) return { field, message: "Enter a whole number.", ok: false };
    values[field] = Number(text);
  }
  const parsed = discordLimitsSchema.safeParse(values);
  if (parsed.success) {
    if (parsed.data.perAuthorDaily < parsed.data.perAuthorHourly) {
      return { field: "perAuthorDaily", message: "The daily limit cannot be lower than the hourly one.", ok: false };
    }
    return { limits: parsed.data, ok: true };
  }
  const issue = parsed.error.issues[0]!;
  const field = issue.path[0] as keyof DiscordLimits;
  const max = "maximum" in issue ? Number(issue.maximum) : null;
  return { field, message: max !== null ? `Enter a number from 1 to ${max}.` : "Enter a number of at least 1.", ok: false };
}

export function discordLimitsDirty(draft: DiscordLimitsDraft, limits: DiscordLimits): boolean {
  const stored = discordLimitsDraft(limits);
  return (Object.keys(stored) as (keyof DiscordLimits)[]).some((field) => draft[field].trim() !== stored[field]);
}

/** Ids typed one per line or separated by commas or spaces; duplicates collapse. */
export function parseDiscordIds(text: string):
  | Readonly<{ ids: string[]; ok: true }>
  | Readonly<{ message: string; ok: false }> {
  const parts = text.split(/[\s,]+/u).filter(Boolean);
  const invalid = parts.find((part) => !DISCORD_SNOWFLAKE_PATTERN.test(part));
  if (invalid !== undefined) return { message: "Use Discord ids: numbers only, one per line or separated by commas.", ok: false };
  const ids = [...new Set(parts)];
  if (ids.length > DISCORD_TEST_IDS_MAX) return { message: `Enter at most ${DISCORD_TEST_IDS_MAX} ids.`, ok: false };
  return { ids, ok: true };
}

export function formatDiscordLatency(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  return seconds < 60 ? `${seconds.toFixed(seconds < 10 ? 1 : 0)} s` : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

const OUTCOME_LABELS: Readonly<Record<string, string>> = {
  admitted: "Running",
  claimed: "Received",
  delivered: "Answered",
  failed: "Failed",
  interrupted: "Interrupted",
  unknown: "Unknown"
};

export function discordOutcomeLabel(state: string, kind: string): string {
  if (kind === "refused") return "Refused";
  return OUTCOME_LABELS[state] ?? "Unknown";
}

export function formatDiscordTime(value: string): string {
  const ms = timeMs(value);
  if (ms === null) return "—";
  return new Intl.DateTimeFormat("en", { day: "numeric", hour: "2-digit", minute: "2-digit", month: "short" }).format(new Date(ms));
}

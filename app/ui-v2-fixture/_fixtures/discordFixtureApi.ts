import {
  DISCORD_LIMIT_DEFAULTS,
  DISCORD_SETUP_CHECK_CODES,
  discordMessageLink,
  type DiscordActivityRow,
  type DiscordActivityStats,
  type DiscordAdminActivity,
  type DiscordAdminState,
  type DiscordMonitoringKey,
  type DiscordSetupItem
} from "@/lib/contracts/discord";

/**
 * Synthetic Discord routes for the gallery states: `/api/admin/discord*`
 * answers in the browser, so a state renders without a session, a database or
 * a bot. Every name and snowflake here is made up.
 */
export const DISCORD_ADMIN_FIXTURE_STATES = [
  "not-configured", "token-only", "setup-incomplete", "healthy", "disconnected", "session-limit", "busy-activity"
] as const;
export type DiscordAdminFixtureScenario = (typeof DISCORD_ADMIN_FIXTURE_STATES)[number];

const GUILD = { id: "900000000000000001", name: "Northwind Studio" };
const BOT = { applicationId: "900000000000000100", userId: "900000000000000101", username: "aiqsa_agent" };
const SERVICE_USER_ID = "svc_discord_fixture";
const ASSISTANT = { id: "asst_discord_fixture", name: "Discord agent" };

const CHANNELS = [
  { id: "900000000000000210", kind: "category", name: "Text channels", parentId: null },
  { id: "900000000000000211", kind: "text", name: "general", parentId: "900000000000000210" },
  { id: "900000000000000212", kind: "text", name: "agent-test", parentId: "900000000000000210" },
  { id: "900000000000000213", kind: "announcement", name: "releases", parentId: "900000000000000210" },
  { id: "900000000000000214", kind: "forum", name: "questions", parentId: "900000000000000210" },
  { id: "900000000000000220", kind: "category", name: "Voice", parentId: null },
  { id: "900000000000000221", kind: "voice", name: "standup", parentId: "900000000000000220" },
  { id: "900000000000000230", kind: "text", name: "welcome", parentId: null }
] as const;

function setupItems(failing: Partial<Record<DiscordSetupItem["code"], Pick<DiscordSetupItem, "action" | "status">>>): DiscordSetupItem[] {
  return DISCORD_SETUP_CHECK_CODES.map((code) => ({ action: null, code, status: "ok" as const, ...failing[code] }));
}

function stats(scale: number): DiscordActivityStats {
  return {
    delivered: 38 * scale,
    failed: 2 * scale,
    failuresByCode: scale > 0 ? [{ code: "discord_user_limit", count: scale }, { code: "model_unavailable", count: scale }] : [],
    interrupted: scale > 0 ? 1 : 0,
    latency: scale > 0 ? { p50Ms: 8_400, p95Ms: 41_000 } : { p50Ms: null, p95Ms: null },
    limitHits: { author: scale, key: 0, thread: 0 },
    notFound: 3 * scale,
    ratingsDown: scale,
    ratingsUp: 9 * scale,
    requests: 41 * scale
  };
}

function activityRows(count: number, now: number): DiscordActivityRow[] {
  const authors = ["Alex Rivera", "Sam Lee", "Priya Natarajan", "Jordan Okafor-Whitfield", "test-runner"];
  const channels = [CHANNELS[1], CHANNELS[2], CHANNELS[4]];
  return Array.from({ length: count }, (_, index) => {
    const channel = channels[index % channels.length]!;
    const questionMessageId = `91000000000000${String(index).padStart(4, "0")}`;
    const dm = index % 9 === 7;
    const failed = index % 6 === 2;
    const test = index % 5 === 4;
    return {
      authorId: `92000000000000000${index % authors.length}`,
      authorName: authors[index % authors.length]!,
      channelId: dm ? "930000000000000001" : channel.id,
      channelName: dm ? null : channel.name,
      code: failed ? (index % 12 === 2 ? "discord_user_limit" : "model_unavailable") : null,
      guildId: dm ? null : GUILD.id,
      kind: failed && index % 12 === 2 ? "refused" : "answer",
      latencyMs: failed ? null : 4_000 + ((index * 7_919) % 52_000),
      messageLink: discordMessageLink(dm ? null : GUILD.id, dm ? "930000000000000001" : channel.id, questionMessageId),
      questionMessageId,
      receivedAt: new Date(now - (index + 1) * 11 * 60_000).toISOString(),
      state: failed ? "failed" : index === 0 ? "admitted" : "delivered",
      test
    };
  });
}

function adminState(scenario: DiscordAdminFixtureScenario, now: number): DiscordAdminState {
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const base: DiscordAdminState = {
    assistant: null,
    bot: null,
    channelMode: "only_listed",
    channels: [],
    dmEnabled: false,
    enabled: false,
    guild: null,
    health: { connected: false, lastConnectedAt: null, lastEventAt: null, lastFailureAt: null, lastFailureCode: null },
    limits: { ...DISCORD_LIMIT_DEFAULTS },
    serviceAccount: { status: "missing", userId: null },
    setup: {
      items: setupItems({
        discord_assistant_missing: { action: "select_assistant", status: "blocking" },
        discord_guild_missing: { action: "select_guild", status: "blocking" },
        discord_service_account_missing: { action: "create_service_account", status: "blocking" },
        discord_token_missing: { action: "enter_token", status: "blocking" }
      }),
      ready: false
    },
    testAuthorIds: [],
    testChannelIds: [],
    callNames: [],
    tokenConfigured: false,
    version: 1
  };
  if (scenario === "not-configured") return base;
  const withToken: DiscordAdminState = {
    ...base,
    bot: BOT,
    setup: {
      items: setupItems({
        discord_assistant_missing: { action: "select_assistant", status: "blocking" },
        discord_guild_missing: { action: "select_guild", status: "blocking" },
        discord_service_account_missing: { action: "create_service_account", status: "blocking" }
      }),
      ready: false
    },
    tokenConfigured: true,
    version: 2
  };
  if (scenario === "token-only") return withToken;
  if (scenario === "setup-incomplete") {
    return {
      ...withToken,
      assistant: ASSISTANT,
      channels: [{ id: CHANNELS[2].id, name: CHANNELS[2].name }],
      guild: GUILD,
      serviceAccount: { status: "active", userId: SERVICE_USER_ID },
      setup: {
        items: setupItems({
          discord_mcp_not_granted: { action: "open_mcp_grants", status: "blocking" },
          discord_message_content_disabled: { action: "enter_token", status: "blocking" },
          discord_monthly_budget: { action: "open_usage_limits", status: "warning" },
          discord_search_disabled: { action: "open_assistant", status: "blocking" },
          discord_shared_key: { action: "open_provider_keys", status: "warning" }
        }),
        ready: false
      },
      version: 6
    };
  }
  const configured: DiscordAdminState = {
    ...withToken,
    assistant: ASSISTANT,
    channels: [
      { id: CHANNELS[2].id, name: CHANNELS[2].name },
      { id: CHANNELS[4].id, name: CHANNELS[4].name },
      { id: "900000000000000299", name: null }
    ],
    dmEnabled: true,
    enabled: true,
    guild: GUILD,
    health: { connected: true, lastConnectedAt: ago(3_600_000), lastEventAt: ago(5_000), lastFailureAt: null, lastFailureCode: null },
    serviceAccount: { status: "active", userId: SERVICE_USER_ID },
    setup: { items: setupItems({ discord_shared_key: { action: "open_provider_keys", status: "warning" } }), ready: true },
    testAuthorIds: ["900000000000000501"],
    testChannelIds: [CHANNELS[2].id],
    callNames: ["Agent", "Агент"],
    version: 9
  };
  if (scenario === "disconnected") {
    return {
      ...configured,
      health: {
        connected: false, lastConnectedAt: ago(7_200_000), lastEventAt: ago(7_200_000),
        lastFailureAt: ago(420_000), lastFailureCode: "discord_token_rejected"
      }
    };
  }
  if (scenario === "session-limit") {
    return {
      ...configured,
      health: {
        connected: false, lastConnectedAt: ago(3_600_000), lastEventAt: ago(3_600_000),
        lastFailureAt: ago(900_000), lastFailureCode: "discord_session_limit"
      }
    };
  }
  return configured;
}

function activity(scenario: DiscordAdminFixtureScenario, now: number): DiscordAdminActivity {
  if (scenario === "busy-activity") return { last24h: stats(4), last7d: stats(23), rows: activityRows(50, now) };
  if (scenario === "healthy" || scenario === "disconnected" || scenario === "session-limit") {
    return { last24h: stats(1), last7d: stats(6), rows: activityRows(6, now) };
  }
  return { last24h: stats(0), last7d: stats(0), rows: [] };
}

function monitoringKeys(scenario: DiscordAdminFixtureScenario, now: number): DiscordMonitoringKey[] {
  if (scenario !== "healthy" && scenario !== "busy-activity") return [];
  return [
    { createdAt: new Date(now - 20 * 86_400_000).toISOString(), id: "dmk_fixture_1", lastUsedAt: new Date(now - 60_000).toISOString(), revokedAt: null },
    {
      createdAt: new Date(now - 40 * 86_400_000).toISOString(), id: "dmk_fixture_0",
      lastUsedAt: new Date(now - 21 * 86_400_000).toISOString(), revokedAt: new Date(now - 20 * 86_400_000).toISOString()
    }
  ];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

/** Replaces `fetch` for the Discord admin routes until the returned restore runs. */
export function installDiscordFixtureApi(scenario: DiscordAdminFixtureScenario): () => void {
  const original = window.fetch;
  const now = Date.now();
  let state = adminState(scenario, now);
  let keys = monitoringKeys(scenario, now);
  let keySerial = 2;
  const handle = async (url: URL, init: RequestInit | undefined): Promise<Response | null> => {
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;
    if (path === "/api/admin/discord") {
      if (method === "PATCH") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
        if (body.expectedVersion !== state.version) return json({ error: "discord_control_stale" }, 409);
        if (body.action === "test_and_save") {
          if (String(body.token).includes("reject")) return json({ error: "discord_token_rejected" }, 422);
          state = { ...state, bot: BOT, tokenConfigured: true };
        }
        if (body.action === "enable" && !state.setup.ready) return json({ error: "discord_setup_incomplete" }, 409);
        if (body.action === "enable" || body.action === "disable") state = { ...state, enabled: body.action === "enable" };
        if (body.action === "set_direct_messages") state = { ...state, dmEnabled: Boolean(body.dmEnabled) };
        if (body.action === "set_guild") state = { ...state, channels: [], guild: GUILD };
        if (body.action === "set_channels") {
          const ids = body.channelIds as string[];
          state = {
            ...state,
            channelMode: body.channelMode as DiscordAdminState["channelMode"],
            channels: ids.map((id) => ({ id, name: CHANNELS.find((channel) => channel.id === id)?.name ?? null }))
          };
        }
        if (body.action === "create_service_account") state = { ...state, serviceAccount: { status: "active", userId: SERVICE_USER_ID } };
        if (body.action === "set_assistant") state = { ...state, assistant: ASSISTANT };
        if (body.action === "set_limits") state = { ...state, limits: body.limits as DiscordAdminState["limits"] };
        if (body.action === "set_call_names") state = { ...state, callNames: body.callNames as string[] };
        if (body.action === "set_test_access") {
          state = { ...state, testAuthorIds: body.testAuthorIds as string[], testChannelIds: body.testChannelIds as string[] };
        }
        state = { ...state, version: state.version + 1 };
      }
      return json(state);
    }
    if (path === "/api/admin/discord/guilds") return json({ guilds: [GUILD, { id: "900000000000000002", name: "Northwind Playground" }] });
    if (path === "/api/admin/discord/channels") return json({ channels: url.searchParams.get("guildId") === GUILD.id ? CHANNELS : [] });
    if (path === "/api/admin/discord/assistants") {
      return json({ assistants: [ASSISTANT, { id: "asst_research_fixture", name: "Research helper" }] });
    }
    if (path === "/api/admin/discord/activity") return json(activity(scenario, now));
    if (path === "/api/admin/discord/monitoring-keys") {
      if (method === "POST") {
        const key: DiscordMonitoringKey = { createdAt: new Date().toISOString(), id: `dmk_fixture_${keySerial++}`, lastUsedAt: null, revokedAt: null };
        keys = [key, ...keys];
        return json({ key, secret: "aiqsa_dmk_FixtureOnlyKey0123456789abcdefghijklmnopqrstuv" });
      }
      return json({ keys });
    }
    if (path.startsWith("/api/admin/discord/monitoring-keys/") && method === "DELETE") {
      const id = decodeURIComponent(path.slice("/api/admin/discord/monitoring-keys/".length));
      keys = keys.map((key) => key.id === id ? { ...key, revokedAt: new Date().toISOString() } : key);
      return json({ keys });
    }
    return null;
  };
  window.fetch = async (request: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url;
    const url = new URL(raw, window.location.origin);
    const answer = url.origin === window.location.origin ? await handle(url, init) : null;
    return answer ?? original(request, init);
  };
  return () => {
    window.fetch = original;
  };
}

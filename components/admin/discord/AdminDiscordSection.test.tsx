import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DISCORD_LIMIT_DEFAULTS,
  DISCORD_SETUP_CHECK_CODES,
  discordAdminStateSchema,
  discordMessageLink,
  type DiscordAdminState,
  type DiscordSetupItem
} from "@/lib/contracts/discord";
import type { AdminConfirmationRequest } from "@/components/admin/useAdminConfirmationController";
import { AdminDiscordSection } from "./AdminDiscordSection";

const TOKEN = "MTAwMDAwMDAwMDAwMDAwMDAx.GaBcDe.abcdefghijklmnopqrstuvwxyz0123";
const GUILD = { id: "100000000000000010", name: "Fixture server" };
const OTHER_GUILD = { id: "100000000000000011", name: "Second server" };
const CHANNEL_A = { id: "100000000000000021", kind: "text", name: "general", parentId: null };
const CHANNEL_B = { id: "100000000000000022", kind: "text", name: "agent-test", parentId: null };
const SECRET = "aiqsa_dmk_abcdefghijklmnopqrstuvwxyz012345";
const emptyStats = {
  delivered: 0, failed: 0, failuresByCode: [], interrupted: 0, latency: { p50Ms: null, p95Ms: null },
  limitHits: { author: 0, key: 0, thread: 0 }, notFound: 0, ratingsDown: 0, ratingsUp: 0, requests: 0
};

function okItems(overrides: Partial<Record<DiscordSetupItem["code"], Pick<DiscordSetupItem, "action" | "status">>> = {}) {
  return DISCORD_SETUP_CHECK_CODES.map((code) => ({ action: null, code, status: "ok", ...overrides[code] }));
}

function adminState(overrides: Partial<DiscordAdminState> = {}): DiscordAdminState {
  // Every fixture is a valid wire value, so the section is tested against the contract.
  return discordAdminStateSchema.parse({
    activity: { last24h: emptyStats, last7d: emptyStats, rows: [] },
    assistant: { id: "asst_one", name: "Discord agent" },
    bot: { applicationId: "100000000000000001", userId: "100000000000000002", username: "fixture_bot" },
    channelMode: "only_listed",
    channels: [{ id: CHANNEL_A.id, name: CHANNEL_A.name }],
    dmEnabled: false,
    enabled: true,
    guild: GUILD,
    health: { connected: true, lastConnectedAt: new Date().toISOString(), lastEventAt: new Date().toISOString(), lastFailureAt: null, lastFailureCode: null },
    limits: DISCORD_LIMIT_DEFAULTS,
    monitoringKeys: [],
    serviceAccount: { status: "active", userId: "svc_discord" },
    setup: { items: okItems(), ready: true },
    testAuthorIds: [],
    testChannelIds: [],
    tokenConfigured: true,
    version: 7,
    ...overrides
  });
}

type Call = { body: Record<string, unknown> | null; method: string; url: string };
type Patch = (body: Record<string, unknown>, state: { current: DiscordAdminState }) => Response;

const accept: Patch = (body, state) => {
  state.current = adminState({ ...state.current, version: state.current.version + 1 });
  return Response.json(state.current);
};

function mockFetch(initial: DiscordAdminState, patch: Patch = accept) {
  const state = { current: initial };
  const calls: Call[] = [];
  let keys = [{ createdAt: "2026-11-01T10:00:00.000Z", id: "dmk_old", lastUsedAt: null, revokedAt: null }];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ body, method, url });
    if (url === "/api/admin/discord") return method === "GET" ? Response.json(state.current) : patch(body ?? {}, state);
    if (url === "/api/admin/discord/guilds") return Response.json({ guilds: [GUILD, OTHER_GUILD] });
    if (url.startsWith("/api/admin/discord/channels?")) return Response.json({ channels: [CHANNEL_A, CHANNEL_B] });
    if (url === "/api/admin/discord/assistants") {
      return Response.json({ assistants: [{ id: "asst_one", name: "Discord agent" }, { id: "asst_two", name: "Research helper" }] });
    }
    if (url === "/api/admin/discord/activity") {
      return Response.json({
        last24h: { ...emptyStats, delivered: 3, requests: 4 },
        last7d: emptyStats,
        rows: [{
          authorId: "100000000000000301", authorName: "Alex Rivera", channelId: CHANNEL_B.id, channelName: CHANNEL_B.name,
          code: null, guildId: GUILD.id, kind: "answer", latencyMs: 8_400,
          messageLink: discordMessageLink(GUILD.id, CHANNEL_B.id, "100000000000000401"),
          questionMessageId: "100000000000000401", receivedAt: "2026-11-12T10:00:00.000Z", state: "delivered", test: true
        }]
      });
    }
    if (url === "/api/admin/discord/monitoring-keys") {
      if (method === "POST") {
        const key = { createdAt: "2026-11-12T11:00:00.000Z", id: "dmk_new", lastUsedAt: null, revokedAt: null };
        keys = [key, ...keys];
        return Response.json({ key, secret: SECRET });
      }
      return Response.json({ keys });
    }
    if (url.startsWith("/api/admin/discord/monitoring-keys/") && method === "DELETE") {
      keys = keys.map((key) => (url.endsWith(key.id) ? { ...key, revokedAt: "2026-11-12T11:30:00.000Z" } : key));
      return Response.json({ keys });
    }
    return Response.json({ error: "unexpected_request" }, { status: 500 });
  });
  return { calls, patches: () => calls.filter((call) => call.method === "PATCH").map((call) => call.body), state };
}

function renderSection() {
  const feedback = { reportError: vi.fn(), reportNotice: vi.fn() };
  const onNavigateSection = vi.fn();
  const confirmations: AdminConfirmationRequest[] = [];
  render(
    <AdminDiscordSection
      feedback={feedback}
      onNavigateSection={onNavigateSection}
      requestConfirmation={(config) => confirmations.push(config)}
    />
  );
  return { confirmations, feedback, onNavigateSection };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AdminDiscordSection", () => {
  it("shows a healthy bot as Connected and disables it with the version it read", async () => {
    const { patches } = mockFetch(adminState({ version: 9 }));
    renderSection();

    expect(await screen.findByTestId("discord-bot-status")).toHaveTextContent("Connected");
    expect(screen.getByTestId("discord-bot-username")).toHaveTextContent("@fixture_bot");
    expect(screen.getByTestId("discord-setup-summary")).toHaveTextContent("Ready");
    fireEvent.click(screen.getByTestId("discord-disable"));

    await waitFor(() => expect(patches()).toEqual([{ action: "disable", expectedVersion: 9 }]));
  });

  it("sends every setting with the version the page last read", async () => {
    const { patches } = mockFetch(adminState({ version: 1 }));
    renderSection();
    await screen.findByTestId("discord-bot-status");
    const settle = async (count: number) => waitFor(() => expect(patches()).toHaveLength(count));

    fireEvent.change(screen.getByLabelText("Bot token"), { target: { value: ` ${TOKEN} ` } });
    fireEvent.click(screen.getByTestId("discord-test-and-save"));
    await settle(1);
    expect(screen.getByLabelText("Bot token")).toHaveValue("");

    await waitFor(() => expect(screen.getByTestId("discord-guild-select")).toBeEnabled());
    fireEvent.change(screen.getByTestId("discord-guild-select"), { target: { value: OTHER_GUILD.id } });
    fireEvent.click(screen.getByTestId("discord-save-guild"));
    await settle(2);

    fireEvent.click(await screen.findByRole("checkbox", { name: "#agent-test" }));
    fireEvent.click(screen.getByTestId("discord-channel-mode-all_except"));
    fireEvent.click(screen.getByTestId("discord-save-channels"));
    await settle(3);

    fireEvent.click(screen.getByTestId("discord-dm-switch"));
    await settle(4);

    await waitFor(() => expect(screen.getByTestId("discord-assistant-select")).toBeEnabled());
    fireEvent.change(screen.getByTestId("discord-assistant-select"), { target: { value: "asst_two" } });
    fireEvent.click(screen.getByTestId("discord-save-assistant"));
    await settle(5);

    fireEvent.change(screen.getByTestId("discord-limit-perAuthorHourly"), { target: { value: "30" } });
    fireEvent.change(screen.getByTestId("discord-limit-parallelThreads"), { target: { value: "8" } });
    fireEvent.click(screen.getByTestId("discord-save-limits"));
    await settle(6);

    fireEvent.change(screen.getByTestId("discord-test-authors"), { target: { value: "100000000000000501, 100000000000000501" } });
    fireEvent.change(screen.getByTestId("discord-test-channels"), { target: { value: CHANNEL_B.id } });
    fireEvent.click(screen.getByTestId("discord-save-test-mode"));
    await settle(7);

    expect(patches()).toEqual([
      { action: "test_and_save", expectedVersion: 1, token: TOKEN },
      { action: "set_guild", expectedVersion: 2, guildId: OTHER_GUILD.id },
      { action: "set_channels", channelIds: [CHANNEL_A.id, CHANNEL_B.id], channelMode: "all_except", expectedVersion: 3 },
      { action: "set_direct_messages", dmEnabled: true, expectedVersion: 4 },
      { action: "set_assistant", assistantId: "asst_two", expectedVersion: 5 },
      { action: "set_limits", expectedVersion: 6, limits: { ...DISCORD_LIMIT_DEFAULTS, parallelThreads: 8, perAuthorHourly: 30 } },
      { action: "set_test_access", expectedVersion: 7, testAuthorIds: ["100000000000000501"], testChannelIds: [CHANNEL_B.id] }
    ]);
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it("creates the missing service account from the section", async () => {
    const { patches } = mockFetch(adminState({
      assistant: null,
      serviceAccount: { status: "missing", userId: null },
      setup: { items: okItems({ discord_service_account_missing: { action: "create_service_account", status: "blocking" } }), ready: false }
    }));
    renderSection();

    expect(await screen.findByTestId("discord-assistant-select")).toBeDisabled();
    fireEvent.click(screen.getByTestId("discord-create-service-account"));
    await waitFor(() => expect(patches()).toEqual([{ action: "create_service_account", expectedVersion: 7 }]));
  });

  it("lists setup items with their reason and action and keeps Enable off while one blocks", async () => {
    mockFetch(adminState({
      enabled: false,
      setup: {
        items: okItems({
          discord_mcp_not_granted: { action: "open_mcp_grants", status: "blocking" },
          discord_message_content_disabled: { action: "enter_token", status: "blocking" },
          discord_shared_key: { action: "open_provider_keys", status: "warning" }
        }),
        ready: false
      }
    }));
    const { onNavigateSection } = renderSection();

    expect(await screen.findByTestId("discord-enable")).toBeDisabled();
    expect(screen.getByTestId("discord-enable")).toHaveAccessibleDescription("Finish the setup checklist first.");
    expect(screen.getByTestId("discord-setup-summary")).toHaveTextContent("2 items block Enable");
    const items = within(screen.getByTestId("discord-setup-items")).getAllByRole("listitem");
    expect(items.map((item) => item.dataset.code).slice(0, 3)).toEqual([
      "discord_message_content_disabled", "discord_mcp_not_granted", "discord_shared_key"
    ]);
    expect(items[0]).toHaveTextContent("Turn on Message Content Intent under Bot → Privileged Gateway Intents");

    fireEvent.click(within(items[0]!).getByRole("button", { name: "Enter token" }));
    expect(screen.getByLabelText("Bot token")).toHaveFocus();

    fireEvent.click(within(items[1]!).getByRole("link", { name: "Open MCP servers" }));
    expect(onNavigateSection).toHaveBeenCalledWith("mcp", null);
  });

  it("shows an Enable refusal with its reason and a way to the checklist", async () => {
    mockFetch(adminState({ enabled: false }), () => Response.json({ error: "discord_setup_incomplete" }, { status: 409 }));
    const { feedback } = renderSection();

    fireEvent.click(await screen.findByTestId("discord-enable"));
    const refusal = await screen.findByTestId("discord-enable-refusal");
    expect(refusal).toHaveTextContent("The setup checklist below has unfinished items.");
    expect(feedback.reportError).toHaveBeenCalled();
    fireEvent.click(within(refusal).getByRole("button", { name: "Review setup" }));
    expect(screen.getByRole("heading", { name: "Setup" })).toHaveFocus();
    expect(screen.queryByTestId("discord-stale")).toBeNull();
  });

  it("raises the reload prompt on a stale version and keeps the unsaved input", async () => {
    const { calls } = mockFetch(adminState({ version: 3 }), (_body, state) => {
      state.current = adminState({ limits: { ...DISCORD_LIMIT_DEFAULTS, perThreadHourly: 90 }, version: 4 });
      return Response.json({ error: "discord_control_stale" }, { status: 409 });
    });
    renderSection();
    const hourly = await screen.findByTestId("discord-limit-perAuthorHourly");

    fireEvent.change(hourly, { target: { value: "25" } });
    fireEvent.click(screen.getByTestId("discord-save-limits"));
    const prompt = await screen.findByTestId("discord-stale");
    expect(prompt).toHaveTextContent("Another administrator changed the Discord settings.");
    expect(hourly).toHaveValue("25");

    const reads = calls.filter((call) => call.url === "/api/admin/discord" && call.method === "GET").length;
    fireEvent.click(within(prompt).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.queryByTestId("discord-stale")).toBeNull());
    expect(calls.filter((call) => call.url === "/api/admin/discord" && call.method === "GET").length).toBe(reads + 1);
    expect(screen.getByTestId("discord-limit-perThreadHourly")).toHaveValue("90");
    expect(hourly).toHaveValue("25");
  });

  it("names a disconnect and offers the token fix", async () => {
    mockFetch(adminState({
      health: {
        connected: false, lastConnectedAt: null, lastEventAt: null,
        lastFailureAt: new Date().toISOString(), lastFailureCode: "discord_token_rejected"
      }
    }));
    renderSection();

    expect(await screen.findByTestId("discord-bot-status")).toHaveTextContent("Disconnected");
    expect(screen.getByTestId("discord-bot-health")).toHaveTextContent("Discord rejected the bot token.");
    fireEvent.click(screen.getByTestId("discord-status-action"));
    expect(screen.getByLabelText("Bot token")).toHaveFocus();
  });

  it("shows a new monitoring key once and revokes a key after confirmation", async () => {
    const { calls } = mockFetch(adminState());
    const { confirmations } = renderSection();

    const create = await screen.findByTestId("discord-create-key");
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);
    expect(await screen.findByTestId("discord-key-secret")).toHaveValue(SECRET);
    fireEvent.click(screen.getByTestId("discord-key-done"));
    await waitFor(() => expect(screen.queryByTestId("discord-key-created")).toBeNull());
    expect(document.body.innerHTML).not.toContain(SECRET);

    const list = await screen.findByTestId("discord-key-list");
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(2));
    fireEvent.click(within(list).getAllByRole("button", { name: /^Revoke key created/u })[1]!);
    expect(confirmations).toHaveLength(1);
    await act(async () => {
      await confirmations[0]!.onConfirm();
    });
    expect(calls.some((call) => call.method === "DELETE" && call.url === "/api/admin/discord/monitoring-keys/dmk_old")).toBe(true);
    expect(within(list).getAllByText("Revoked")).toHaveLength(1);
  });

  it("lists recent questions with their Discord link and test mark, never message text", async () => {
    mockFetch(adminState());
    renderSection();

    const rows = await screen.findByTestId("discord-activity-rows");
    const link = within(rows).getByRole("link");
    expect(link).toHaveAttribute("href", `https://discord.com/channels/${GUILD.id}/${CHANNEL_B.id}/100000000000000401`);
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(rows).toHaveTextContent("Alex Rivera");
    expect(rows).toHaveTextContent("Test");
    expect(rows).toHaveTextContent("#agent-test");
    expect(rows).toHaveTextContent("Answered");
  });
});

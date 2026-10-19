import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminGroup } from "@/lib/contracts/admin";
import { telegramAdminStateSchema, type TelegramAdminState } from "@/lib/contracts/telegram";
import { AdminTelegramSection } from "./AdminTelegramSection";

const TOKEN = "123456789:AAEexampleSecretPart_abcdefghijk";
const GROUP_A = "11111111-1111-4111-8111-111111111111";
const GROUP_B = "22222222-2222-4222-8222-222222222222";
const ARCHIVED = "33333333-3333-4333-8333-333333333333";

function group(id: string, name: string, archivedAt: string | null = null): AdminGroup {
  return { accessGrants: [], archivedAt, id, name, systemRole: null, userCount: 3 };
}

const groups = [group(GROUP_A, "Research"), group(GROUP_B, "Support"), group(ARCHIVED, "Old team", "2026-01-01T00:00:00.000Z")];

function adminState(overrides: Partial<TelegramAdminState> = {}): TelegramAdminState {
  // Every fixture is a valid wire value, so the section is tested against the contract.
  return telegramAdminStateSchema.parse({
    botUsername: null,
    enabled: false,
    groupIds: [],
    health: { lastFailureAt: null, lastFailureCode: null, lastPollAt: null, lastSuccessAt: null },
    restricted: false,
    tokenConfigured: false,
    version: 1,
    ...overrides
  });
}

type Call = { body: Record<string, unknown> | null; method: string; url: string };

function mockFetch(initial: TelegramAdminState, patch: (body: Record<string, unknown>, state: { current: TelegramAdminState }) => Response) {
  const state = { current: initial };
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ body, method, url });
    if (url !== "/api/admin/telegram") return Response.json({ error: "unexpected_request" }, { status: 500 });
    if (method === "GET") return Response.json(state.current);
    return patch(body ?? {}, state);
  });
  return { calls, state };
}

function renderSection() {
  const feedback = { reportError: vi.fn(), reportNotice: vi.fn() };
  render(<AdminTelegramSection feedback={feedback} groups={groups} />);
  return feedback;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("AdminTelegramSection", () => {
  it("starts off without a token: Enable waits for Test & Save and the help names BotFather and /setjoingroups", async () => {
    mockFetch(adminState(), () => Response.json({}, { status: 500 }));
    renderSection();

    expect(await screen.findByTestId("telegram-bot-status")).toHaveTextContent("Not set up");
    expect(screen.getByTestId("telegram-enable")).toBeDisabled();
    const token = screen.getByLabelText("Bot token");
    expect(token).toHaveAttribute("type", "password");
    expect(token).toHaveAccessibleDescription(expect.stringContaining(
      "Create a bot in @BotFather, paste its token here. Turn off group joining with /setjoingroups → Disable."
    ));
    expect(screen.getByRole("radio", { name: /Everyone/u })).toBeChecked();
  });

  it("tests and saves a token, shows the bot's username and never echoes the token back", async () => {
    const { calls } = mockFetch(adminState(), (body, state) => {
      state.current = adminState({ botUsername: "aiqsa_team_bot", tokenConfigured: true, version: 2 });
      expect(body).toEqual({ action: "test_and_save", expectedVersion: 1, token: TOKEN });
      return Response.json(state.current);
    });
    renderSection();
    const token = await screen.findByLabelText("Bot token");

    fireEvent.change(token, { target: { value: ` ${TOKEN} ` } });
    fireEvent.click(screen.getByTestId("telegram-test-and-save"));

    expect(await screen.findByTestId("telegram-test-result")).toHaveTextContent("Bot found. The token is saved. Connected to @aiqsa_team_bot.");
    expect(token).toHaveValue("");
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(document.body.innerHTML).not.toContain("SecretPart");
    expect(screen.getByTestId("telegram-bot-username")).toHaveTextContent("@aiqsa_team_bot");
    expect(screen.getByTestId("telegram-enable")).toBeEnabled();
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
  });

  it("refuses a malformed token locally and shows Telegram's refusal with the token kept", async () => {
    const { calls } = mockFetch(adminState(), () => Response.json({ error: "telegram_token_rejected" }, { status: 422 }));
    renderSection();
    const token = await screen.findByLabelText("Bot token");

    fireEvent.change(token, { target: { value: "not-a-token" } });
    fireEvent.click(screen.getByTestId("telegram-test-and-save"));
    expect(token).toHaveAccessibleDescription(expect.stringContaining("This is not a bot token."));
    expect(token).toHaveFocus();
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);

    fireEvent.change(token, { target: { value: TOKEN } });
    fireEvent.click(screen.getByTestId("telegram-test-and-save"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Telegram rejected the bot token. Create a new token in @BotFather and use Test & Save.");
    expect(token).toHaveValue(TOKEN);
  });

  it("reloads after a stale version and keeps the unsaved token for another try", async () => {
    const { calls } = mockFetch(adminState({ version: 3 }), (_body, state) => {
      state.current = adminState({ botUsername: "other_admin_bot", tokenConfigured: true, version: 4 });
      return Response.json({ error: "telegram_control_stale" }, { status: 409 });
    });
    renderSection();
    const token = await screen.findByLabelText("Bot token");

    fireEvent.change(token, { target: { value: TOKEN } });
    fireEvent.click(screen.getByTestId("telegram-test-and-save"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Telegram settings changed elsewhere. The page was refreshed; review and try again.");
    expect(await screen.findByTestId("telegram-bot-username")).toHaveTextContent("@other_admin_bot");
    expect(token).toHaveValue(TOKEN);
    expect(calls.find((call) => call.method === "PATCH")?.body).toMatchObject({ expectedVersion: 3 });
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(2);
  });

  it("enables and disables with the version it read and shows poll health", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-19T12:00:10.000Z"), toFake: ["Date"] });
    const enabled = adminState({
      botUsername: "aiqsa_team_bot",
      enabled: true,
      health: { lastFailureAt: null, lastFailureCode: null, lastPollAt: "2026-10-19T12:00:05.000Z", lastSuccessAt: "2026-10-19T12:00:05.000Z" },
      tokenConfigured: true,
      version: 6
    });
    const { calls } = mockFetch(adminState({ botUsername: "aiqsa_team_bot", tokenConfigured: true, version: 5 }), (body, state) => {
      state.current = body.action === "enable" ? enabled : adminState({ botUsername: "aiqsa_team_bot", tokenConfigured: true, version: 7 });
      return Response.json(state.current);
    });
    const feedback = renderSection();

    fireEvent.click(await screen.findByTestId("telegram-enable"));
    await waitFor(() => expect(screen.getByTestId("telegram-bot-health")).toHaveTextContent("Polling · last update 5 s ago"));
    expect(screen.getByTestId("telegram-bot-status")).toHaveTextContent("On");
    expect(feedback.reportNotice).toHaveBeenCalledWith("The Telegram bot is on.");

    fireEvent.click(screen.getByTestId("telegram-disable"));
    expect(await screen.findByTestId("telegram-enable")).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "PATCH").map((call) => call.body)).toEqual([
      { action: "enable", expectedVersion: 5 },
      { action: "disable", expectedVersion: 6 }
    ]);
  });

  it("shows the latest poll failure as attention", async () => {
    mockFetch(adminState({
      enabled: true,
      health: {
        lastFailureAt: "2026-10-19T12:00:00.000Z",
        lastFailureCode: "telegram_poll_conflict",
        lastPollAt: "2026-10-19T12:00:00.000Z",
        lastSuccessAt: "2026-10-19T11:00:00.000Z"
      },
      tokenConfigured: true
    }), () => Response.json({}, { status: 500 }));
    renderSection();

    expect(await screen.findByTestId("telegram-bot-status")).toHaveTextContent("Attention");
    expect(screen.getByTestId("telegram-bot-health")).toHaveTextContent("Another program is reading this bot's updates.");
    // A restart or deploy overlap is named first, so a transient conflict does not send the administrator to rotate the token.
    expect(screen.getByTestId("telegram-bot-health")).toHaveTextContent(/second AIQSA instance during a restart or deploy.*if it persists/u);
  });

  it("opens Telegram to selected groups, requires one, and drops archived groups on save", async () => {
    const { calls } = mockFetch(adminState({ groupIds: [ARCHIVED], restricted: true, version: 2 }), (body, state) => {
      state.current = adminState({ groupIds: body.groupIds as string[], restricted: true, version: 3 });
      return Response.json(state.current);
    });
    renderSection();
    const form = await screen.findByTestId("telegram-access-form");

    expect(within(form).getByRole("radio", { name: /Selected groups/u })).toBeChecked();
    expect(within(form).getByTestId("telegram-access-unavailable-groups")).toHaveTextContent("1 selected group is archived or deleted");
    expect(within(form).queryByRole("checkbox", { name: "Old team" })).not.toBeInTheDocument();

    fireEvent.click(within(form).getByRole("radio", { name: /Everyone/u }));
    fireEvent.click(within(form).getByRole("radio", { name: /Selected groups/u }));
    fireEvent.click(within(form).getByRole("checkbox", { name: "Support" }));
    fireEvent.click(within(form).getByRole("checkbox", { name: "Support" }));
    fireEvent.click(within(form).getByTestId("telegram-save-access"));
    expect(await within(form).findByRole("alert")).toHaveTextContent("Choose at least one group, or choose Everyone.");
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);

    fireEvent.click(within(form).getByRole("checkbox", { name: "Research" }));
    fireEvent.click(within(form).getByTestId("telegram-save-access"));
    await waitFor(() => expect(within(form).getByRole("status")).toHaveTextContent("Access is checked on every message"));
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
      action: "set_access", expectedVersion: 2, groupIds: [GROUP_A], restricted: true
    });
  });

  it("keeps the access choice through a stale save", async () => {
    mockFetch(adminState({ version: 8 }), (_body, state) => {
      state.current = adminState({ version: 9 });
      return Response.json({ error: "telegram_control_stale" }, { status: 409 });
    });
    renderSection();
    const form = await screen.findByTestId("telegram-access-form");

    fireEvent.click(within(form).getByRole("radio", { name: /Selected groups/u }));
    fireEvent.click(within(form).getByRole("checkbox", { name: "Research" }));
    fireEvent.click(within(form).getByTestId("telegram-save-access"));

    expect(await within(form).findByRole("alert")).toHaveTextContent("Telegram settings changed elsewhere.");
    await act(async () => undefined);
    expect(within(form).getByRole("radio", { name: /Selected groups/u })).toBeChecked();
    expect(within(form).getByRole("checkbox", { name: "Research" })).toBeChecked();
    expect(within(form).getByTestId("telegram-save-access")).toBeEnabled();
  });

  it("explains a failed load and retries", async () => {
    let fail = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => fail
      ? Response.json({ error: "forbidden" }, { status: 403 })
      : Response.json(adminState()));
    renderSection();

    expect(await screen.findByRole("alert")).toHaveTextContent("Your account no longer has permission to manage Telegram.");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("telegram-bot-status")).toHaveTextContent("Not set up");
  });
});

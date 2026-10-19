import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  telegramLinkCodeResponseSchema,
  telegramUserStatusSchema,
  type TelegramLinkCodeResponse,
  type TelegramUserStatus
} from "@/lib/contracts/telegram";
import { TELEGRAM_LINK_POLL_MS, TelegramConnectionSection } from "./TelegramConnectionSection";

const START = Date.parse("2026-10-19T12:00:00.000Z");
const DEEP_LINK = "https://t.me/aiqsa_team_bot?start=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";

function status(value: TelegramUserStatus): TelegramUserStatus {
  return telegramUserStatusSchema.parse(value);
}

function linkCode(expiresInMs: number): TelegramLinkCodeResponse {
  return telegramLinkCodeResponseSchema.parse({ deepLink: DEEP_LINK, expiresAt: new Date(START + expiresInMs).toISOString() });
}

const notLinked = status({ available: true, state: "not_linked" });
const linked = status({ available: true, linkedAt: "2026-10-19T12:00:05.000Z", state: "linked", telegramUsername: "alex" });

type Route = (method: string, url: string) => Response | undefined;

function mockFetch(route: Route) {
  const calls: { method: string; url: string }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    return route(method, url) ?? Response.json({ error: "unexpected_request" }, { status: 500 });
  });
  return calls;
}

const statusReads = (calls: { method: string; url: string }[]) =>
  calls.filter((call) => call.method === "GET" && call.url === "/api/me/telegram").length;

function useClock() {
  // Real timeouts keep Testing Library's waits working; the poll interval and the clock are driven by the test.
  vi.useFakeTimers({ now: START, toFake: ["setInterval", "clearInterval", "Date"] });
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("TelegramConnectionSection", () => {
  it("renders nothing when Telegram is not open to an unlinked user", async () => {
    const calls = mockFetch(() => Response.json(status({ available: false, state: "not_linked" })));
    const { container } = render(<TelegramConnectionSection />);
    await waitFor(() => expect(statusReads(calls)).toBe(1));
    await act(async () => undefined);
    expect(container).toBeEmptyDOMElement();
  });

  it("connects through a one-time link, polls every 3 s while it is open and stops once Telegram confirms", async () => {
    useClock();
    let current = notLinked;
    const calls = mockFetch((method, url) => {
      if (url === "/api/me/telegram" && method === "GET") return Response.json(current);
      if (url === "/api/me/telegram/link-code" && method === "POST") return Response.json(linkCode(10 * 60_000));
      return undefined;
    });
    render(<TelegramConnectionSection />);

    await waitFor(() => expect(screen.getByTestId("settings-telegram-state")).toHaveTextContent("Not connected"));
    expect(screen.getByTestId("settings-telegram")).not.toHaveTextContent(/privacy|Telegram servers|stored by Telegram/iu);
    fireEvent.click(screen.getByRole("button", { name: "Connect Telegram" }));

    const open = await screen.findByRole("link", { name: "Open Telegram" });
    expect(open).toHaveAttribute("href", DEEP_LINK);
    expect(open).toHaveAttribute("target", "_blank");
    expect(open).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByTestId("settings-telegram-deep-link")).toHaveTextContent(DEEP_LINK);
    expect(screen.getByTestId("settings-telegram-link")).toHaveTextContent("It works once and expires at");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Connect Telegram" })).toHaveFocus());
    expect(screen.queryByRole("button", { name: "Connect Telegram" })).not.toBeInTheDocument();

    await tick(TELEGRAM_LINK_POLL_MS);
    await tick(TELEGRAM_LINK_POLL_MS);
    expect(statusReads(calls)).toBe(3);

    current = linked;
    await tick(TELEGRAM_LINK_POLL_MS);
    await waitFor(() => expect(screen.getByTestId("settings-telegram-state")).toHaveTextContent(/^Connected as @alex since .+$/u));
    expect(screen.queryByTestId("settings-telegram-link")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Connected as @alex since");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Telegram" })).toHaveFocus());

    await tick(TELEGRAM_LINK_POLL_MS * 3);
    expect(statusReads(calls)).toBe(4);
  });

  it("stops polling when the link expires and offers a new one", async () => {
    useClock();
    const calls = mockFetch((method, url) => {
      if (url === "/api/me/telegram") return Response.json(notLinked);
      if (url === "/api/me/telegram/link-code") return Response.json(linkCode(7_000));
      return undefined;
    });
    render(<TelegramConnectionSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Telegram" }));
    await screen.findByRole("link", { name: "Open Telegram" });

    await tick(TELEGRAM_LINK_POLL_MS * 3);
    expect(await screen.findByText("This link has expired. Create a new one.")).toBeInTheDocument();
    const reads = statusReads(calls);
    await tick(TELEGRAM_LINK_POLL_MS * 3);
    expect(statusReads(calls)).toBe(reads);

    fireEvent.click(screen.getByRole("button", { name: "Create a new link" }));
    expect(await screen.findByRole("link", { name: "Open Telegram" })).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(2);
  });

  it("polls for at most 10 minutes even when the link lives longer", async () => {
    useClock();
    const calls = mockFetch((method, url) => {
      if (url === "/api/me/telegram") return Response.json(notLinked);
      if (url === "/api/me/telegram/link-code") return Response.json(linkCode(30 * 60_000));
      return undefined;
    });
    render(<TelegramConnectionSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Telegram" }));
    await screen.findByRole("link", { name: "Open Telegram" });

    await tick(10 * 60_000 + TELEGRAM_LINK_POLL_MS);
    expect(await screen.findByText("This link has expired. Create a new one.")).toBeInTheDocument();
    expect(statusReads(calls)).toBeLessThanOrEqual(1 + (10 * 60_000) / TELEGRAM_LINK_POLL_MS);
  });

  it("closes the link step with Cancel or Escape and returns focus to Connect", async () => {
    mockFetch((method, url) => {
      if (url === "/api/me/telegram") return Response.json(notLinked);
      if (url === "/api/me/telegram/link-code") return Response.json(linkCode(10 * 60_000));
      return undefined;
    });
    render(<TelegramConnectionSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Telegram" }));
    await screen.findByRole("link", { name: "Open Telegram" });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Connect Telegram" })).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Connect Telegram" }));
    const open = await screen.findByRole("link", { name: "Open Telegram" });
    fireEvent.keyDown(open, { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Connect Telegram" })).toHaveFocus());
    expect(screen.queryByTestId("settings-telegram-link")).not.toBeInTheDocument();
  });

  it("explains a rate-limited link request", async () => {
    mockFetch((method, url) => {
      if (url === "/api/me/telegram") return Response.json(notLinked);
      if (url === "/api/me/telegram/link-code") return Response.json({ error: "rate_limited" }, { status: 429 });
      return undefined;
    });
    render(<TelegramConnectionSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect Telegram" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many links were created. Try again in a few minutes.");
  });

  it("disconnects after a confirmation and restores focus", async () => {
    const calls = mockFetch((method, url) => {
      if (url !== "/api/me/telegram") return undefined;
      return Response.json(method === "DELETE" ? notLinked : linked);
    });
    render(<TelegramConnectionSection />);
    await waitFor(() => expect(screen.getByTestId("settings-telegram-state")).toHaveTextContent("Connected as @alex since"));

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    const confirm = screen.getByTestId("settings-telegram-disconnect-confirm");
    expect(confirm).toHaveTextContent("Disconnect Telegram? The bot stops answering for your AIQSA account.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Disconnect" })).toHaveFocus());
    fireEvent.keyDown(confirm, { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Disconnect" })).toHaveFocus());
    expect(screen.queryByTestId("settings-telegram-disconnect-confirm")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(screen.getByTestId("settings-telegram-state")).toHaveTextContent("Not connected"));
    expect(screen.getByRole("status")).toHaveTextContent("Telegram disconnected.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Connect Telegram" })).toHaveFocus());
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  });

  it("shows the access-off reason with Disconnect and offers Reconnect after the bot changed", async () => {
    mockFetch(() => Response.json(status({
      available: false, linkedAt: "2026-10-01T12:00:00.000Z", reasonCode: "telegram_access_off", state: "access_off", telegramUsername: "alex"
    })));
    render(<TelegramConnectionSection />);
    await waitFor(() => expect(screen.getByTestId("settings-telegram-state")).toHaveTextContent("Access off for @alex"));
    expect(screen.getByTestId("settings-telegram-status"))
      .toHaveTextContent("Telegram access is off for your account. Ask your AIQSA administrator.");
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Connect/u })).not.toBeInTheDocument();
    cleanup();
    vi.restoreAllMocks();

    mockFetch((method, url) => url === "/api/me/telegram/link-code"
      ? Response.json(linkCode(10 * 60_000))
      : Response.json(status({ available: true, reasonCode: "telegram_bot_changed", state: "bot_changed", telegramUsername: "alex" })));
    render(<TelegramConnectionSection />);
    await waitFor(() => expect(screen.getByTestId("settings-telegram-state")).toHaveTextContent("Reconnect needed"));
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(await screen.findByRole("heading", { name: "Reconnect Telegram" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Telegram" })).toHaveAttribute("href", DEEP_LINK);
  });

  it("treats a failed or malformed status read as unavailable, not as not connected", async () => {
    let answer: Response = Response.json({ available: true, state: "linked", telegramUserId: 42 });
    mockFetch(() => answer);
    render(<TelegramConnectionSection />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Telegram status could not be loaded.");
    expect(screen.queryByRole("button", { name: "Connect Telegram" })).not.toBeInTheDocument();

    answer = Response.json(notLinked);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Connect Telegram" })).toBeInTheDocument();
  });
});

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { telegramAdminUserLinkSchema, type TelegramAdminUserLink } from "@/lib/contracts/telegram";
import { AdminUserTelegram } from "./AdminUserTelegram";

function link(value: TelegramAdminUserLink): TelegramAdminUserLink {
  return telegramAdminUserLinkSchema.parse(value);
}

const linked = link({
  displayName: "Ada Analyst",
  lastSeenAt: "2026-10-18T09:00:00.000Z",
  linkedAt: "2026-10-01T09:00:00.000Z",
  state: "linked",
  telegramUsername: "ada_analyst"
});

function mockFetch(get: () => Response, remove: () => Response = () => Response.json(link({ state: "not_linked" }))) {
  const calls: { method: string; url: string }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    return method === "DELETE" ? remove() : get();
  });
  return calls;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AdminUserTelegram", () => {
  it("shows the linked account, its date and unlinks after a confirmation", async () => {
    const calls = mockFetch(() => Response.json(linked));
    render(<AdminUserTelegram userId="user 1" />);

    expect(await screen.findByTestId("admin-user-telegram-account")).toHaveTextContent("@ada_analyst · Ada Analyst");
    expect(screen.getByTestId("admin-user-telegram-status")).toHaveTextContent(/^Connected · since .+ · last message .+$/u);

    const unlink = screen.getByRole("button", { name: "Unlink" });
    fireEvent.click(unlink);
    const confirm = screen.getByRole("button", { name: "Unlink Telegram" });
    expect(confirm).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Unlink" })).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    fireEvent.click(screen.getByRole("button", { name: "Unlink Telegram" }));
    expect(await screen.findByTestId("admin-user-telegram-empty")).toHaveTextContent("No Telegram account connected.");
    expect(screen.getByRole("status")).toHaveTextContent("Telegram unlinked.");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Telegram" })).toHaveFocus());
    expect(calls).toEqual([
      { method: "GET", url: "/api/admin/telegram/users/user%201" },
      { method: "DELETE", url: "/api/admin/telegram/users/user%201" }
    ]);
  });

  it("reads a missing user as not connected and shows the access-off and bot-changed states", async () => {
    mockFetch(() => Response.json({ error: "not_found" }, { status: 404 }));
    render(<AdminUserTelegram userId="missing" />);
    expect(await screen.findByTestId("admin-user-telegram-empty")).toBeInTheDocument();
    cleanup();
    vi.restoreAllMocks();

    mockFetch(() => Response.json(link({ linkedAt: "2026-10-01T09:00:00.000Z", reasonCode: "telegram_access_off", state: "access_off" })));
    render(<AdminUserTelegram userId="user-2" />);
    expect(await screen.findByTestId("admin-user-telegram-status")).toHaveTextContent("Telegram access is off for this user");
    expect(screen.getByTestId("admin-user-telegram-account")).toHaveTextContent("Telegram account");
    cleanup();
    vi.restoreAllMocks();

    mockFetch(() => Response.json(link({ state: "bot_changed", telegramUsername: "ada_analyst" })));
    render(<AdminUserTelegram userId="user-3" />);
    expect(await screen.findByTestId("admin-user-telegram-status")).toHaveTextContent("the user needs to reconnect");
  });

  it("keeps the link and says why when unlinking fails, and never shows a malformed answer", async () => {
    mockFetch(() => Response.json(linked), () => Response.json({ error: "forbidden" }, { status: 403 }));
    render(<AdminUserTelegram userId="user-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Unlink" }));
    fireEvent.click(screen.getByRole("button", { name: "Unlink Telegram" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your account no longer has permission to manage Telegram.");
    expect(screen.getByTestId("admin-user-telegram-account")).toHaveTextContent("@ada_analyst");
    cleanup();
    vi.restoreAllMocks();

    mockFetch(() => Response.json({ state: "linked", telegramUserId: 42 }));
    render(<AdminUserTelegram userId="user-4" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The Telegram API returned an unexpected response.");
  });
});

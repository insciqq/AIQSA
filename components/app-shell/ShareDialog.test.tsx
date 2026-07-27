import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShareDialog, type ShareDialogTarget } from "./ShareDialog";
import type { ChatSummary } from "./types";

function chatSummary(overrides: Partial<ChatSummary> = {}): ChatSummary {
  return {
    activeLeafMessageId: "message-2",
    createdAt: "2026-07-01T00:00:00.000Z",
    defaultModelId: "gpt-5.5",
    defaultPromptPresetId: null,
    defaultProvider: "openai",
    folderId: null,
    id: "chat-share",
    messageCount: 2,
    title: "Chat to share",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

function target(overrides: Partial<ShareDialogTarget> = {}): ShareDialogTarget {
  return {
    activeLeafMessageId: "message-2",
    chat: chatSummary(),
    ...overrides
  };
}

describe("ShareDialog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lists existing live links and never publishes without the explicit action", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === "/api/chats/chat-share/share") {
        return Response.json({
          shares: [{ createdAt: "2026-07-20T10:00:00.000Z", id: "share-old" }]
        });
      }
      return new Response("", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ShareDialog target={target()} onClose={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: "Share anonymously" })).toBeVisible();
    await waitFor(() => expect(screen.getByTestId("share-links")).toBeVisible());
    expect(screen.getByText("Public link")).toBeVisible();
    expect(screen.getByRole("button", { name: /Revoke link created/ })).toBeEnabled();
    expect(
      (fetchMock.mock.calls as unknown as [string, RequestInit | undefined][]).filter(
        ([, init]) => init?.method === "POST"
      )
    ).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Create public link" })).toBeEnabled();
  });

  it("creates a link only on the explicit action and keeps the URL visible with copy feedback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === "/api/chats/chat-share/share" && init?.method === "POST") {
        return Response.json({
          share: {
            createdAt: "2026-07-27T12:00:00.000Z",
            id: "share-new",
            publicPath: "/s/new-token"
          }
        });
      }
      if (String(url) === "/api/chats/chat-share/share") {
        return Response.json({ shares: [] });
      }
      return new Response("", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ShareDialog target={target()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("share-links-empty")).toBeVisible());

    fireEvent.click(screen.getByRole("button", { name: "Create public link" }));

    await waitFor(() => expect(screen.getByTestId("share-link")).toBeVisible());
    expect(screen.getByTestId("share-link")).toHaveTextContent("Link created and copied");
    expect(screen.getByRole("link")).toHaveAttribute("href", "http://localhost:3000/s/new-token");
    expect(writeText).toHaveBeenCalledWith("http://localhost:3000/s/new-token");
    const createBody = JSON.parse(
      String(
        (fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST")?.[1] as RequestInit).body
      )
    );
    expect(createBody).toEqual({ activeLeafMessageId: "message-2" });
    expect(screen.getByText("Just created")).toBeVisible();
  });

  it("revokes a listed link and removes only that row", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === "/api/chats/chat-share/share" && !init?.method) {
        return Response.json({
          shares: [
            { createdAt: "2026-07-20T10:00:00.000Z", id: "share-a" },
            { createdAt: "2026-07-21T10:00:00.000Z", id: "share-b" }
          ]
        });
      }
      if (href === "/api/shares/share-a/revoke" && init?.method === "POST") {
        return Response.json({ share: { id: "share-a", revoked: true } });
      }
      return new Response("", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ShareDialog target={target()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Revoke link created/ })).toHaveLength(2));

    fireEvent.click(screen.getAllByRole("button", { name: /Revoke link created/ })[0]);

    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /Revoke link created/ })).toHaveLength(1)
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/shares/share-a/revoke", { method: "POST" });
  });

  it("keeps a failed revoke readable and retryable", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === "/api/chats/chat-share/share" && !init?.method) {
        return Response.json({
          shares: [{ createdAt: "2026-07-20T10:00:00.000Z", id: "share-a" }]
        });
      }
      if (href === "/api/shares/share-a/revoke" && init?.method === "POST") {
        return Response.json({ error: "temporary_failure" }, { status: 503 });
      }
      return new Response("", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ShareDialog target={target()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Revoke link created/ })).toBeVisible());

    fireEvent.click(screen.getByRole("button", { name: /Revoke link created/ }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("temporary_failure"));
    expect(screen.getByRole("button", { name: /Revoke link created/ })).toBeEnabled();
  });

  it("disables creation when the chat has no shareable leaf and reports list failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "list_failed" }, { status: 500 }))
    );

    render(
      <ShareDialog target={target({ activeLeafMessageId: null })} onClose={vi.fn()} />
    );

    await waitFor(() => expect(screen.getByText(/list_failed|share_list_failed_500/)).toBeVisible());
    expect(screen.getByRole("button", { name: "Create public link" })).toBeDisabled();
  });

  it("closes through the explicit action and Escape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ shares: [] })));
    const onClose = vi.fn();

    render(<ShareDialog target={target()} onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId("share-links-empty")).toBeVisible());

    fireEvent.click(screen.getByRole("button", { name: "Close share dialog" }));
    expect(onClose).toHaveBeenCalledOnce();

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Share anonymously" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
    const announcement = screen.getByRole("status");
    expect(announcement).toBeEmptyDOMElement();
    await waitFor(() => expect(screen.getByTestId("share-links")).toBeVisible());
    expect(announcement).toHaveTextContent("1 live shared link loaded.");
    expect(screen.getAllByRole("status")).toEqual([announcement]);
    expect(screen.getByText("Public link")).toBeVisible();
    expect(screen.getByRole("button", { name: /Revoke link created/ })).toBeEnabled();
    expect(
      (fetchMock.mock.calls as unknown as [string, RequestInit | undefined][]).filter(
        ([, init]) => init?.method === "POST"
      )
    ).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Create public link" })).toBeEnabled();
  });

  it("waits for the initial link list before allowing share creation", async () => {
    const listResponse = deferred<Response>();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) =>
      init?.method === "POST"
        ? Promise.resolve(Response.json({
            share: {
              createdAt: "2026-07-27T12:00:00.000Z",
              id: "share-new",
              publicPath: "/s/new-token"
            }
          }))
        : listResponse.promise
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<ShareDialog target={target()} onClose={vi.fn()} />);
    const createButton = screen.getByRole("button", { name: "Create public link" });
    expect(createButton).toBeDisabled();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    fireEvent.click(createButton);
    expect(fetchMock).toHaveBeenCalledOnce();

    await act(async () => {
      listResponse.resolve(Response.json({ shares: [] }));
      await listResponse.promise;
    });

    await waitFor(() => expect(createButton).toBeEnabled());
    fireEvent.click(createButton);

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Public link created and copied.")
    );
    expect(screen.getByTestId("share-link")).toBeVisible();
    expect(screen.getByText("Just created")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    const announcement = screen.getByRole("status");

    fireEvent.click(screen.getByRole("button", { name: "Create public link" }));
    expect(announcement).toHaveTextContent("Creating public link.");

    await waitFor(() => expect(screen.getByTestId("share-link")).toBeVisible());
    expect(screen.getByTestId("share-link")).toHaveTextContent("Link created and copied");
    expect(screen.getByTestId("share-link").querySelector('[aria-live], [role="alert"], [role="status"]')).toBeNull();
    expect(announcement).toHaveTextContent("Public link created and copied.");
    expect(screen.getAllByRole("status")).toEqual([announcement]);
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

  it("serializes share actions while automatic copying is pending", async () => {
    const automaticCopy = deferred<void>();
    const writeText = vi.fn(() => automaticCopy.promise);
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
        return Response.json({
          shares: [{ createdAt: "2026-07-20T10:00:00.000Z", id: "share-old" }]
        });
      }
      return new Response("", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ShareDialog target={target()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("share-links")).toBeVisible());
    const createButton = screen.getByRole("button", { name: "Create public link" });

    fireEvent.click(createButton);

    await waitFor(() => expect(screen.getByTestId("share-link")).toBeVisible());
    expect(createButton).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeDisabled();
    const revokeButtons = screen.getAllByRole("button", { name: /Revoke link/ });
    expect(revokeButtons.length).toBeGreaterThan(1);
    revokeButtons.forEach((button) => expect(button).toBeDisabled());
    expect(writeText).toHaveBeenCalledOnce();

    await act(async () => {
      automaticCopy.resolve(undefined);
      await automaticCopy.promise;
    });

    await waitFor(() => expect(createButton).toBeEnabled());
    expect(createButton).toHaveTextContent("Create public link");
    expect(screen.getByRole("button", { name: "Copy link" })).toBeEnabled();
    screen.getAllByRole("button", { name: /Revoke link/ }).forEach((button) =>
      expect(button).toBeEnabled()
    );
    expect(screen.getByRole("status")).toHaveTextContent("Public link created and copied.");
  });

  it("announces automatic copy failure and a later copy recovery from the same owner", async () => {
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new Error("clipboard denied"))
      .mockResolvedValueOnce(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
        init?.method === "POST"
          ? Response.json({
              share: {
                createdAt: "2026-07-27T12:00:00.000Z",
                id: "share-new",
                publicPath: "/s/new-token"
              }
            })
          : Response.json({ shares: [] })
      )
    );

    render(<ShareDialog target={target()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("share-links-empty")).toBeVisible());
    const announcement = screen.getByRole("status");

    fireEvent.click(screen.getByRole("button", { name: "Create public link" }));

    await waitFor(() =>
      expect(announcement).toHaveTextContent(
        "Public link created, but copying failed. Use Copy link or select the URL."
      )
    );
    expect(screen.getByRole("link")).toHaveAttribute("href", "http://localhost:3000/s/new-token");
    expect(screen.getByTestId("share-link")).toHaveTextContent("Copying failed");

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(announcement).toHaveTextContent("Copying public link.");

    await waitFor(() => expect(announcement).toHaveTextContent("Public link copied."));
    expect(screen.getByTestId("share-link")).toHaveTextContent("Link created and copied");
    expect(screen.getAllByRole("status")).toEqual([announcement]);
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
    const announcement = screen.getByRole("status");

    fireEvent.click(screen.getAllByRole("button", { name: /Revoke link created/ })[0]);
    expect(announcement).toHaveTextContent("Revoking public link.");

    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /Revoke link created/ })).toHaveLength(1)
    );
    expect(announcement).toHaveTextContent("Public link revoked.");
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
    const announcement = screen.getByRole("status");

    fireEvent.click(screen.getByRole("button", { name: /Revoke link created/ }));

    await waitFor(() =>
      expect(announcement).toHaveTextContent("Could not revoke public link. temporary failure (temporary_failure)")
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("temporary failure (temporary_failure)")).toBeVisible();
    expect(screen.getByRole("button", { name: /Revoke link created/ })).toBeEnabled();
  });

  it("keeps list failures in one announcement owner and recovers through the explicit retry", async () => {
    const retryResponse = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: "list_failed" }, { status: 500 }))
      .mockImplementationOnce(() => retryResponse.promise);
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ShareDialog target={target({ activeLeafMessageId: null })} onClose={vi.fn()} />
    );

    const announcement = screen.getByRole("status");
    await waitFor(() =>
      expect(announcement).toHaveTextContent(
        "Could not load shared links. list failed (list_failed)"
      )
    );
    expect(screen.getByText("list failed (list_failed)")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getAllByRole("status")).toEqual([announcement]);
    expect(screen.getByRole("button", { name: "Retry loading links" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Create public link" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Retry loading links" }));
    await waitFor(() => expect(announcement).toHaveTextContent("Loading shared links."));
    expect(screen.getByTestId("share-links-loading")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry loading links" })).not.toBeInTheDocument();

    retryResponse.resolve(
      Response.json({
        shares: [{ createdAt: "2026-07-20T10:00:00.000Z", id: "share-recovered" }]
      })
    );

    await waitFor(() => expect(screen.getByTestId("share-links")).toBeVisible());
    expect(announcement).toHaveTextContent("1 live shared link loaded.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ignores a stale list response after the dialog target changes", async () => {
    const firstResponse = deferred<Response>();
    const secondResponse = deferred<Response>();
    const requestSignals: AbortSignal[] = [];
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      requestSignals.push(init?.signal as AbortSignal);
      return String(url).includes("chat-next") ? secondResponse.promise : firstResponse.promise;
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(<ShareDialog target={target()} onClose={vi.fn()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    rerender(
      <ShareDialog
        target={target({ chat: chatSummary({ id: "chat-next", title: "Next chat" }) })}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(requestSignals[0].aborted).toBe(true);

    await act(async () => {
      secondResponse.resolve(
        Response.json({ shares: [{ createdAt: "2042-08-02T10:00:00.000Z", id: "share-next" }] })
      );
    });
    await waitFor(() => expect(screen.getByTestId("share-links")).toHaveTextContent("2042"));

    await act(async () => {
      firstResponse.resolve(
        Response.json({
          shares: [
            { createdAt: "1999-08-02T10:00:00.000Z", id: "share-stale-a" },
            { createdAt: "1999-08-03T10:00:00.000Z", id: "share-stale-b" }
          ]
        })
      );
    });
    expect(screen.getByTestId("share-links")).toHaveTextContent("2042");
    expect(screen.getByTestId("share-links")).not.toHaveTextContent("1999");
    expect(screen.getAllByRole("button", { name: /Revoke link created/ })).toHaveLength(1);
  });

  it("aborts the active list request when the dialog unmounts", async () => {
    const listResponse = deferred<Response>();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        requestSignal = init?.signal as AbortSignal;
        return listResponse.promise;
      })
    );

    const { unmount } = render(<ShareDialog target={target()} onClose={vi.fn()} />);
    await waitFor(() => expect(requestSignal).toBeDefined());

    unmount();

    expect(requestSignal?.aborted).toBe(true);
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

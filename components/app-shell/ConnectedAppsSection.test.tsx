import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectedAppsSection } from "./ConnectedAppsSection";
import { deactivateConnectedApps } from "./connectedAppsStore";

const activeApp = {
  resourcePath: "/mcp" as const,
  capability: "memory:facts" as const,
  clientName: "Codex CLI",
  clientOrigin: "http://127.0.0.1:43119",
  connectedAt: "2026-09-03T01:00:00.000Z",
  connectionId: "grant-1",
  lastUsedAt: null,
  revokedAt: null,
  state: "ACTIVE" as const
};

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe("ConnectedAppsSection", () => {
  afterEach(() => {
    deactivateConnectedApps();
    vi.unstubAllGlobals();
  });

  it("explains fact-only authority and renders the empty state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ apps: [] })));
    render(<ConnectedAppsSection accountId="account-a" />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading connected apps");
    expect(await screen.findByText("No connected apps")).toBeInTheDocument();
    expect(screen.getByText(/read, add, change, and delete all your Personal Memory facts/i))
      .toBeInTheDocument();
    expect(screen.getByText(/Chat history is not shared/i)).toBeInTheDocument();
    expect(screen.getByText(/keeps your MCP connections and stored Memory facts/i)).toBeInTheDocument();
  });

  it("revokes access, reports retained facts, and focuses the changed app", async () => {
    const revoked = {
      ...activeApp,
      revokedAt: "2026-09-03T02:00:00.000Z",
      state: "REVOKED" as const
    };
    let resolveRevoke!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ apps: [activeApp] }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveRevoke = resolve;
      }));
    vi.stubGlobal("fetch", fetchMock);
    const onBusyChange = vi.fn();
    render(
      <ConnectedAppsSection accountId="account-a" onBusyChange={onBusyChange} />
    );

    const revoke = await screen.findByRole("button", {
      name: "Revoke Codex CLI Personal Memory access"
    });
    fireEvent.click(revoke);
    await waitFor(() => expect(onBusyChange).toHaveBeenCalledWith(true));
    expect(revoke).toBeDisabled();

    resolveRevoke(jsonResponse({ app: revoked }));
    const heading = await screen.findByRole("heading", { name: "Codex CLI" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByRole("status")).toHaveTextContent(
      "Personal Memory access revoked. Stored Memory facts were kept."
    );
    expect(screen.queryByRole("button", { name: /Revoke Codex CLI Personal Memory access/i }))
      .not.toBeInTheDocument();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("renders a recoverable, non-destructive load failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      jsonResponse({ error: "connected_apps_unavailable" }, 503)
    ));
    render(<ConnectedAppsSection accountId="account-a" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Connected apps could not be loaded"
    );
    expect(screen.getByText("Your connections were not changed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });

  it("revokes only the selected resource when the same app has both permissions", async () => {
    const hub = { ...activeApp, connectionId: "hub-grant", resourcePath: "/mcp/hub", capability: "mcp:hub" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ apps: [activeApp, hub] }))
      .mockResolvedValueOnce(jsonResponse({ app: { ...hub, state: "REVOKED", revokedAt: "2026-09-03T02:00:00.000Z" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ConnectedAppsSection accountId="account-a" />);
    const revoke = await screen.findByRole("button", { name: "Revoke Codex CLI MCP Hub access" });
    expect(screen.getByRole("button", { name: "Revoke Codex CLI Personal Memory access" })).toBeEnabled();
    fireEvent.click(revoke);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("MCP Hub access revoked. Your MCP connections were kept."));
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/me/connected-apps/hub-grant");
    expect(screen.getByRole("button", { name: "Revoke Codex CLI Personal Memory access" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Revoke Codex CLI MCP Hub access" })).not.toBeInTheDocument();
  });
});

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

function stubFetch(fetcher: (input: string, ...args: unknown[]) => Promise<Response>) {
  vi.stubGlobal("fetch", (input: string, ...args: unknown[]) => input === "/agents/metadata"
    ? Promise.resolve(Response.json({ origin: "https://canonical.example", hubEnabled: true }))
    : fetcher(input, ...args));
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe("ConnectedAppsSection", () => {
  afterEach(() => {
    deactivateConnectedApps();
    vi.unstubAllGlobals();
  });

  it("explains fact-only authority and renders the empty state", async () => {
    stubFetch(vi.fn(async () => jsonResponse({ apps: [] })));
    render(<ConnectedAppsSection accountId="account-a" />);

    expect(screen.getAllByRole("status").some((node) => node.textContent?.includes("Loading connected apps"))).toBe(true);
    expect(await screen.findByText("No connected apps")).toBeInTheDocument();
    expect(screen.getByText(/read, add, change, and delete your Memory facts/i))
      .toBeInTheDocument();
    expect(screen.getByText(/Chat history is not shared/i)).toBeInTheDocument();
    expect(screen.getByText(/Your stored Skills, MCP connections, and Memory facts remain/i)).toBeInTheDocument();
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
    stubFetch(fetchMock);
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
    stubFetch(vi.fn(async () =>
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
    stubFetch(fetchMock);
    render(<ConnectedAppsSection accountId="account-a" />);
    const revoke = await screen.findByRole("button", { name: "Revoke Codex CLI MCP Hub access" });
    expect(screen.getByRole("button", { name: "Revoke Codex CLI Personal Memory access" })).toBeEnabled();
    fireEvent.click(revoke);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("MCP Hub access revoked. Your MCP connections were kept."));
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/me/connected-apps/hub-grant");
    expect(screen.getByRole("button", { name: "Revoke Codex CLI Personal Memory access" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Revoke Codex CLI MCP Hub access" })).not.toBeInTheDocument();
  });

  it("distinguishes Skill read and write grants and retains packages after revocation", async () => {
    const read = { ...activeApp, connectionId: "skills-read", clientName: "Reader", resourcePath: "/mcp/skills", capability: "skills:store", scopes: ["skills:read"] };
    const write = { ...read, connectionId: "skills-write", clientName: "Writer", scopes: ["skills:read", "skills:write"] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ apps: [read, write] }))
      .mockResolvedValueOnce(jsonResponse({ app: { ...write, state: "REVOKED", revokedAt: "2026-09-03T02:00:00.000Z" } }));
    stubFetch(fetchMock);
    render(<ConnectedAppsSection accountId="account-a" />);
    expect(await screen.findByText("Skills · read and download")).toBeVisible();
    const revoke = screen.getByRole("button", { name: "Revoke Writer Skills · read, download, create, update, and delete access" });
    fireEvent.click(revoke);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Skills access revoked. Your stored Skills and downloaded copies were kept."));
    expect(screen.getByRole("button", { name: "Revoke Reader Skills · read and download access" })).toBeEnabled();
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/me/connected-apps/skills-write");
    expect(screen.getByRole("heading", { name: "Writer" })).toHaveFocus();
  });
});

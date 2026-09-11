import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpHubConnection } from "./McpHubConnection";

afterEach(() => vi.unstubAllGlobals());

describe("MCP Hub onboarding", () => {
  it("loads and copies the canonical resource only after opening the instructions", async () => {
    const url = "https://canonical.example/mcp/hub";
    const fetch = vi.fn(async () => Response.json({ resource: url, authorization_servers: ["https://canonical.example"] }));
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<McpHubConnection />);
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Connect an external agent to MCP Hub"));
    expect(await screen.findByLabelText("MCP Hub URL")).toHaveValue(url);
    expect(fetch).toHaveBeenCalledWith("/.well-known/oauth-protected-resource/mcp/hub", expect.objectContaining({ cache: "no-store" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy URL" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("MCP Hub URL copied."));
    expect(writeText).toHaveBeenCalledWith(url);
    expect(screen.getByText(/approve MCP Hub access/)).toBeVisible();
    expect(screen.getByText(/Personal Memory uses a separate permission/)).toBeVisible();
  });

  it("offers a retry for malformed metadata and manual copy when clipboard access fails", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ resource: "https://secret@canonical.example/mcp/hub" }))
      .mockResolvedValueOnce(Response.json({ resource: "https://canonical.example/mcp/hub" }));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("navigator", { clipboard: { writeText: async () => { throw new Error("blocked"); } } });
    render(<McpHubConnection />);
    fireEvent.click(screen.getByText("Connect an external agent to MCP Hub"));
    expect(await screen.findByRole("alert")).toHaveTextContent("The MCP Hub address could not be loaded.");
    expect(screen.queryByLabelText("MCP Hub URL")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry address" }));
    await screen.findByLabelText("MCP Hub URL");
    fireEvent.click(screen.getByRole("button", { name: "Copy URL" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Select and copy the address above."));
  });
});

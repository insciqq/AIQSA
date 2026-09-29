import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpHubConnection } from "./McpHubConnection";
import { initialSettingsDestinationSnapshot, useSettingsDestinationStore } from "./settingsDestinationStore";

afterEach(() => {
  vi.unstubAllGlobals();
  useSettingsDestinationStore.setState(initialSettingsDestinationSnapshot);
});

describe("Agent onboarding", () => {
  it("sends Studio users to the same Settings owner without loading metadata or waking tools", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(<McpHubConnection />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Claude Code or Codex" }));
    expect(useSettingsDestinationStore.getState()).toMatchObject({ settingsOpen: true, settingsSection: "connected_apps" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("copies the canonical guide and changes manual commands for the selected client and capability", async () => {
    const fetch = vi.fn(async () => Response.json({ origin: "https://canonical.example", hubEnabled: true }));
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<McpHubConnection expanded />);
    expect(await screen.findByLabelText("Agent instructions")).toHaveValue("https://canonical.example/AGENTS.md");
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Agent instructions link copied."));
    expect(writeText).toHaveBeenCalledWith("https://canonical.example/AGENTS.md");
    expect(screen.getByRole("link", { name: "Read the connection guide" })).toHaveAttribute("href", "https://canonical.example/AGENTS.md");
    expect(screen.getByText("Set up manually").closest("details")).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("Set up manually"));
    expect(screen.getByText("claude mcp add --transport http --scope user aiqsa-hub 'https://canonical.example/mcp/hub'")).toBeVisible();
    fireEvent.click(within(screen.getByRole("group", { name: "Agent client" })).getByRole("button", { name: "Codex" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Connection" }), { target: { value: "skills" } });
    expect(screen.getByText(/codex mcp add aiqsa-skills/)).toHaveTextContent("codex mcp login aiqsa-skills");
    expect(screen.getByText(/codex mcp add aiqsa-skills/)).not.toHaveTextContent("mcp/hub");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("offers a retry for malformed metadata and manual copy when clipboard access fails", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ origin: "https://secret@canonical.example", hubEnabled: true }))
      .mockResolvedValueOnce(Response.json({ origin: "https://canonical.example", hubEnabled: true }));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("navigator", { clipboard: { writeText: async () => { throw new Error("blocked"); } } });
    render(<McpHubConnection expanded />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The connection guide address could not be loaded.");
    expect(screen.queryByLabelText("Agent instructions")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry address" }));
    await screen.findByLabelText("Agent instructions");
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Select and copy the address above."));
  });

  it("offers Skills and optional Memory when the administrator disabled Hub", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ origin: "https://canonical.example", hubEnabled: false })));
    render(<McpHubConnection expanded />);
    await screen.findByLabelText("Agent instructions");
    fireEvent.click(screen.getByText("Set up manually"));
    expect(screen.getByRole("combobox", { name: "Connection" })).toHaveValue("skills");
    expect(screen.queryByRole("option", { name: "MCP Hub" })).not.toBeInTheDocument();
    expect(screen.getByText(/claude mcp add/)).toHaveTextContent("/mcp/skills");
  });
});

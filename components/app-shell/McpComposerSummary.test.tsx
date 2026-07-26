import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpComposerSummary } from "./McpComposerSummary";
import { resetMcpSettingsStoreForTest, useMcpSettingsStore } from "./mcpSettingsStore";

describe("McpComposerSummary", () => {
  afterEach(() => {
    cleanup();
    resetMcpSettingsStoreForTest();
  });

  it("shows aggregate ready tools and routes issues to MCP settings", () => {
    const onOpenSettings = vi.fn();
    useMcpSettingsStore.setState({
      loadState: "ready",
      servers: [
        {
          accountLabel: null,
          description: "Memory",
          enabled: true,
          errorCode: null,
          fields: [],
          id: "memory",
          knownToolCount: 2,
          name: "Memory",
          oauthAvailable: false,
          oauthState: null,
          readiness: "ready",
          tools: [{ description: null, name: "remember" }, { description: null, name: "recall" }]
        },
        {
          accountLabel: null,
          description: "Tasks",
          enabled: true,
          errorCode: "mcp_runtime_unavailable",
          fields: [],
          id: "tasks",
          knownToolCount: 1,
          name: "Tasks",
          oauthAvailable: false,
          oauthState: null,
          readiness: "unavailable",
          tools: []
        }
      ]
    });

    render(<McpComposerSummary onOpenSettings={onOpenSettings} />);
    expect(screen.getByText("Tools", { selector: "span" })).toBeVisible();
    const summary = screen.getByTestId("composer-mcp-summary");
    expect(summary).toHaveClass("text-ink-secondary", "hover:bg-control-hover");
    expect(summary).not.toHaveClass("w-full", "mt-2");
    expect(summary).toHaveAttribute("title", "Tools. 1/2 ready · 2 tools. 1 need attention");
    fireEvent.click(summary);
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("surfaces an enabled known inventory above the run tool limit", () => {
    useMcpSettingsStore.setState({
      loadState: "ready",
      servers: [{
        accountLabel: null,
        description: "Large catalog",
        enabled: true,
        errorCode: null,
        fields: [],
        id: "large",
        knownToolCount: 129,
        name: "Large",
        oauthAvailable: false,
        oauthState: null,
        readiness: "idle",
        tools: []
      }]
    });

    render(<McpComposerSummary onOpenSettings={vi.fn()} />);

    expect(screen.getByTestId("composer-mcp-summary")).toHaveAttribute(
      "title",
      "Tools. 0/1 ready · 0 tools. 1 need attention. Tool limit exceeded"
    );
  });

  it("keeps the Tools entry visible before any server is configured", () => {
    const onOpenSettings = vi.fn();
    useMcpSettingsStore.setState({ loadState: "ready", servers: [] });

    render(<McpComposerSummary onOpenSettings={onOpenSettings} />);

    expect(screen.getByText("Tools", { selector: "span" })).toBeVisible();
    expect(screen.getByTestId("composer-mcp-summary")).toHaveAttribute("title", "Tools. Not configured");
    fireEvent.click(screen.getByTestId("composer-mcp-summary"));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });
});

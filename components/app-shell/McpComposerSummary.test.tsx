import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpComposerSummary } from "./McpComposerSummary";
import { resetMcpSettingsStoreForTest, useMcpSettingsStore } from "./mcpSettingsStore";

describe("McpComposerSummary", () => {
  afterEach(() => {
    cleanup();
    resetMcpSettingsStoreForTest();
    vi.unstubAllGlobals();
  });

  it("shows runtime failure without mislabeling it as setup work", () => {
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
    expect(summary).toHaveAttribute("title", "Tools. 1/2 ready · 2 tools. 1 activation failed");
    expect(screen.getByText("Enabled", { selector: "[data-resource-availability]" })).toBeVisible();
    expect(screen.getByText("Activation failed")).toHaveClass("text-critical");
    expect(screen.queryByText("2 tools ready")).not.toBeInTheDocument();
    expect(screen.queryByText(/needs setup/iu)).not.toBeInTheDocument();
    fireEvent.click(summary);
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("shows an idle enabled runtime as activating while preserving the tool-limit warning", () => {
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
      "Tools. 0/1 ready · 0 tools. 1 activating. Tool limit exceeded"
    );
    expect(screen.getByText("Enabled", { selector: "[data-resource-availability]" })).toBeVisible();
    expect(screen.getByText("Activating")).toHaveClass("text-proof");
    expect(screen.queryByText(/needs setup/iu)).not.toBeInTheDocument();
  });

  it("keeps mixed ready and transient runtimes visibly labeled Activating", () => {
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
          knownToolCount: 1,
          name: "Memory",
          oauthAvailable: false,
          oauthState: null,
          readiness: "ready",
          tools: [{ description: null, name: "remember" }]
        },
        {
          accountLabel: null,
          description: "Tasks",
          enabled: true,
          errorCode: null,
          fields: [],
          id: "tasks",
          knownToolCount: 1,
          name: "Tasks",
          oauthAvailable: false,
          oauthState: null,
          readiness: "queued",
          tools: []
        }
      ]
    });

    render(<McpComposerSummary onOpenSettings={vi.fn()} />);

    expect(screen.getByText("Activating")).toHaveClass("text-proof");
    expect(screen.queryByText("1 activating")).not.toBeInTheDocument();
    expect(screen.getByTestId("composer-mcp-summary")).toHaveAttribute(
      "title",
      "Tools. 1/2 ready · 1 tool. 1 activating"
    );
    expect(screen.queryByText(/needs setup/iu)).not.toBeInTheDocument();
  });

  it("reserves Needs setup for the exact actionable readiness state", () => {
    useMcpSettingsStore.setState({
      loadState: "ready",
      servers: [{
        accountLabel: null,
        description: "Missing personal value",
        enabled: true,
        errorCode: "configuration_required",
        fields: [],
        id: "setup",
        knownToolCount: 1,
        name: "Setup server",
        oauthAvailable: false,
        oauthState: null,
        readiness: "needs_setup",
        tools: []
      }]
    });

    render(<McpComposerSummary onOpenSettings={vi.fn()} />);

    expect(screen.getByText("Needs setup")).toHaveClass("text-caution");
    expect(screen.getByTestId("composer-mcp-summary")).toHaveAttribute(
      "title",
      "Tools. 0/1 ready · 0 tools. 1 needs setup"
    );
  });

  it("keeps the Tools entry visible before any server is configured", () => {
    const onOpenSettings = vi.fn();
    useMcpSettingsStore.setState({ loadState: "ready", servers: [] });

    render(<McpComposerSummary onOpenSettings={onOpenSettings} />);

    expect(screen.getByText("Tools", { selector: "span" })).toBeVisible();
    expect(screen.getByText("Not configured", { selector: "span" })).toBeVisible();
    expect(screen.getByTestId("composer-mcp-summary")).toHaveAttribute("title", "Tools. Not configured");
    fireEvent.click(screen.getByTestId("composer-mcp-summary"));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("shows a disabled aggregate without relying on hover text", () => {
    useMcpSettingsStore.setState({
      loadState: "ready",
      servers: [{
        accountLabel: null,
        description: "Memory",
        enabled: false,
        errorCode: null,
        fields: [],
        id: "memory",
        knownToolCount: 1,
        name: "Memory",
        oauthAvailable: false,
        oauthState: null,
        readiness: "disabled",
        tools: []
      }]
    });

    render(<McpComposerSummary onOpenSettings={vi.fn()} />);

    expect(screen.getByText("Disabled", { selector: "[data-resource-availability]" })).toHaveClass("text-ink-muted");
    expect(screen.getByTestId("composer-mcp-summary")).toHaveAttribute("title", "Tools. Disabled");
  });

  it("keeps an initial load failure distinct from an empty catalog", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    render(<McpComposerSummary onOpenSettings={vi.fn()} />);

    expect(await screen.findByText("Unavailable", { selector: "span" })).toHaveClass("text-critical");
    expect(screen.getByTestId("composer-mcp-summary")).toHaveAttribute("title", "Tools. Unavailable");
    expect(screen.queryByText("Not configured")).not.toBeInTheDocument();
  });
});

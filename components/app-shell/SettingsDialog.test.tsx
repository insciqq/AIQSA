import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { UserMcpServer } from "@/lib/contracts/mcp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMemoryManagerStoreForTest } from "./memoryManagerStore";
import { resetMemorySettingsStoreForTest, useMemorySettingsStore } from "./memorySettingsStore";
import { memorySettingsFixture } from "./memoryTestFixtures";
import { resetMcpSettingsStoreForTest, useMcpSettingsStore } from "./mcpSettingsStore";
import { SettingsDialog } from "./SettingsDialog";

const mcpServer: UserMcpServer = {
  accountLabel: null,
  description: "Personal memory",
  enabled: false,
  errorCode: null,
  fields: [{
    configured: false,
    label: "API key",
    sensitive: true,
    slotKey: "api_key",
    source: "missing",
    valueType: "secret"
  }],
  id: "memory",
  knownToolCount: 1,
  name: "Memory",
  oauthAvailable: false,
  oauthState: null,
  readiness: "needs_setup",
  tools: []
};

type SettingsDialogProps = Parameters<typeof SettingsDialog>[0];

function renderDialog(overrides: Partial<SettingsDialogProps> = {}) {
  const props: SettingsDialogProps = {
    initialSection: "appearance",
    onClose: vi.fn(),
    onThemeChange: vi.fn(),
    themeId: "aiqsa"
  };
  const renderProps = { ...props, ...overrides };
  const view = render(<SettingsDialog {...renderProps} />);

  return { ...renderProps, ...view };
}

function setMcpServer() {
  useMcpSettingsStore.setState({ loadState: "ready", servers: [mcpServer] });
}

function confirmDiscard() {
  fireEvent.click(screen.getByRole("button", { name: "Confirm discard changes" }));
}

describe("SettingsDialog", () => {
  beforeEach(() => {
    resetMcpSettingsStoreForTest();
    resetMemoryManagerStoreForTest();
    resetMemorySettingsStoreForTest();
    useMcpSettingsStore.setState({ loadState: "ready" });
  });

  afterEach(() => {
    cleanup();
    resetMcpSettingsStoreForTest();
    resetMemoryManagerStoreForTest();
    resetMemorySettingsStoreForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("contains Appearance, Memory, and MCP settings and can open each section directly", () => {
    const appearanceView = renderDialog();
    const settings = screen.getByRole("dialog", { name: "Settings" });
    const navigation = within(settings).getByRole("navigation", { name: "Settings sections" });

    expect(within(settings).getByRole("heading", { name: "Settings" })).toBeVisible();
    expect(within(settings).getByRole("heading", { name: "Appearance" })).toBeVisible();
    expect(within(navigation).getByRole("button", { name: "Appearance" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(within(navigation).getByRole("button", { name: "MCP & tools" })).toBeVisible();
    expect(within(navigation).getByRole("button", { name: "Memory" })).toBeVisible();
    expect(within(navigation).queryByRole("button", { name: "Prompts" })).not.toBeInTheDocument();
    expect(screen.queryByText("Prompt library")).not.toBeInTheDocument();

    appearanceView.unmount();
    renderDialog({ initialSection: "mcp" });

    expect(screen.getByRole("heading", { name: "MCP & tools" })).toBeVisible();
    expect(screen.getByRole("button", { name: "MCP & tools" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("No MCP servers available")).toBeVisible();

    cleanup();
    useMemorySettingsStore.setState({
      data: memorySettingsFixture(),
      error: null,
      loadState: "ready"
    });
    renderDialog({ initialSection: "memory" });

    expect(screen.getByRole("heading", { name: /^Memory$/u })).toBeVisible();
    expect(screen.getByRole("button", { name: "Memory" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps the bounded overlay safe in short viewports with local scrolling and a clean backdrop close", () => {
    const props = renderDialog();
    const backdrop = screen.getByTestId("settings-backdrop");
    const dialog = screen.getByRole("dialog", { name: "Settings" });

    expect(backdrop.className).toContain("sm:pl-[max(1.25rem,env(safe-area-inset-left))]");
    expect(backdrop.className).toContain("sm:pr-[max(1.25rem,env(safe-area-inset-right))]");
    expect(backdrop.className).toContain("[@media(max-height:32rem)]:!pt-[max(.5rem,env(safe-area-inset-top))]");
    expect(backdrop.className).toContain(
      "[@media(max-height:32rem)]:!pb-[max(.5rem,env(safe-area-inset-bottom))]"
    );
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveClass(
      "h-[100dvh]",
      "max-w-4xl",
      "overflow-hidden",
      "sm:rounded-panel",
      "[@media(max-height:32rem)]:!h-full",
      "[@media(max-height:32rem)]:!max-h-full"
    );
    expect(dialog.className).toContain("pl-[env(safe-area-inset-left)]");
    expect(dialog.className).toContain("pr-[env(safe-area-inset-right)]");
    expect(screen.getByTestId("settings-appearance-scroll")).toHaveClass(
      "min-h-0",
      "flex-1",
      "overflow-y-auto",
      "overscroll-contain"
    );
    expect(screen.getByRole("button", { name: "Close settings" })).toHaveClass(
      "sm:size-9",
      "[@media(hover:none)]:!size-11",
      "[@media(pointer:coarse)]:!size-11"
    );
    for (const theme of screen.getAllByRole("radio")) {
      expect(theme).toHaveClass("min-h-touch");
    }

    fireEvent.mouseDown(backdrop);
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("describes local-only palettes and supports radio Arrow, Home, End, and direct selection", () => {
    const props = renderDialog({ themeId: "graphite" });

    expect(screen.getByText("This theme is saved only in this browser and does not follow your account.")).toBeVisible();
    expect(screen.queryByText(/same-site cookie|first paint/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Choose an AIQSA palette/)).toBeVisible();

    const graphite = screen.getByRole("radio", { name: /Use Graphite theme/ });
    const verdant = screen.getByRole("radio", { name: /Use Verdant theme/ });
    const classicDark = screen.getByRole("radio", { name: /Use Classic Dark theme/ });
    const neutral = screen.getByRole("radio", { name: /Use Classic Light theme/ });
    const paper = screen.getByRole("radio", { name: /Use Paper theme/ });
    const aiqsa = screen.getByRole("radio", { name: /Use AIQSA theme/ });
    expect(screen.getAllByRole("radio")).toHaveLength(6);
    expect(graphite).toHaveAttribute("aria-checked", "true");
    expect(graphite).toHaveAttribute("tabindex", "0");
    expect(verdant).toHaveAttribute("tabindex", "-1");
    expect(classicDark).toHaveAttribute("tabindex", "-1");
    expect(neutral).toHaveAttribute("tabindex", "-1");
    expect(paper).toHaveAttribute("tabindex", "-1");

    graphite.focus();
    fireEvent.keyDown(graphite, { key: "End" });
    expect(props.onThemeChange).toHaveBeenLastCalledWith("paper");
    expect(paper).toHaveFocus();

    fireEvent.keyDown(paper, { key: "Home" });
    expect(props.onThemeChange).toHaveBeenLastCalledWith("aiqsa");
    expect(aiqsa).toHaveFocus();

    fireEvent.keyDown(aiqsa, { key: "ArrowRight" });
    expect(props.onThemeChange).toHaveBeenLastCalledWith("graphite");
    expect(graphite).toHaveFocus();

    fireEvent.click(verdant);
    expect(props.onThemeChange).toHaveBeenLastCalledWith("verdant");
    fireEvent.click(classicDark);
    expect(props.onThemeChange).toHaveBeenLastCalledWith("classic-dark");
  });

  it("owns Settings notices inside the dialog and dismisses only that channel", () => {
    const onDismissNotice = vi.fn();
    renderDialog({
      notice: {
        kind: "error",
        scope: "settings",
        text: "MCP settings update failed"
      },
      onDismissNotice
    });

    const settings = screen.getByRole("dialog", { name: "Settings" });
    const noticeRegion = screen.getByTestId("settings-notice-region");
    expect(settings).toContainElement(noticeRegion);
    expect(noticeRegion).toContainElement(screen.getByRole("alert"));
    expect(screen.getByRole("alert")).toHaveTextContent("MCP settings update failed");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(onDismissNotice).toHaveBeenCalledOnce();
  });

  it("routes dirty close, Escape, and backdrop paths through one inert MCP discard dialog", () => {
    setMcpServer();
    const props = renderDialog({ initialSection: "mcp" });
    const settings = screen.getByTestId("settings-dialog");

    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "personal-secret" } });
    expect(screen.getByText("Unsaved personal values")).toBeVisible();
    expect(screen.getByText("Unsaved MCP values")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    let discard = screen.getByRole("dialog", { name: "Discard MCP settings changes" });
    expect(settings).toHaveAttribute("aria-hidden", "true");
    expect(settings).toHaveAttribute("inert");

    fireEvent.keyDown(discard, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Discard MCP settings changes" })).not.toBeInTheDocument();
    expect(settings).not.toHaveAttribute("aria-hidden");
    expect(settings).not.toHaveAttribute("inert");
    expect(screen.getByLabelText("API key")).toHaveValue("personal-secret");
    expect(props.onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape" });
    discard = screen.getByRole("dialog", { name: "Discard MCP settings changes" });
    fireEvent.click(within(discard).getByRole("button", { name: "Keep editing" }));
    expect(props.onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(screen.getByTestId("settings-backdrop"));
    expect(screen.getByRole("dialog", { name: "Discard MCP settings changes" })).toBeVisible();
    confirmDiscard();
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("protects a dirty MCP draft before replacing it with Appearance", () => {
    setMcpServer();
    const props = renderDialog({ initialSection: "mcp" });

    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "personal-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));

    let discard = screen.getByRole("dialog", { name: "Discard MCP settings changes" });
    fireEvent.click(within(discard).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("button", { name: "MCP & tools" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByLabelText("API key")).toHaveValue("personal-secret");

    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    discard = screen.getByRole("dialog", { name: "Discard MCP settings changes" });
    fireEvent.click(within(discard).getByRole("button", { name: "Confirm discard changes" }));

    expect(screen.getByRole("heading", { name: "Appearance" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Appearance" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("blocks close and section replacement while an MCP value save is in flight", async () => {
    const savedServer: UserMcpServer = {
      ...mcpServer,
      fields: mcpServer.fields.map((field) => ({
        ...field,
        configured: true,
        source: "personal"
      }))
    };
    const savedResponse = new Response(JSON.stringify({ server: savedServer }), {
      headers: { "content-type": "application/json" },
      status: 200
    });
    let resolveSave!: (response: Response) => void;
    const pendingSave = new Promise<Response>((resolve) => {
      resolveSave = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return pendingSave;
      }
      return new Response(JSON.stringify({ servers: [mcpServer] }), {
        headers: { "content-type": "application/json" },
        status: 200
      });
    }));
    setMcpServer();
    const props = renderDialog({ initialSection: "mcp" });

    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "personal-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save personal values" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Close settings" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Appearance" })).toBeDisabled();
    expect(screen.getByTestId("settings-dialog")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Close settings" })).toHaveAttribute(
      "title",
      "Wait for the MCP update to finish"
    );
    fireEvent.mouseDown(screen.getByTestId("settings-backdrop"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onClose).not.toHaveBeenCalled();

    resolveSave(savedResponse);
    await waitFor(() => expect(screen.getByRole("button", { name: "Close settings" })).toBeEnabled());
    expect(screen.queryByText("Unsaved personal values")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Discard MCP settings changes" })).not.toBeInTheDocument();
  });

  it("contains keyboard focus, closes cleanly on Escape, and restores the opener on unmount", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open Settings";
    document.body.appendChild(trigger);
    trigger.focus();

    const props = renderDialog();
    const close = screen.getByRole("button", { name: "Close settings" });
    const selectedTheme = screen.getByRole("radio", { name: /Use AIQSA theme/ });

    expect(trigger).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(close).toHaveFocus();

    selectedTheme.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(close).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledOnce();

    props.unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("uses the explicit visible fallback when a responsive crossing hides its captured opener", () => {
    const trigger = document.createElement("button");
    const compactFallback = document.createElement("button");
    trigger.textContent = "Rail Settings";
    compactFallback.textContent = "Open workspace";
    document.body.append(trigger, compactFallback);
    trigger.focus();

    const view = renderDialog({ restoreFocus: () => compactFallback });
    trigger.style.display = "none";
    view.unmount();

    expect(compactFallback).toHaveFocus();
    trigger.remove();
    compactFallback.remove();
  });
});

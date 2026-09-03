import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsV2 } from "./SettingsV2";

describe("SettingsV2", () => {
  it("exposes exactly System, Light, and Dark and supports roving selection", () => {
    const onThemeChange = vi.fn();
    render(
      <SettingsV2
        connectedAppsContent={<p>Connected apps owner</p>}
        mcpContent={<p>MCP owner</p>}
        onClose={vi.fn()}
        onThemeChange={onThemeChange}
        themeId="system"
      />
    );
    const radios = screen.getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("aria-label"))).toEqual([
      "Use System theme, Follow this device",
      "Use Light theme, Cool paper",
      "Use Dark theme, Deep navy"
    ]);
    fireEvent.keyDown(radios[0]!, { key: "ArrowRight" });
    expect(onThemeChange).toHaveBeenCalledWith("light");
  });

  it("reveals a newly selected destination when the mobile strip overflows", async () => {
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView"
    );
    const revealed: HTMLElement[] = [];
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value(this: HTMLElement) {
        revealed.push(this);
      }
    });

    try {
      render(
        <SettingsV2
          connectedAppsContent={<p>Connected apps owner</p>}
          mcpContent={<p>MCP owner</p>}
          onClose={vi.fn()}
          onThemeChange={vi.fn()}
          panels={{ data: <p>Data owner</p> }}
          themeId="dark"
        />
      );

      const nav = screen.getByRole("navigation", { name: "Settings sections" });
      Object.defineProperties(nav, {
        clientWidth: { configurable: true, value: 200 },
        scrollWidth: { configurable: true, value: 700 }
      });
      const data = screen.getByRole("button", { name: "Data" });
      fireEvent.click(data);

      await waitFor(() => expect(revealed).toContain(data));
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollIntoView",
          originalScrollIntoView
        );
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      }
    }
  });

  it("lets the MCP owner block section replacement until discard is explicit", () => {
    const onDiscard = vi.fn();
    render(
      <SettingsV2
        connectedAppsContent={<p>Connected apps owner</p>}
        dirty
        initialSection="mcp"
        mcpContent={<p>MCP owner</p>}
        onClose={vi.fn()}
        onDiscard={onDiscard}
        onThemeChange={vi.fn()}
        themeId="dark"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    expect(screen.getByRole("alertdialog", { name: "Unsaved MCP changes" })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Theme" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(onDiscard).toHaveBeenCalledOnce();
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeInTheDocument();
  });

  it("blocks close while the existing MCP owner is busy", () => {
    const onClose = vi.fn();
    render(
      <SettingsV2
        busy
        connectedAppsContent={<p>Connected apps owner</p>}
        initialSection="mcp"
        mcpContent={<p>MCP owner</p>}
        onClose={onClose}
        onThemeChange={vi.fn()}
        themeId="dark"
      />
    );
    expect(screen.getByRole("button", { name: "Close settings" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Settings" }), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps authorized apps separate from MCP servers AIQSA calls", () => {
    render(
      <SettingsV2
        connectedAppsContent={<p>Personal Memory grants</p>}
        mcpContent={<p>Outbound MCP servers</p>}
        onClose={vi.fn()}
        onThemeChange={vi.fn()}
        themeId="dark"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Connected apps" }));
    expect(screen.getByRole("heading", { name: "Connected apps" })).toBeInTheDocument();
    expect(screen.getByText("Personal Memory grants")).toBeInTheDocument();
    expect(screen.queryByText("Outbound MCP servers")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "MCP & tools" }));
    expect(screen.getByText("Outbound MCP servers")).toBeInTheDocument();
    expect(screen.queryByText("Personal Memory grants")).not.toBeInTheDocument();
  });

  it("owns a focus-safe section subview and settles it before another tab", async () => {
    const onBack = vi.fn();
    const onSectionChange = vi.fn();
    render(
      <SettingsV2
        connectedAppsContent={<p>Connected apps owner</p>}
        initialSection="data"
        mcpContent={<p>MCP owner</p>}
        onClose={vi.fn()}
        onSectionChange={onSectionChange}
        onThemeChange={vi.fn()}
        panels={{ data: <p>Archived list</p> }}
        subview={{ label: "Archived chats", onBack }}
        themeId="dark"
      />
    );

    expect(screen.getByRole("heading", { name: "Data / Archived chats" })).toBeVisible();
    const back = screen.getByRole("button", { name: "Back to Data" });
    await waitFor(() => expect(back).toHaveFocus());
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "General" }));
    expect(onSectionChange).toHaveBeenCalledWith("general");
  });
});

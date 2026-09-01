import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsV2 } from "./SettingsV2";

describe("SettingsV2", () => {
  it("exposes exactly System, Light, and Dark and supports roving selection", () => {
    const onThemeChange = vi.fn();
    render(
      <SettingsV2
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

  it("lets the MCP owner block section replacement until discard is explicit", () => {
    const onDiscard = vi.fn();
    render(
      <SettingsV2
        dirty
        initialSection="mcp"
        mcpContent={<p>MCP owner</p>}
        onClose={vi.fn()}
        onDiscard={onDiscard}
        onThemeChange={vi.fn()}
        themeId="dark"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
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
});

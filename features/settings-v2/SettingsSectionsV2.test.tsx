import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GeneralSettingsSectionV2 } from "./SettingsSectionsV2";

function generalComposer() {
  return {
    notificationSoundEnabled: true,
    notificationSoundId: "rise" as const,
    notificationSoundReady: true,
    previewAnswerSound: vi.fn(async () => true),
    selectAnswerSound: vi.fn(),
    sendWithEnter: true,
    setSendWithEnter: vi.fn(),
    showCitations: true,
    showReasoningBlocks: false,
    toggleCitationsVisibility: vi.fn(),
    toggleNotificationSound: vi.fn(),
    toggleReasoningBlockVisibility: vi.fn()
  };
}

describe("Settings › General", () => {
  it("exposes exactly System, Light, and Dark and supports roving selection", () => {
    const onThemeChange = vi.fn();
    render(<GeneralSettingsSectionV2 composer={generalComposer()} onThemeChange={onThemeChange} themeId="system" />);
    expect(screen.getByRole("heading", { level: 2, name: "General" })).toBeInTheDocument();
    const radios = screen.getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("aria-label"))).toEqual([
      "Use System theme, Follow this device",
      "Use Light theme, Paper",
      "Use Dark theme, Graphite"
    ]);
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(radios[0]!, { key: "ArrowRight" });
    expect(onThemeChange).toHaveBeenCalledWith("light");
  });

  it("keeps the answer sound, citations, reasoning blocks and Send with Enter rows", () => {
    const composer = generalComposer();
    render(<GeneralSettingsSectionV2 composer={composer} onThemeChange={vi.fn()} themeId="dark" />);
    expect(screen.getByRole("switch", { name: "Answer sound" })).toHaveAttribute("aria-checked", "true");
    // Without the account's browser notifications view the row is absent.
    expect(screen.queryByRole("switch", { name: "Browser notifications" })).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Citations" }));
    expect(composer.toggleCitationsVisibility).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("switch", { name: "Reasoning blocks" }));
    expect(composer.toggleReasoningBlockVisibility).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("switch", { name: "Send with Enter" }));
    expect(composer.setSendWithEnter).toHaveBeenCalledWith(false);
    expect(screen.getByTestId("settings-general-panel")).toBeInTheDocument();
  });
});

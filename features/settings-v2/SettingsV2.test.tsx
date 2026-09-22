import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsV2 } from "./SettingsV2";

describe("SettingsV2", () => {
  it("contains only the four personal account sections in their intended order", () => {
    render(<SettingsV2 connectedAppsContent={<p>Apps</p>} panels={{ account: <p>Account</p>, data: <p>Data</p> }}
      onClose={vi.fn()} onThemeChange={vi.fn()} themeId="light" />);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).getAllByRole("button").map(button => button.textContent?.trim())).toEqual([
      "General", "Account", "Connected apps", "Data"
    ]);
  });
  it("exposes exactly System, Light, and Dark and supports roving selection", () => {
    const onThemeChange = vi.fn();
    render(
      <SettingsV2
        connectedAppsContent={<p>Connected apps owner</p>}
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

  it.each([
    ["account", "Unsaved account changes"]
  ] as const)("lets the %s owner block section replacement until discard is explicit", (section, label) => {
    const onDiscard = vi.fn();
    render(
      <SettingsV2
        connectedAppsContent={<p>Connected apps owner</p>}
        dirty
        initialSection={section}
        panels={{ account: <p>Account owner</p> }}
        onClose={vi.fn()}
        onDiscard={onDiscard}
        onThemeChange={vi.fn()}
        themeId="dark"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    expect(screen.getByRole("alertdialog", { name: label })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Theme" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(onDiscard).toHaveBeenCalledOnce();
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeInTheDocument();
  });

  it("blocks close while the Account owner is busy", () => {
    const onClose = vi.fn();
    render(
      <SettingsV2
        busy
        connectedAppsContent={<p>Connected apps owner</p>}
        initialSection="account"
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
        onClose={vi.fn()}
        onThemeChange={vi.fn()}
        themeId="dark"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Connected apps" }));
    expect(screen.getByRole("heading", { name: "Connected apps" })).toBeInTheDocument();
    expect(screen.getByText("Personal Memory grants")).toBeInTheDocument();
    expect(screen.queryByText("Outbound MCP servers")).not.toBeInTheDocument();

    expect(screen.queryByRole("button", { name: "MCP & tools" })).not.toBeInTheDocument();
  });

  it("owns a focus-safe section subview and settles it before another tab", async () => {
    const onBack = vi.fn();
    const onSectionChange = vi.fn();
    render(
      <SettingsV2
        connectedAppsContent={<p>Connected apps owner</p>}
        initialSection="data"
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

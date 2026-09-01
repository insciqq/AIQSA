"use client";

import { UiV2Button } from "@/components/ui-v2";
import { applyThemeId, type ThemeId } from "@/components/app-shell/theme";
import { useState } from "react";
import {
  McpSettingsSummaryV2,
  SettingsV2
} from "@/features/settings-v2/SettingsV2";

export type SettingsGalleryStateV2 = "appearance" | "dirty" | "mcp";

export function SettingsV2Gallery({ state = "appearance" }: { state?: SettingsGalleryStateV2 }) {
  const [open, setOpen] = useState(true);
  const [dirty, setDirty] = useState(state === "dirty");
  const [theme, setTheme] = useState<ThemeId>(() => {
    const value = typeof document === "undefined" ? "dark" : document.documentElement.dataset.theme;
    return value === "light" || value === "system" ? value : "dark";
  });
  const updateTheme = (next: ThemeId) => {
    setTheme(next);
    applyThemeId(next);
  };
  return (
    <main className="v2-settings-fixture">
      <h1>Quarterly product brief</h1>
      <p>Settings is a temporary layer over the conversation, not a separate dashboard.</p>
      <UiV2Button onClick={() => setOpen(true)}>Open settings</UiV2Button>
      {open ? (
        <SettingsV2
          dirty={dirty}
          initialSection={state === "appearance" ? "general" : "mcp"}
          mcpContent={(
            <>
              <McpSettingsSummaryV2 servers={[
                { detail: "Workspace · OAuth connected", enabled: true, id: "jira", name: "Jira", ready: true, tools: 6 },
                { detail: "Personal setup required", enabled: true, id: "drive", name: "Drive", ready: false, tools: 0 }
              ]} />
              <div className="v2-settings-fixture-dirty">
                <UiV2Button onClick={() => setDirty((value) => !value)}>
                  {dirty ? "Save fixture" : "Edit personal field"}
                </UiV2Button>
              </div>
            </>
          )}
          onClose={() => setOpen(false)}
          onDiscard={() => setDirty(false)}
          onThemeChange={updateTheme}
          themeId={theme}
        />
      ) : null}
    </main>
  );
}

"use client";

import {
  applyAndRememberThemeId,
  applyThemeId,
  storedThemeId,
  type ThemeId
} from "@/components/app-shell/theme";
import type { InspectorMode } from "@/components/app-shell/types";
import { useEventCallback } from "@/components/app-shell/useEventCallback";
import type { InspectorTabId } from "@/components/app-shell/inspectorContracts";
import { useEffect, useState, type SetStateAction } from "react";

export type ShellAppearanceController = {
  details: {
    activeTab: InspectorTabId;
    changeActiveTab(tab: InspectorTabId): void;
    changeMode(value: SetStateAction<InspectorMode>): void;
    mode: InspectorMode;
  };
  theme: {
    change(themeId: ThemeId): void;
    id: ThemeId;
  };
};

export function useShellAppearanceController(): ShellAppearanceController {
  const [detailsMode, updateDetailsMode] = useState<InspectorMode>("closed");
  const [detailsActiveTab, updateDetailsActiveTab] = useState<InspectorTabId>("branch");
  const [themeId, updateThemeId] = useState<ThemeId>(() => storedThemeId());

  useEffect(() => {
    applyThemeId(themeId);
    if (themeId !== "system") {
      return;
    }

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const syncSystemScheme = () => applyThemeId("system");
    media.addEventListener("change", syncSystemScheme);
    return () => media.removeEventListener("change", syncSystemScheme);
  }, [themeId]);

  const changeTheme = useEventCallback((nextThemeId: ThemeId) => {
    updateThemeId(applyAndRememberThemeId(nextThemeId));
  });

  const changeDetailsMode = useEventCallback((value: SetStateAction<InspectorMode>) => {
    updateDetailsMode(value);
  });

  const changeDetailsActiveTab = useEventCallback((tab: InspectorTabId) => {
    updateDetailsActiveTab(tab);
  });

  return {
    details: {
      activeTab: detailsActiveTab,
      changeActiveTab: changeDetailsActiveTab,
      changeMode: changeDetailsMode,
      mode: detailsMode
    },
    theme: {
      change: changeTheme,
      id: themeId
    }
  };
}

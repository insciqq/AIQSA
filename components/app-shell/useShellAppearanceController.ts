"use client";

import { rememberInspectorMode, storedInspectorMode } from "@/components/app-shell/shellStorage";
import {
  applyAndRememberThemeId,
  applyThemeId,
  storedThemeId,
  type ThemeId
} from "@/components/app-shell/theme";
import type { InspectorMode } from "@/components/app-shell/types";
import { useEventCallback } from "@/components/app-shell/useEventCallback";
import type { InspectorTabId } from "@/components/inspector/InspectorTabs";
import { useEffect, useState, type SetStateAction } from "react";

export const detailsPinningMediaQuery = "(min-width: 1440px)";

export type ShellAppearanceController = {
  details: {
    activeTab: InspectorTabId;
    changeActiveTab(tab: InspectorTabId): void;
    changeMode(value: SetStateAction<InspectorMode>): void;
    mode: InspectorMode;
    pinningAvailable: boolean;
  };
  theme: {
    change(themeId: ThemeId): void;
    id: ThemeId;
  };
};

export function useShellAppearanceController(): ShellAppearanceController {
  const [detailsMode, updateDetailsMode] = useState<InspectorMode>("closed");
  const [detailsPinningAvailable, updateDetailsPinningAvailable] = useState(false);
  const [detailsActiveTab, updateDetailsActiveTab] = useState<InspectorTabId>("branch");
  const [themeId, updateThemeId] = useState<ThemeId>(() => storedThemeId());

  useEffect(() => {
    applyThemeId(themeId);
  }, [themeId]);

  const changeTheme = useEventCallback((nextThemeId: ThemeId) => {
    updateThemeId(applyAndRememberThemeId(nextThemeId));
  });

  const changeDetailsMode = useEventCallback((value: SetStateAction<InspectorMode>) => {
    updateDetailsMode((current) => {
      const next = typeof value === "function" ? value(current) : value;
      rememberInspectorMode(next);
      return next;
    });
  });

  const changeDetailsActiveTab = useEventCallback((tab: InspectorTabId) => {
    updateDetailsActiveTab(tab);
  });

  useEffect(() => {
    const media = window.matchMedia(detailsPinningMediaQuery);
    const storedMode = storedInspectorMode(media.matches);
    const timer = window.setTimeout(() => {
      updateDetailsPinningAvailable(media.matches);
      updateDetailsMode(storedMode);
    }, 0);

    function handlePinningViewportChange(event: MediaQueryListEvent) {
      updateDetailsPinningAvailable(event.matches);
      if (!event.matches) {
        updateDetailsMode((mode) => (mode === "pinned" ? "overlay" : mode));
      }
    }

    media.addEventListener("change", handlePinningViewportChange);
    return () => {
      window.clearTimeout(timer);
      media.removeEventListener("change", handlePinningViewportChange);
    };
  }, []);

  return {
    details: {
      activeTab: detailsActiveTab,
      changeActiveTab: changeDetailsActiveTab,
      changeMode: changeDetailsMode,
      mode: detailsMode,
      pinningAvailable: detailsPinningAvailable
    },
    theme: {
      change: changeTheme,
      id: themeId
    }
  };
}

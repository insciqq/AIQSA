"use client";

import {
  applyAndRememberThemeId,
  applyThemeId,
  storedThemeId,
  type ThemeId
} from "@/components/app-shell/theme";
import { useEventCallback } from "@/components/app-shell/useEventCallback";
import { useEffect, useState } from "react";

export type ShellAppearanceController = {
  theme: {
    change(themeId: ThemeId): void;
    id: ThemeId;
  };
};

export function useShellAppearanceController(): ShellAppearanceController {
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

  return {
    theme: {
      change: changeTheme,
      id: themeId
    }
  };
}

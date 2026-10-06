"use client";

import { useEffect } from "react";
import { AIQSA_THEME_STORAGE_KEY, applyThemeId, resolveThemeId } from "@/components/app-shell/theme";
import { AppErrorScreen } from "@/components/errors/AppErrorScreen";
import "../styles/tokens-v2.css";
import "../components/ui-v2/primitives.css";
import "./globals.css";

/** Replaces the root layout when it crashes, so it brings its own document and styles. */
export default function GlobalError({
  error,
  reset,
  retry
}: Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
  retry?: () => void;
}>) {
  useEffect(() => {
    // The root layout's theme cookie is not available here; the remembered
    // choice repairs the System default after hydration.
    try {
      applyThemeId(resolveThemeId(window.localStorage.getItem(AIQSA_THEME_STORAGE_KEY)));
    } catch {
      // Storage may be unavailable; System follows the OS.
    }
  }, []);

  return (
    <html data-theme="system" lang="en" suppressHydrationWarning>
      <body>
        <title>Something went wrong · AIQSA</title>
        <AppErrorScreen error={error} reset={reset} retry={retry} />
      </body>
    </html>
  );
}

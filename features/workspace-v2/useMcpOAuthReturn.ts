import { useEffect } from "react";
import { consumeMcpOAuthReturn, refreshMcpSettings } from "@/components/app-shell/mcpSettingsStore";

export function useMcpOAuthReturn(accountId: string, openMcpSettings: () => void): void {
  useEffect(() => {
    let current = true;
    // Account cleanup can run during React effect replay. Consume the URL
    // only for the live setup, after that cleanup has finished.
    queueMicrotask(() => {
      if (!current) return;
      const url = new URL(window.location.href);
      const shouldOpenMcp = url.searchParams.get("settings") === "mcp";
      consumeMcpOAuthReturn(url);
      if (shouldOpenMcp) {
        openMcpSettings();
        void refreshMcpSettings(true).catch(() => undefined);
      }
    });
    return () => { current = false; };
  }, [accountId, openMcpSettings]);
}

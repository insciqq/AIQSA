import { useEffect } from "react";
import { consumeMcpOAuthReturn, refreshMcpSettings } from "@/components/app-shell/mcpSettingsStore";
import { refreshPersonalMcp } from "@/components/app-shell/personalMcpStore";

export function useMcpOAuthReturn(accountId: string, openMcpSettings: () => void, openConnectionsSettings?: () => void): void {
  useEffect(() => {
    let current = true;
    // Account cleanup can run during React effect replay. Consume the URL
    // only for the live setup, after that cleanup has finished.
    queueMicrotask(() => {
      if (!current) return;
      const url = new URL(window.location.href);
      const shouldOpenConnections = url.searchParams.get("settings") === "connections";
      const shouldOpenMcp = url.searchParams.get("settings") === "mcp" ||
        (url.searchParams.get("library") === "mcp" && url.searchParams.has("oauth"));
      if (!shouldOpenMcp && !shouldOpenConnections) return;
      consumeMcpOAuthReturn(url);
      if (shouldOpenConnections) {
        // A personal outcome refreshes only the personal store; Studio's catalog is unaffected.
        openConnectionsSettings?.();
        void refreshPersonalMcp().catch(() => undefined);
        return;
      }
      openMcpSettings();
      void refreshMcpSettings(true).catch(() => undefined);
    });
    return () => { current = false; };
  }, [accountId, openConnectionsSettings, openMcpSettings]);
}

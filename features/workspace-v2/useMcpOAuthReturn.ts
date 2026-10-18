import { useEffect } from "react";
import { consumeMcpOAuthReturn, refreshMcpSettings } from "@/components/app-shell/mcpSettingsStore";
import { refreshPersonalMcp } from "@/components/app-shell/personalMcpStore";
import { useSettingsDestinationStore } from "@/components/app-shell/settingsDestinationStore";

export function useMcpOAuthReturn(accountId: string, openMcpSettings: () => void, openConnectionsSettings?: () => void): void {
  useEffect(() => {
    let current = true;
    // Account cleanup can run during React effect replay. Consume the URL
    // only for the live setup, after that cleanup has finished.
    queueMicrotask(() => {
      if (!current) return;
      const url = new URL(window.location.href);
      // A link from outside the chat shell (AIQSA Connect) to the agent connection commands.
      if (url.searchParams.get("settings") === "connected_apps") {
        url.searchParams.delete("settings");
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
        useSettingsDestinationStore.getState().openSettings("connected_apps");
        return;
      }
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

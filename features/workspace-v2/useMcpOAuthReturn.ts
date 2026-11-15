import { useEffect } from "react";
import { consumeMcpOAuthReturn, refreshMcpSettings } from "@/components/app-shell/mcpSettingsStore";
import { refreshPersonalMcp } from "@/components/app-shell/personalMcpStore";
import { legacySettingsSection } from "@/components/app-shell/settingsDestinationStore";
import type { LibraryTabIdV2 } from "@/features/library-v2/contracts";

/**
 * Opens the Settings section an address names with `?settings=<section>`
 * (links outside the chat shell, answers and bookmarks from the former
 * Settings dialog) and lands both MCP OAuth returns in MCP servers: the
 * installation's (`?settings=mcp` or `?library=mcp` with `oauth`) and a
 * personal connection's (`?settings=connections`). The parameter is consumed.
 */
export function useMcpOAuthReturn(accountId: string, openSection: (section: LibraryTabIdV2) => void): void {
  useEffect(() => {
    let current = true;
    // Account cleanup can run during React effect replay. Consume the URL
    // only for the live setup, after that cleanup has finished.
    queueMicrotask(() => {
      if (!current) return;
      const url = new URL(window.location.href);
      const named = url.searchParams.get("settings");
      const personal = named === "connections";
      const installation = named === "mcp" || (url.searchParams.get("library") === "mcp" && url.searchParams.has("oauth"));
      if (!personal && !installation) {
        const section = legacySettingsSection(named);
        if (!section) return;
        url.searchParams.delete("settings");
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
        openSection(section);
        return;
      }
      consumeMcpOAuthReturn(url);
      openSection("mcp");
      // A personal outcome refreshes only the personal store; the installation catalog is unaffected.
      if (personal) void refreshPersonalMcp().catch(() => undefined);
      else void refreshMcpSettings(true).catch(() => undefined);
    });
    return () => { current = false; };
  }, [accountId, openSection]);
}

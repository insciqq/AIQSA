"use client";

import { useEffect, useState } from "react";
import { UiV2Button } from "@/components/ui-v2";
import { mcpHubResourceMetadataSchema } from "@/lib/contracts/mcpHub";
import { shellFetch } from "./shellApi";

type ConnectionState = { status: "idle" | "loading" | "error" } | { status: "ready"; url: string };

export function McpHubConnection() {
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ConnectionState>({ status: "idle" });
  const [copy, setCopy] = useState<"idle" | "copied" | "error">("idle");

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    async function load() {
      setState({ status: "loading" });
      try {
        const response = await shellFetch("/.well-known/oauth-protected-resource/mcp/hub", {
          cache: "no-store", headers: { accept: "application/json" }, signal: controller.signal
        });
        if (!response.ok) throw new Error("hub_metadata_unavailable");
        const { resource } = mcpHubResourceMetadataSchema.parse(await response.json());
        if (!controller.signal.aborted) setState({ status: "ready", url: resource });
      } catch {
        if (!controller.signal.aborted) setState({ status: "error" });
      }
    }
    void load();
    return () => controller.abort();
  }, [open, attempt]);

  async function copyUrl() {
    if (state.status !== "ready") return;
    try {
      await navigator.clipboard.writeText(state.url);
      setCopy("copied");
    } catch { setCopy("error"); }
  }

  return (
    <details className="v2-settings-footnote" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="v2-focusable">Connect an external agent to MCP Hub</summary>
      <div className="v2-settings-disclosure-body">
        <p>Use the same enabled MCP connections from your external agent. Complete any required external account sign-in in the connection settings above.</p>
        {state.status === "loading" ? <p role="status">Loading the MCP Hub address…</p>
          : state.status === "error" ? (
            <div>
              <p role="alert">The MCP Hub address could not be loaded.</p>
              <UiV2Button onClick={() => setAttempt((value) => value + 1)}>Retry address</UiV2Button>
            </div>
          ) : state.status === "ready" ? (
            <div className="v2-settings-field">
              <label htmlFor="mcp-hub-address">MCP Hub URL</label>
              <div className="v2-settings-field-controls">
                <input className="v2-settings-input min-w-0 font-mono" id="mcp-hub-address" readOnly value={state.url} />
                <UiV2Button onClick={() => void copyUrl()}>Copy URL</UiV2Button>
              </div>
              {copy === "copied" ? <p role="status">MCP Hub URL copied.</p>
                : copy === "error" ? <p role="status">Select and copy the address above.</p> : null}
            </div>
          ) : null}
        <ol className="list-decimal space-y-1 pl-5">
          <li>Add the URL as an HTTP MCP server in your client.</li>
          <li>Sign in on the AIQSA page and approve MCP Hub access for that app.</li>
          <li>Ask the agent to find tools for your goal, then call a returned tool.</li>
        </ol>
        <p>MCP Hub exposes <code>find_tools</code> and <code>call_tool</code>. It follows your current permissions and enabled connections, including tools you enable later. Permitted tools may change external data.</p>
        <p>Manage or revoke the app&apos;s MCP Hub permission in Connected Apps. Personal Memory uses a separate permission and the <code>/mcp</code> address.</p>
      </div>
    </details>
  );
}

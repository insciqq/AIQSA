"use client";

import { useEffect, useState } from "react";
import { UiV2Button } from "@/components/ui-v2";
import { AGENT_CONNECTION_PATHS, agentConnectionCommands, agentConnectionMetadataSchema, type AgentClient, type AgentConnection } from "@/lib/contracts/agentConnections";
import { useSettingsDestinationStore } from "./settingsDestinationStore";
import { shellFetch } from "./shellApi";

type ConnectionState = { status: "loading" } | { status: "error" } | { status: "ready"; origin: string; hubEnabled: boolean };

const CONNECTIONS = {
  hub: { label: "MCP Hub", description: "Find and use your enabled tools. Permitted tools may change data in connected services." },
  skills: { label: "Personal Skills", description: "Download and install your Skills locally. You can separately allow creating, updating, and deleting your Skills." },
  memory: { label: "Personal Memory", description: "Optional access to read, add, change, and delete your Memory facts. Your chat history is not shared." }
} as const;

export function McpHubConnection({ expanded = false }: Readonly<{ expanded?: boolean }>) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ConnectionState>({ status: "loading" });
  const [copy, setCopy] = useState<"idle" | "copied" | "error">("idle");
  const [client, setClient] = useState<AgentClient>("claude");
  const [connection, setConnection] = useState<AgentConnection>("hub");

  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    async function load() {
      setState({ status: "loading" });
      try {
        const response = await shellFetch("/agents/metadata", {
          cache: "no-store", headers: { accept: "application/json" }, signal: controller.signal
        });
        if (!response.ok) throw new Error("agent_metadata_unavailable");
        const metadata = agentConnectionMetadataSchema.parse(await response.json());
        if (!controller.signal.aborted) {
          setState({ status: "ready", ...metadata });
          if (!metadata.hubEnabled) setConnection("skills");
        }
      } catch {
        if (!controller.signal.aborted) setState({ status: "error" });
      }
    }
    void load();
    return () => controller.abort();
  }, [expanded, attempt]);

  async function copyGuide() {
    if (state.status !== "ready") return;
    try {
      await navigator.clipboard.writeText(`${state.origin}/AGENTS.md`);
      setCopy("copied");
    } catch { setCopy("error"); }
  }

  if (!expanded) return (
    <div className="v2-settings-footnote">
      <UiV2Button tone="ghost" onClick={() => useSettingsDestinationStore.getState().openSettings("connected_apps")}>
        Connect Claude Code or Codex
      </UiV2Button>
    </div>
  );

  return (
    <section aria-labelledby="agent-connect-heading" className="v2-agent-connect">
      <div>
        <h3 id="agent-connect-heading">Connect your agent</h3>
        <p>Give this link to your agent and ask it to connect AIQSA. You sign in and choose its permissions in the browser.</p>
      </div>
      {state.status === "loading" ? <p role="status">Loading the connection guide…</p>
        : state.status === "error" ? (
          <div>
            <p role="alert">The connection guide address could not be loaded.</p>
            <UiV2Button onClick={() => setAttempt((value) => value + 1)}>Retry address</UiV2Button>
          </div>
        ) : (
          <>
            <div className="v2-agent-guide-field">
              <label htmlFor="agent-guide-address">Agent instructions</label>
              <div className="v2-settings-field-controls">
                <input className="v2-settings-input" id="agent-guide-address" readOnly value={`${state.origin}/AGENTS.md`} />
                <UiV2Button onClick={() => void copyGuide()}>Copy link</UiV2Button>
              </div>
              {copy === "copied" ? <p role="status">Agent instructions link copied.</p>
                : copy === "error" ? <p role="status">Select and copy the address above.</p> : null}
              <a className="v2-focusable" href={`${state.origin}/AGENTS.md`} rel="noreferrer" target="_blank">Read the connection guide</a>
            </div>
            <dl className="v2-agent-capabilities">
              {Object.entries(CONNECTIONS).filter(([key]) => key !== "hub" || state.hubEnabled).map(([key, item]) => (
                <div key={key}><dt>{item.label}</dt><dd>{item.description}</dd></div>
              ))}
            </dl>
            <details className="v2-settings-disclosure">
              <summary className="v2-focusable">Set up manually</summary>
              <div className="v2-agent-manual">
                <div aria-label="Agent client" className="v2-agent-client-picker" role="group">
                  <UiV2Button aria-pressed={client === "claude"} onClick={() => setClient("claude")}>Claude Code</UiV2Button>
                  <UiV2Button aria-pressed={client === "codex"} onClick={() => setClient("codex")}>Codex</UiV2Button>
                </div>
                <label className="v2-agent-connection-select">
                  Connection
                  <select className="v2-settings-input" value={connection} onChange={(event) => setConnection(event.target.value as AgentConnection)}>
                    {state.hubEnabled ? <option value="hub">MCP Hub</option> : null}
                    <option value="skills">Personal Skills</option>
                    <option value="memory">Personal Memory (optional)</option>
                  </select>
                </label>
                <p>Keep existing connections. Run these commands in your terminal if this AIQSA address is not already configured.</p>
                <pre className="v2-agent-command" tabIndex={0}><code>{agentConnectionCommands(client, connection, state.origin)}</code></pre>
                <p>{client === "claude"
                  ? "Open Claude Code, run /mcp, and select the connection to sign in. Reconnect there or start a new session to discover its tools."
                  : "Complete sign-in in your browser, then start a new Codex session to discover its tools. Adding a connection may start sign-in automatically."}</p>
                <p className="v2-agent-endpoint">HTTP MCP address: <code>{state.origin}{AGENT_CONNECTION_PATHS[connection]}</code></p>
                {connection === "skills" ? <p>Read access is enough to install a Skill. The connection guide explains how to allow changes and transfer complete packages.</p>
                  : connection === "hub" ? <p>Ask the agent to find a tool for your goal and use an appropriate returned tool. Available tools follow your current permissions and enabled connections.</p>
                    : <p>Memory has its own permission; it is not needed for MCP Hub or Skills.</p>}
              </div>
            </details>
          </>
        )}
    </section>
  );
}

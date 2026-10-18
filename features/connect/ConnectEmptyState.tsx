"use client";

import { UiV2Button } from "@/components/ui-v2";
import { CONNECT_INSTALL_SCRIPT_PATH } from "@/lib/contracts/connect";
import { useState } from "react";

/** Settings → Claude Code & Codex in the chat shell, where Memory, Skills and Hub are connected. */
export const CONNECT_AGENT_CONNECTIONS_HREF = "/?settings=connected_apps";

export function connectInstallSteps(origin: string): readonly Readonly<{ command: string; description: string; title: string }>[] {
  return [
    {
      command: `curl -fsSL ${origin}${CONNECT_INSTALL_SCRIPT_PATH} | sh`,
      description: "Installs aiqsa-connect into ~/.local/bin on macOS, Linux or WSL. No administrator rights are needed.",
      title: "Install aiqsa-connect"
    },
    {
      command: `aiqsa-connect login ${origin}`,
      description: "Shows a code and a link. Open the link here and approve the computer.",
      title: "Connect the computer"
    },
    {
      command: "aiqsa-connect setup\naiqsa-connect service install",
      description: "Checks tmux, adds the Claude Code and Codex status hooks and keeps aiqsa-connect running in the background.",
      title: "Finish setup"
    }
  ];
}

function CommandBlock({ command, label }: Readonly<{ command: string; label: string }>) {
  const [copy, setCopy] = useState<"copied" | "error" | "idle">("idle");
  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setCopy("copied");
    } catch {
      setCopy("error");
    }
  }
  return (
    <div className="v2-connect-command">
      <pre aria-label={label} tabIndex={0}><code>{command}</code></pre>
      <UiV2Button icon="copy" onClick={() => void copyCommand()}>{copy === "copied" ? "Copied" : "Copy"}</UiV2Button>
      {copy === "error" ? <p className="text-metadata text-ink-muted" role="status">Select the command and copy it.</p> : null}
    </div>
  );
}

/** No computers yet: the three steps that add one, with this installation's commands. */
export function ConnectEmptyState({ installOrigin }: Readonly<{ installOrigin: string | null }>) {
  return (
    <section aria-labelledby="connect-empty-heading" className="v2-connect-empty" data-testid="connect-empty-state">
      <h2 className="text-lg font-semibold text-ink" id="connect-empty-heading">Connect your first computer</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-secondary">
        Open terminals, Claude Code and Codex running on your own computer from any browser where you use AIQSA.
        Run these commands in a terminal on that computer.
      </p>
      {installOrigin ? (
        <ol className="mt-6 flex flex-col gap-5">
          {connectInstallSteps(installOrigin).map((step, index) => (
            <li className="v2-connect-step" key={step.title}>
              <span aria-hidden="true" className="v2-connect-step-number">{index + 1}</span>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-ink">{step.title}</h3>
                <p className="mt-1 text-sm leading-6 text-ink-secondary">{step.description}</p>
                <CommandBlock command={step.command} label={`${step.title} command`} />
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="v2-connect-alert mt-6" role="alert">
          This installation has no valid public address, so the install commands are unavailable. Ask your administrator.
        </p>
      )}
      <div className="mt-8 max-w-2xl border-t border-trace-subtle pt-5 text-sm leading-6 text-ink-secondary">
        <p>
          Signing in to Claude Code, Codex and their MCP connections happens at the computer, in its terminal.
          To give your agents your AIQSA Memory, Skills and MCP Hub, use the commands in{" "}
          <a className="v2-connect-link v2-focusable" href={CONNECT_AGENT_CONNECTIONS_HREF}>Settings → Claude Code &amp; Codex</a>.
        </p>
      </div>
    </section>
  );
}

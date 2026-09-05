"use client";

import { writeClipboardText } from "@/components/clipboard/writeClipboardText";
import { UiV2Icon } from "@/components/ui-v2";
import type {
  ThreadWorkspaceActivity,
  ThreadWorkspaceActivityEntry
} from "@/lib/contracts/workspace";
import { useEffect, useRef, useState } from "react";
import {
  WORKSPACE_RECREATED_NOTICE_V2,
  aggregateWorkspaceActivityV2,
  workspaceActivityLabelV2,
  workspaceDurationV2
} from "./workspaceActivityPresentation";

type Phase = ThreadWorkspaceActivityEntry["phase"];

function markStatus(phase: Phase): "cancelled" | "complete" | "error" | "running" {
  switch (phase) {
    case "succeeded":
      return "complete";
    case "failed":
      return "error";
    case "cancelled":
      return "cancelled";
    default:
      return "running";
  }
}

function ActivityMarkV2({ phase }: { phase: Phase }) {
  const status = markStatus(phase);
  if (status === "running") {
    return <span className="v2-answer-process-mark v2-spinner" data-status={status} aria-hidden="true" />;
  }
  return (
    <span className="v2-answer-process-mark" data-status={status} aria-hidden="true">
      {status === "complete" ? <UiV2Icon name="check" /> : null}
      {status === "error" ? <UiV2Icon name="alert" /> : null}
    </span>
  );
}

function CopyCommandV2({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const resetRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (resetRef.current !== null) window.clearTimeout(resetRef.current);
  }, []);
  return (
    <button
      aria-label="Copy command"
      className="v2-workspace-copy v2-focusable"
      onClick={() => {
        void writeClipboardText(command).then(() => {
          setCopied(true);
          if (resetRef.current !== null) window.clearTimeout(resetRef.current);
          resetRef.current = window.setTimeout(() => setCopied(false), 1_600);
        }).catch(() => setCopied(false));
      }}
      type="button"
    >
      <UiV2Icon name={copied ? "check" : "copy"} />
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function OutputBlockV2({ label, text }: { label: string; text: string }) {
  return (
    <div className="v2-workspace-output" data-stream={label}>
      <span className="v2-workspace-output-label">{label}</span>
      <pre className="v2-workspace-output-text" tabIndex={0}>{text}</pre>
    </div>
  );
}

function CommandRowV2({ entry }: { entry: ThreadWorkspaceActivityEntry }) {
  const command = entry.command;
  const failed = entry.phase === "failed" || entry.phase === "cancelled";
  const duration = workspaceDurationV2(entry.durationMs);
  const label = workspaceActivityLabelV2(entry);
  if (!command) return null;
  const streams = failed
    ? [["stderr", command.stderrPreview], ["stdout", command.stdoutPreview]] as const
    : [["stdout", command.stdoutPreview], ["stderr", command.stderrPreview]] as const;
  return (
    <details className="v2-workspace-command" data-phase={entry.phase} open={failed || undefined}>
      <summary className="v2-focusable">
        <ActivityMarkV2 phase={entry.phase} />
        <span className="v2-workspace-row-label">{label}</span>
        {duration ? <span className="v2-workspace-row-meta">{duration}</span> : null}
      </summary>
      <div className="v2-workspace-command-body">
        <div className="v2-workspace-command-line">
          <span className="v2-workspace-output-label">Command</span>
          <code className="v2-workspace-command-text">$ {command.preview}</code>
          <CopyCommandV2 command={command.preview} />
        </div>
        {command.cwd ? (
          <div className="v2-workspace-command-line">
            <span className="v2-workspace-output-label">Working directory</span>
            <code className="v2-workspace-command-text">{command.cwd}</code>
          </div>
        ) : null}
        {streams.map(([name, text]) => text ? <OutputBlockV2 key={name} label={name} text={text} /> : null)}
        {command.truncated ? <p className="v2-workspace-truncated" role="note">Output truncated</p> : null}
        {command.exitCode !== undefined && command.exitCode !== null ? (
          <p className="v2-workspace-exit">
            Exit code {command.exitCode}{duration ? ` · ${duration}` : ""}
          </p>
        ) : null}
      </div>
    </details>
  );
}

function PlainRowV2({ entry }: { entry: ThreadWorkspaceActivityEntry }) {
  const duration = workspaceDurationV2(entry.durationMs);
  return (
    <div className="v2-workspace-row">
      <ActivityMarkV2 phase={entry.phase} />
      <span className="v2-workspace-row-copy">
        <span className="v2-workspace-row-label">{workspaceActivityLabelV2(entry)}</span>
        {duration ? <span className="v2-workspace-row-meta">{duration}</span> : null}
        {entry.kind === "workspace_recreated" ? (
          <span className="v2-workspace-row-note" role="note">{WORKSPACE_RECREATED_NOTICE_V2}</span>
        ) : null}
      </span>
    </div>
  );
}

export type WorkspaceActivityTimelineV2Props = Readonly<{
  activity: ThreadWorkspaceActivity;
}>;

/**
 * Chronological Workspace feed: lifecycle rows, file operations, and command
 * cards that open into a terminal-style excerpt. Failed commands open on their
 * own; successful ones stay compact. Every label is client copy.
 */
export function WorkspaceActivityTimelineV2({ activity }: WorkspaceActivityTimelineV2Props) {
  const rows = aggregateWorkspaceActivityV2(activity.entries);
  if (rows.length === 0) return null;
  return (
    <ol className="v2-workspace-timeline" data-testid="workspace-activity">
      {rows.map((entry) => (
        <li data-kind={entry.kind} data-phase={entry.phase} key={entry.id}>
          {entry.kind === "command" && entry.command ? <CommandRowV2 entry={entry} /> : <PlainRowV2 entry={entry} />}
        </li>
      ))}
    </ol>
  );
}

"use client";

import { summarizeInspectorEvents } from "@/components/app-shell/eventLog";
import { branchTreeHasForks, branchTreeNodes } from "@/components/app-shell/threadPath";
import type { RunEventView, ThreadMessage } from "@/components/app-shell/types";
import {
  InspectorTabs,
  inspectorPanelId,
  inspectorTabId,
  type InspectorTabId
} from "@/components/inspector/InspectorTabs";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Circle,
  GitBranch,
  Pin,
  PinOff,
  X,
  XCircle
} from "lucide-react";

export function DetailedInspector({
  activeLeafId,
  activeTab,
  errorText,
  events,
  messages,
  onActiveTabChange,
  onClose,
  onPinToggle,
  onSelectBranch,
  pinned,
  pinningAvailable,
  runId,
  streaming
}: {
  activeLeafId: string | null;
  activeTab: InspectorTabId;
  errorText: string | null;
  events: RunEventView[];
  messages: ThreadMessage[];
  onActiveTabChange(tab: InspectorTabId): void;
  onClose(): void;
  onPinToggle(): void;
  onSelectBranch(messageId: string): void;
  pinned: boolean;
  pinningAvailable: boolean;
  runId: string | null;
  streaming: boolean;
}) {
  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-overlay-surface text-ink"
      data-testid="details-content"
    >
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-trace-subtle px-4 py-4 [@media(max-height:32rem)]:py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h2 className="text-base font-semibold tracking-[-0.01em] text-ink" id="details-heading">Details</h2>
            <span
              className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-muted"
              data-testid="details-mode-label"
            >
              {pinned ? "Pinned view" : "Overlay view"}
            </span>
          </div>
          <p
            className={`mt-1 max-h-10 overflow-y-auto break-words text-xs leading-5 [overflow-wrap:anywhere] ${errorText ? "text-critical" : streaming ? "text-proof" : "text-ink-muted"}`}
            data-testid="details-summary"
            title={errorText ?? undefined}
          >
            {errorText ?? (
              streaming
                ? events.length > 0 ? "Run active · live events available" : "Run active"
                : runId
                  ? events.length > 0 ? "Run events available" : "Run recorded · no events captured"
                  : "Branch and run events"
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {pinningAvailable ? (
            <button
              className="grid size-9 place-items-center rounded-control text-ink-muted outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-proof/55 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"
              type="button"
              aria-label={pinned ? "Unpin details" : "Pin details"}
              aria-pressed={pinned}
              title={pinned ? "Unpin details" : "Pin details"}
              onClick={onPinToggle}
            >
              {pinned ? <PinOff className="size-4" aria-hidden="true" /> : <Pin className="size-4" aria-hidden="true" />}
            </button>
          ) : null}
          <button
            className="grid size-9 place-items-center rounded-control text-ink-muted outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-proof/55 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"
            type="button"
            aria-label="Close details"
            title="Close details"
            onClick={onClose}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      <InspectorTabs activeTab={activeTab} onTabChange={onActiveTabChange} />

      <div
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-3 py-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-proof/55 sm:px-4 [@media(max-height:32rem)]:py-3"
        id={inspectorPanelId(activeTab)}
        role="tabpanel"
        aria-labelledby={inspectorTabId(activeTab)}
        tabIndex={0}
      >
        <div className="min-w-0">
          {activeTab === "events" ? <EventLog events={events} /> : null}

          {activeTab === "branch" ? (
            <BranchTree
              messages={messages}
              activeLeafId={activeLeafId}
              streaming={streaming}
              onSelect={onSelectBranch}
            />
          ) : null}

        </div>
      </div>
      {(["branch", "events"] as const)
        .filter((tab) => tab !== activeTab)
        .map((tab) => (
          <div
            aria-labelledby={inspectorTabId(tab)}
            hidden
            id={inspectorPanelId(tab)}
            key={tab}
            role="tabpanel"
          />
        ))}
    </div>
  );
}

function EventLog({ events }: { events: RunEventView[] }) {
  const summaries = summarizeInspectorEvents(events);

  return (
    <section aria-labelledby="details-events-heading">
      <div className="flex items-start gap-3">
        <Activity className="mt-0.5 size-4 shrink-0 text-proof" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-[0.09em] text-ink-muted">Run trace</p>
          <h3 className="mt-0.5 text-[15px] font-semibold text-ink" id="details-events-heading">Events</h3>
          <p className="mt-1 text-xs leading-5 text-ink-secondary">
            Chronological run evidence. Repeated provider, token, tool, and artifact updates are compacted at their first occurrence.
          </p>
        </div>
      </div>

      <ol className="mt-4 border-y border-trace-subtle" data-testid="inspector-event-log">
        {summaries.length === 0 ? (
          <li className="bg-control-surface px-3 py-5 text-xs leading-5 text-ink-secondary">
            Events appear here during a run. Details stays closed until you open it.
          </li>
        ) : (
          summaries.map((item, index) => (
            <li
              className={[
                "relative grid min-w-0 grid-cols-[2.75rem_minmax(0,1fr)] gap-3 border-b border-trace-subtle px-2 py-3 text-xs last:border-b-0 sm:grid-cols-[3rem_minmax(0,1fr)] sm:px-3",
                item.tone === "error"
                  ? "bg-critical/[0.055]"
                  : item.tone === "warning"
                    ? "bg-caution/[0.055]"
                    : "bg-overlay-surface"
              ].join(" ")}
              data-tone={item.tone}
              key={item.id}
            >
              <span className="sr-only">Event {index + 1}, stage {item.stage}.</span>
              <div className="border-r border-trace-subtle pr-2 font-mono text-[10px] leading-4 text-ink-muted" aria-hidden="true">
                <div className="text-ink-disabled">{String(index + 1).padStart(2, "0")}</div>
                <div className="mt-1 break-words font-semibold text-ink-secondary [overflow-wrap:anywhere]">
                  {item.stage}
                </div>
              </div>
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-1.5 font-medium text-ink-secondary">
                    <EventToneIcon tone={item.tone} />
                    <span className="min-w-0 break-words [overflow-wrap:anywhere]">{item.label}</span>
                </div>
                <p
                  className={[
                    "mt-1 break-words text-sm leading-5 [overflow-wrap:anywhere]",
                    item.tone === "error"
                      ? "text-critical"
                      : item.tone === "success"
                        ? "text-positive"
                        : item.tone === "warning"
                          ? "text-caution"
                          : "text-ink"
                  ].join(" ")}
                >
                  {item.value}
                </p>
                {item.detail ? (
                  <div
                    className="mt-1 break-words font-mono text-[11px] leading-5 text-ink-muted [overflow-wrap:anywhere]"
                    title={item.detail}
                  >
                    {item.detail}
                  </div>
                ) : null}
              </div>
            </li>
          ))
        )}
      </ol>
    </section>
  );
}

function EventToneIcon({ tone }: { tone: "default" | "error" | "success" | "warning" }) {
  if (tone === "error") {
    return <XCircle className="size-3.5 shrink-0 text-critical" aria-hidden="true" />;
  }

  if (tone === "success") {
    return <CheckCircle2 className="size-3.5 shrink-0 text-positive" aria-hidden="true" />;
  }

  if (tone === "warning") {
    return <AlertTriangle className="size-3.5 shrink-0 text-caution" aria-hidden="true" />;
  }

  return <Circle className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />;
}

function BranchTree({
  activeLeafId,
  messages,
  onSelect,
  streaming
}: {
  activeLeafId: string | null;
  messages: ThreadMessage[];
  onSelect(messageId: string): void;
  streaming: boolean;
}) {
  const nodes = branchTreeNodes(messages, activeLeafId);
  const hasForks = branchTreeHasForks(messages);
  const activePathLength = nodes.filter((node) => node.activePath).length;
  const leafCount = nodes.filter((node) => node.childCount === 0).length;
  const childCountByMessageId = new Map(nodes.map((node) => [node.message.id, node.childCount]));

  return (
    <section aria-labelledby="details-branch-heading" data-testid="branch-tree">
      <div className="flex items-start gap-3">
        <GitBranch className="mt-0.5 size-4 shrink-0 text-proof" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-[0.09em] text-ink-muted">Conversation path</p>
          <h3 className="mt-0.5 text-[15px] font-semibold text-ink" id="details-branch-heading">Branches</h3>
          <p className="mt-1 text-xs leading-5 text-ink-secondary">
            {nodes.length === 0
              ? "Messages appear here after the conversation begins."
              : hasForks
                ? `${leafCount} paths · ${activePathLength} messages on the active path`
                : `${activePathLength} messages on one linear path`}
          </p>
        </div>
      </div>

      {nodes.length > 0 && !hasForks ? (
        <p className="mt-4 border-l border-trace-strong bg-control-surface px-3 py-2.5 text-xs leading-5 text-ink-secondary">
          This chat has a single path. Edit, regenerate, or Branch from here to create branches.
        </p>
      ) : null}
      {streaming && nodes.length > 0 ? (
        <p className="mt-3 border-l border-caution/60 bg-caution/[0.06] px-3 py-2.5 text-xs leading-5 text-ink-secondary" id="branch-streaming-guidance" role="status">
          You can’t open another version while a response is streaming. Stop or finish the response first.
        </p>
      ) : null}

      {nodes.length === 0 ? (
        <div className="mt-4 border-y border-trace-subtle bg-control-surface px-3 py-5 text-xs leading-5 text-ink-secondary">
          No conversation yet. Ask a question to create the first path.
        </div>
      ) : null}

      <div className="mt-4 border-y border-trace-subtle text-xs empty:hidden">
        {nodes.map((node, index) => (
          <button
            aria-label={`${node.active ? "Active branch" : "Open this version, branch"} ${node.message.role} ${index + 1}`}
            aria-disabled={node.active || streaming}
            aria-current={node.active ? "true" : undefined}
            aria-describedby={[
              `branch-node-${index + 1}-description`,
              streaming ? "branch-streaming-guidance" : null
            ].filter(Boolean).join(" ")}
            className={[
              "group relative grid min-h-touch w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2 border-b border-trace-subtle px-2 py-3 text-left outline-none last:border-b-0 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-proof/55 disabled:cursor-not-allowed disabled:opacity-55 sm:gap-3 sm:px-3",
              node.active
                ? "bg-control-selected text-ink before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-pill before:bg-proof"
                : node.activePath
                  ? "bg-proof/[0.025] text-ink hover:bg-control-hover"
                  : "bg-overlay-surface text-ink-secondary hover:bg-control-hover hover:text-ink"
            ].join(" ")}
            data-active-leaf={node.active ? "true" : undefined}
            data-depth={node.depth}
            disabled={streaming}
            key={node.message.id}
            title={
              streaming
                ? "Opening another version is disabled while a response is streaming"
                : node.active
                  ? "Current active leaf"
                  : node.preview
            }
            type="button"
            onClick={() => {
              if (!node.active) {
                onSelect(node.message.id);
              }
            }}
          >
            <span className="sr-only" id={`branch-node-${index + 1}-description`}>
              {node.message.role === "user" ? "Question" : "Answer"}. {node.preview.replace(/[.!?]+$/, "")}.{" "}
              {node.childCount > 1 ? `Fork point with ${node.childCount} choices. ` : ""}
              {node.active
                ? "Active leaf."
                : `${node.activePath ? "On the active path. " : ""}Open this version.`}
            </span>
            <span className="flex min-w-0 items-start gap-2" style={{ paddingLeft: `${Math.min(node.depth, 5) * 10}px` }}>
              <span
                className={[
                  "grid size-6 shrink-0 place-items-center rounded-full border font-mono text-[10px] font-semibold",
                  node.activePath
                    ? "border-proof/35 bg-proof/[0.08] text-proof"
                    : "border-trace-subtle bg-control-surface text-ink-muted"
                ].join(" ")}
                aria-hidden="true"
              >
                {node.roleGlyph}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-medium text-ink-muted">
                  <span>{node.message.role === "user" ? "Question" : "Answer"}</span>
                  {node.childCount > 1 ? <span className="text-caution">Fork point · {node.childCount} choices</span> : null}
                  {node.message.parentMessageId && (childCountByMessageId.get(node.message.parentMessageId) ?? 0) > 1 ? (
                    <span className="text-proof">Branch path</span>
                  ) : null}
                </span>
                <span className="mt-1 block break-words text-[13px] leading-5 [display:-webkit-box] [overflow-wrap:anywhere] [-webkit-box-orient:vertical] [-webkit-line-clamp:3]">
                  {node.preview}
                </span>
              </span>
            </span>
            {node.active ? (
              <span className="pt-0.5 text-[11px] font-semibold text-proof">
                Active leaf
              </span>
            ) : (
              <span className="pt-0.5 text-[11px] font-medium text-ink-secondary group-hover:text-ink">
                <span className="sm:hidden">Open</span>
                <span className="hidden sm:inline">Open this version</span>
              </span>
            )}
          </button>
        ))}
      </div>
    </section>
  );
}

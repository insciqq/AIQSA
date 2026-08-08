"use client";

import { summarizeInspectorEvents } from "@/components/app-shell/eventLog";
import { branchTreeHasForks, branchTreeNodes } from "@/components/app-shell/threadPath";
import type { Catalog, RunEventView, ThreadMessage } from "@/components/app-shell/types";
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
  catalog = null,
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
  catalog?: Catalog | null;
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
            {pinned ? (
              <span
                className="text-xs font-medium text-ink-muted"
                data-testid="details-mode-label"
              >
                Pinned beside chat
              </span>
            ) : null}
          </div>
          <p
            className={`mt-1 max-h-10 overflow-y-auto break-words text-xs leading-5 [overflow-wrap:anywhere] ${errorText ? "text-critical" : streaming ? "text-proof" : "text-ink-muted"}`}
            data-testid="details-summary"
            title={errorText ?? undefined}
          >
            {errorText ?? (
              streaming
                ? events.length > 0
                  ? `${events.length} ${events.length === 1 ? "event" : "events"} recorded so far. The run is still active.`
                  : "The run is active. No events have arrived yet."
                : runId
                  ? events.length > 0
                    ? `${events.length} recorded ${events.length === 1 ? "event" : "events"} for this run.`
                    : "This run was recorded without events."
                  : "Review conversation branches or recorded run events."
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {pinningAvailable ? (
            <button
              className="grid size-9 place-items-center rounded-control text-ink-muted outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-focus [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"
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
            className="grid size-9 place-items-center rounded-control text-ink-muted outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-focus [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"
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
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-3 py-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus sm:px-4 [@media(max-height:32rem)]:py-3"
        id={inspectorPanelId(activeTab)}
        role="tabpanel"
        aria-labelledby={inspectorTabId(activeTab)}
        tabIndex={0}
      >
        <div className="min-w-0">
          {activeTab === "events" ? (
            <EventLog catalog={catalog} events={events} runRecorded={Boolean(runId)} streaming={streaming} />
          ) : null}

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

function EventLog({
  catalog,
  events,
  runRecorded,
  streaming
}: {
  catalog: Catalog | null;
  events: RunEventView[];
  runRecorded: boolean;
  streaming: boolean;
}) {
  const summaries = summarizeInspectorEvents(events, catalog);

  return (
    <section aria-labelledby="details-events-heading">
      <div className="flex items-start gap-3">
        <Activity className="mt-0.5 size-4 shrink-0 text-proof" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-xs font-medium text-ink-muted">Run timeline</p>
          <h3 className="mt-0.5 text-[15px] font-semibold text-ink" id="details-events-heading">Events</h3>
          <p className="mt-1 text-xs leading-5 text-ink-secondary">
            Recorded events in order. Repeated text, provider, tool, and usage updates are grouped while their counts and recorded details stay visible.
          </p>
        </div>
      </div>

      <ol className="mt-4 border-y border-trace-subtle" data-testid="inspector-event-log">
        {summaries.length === 0 ? (
          <li className="bg-control-surface px-3 py-5 text-xs leading-5 text-ink-secondary">
            {streaming
              ? "The run is active. No events have arrived yet."
              : runRecorded
                ? "This run has no recorded events."
                : "Run events will appear here after a response starts."}
          </li>
        ) : (
          summaries.map((item, index) => (
            <li
              className={[
                "relative grid min-w-0 grid-cols-[4.25rem_minmax(0,1fr)] gap-2 border-b border-trace-subtle px-2 py-3 text-xs last:border-b-0 sm:grid-cols-[4.5rem_minmax(0,1fr)] sm:gap-3 sm:px-3",
                item.tone === "error"
                  ? "bg-critical/[0.055]"
                  : item.tone === "warning"
                    ? "bg-caution/[0.055]"
                    : "bg-overlay-surface"
              ].join(" ")}
              data-tone={item.tone}
              key={item.id}
            >
              <span className="sr-only">Event {index + 1}, {eventStageLabel(item.stage)}.</span>
              <div className="border-r border-trace-subtle pr-2 text-xs leading-4 text-ink-muted" aria-hidden="true">
                <div className="font-mono text-ink-disabled">{String(index + 1).padStart(2, "0")}</div>
                <div className="mt-1 break-words font-semibold text-ink-secondary [overflow-wrap:anywhere]">
                  {eventStageLabel(item.stage)}
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
                    className="mt-1 break-words font-mono text-xs leading-5 text-ink-muted [overflow-wrap:anywhere]"
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

function eventStageLabel(stage: string): string {
  const labels: Record<string, string> = {
    A: "Answer",
    API: "Usage",
    ART: "Evidence",
    K: "Knowledge",
    Q: "Question",
    RUN: "Run",
    S: "Search",
    TOOL: "Tool"
  };

  return labels[stage] ?? stage.replace(/[_-]+/g, " ");
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
  const messageCountLabel = `${activePathLength} ${activePathLength === 1 ? "message" : "messages"}`;

  return (
    <section aria-labelledby="details-branch-heading" data-testid="branch-tree">
      <div className="flex items-start gap-3">
        <GitBranch className="mt-0.5 size-4 shrink-0 text-proof" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-xs font-medium text-ink-muted">Conversation versions</p>
          <h3 className="mt-0.5 text-[15px] font-semibold text-ink" id="details-branch-heading">Branches</h3>
          <p className="mt-1 text-xs leading-5 text-ink-secondary">
            {nodes.length === 0
              ? "No messages yet."
              : hasForks
                ? `${leafCount} versions · ${messageCountLabel} in the current version`
                : `${messageCountLabel} · one version`}
          </p>
        </div>
      </div>

      {nodes.length > 0 && !hasForks ? (
        <p className="mt-4 border-l border-trace-strong bg-control-surface px-3 py-2.5 text-xs leading-5 text-ink-secondary">
          This conversation has one version. Edit, regenerate, or use Branch from here to create another.
        </p>
      ) : null}
      {streaming && hasForks && nodes.some((node) => !node.activePath) ? (
        <p className="mt-3 border-l border-caution/60 bg-caution/[0.06] px-3 py-2.5 text-xs leading-5 text-ink-secondary" id="branch-streaming-guidance" role="status">
          Another version cannot be opened while this response is streaming. Stop it or wait for it to finish.
        </p>
      ) : null}

      {nodes.length === 0 ? (
        <div className="mt-4 border-y border-trace-subtle bg-control-surface px-3 py-5 text-xs leading-5 text-ink-secondary">
          No conversation yet. Ask a question to create the first version.
        </div>
      ) : null}

      <div className="mt-4 border-y border-trace-subtle text-xs empty:hidden">
        {nodes.map((node, index) => {
          const alternateVersion = hasForks && !node.activePath;
          const rowClassName = [
            "group relative grid min-h-touch w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2 border-b border-trace-subtle px-2 py-3 text-left outline-none last:border-b-0 sm:gap-3 sm:px-3",
            alternateVersion
              ? "bg-overlay-surface text-ink-secondary hover:bg-control-hover hover:text-ink focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-55"
              : node.active
                ? "bg-control-selected text-ink before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-pill before:bg-proof"
                : "bg-proof/[0.025] text-ink"
          ].join(" ");
          const rowContent = (
            <>
              <span className="flex min-w-0 items-start gap-2" style={{ paddingLeft: `${Math.min(node.depth, 5) * 10}px` }}>
                <span
                  className={[
                    "grid size-6 shrink-0 place-items-center rounded-full border font-mono text-xs font-semibold",
                    node.activePath
                      ? "border-proof/35 bg-proof/[0.08] text-proof"
                      : "border-trace-subtle bg-control-surface text-ink-muted"
                  ].join(" ")}
                  aria-hidden="true"
                >
                  {node.roleGlyph}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-medium text-ink-muted">
                    <span>{node.message.role === "user" ? "Question" : "Answer"}</span>
                    {node.childCount > 1 ? (
                      <span className={node.active ? "text-ink-secondary" : "text-caution"}>
                        Fork point · {node.childCount} choices
                      </span>
                    ) : null}
                    {node.forkChoice ? <span className="text-proof">Branch version</span> : null}
                  </span>
                  <span className="mt-1 block break-words text-[13px] leading-5 [display:-webkit-box] [overflow-wrap:anywhere] [-webkit-box-orient:vertical] [-webkit-line-clamp:3]">
                    {node.preview}
                  </span>
                </span>
              </span>
              <span className={`pt-0.5 text-xs ${node.active ? "font-semibold text-proof" : "font-medium text-ink-secondary group-hover:text-ink"}`}>
                {node.active ? "Current" : alternateVersion ? "Open version" : "Current path"}
              </span>
            </>
          );

          if (!alternateVersion) {
            return (
              <div
                aria-current={node.active ? "true" : undefined}
                className={rowClassName}
                data-active-leaf={node.active ? "true" : undefined}
                data-depth={node.depth}
                key={node.message.id}
              >
                {rowContent}
              </div>
            );
          }

          return (
            <button
              aria-label={`Open alternate version, ${node.message.role} ${index + 1}`}
              aria-describedby={[
                `branch-node-${index + 1}-description`,
                streaming ? "branch-streaming-guidance" : null
              ].filter(Boolean).join(" ")}
              className={rowClassName}
              data-depth={node.depth}
              disabled={streaming}
              key={node.message.id}
              title={streaming ? "Opening another version is disabled while a response is streaming" : node.preview}
              type="button"
              onClick={() => onSelect(node.checkoutLeafId)}
            >
              <span className="sr-only" id={`branch-node-${index + 1}-description`}>
                {node.message.role === "user" ? "Question" : "Answer"}. {node.preview.replace(/[.!?]+$/, "")}.{" "}
                {node.childCount > 1 ? `Fork point with ${node.childCount} choices. ` : ""}
                Open this alternate version.
              </span>
              {rowContent}
            </button>
          );
        })}
      </div>
    </section>
  );
}

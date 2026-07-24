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
    <div className="flex h-full min-h-0 flex-col" data-testid="details-content">
      <div className="flex min-h-16 items-start justify-between gap-3 border-b border-separator-subtle px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="text-sm font-semibold text-content-primary" id="details-heading">Details</h2>
            <span
              className="rounded-pill bg-surface-hover px-2 py-0.5 text-[11px] font-medium text-content-muted"
              data-testid="details-mode-label"
            >
              {pinned ? "Pinned" : "Overlay"}
            </span>
          </div>
          <p
            className={`mt-1 max-h-10 overflow-y-auto break-words text-xs leading-5 [overflow-wrap:anywhere] ${errorText ? "text-accent-rose" : streaming ? "text-accent-cyan" : "text-content-muted"}`}
            data-testid="details-summary"
            title={errorText ?? undefined}
          >
            {errorText ?? (streaming ? "Run active · live Events available" : runId ? `Latest run ${runId.slice(0, 8)}` : "Branch and run events")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {pinningAvailable ? (
            <button
              className="grid size-9 place-items-center rounded-control text-content-muted hover:bg-surface-hover hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/55 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"
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
            className="grid size-9 place-items-center rounded-control text-content-muted hover:bg-surface-hover hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/55 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"
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
        className="min-h-0 flex-1 overscroll-contain overflow-y-auto px-4 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-cyan/55"
        id={inspectorPanelId(activeTab)}
        role="tabpanel"
        aria-labelledby={inspectorTabId(activeTab)}
        tabIndex={0}
      >
        <div>
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
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-control bg-accent-cyan/10 text-accent-cyan">
          <Activity className="size-4" aria-hidden="true" />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-content-primary" id="details-events-heading">Run events</h3>
          <p className="mt-1 text-xs leading-5 text-content-muted">
            A chronological digest. Repeated provider, token, tool, and artifact updates stay grouped at their first occurrence.
          </p>
        </div>
      </div>

      <ol className="mt-4 space-y-2" data-testid="inspector-event-log">
        {summaries.length === 0 ? (
          <li className="rounded-panel border border-dashed border-separator-subtle px-3 py-4 text-xs leading-5 text-content-muted">
            Events appear here during a run. Starting a response does not open Details automatically.
          </li>
        ) : (
          summaries.map((item, index) => (
            <li
              className={[
                "grid grid-cols-[3rem_minmax(0,1fr)] gap-3 rounded-panel border px-3 py-3 text-xs",
                item.tone === "error"
                  ? "border-accent-rose/25 bg-accent-rose/[0.07]"
                  : item.tone === "warning"
                    ? "border-accent-amber/25 bg-accent-amber/[0.06]"
                    : "border-separator-subtle bg-surface-raised"
              ].join(" ")}
              data-tone={item.tone}
              key={item.id}
            >
              <span className="sr-only">Event {index + 1}, stage {item.stage}.</span>
              <div className="font-mono text-[11px] leading-4 text-content-muted" aria-hidden="true">
                <div className="text-content-disabled">{String(index + 1).padStart(2, "0")}</div>
                <div className="mt-1 inline-flex max-w-full rounded-control bg-surface-hover px-1.5 py-0.5 text-content-secondary">
                  {item.stage}
                </div>
              </div>
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-1.5 font-medium text-content-secondary">
                    <EventToneIcon tone={item.tone} />
                    <span className="min-w-0 break-words [overflow-wrap:anywhere]">{item.label}</span>
                </div>
                <p
                  className={[
                    "mt-1 break-words text-sm leading-5 [overflow-wrap:anywhere]",
                    item.tone === "error"
                      ? "text-accent-rose"
                      : item.tone === "success"
                        ? "text-accent-green"
                        : item.tone === "warning"
                          ? "text-accent-amber"
                          : "text-content-primary"
                  ].join(" ")}
                >
                  {item.value}
                </p>
                {item.detail ? (
                  <div
                    className="mt-1 break-words font-mono text-[11px] leading-5 text-content-muted [overflow-wrap:anywhere]"
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
    return <XCircle className="size-3.5 shrink-0 text-accent-rose" aria-hidden="true" />;
  }

  if (tone === "success") {
    return <CheckCircle2 className="size-3.5 shrink-0 text-accent-green" aria-hidden="true" />;
  }

  if (tone === "warning") {
    return <AlertTriangle className="size-3.5 shrink-0 text-accent-amber" aria-hidden="true" />;
  }

  return <Circle className="size-3.5 shrink-0 text-content-muted" aria-hidden="true" />;
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
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-control bg-accent-cyan/10 text-accent-cyan">
          <GitBranch className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-content-primary" id="details-branch-heading">Conversation branches</h3>
          <p className="mt-1 text-xs leading-5 text-content-muted">
            {nodes.length === 0
              ? "Messages appear here after the conversation begins."
              : hasForks
                ? `${leafCount} paths · ${activePathLength} messages on the active path`
                : `${activePathLength} messages on one linear path`}
          </p>
        </div>
      </div>

      {nodes.length > 0 && !hasForks ? (
        <p className="mt-4 rounded-control bg-surface-raised px-3 py-2 text-xs leading-5 text-content-muted">
          This chat has a single path. Edit, regenerate, or Branch from here to create branches.
        </p>
      ) : null}
      {streaming && nodes.length > 0 ? (
        <p className="mt-3 rounded-control bg-accent-amber/[0.07] px-3 py-2 text-xs leading-5 text-accent-amber" id="branch-streaming-guidance" role="status">
          You can’t open another version while a response is streaming. Stop or finish the response first.
        </p>
      ) : null}

      <div className="mt-4 space-y-1.5 text-xs">
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
              "grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-3 rounded-panel border px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/55 disabled:cursor-not-allowed disabled:opacity-55",
              node.active
                ? "border-accent-cyan/30 bg-accent-cyan/[0.09] text-content-primary"
                : node.activePath
                  ? "border-accent-cyan/10 bg-accent-cyan/[0.035] text-content-primary hover:bg-accent-cyan/[0.07]"
                  : "border-separator-subtle bg-surface-raised text-content-secondary hover:bg-surface-hover hover:text-content-primary"
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
            <span className="flex min-w-0 items-start gap-2" style={{ paddingLeft: `${Math.min(node.depth, 6) * 12}px` }}>
              <span
                className={[
                  "grid size-5 shrink-0 place-items-center rounded-control border font-mono text-[11px] font-semibold",
                  node.activePath
                    ? "border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan"
                    : "border-separator-subtle bg-surface-thread text-content-muted"
                ].join(" ")}
                aria-hidden="true"
              >
                {node.roleGlyph}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-content-muted">
                  <span>{node.message.role === "user" ? "Question" : "Answer"}</span>
                  {node.childCount > 1 ? <span className="text-accent-amber">Fork point · {node.childCount} choices</span> : null}
                  {node.message.parentMessageId && (childCountByMessageId.get(node.message.parentMessageId) ?? 0) > 1 ? (
                    <span className="text-accent-cyan">Branch path</span>
                  ) : null}
                </span>
                <span className="mt-1 block break-words text-xs leading-5 [display:-webkit-box] [overflow-wrap:anywhere] [-webkit-box-orient:vertical] [-webkit-line-clamp:3]">
                  {node.preview}
                </span>
              </span>
            </span>
            {node.active ? (
              <span className="rounded-pill border border-accent-cyan/25 bg-accent-cyan/10 px-2 py-0.5 text-[11px] font-medium text-accent-cyan">
                Active leaf
              </span>
            ) : (
              <span className="mt-0.5 max-w-24 rounded-control border border-separator-subtle bg-surface-thread px-2 py-1 text-center text-[11px] font-medium leading-4 text-content-secondary">
                Open this version
              </span>
            )}
          </button>
        ))}
      </div>
    </section>
  );
}

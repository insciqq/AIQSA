"use client";

import {
  UiV2Button,
  UiV2Icon,
  UiV2IconButton,
  UiV2Skeleton
} from "@/components/ui-v2";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";
import type { ChatBranchGraphWire } from "@/lib/contracts/chats";
import {
  useId,
  useState,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import {
  branchPagerForMessageV2,
  branchVersionsV2,
  type BranchPagerStateV2,
  type BranchVersionV2
} from "./branchModel";

export function BranchPagerV2({
  disabledReason = null,
  onCheckout,
  pending = false,
  state
}: Readonly<{
  disabledReason?: string | null;
  onCheckout(leafId: string): void;
  pending?: boolean;
  state: BranchPagerStateV2;
}>) {
  const reasonId = useId();
  const disabled = Boolean(disabledReason || pending);
  const description = pending ? "Switching version…" : disabledReason;

  return (
    <div className="v2-branch-pager-wrap">
      <nav
        aria-label="Message versions"
        aria-describedby={description ? reasonId : undefined}
        className="v2-branch-pager"
        data-testid="branch-pager"
      >
        <button
          aria-label="Previous version"
          disabled={disabled || state.previousLeafId === null}
          onClick={() => state.previousLeafId && onCheckout(state.previousLeafId)}
          type="button"
        >
          ‹
        </button>
        <span aria-label={`Version ${state.current} of ${state.total}`}>
          {state.current}/{state.total}
        </span>
        <button
          aria-label="Next version"
          disabled={disabled || state.nextLeafId === null}
          onClick={() => state.nextLeafId && onCheckout(state.nextLeafId)}
          type="button"
        >
          ›
        </button>
      </nav>
      {description ? (
        <span className="v2-branch-pager-reason" id={reasonId}>{description}</span>
      ) : null}
    </div>
  );
}

export function BranchPagerSlotV2({
  disabledReason = null,
  graph,
  messageId,
  onCheckout
}: Readonly<{
  disabledReason?: string | null;
  graph: ChatBranchGraphWire | null;
  messageId: string;
  onCheckout(leafId: string): void;
}>) {
  const state = graph ? branchPagerForMessageV2(graph, messageId) : null;
  if (!state) return null;
  return (
    <BranchPagerV2
      disabledReason={disabledReason}
      onCheckout={onCheckout}
      state={state}
    />
  );
}

function versionKindLabel(kind: BranchVersionV2["kind"]): string {
  if (kind === "original") return "Original version";
  if (kind === "edited_question") return "Edited question";
  if (kind === "regenerated_answer") return "Regenerated answer";
  return "Alternate version";
}

function statusLabel(status: BranchVersionV2["status"]): string {
  if (status === "complete") return "Complete";
  if (status === "cancelled") return "Stopped";
  if (status === "error") return "Error";
  if (status === "streaming") return "Running";
  return "Queued";
}

function BranchVersionRow({
  checkoutDisabledReason,
  checkoutPending,
  onCheckout,
  pending,
  version
}: Readonly<{
  checkoutDisabledReason: string | null;
  checkoutPending: boolean;
  onCheckout(version: BranchVersionV2): void;
  pending: boolean;
  version: BranchVersionV2;
}>) {
  return (
    <li className="v2-branch-version" data-current={version.active || undefined}>
      <span className="v2-branch-version-mark" aria-hidden="true" />
      <span className="v2-branch-version-copy">
        <span>
          <strong>Version {version.ordinal}</strong>
          <small>{versionKindLabel(version.kind)}</small>
        </span>
        <span className="v2-branch-version-preview">{version.preview}</span>
        <small>
          {version.messageCount} {version.messageCount === 1 ? "message" : "messages"} · {statusLabel(version.status)}
        </small>
      </span>
      {version.active ? (
        <span className="v2-branch-current" aria-current="true">Current</span>
      ) : (
        <UiV2Button
          busy={pending}
          disabled={Boolean(checkoutDisabledReason || checkoutPending)}
          onClick={() => onCheckout(version)}
          title={checkoutDisabledReason ?? undefined}
        >
          Switch
        </UiV2Button>
      )}
    </li>
  );
}

export function BranchDrawerV2({
  checkoutDisabledReason = null,
  error = null,
  graph,
  loading = false,
  onCheckout,
  onClose,
  onRetry
}: Readonly<{
  checkoutDisabledReason?: string | null;
  error?: string | null;
  graph: ChatBranchGraphWire | null;
  loading?: boolean;
  onCheckout(leafId: string): Promise<boolean | void> | boolean | void;
  onClose(): void;
  onRetry?(): void;
}>) {
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [pendingLeafId, setPendingLeafId] = useState<string | null>(null);
  const {
    dialogRef,
    initialFocusRef: closeRef,
    onDialogKeyDown,
    portalReady
  } = useModalLayerV2({
    closeBlocked: pendingLeafId !== null,
    onClose
  });
  const versions = graph ? branchVersionsV2(graph) : [];

  async function checkout(version: BranchVersionV2) {
    if (pendingLeafId || checkoutDisabledReason) return;
    setCheckoutError(null);
    setPendingLeafId(version.checkoutLeafId);
    try {
      const succeeded = await onCheckout(version.checkoutLeafId);
      if (succeeded === false) {
        setCheckoutError("Could not switch versions. The current branch is unchanged.");
        return;
      }
      onClose();
    } catch {
      setCheckoutError("Could not switch versions. The current branch is unchanged.");
    } finally {
      setPendingLeafId(null);
    }
  }

  const drawer = (
    <div
      className="v2-branch-scrim"
      data-testid="branch-drawer-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pendingLeafId) onClose();
      }}
      role="presentation"
    >
      <aside
        aria-busy={pendingLeafId !== null}
        aria-label="Conversation branches"
        aria-modal="true"
        className="v2-branch-drawer"
        onKeyDown={onDialogKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <header className="v2-branch-drawer-header">
          <span>
            <small>Conversation history</small>
            <h2>Branches</h2>
          </span>
          <UiV2IconButton
            disabled={Boolean(pendingLeafId)}
            icon="close"
            label="Close branches"
            onClick={onClose}
            ref={closeRef}
          />
        </header>
        <p className="v2-branch-drawer-copy">
          Switching changes the active branch for future messages. History is never rewritten.
        </p>
        {checkoutDisabledReason ? (
          <p className="v2-branch-disabled-guidance" role="status">
            {checkoutDisabledReason}
          </p>
        ) : null}
        {checkoutError ? (
          <p className="v2-branch-error" role="alert">{checkoutError}</p>
        ) : null}
        <div className="v2-branch-drawer-scroll">
          {loading ? (
            <div className="v2-branch-loading" aria-label="Loading branches" role="status">
              <UiV2Skeleton />
              <UiV2Skeleton />
              <UiV2Skeleton />
            </div>
          ) : error ? (
            <div className="v2-branch-error-state" role="alert">
              <strong>Could not load branches</strong>
              <p>The current version is unchanged.</p>
              {onRetry ? <UiV2Button onClick={onRetry}>Retry</UiV2Button> : null}
            </div>
          ) : versions.length === 0 ? (
            <div className="v2-branch-empty">
              <strong>No branches yet</strong>
              <p>Edit a message or regenerate an answer to create a new version.</p>
            </div>
          ) : (
            <ol className="v2-branch-version-list">
              {versions.map((version) => (
                <BranchVersionRow
                  checkoutDisabledReason={checkoutDisabledReason}
                  checkoutPending={pendingLeafId !== null}
                  key={version.checkoutLeafId}
                  onCheckout={checkout}
                  pending={pendingLeafId === version.checkoutLeafId}
                  version={version}
                />
              ))}
            </ol>
          )}
        </div>
      </aside>
    </div>
  );

  return portalReady ? createPortal(drawer, document.body) : null;
}

export function BranchesSlotV2({ children }: { children: ReactNode }) {
  return <div className="v2-branches-slot">{children}</div>;
}

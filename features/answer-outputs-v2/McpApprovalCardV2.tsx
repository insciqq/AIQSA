"use client";

import { useId, useRef, useState } from "react";
import { UiV2Button, UiV2Chip, UiV2Icon } from "@/components/ui-v2";
import { randomUUID } from "@/lib/browser/randomUUID";
import {
  mcpApprovalContinuationTool,
  type McpApprovalCard,
  type McpApprovalContinuationOutcome,
  type McpApprovalDecision,
  type McpApprovalState
} from "@/lib/contracts/mcpApprovals";
import { decideMcpApproval, McpApprovalApiError } from "./mcpApprovalApi";
import { McpCallDetailsV2 } from "./McpCallDetailsV2";

type Decide = typeof decideMcpApproval;
/** Starts the continuation turn after an Allow; says whether a run started. */
type Continue = (card: McpApprovalCard) => void | Promise<McpApprovalContinuationOutcome | void>;

const HEADINGS: Readonly<Record<McpApprovalState, string>> = {
  allowed_once: "Allowed once",
  allowed_server: "Always allowed",
  denied: "Denied",
  pending: "Approval needed"
};

const TONES: Readonly<Record<McpApprovalState, "neutral" | "ok" | "warn">> = {
  allowed_once: "ok",
  allowed_server: "ok",
  denied: "neutral",
  pending: "warn"
};

function pendingText(card: McpApprovalCard): string {
  if (card.source === "code") {
    return "Code in the Workspace called this tool, which may change data. Nothing was sent. If you allow it, the next run repeats the script.";
  }
  if (card.source === "agent") return "Agent called this tool, which may change data. Nothing was sent. If you allow it, Agent continues.";
  return "This tool may change data, so nothing was sent. If you allow it, the answer continues.";
}

function stateText(card: McpApprovalCard, live: boolean, continuable: boolean): string {
  const waiting = continuable ? " The answer has not continued yet." : "";
  switch (card.state) {
    case "allowed_once": return `Allowed once: only this exact call may run, once.${waiting}`;
    case "allowed_server":
      return `Tools of ${card.serverName} now run without asking. You can revoke this in Settings › MCP servers.${waiting}`;
    case "denied": return "Nothing was sent.";
    case "pending":
      return !card.canDecide ? "Only the person who sent this message can allow this tool. Nothing was sent."
        : live ? "Nothing was sent. Decide when the answer finishes." : pendingText(card);
  }
}

function errorText(failure: unknown): string {
  if (failure instanceof McpApprovalApiError) {
    if (failure.code === "mcp_approval_run_active") return "The answer is still finishing. Try again when it ends.";
    if (failure.status === 404) return "This approval is no longer available.";
  }
  return "Your decision could not be saved. Try again.";
}

function McpApprovalCardV2({ card, decide, live, offerContinue, onContinue, runId }: Readonly<{
  card: McpApprovalCard;
  decide: Decide;
  live: boolean;
  offerContinue: boolean;
  onContinue?: Continue;
  runId: string | null;
}>) {
  const headingId = useId();
  const statusRef = useRef<HTMLParagraphElement>(null);
  const nonces = useRef(new Map<McpApprovalDecision, string>());
  const [decided, setDecided] = useState<McpApprovalCard | null>(null);
  const [busy, setBusy] = useState<McpApprovalDecision | "continue" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The server refused the continuation for good (expired or already used).
  const [continueSpent, setContinueSpent] = useState(false);
  // A decision the saved answer already carries wins over this card's own
  // (decisions are final, so a saved card never returns to pending).
  const current = card.state === "pending" && decided ? decided : card;

  async function startContinuation(allowed: McpApprovalCard) {
    if (await onContinue?.(allowed) === "unavailable") setContinueSpent(true);
  }

  async function choose(decision: McpApprovalDecision) {
    if (busy || !runId) return;
    // A retry of the same decision repeats its nonce, so the server replays it.
    const nonce = nonces.current.get(decision) ?? randomUUID();
    nonces.current.set(decision, nonce);
    setBusy(decision);
    setError(null);
    try {
      const result = await decide({ approvalId: card.approvalId, decision, nonce, runId });
      setDecided(result);
      queueMicrotask(() => statusRef.current?.focus());
      if (result.state === "allowed_once" || result.state === "allowed_server") await startContinuation(result);
    } catch (failure) {
      if (failure instanceof McpApprovalApiError && failure.card) setDecided(failure.card);
      else setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  }

  /** Retries a continuation that started no run (the chat said why). */
  async function continueAnswer() {
    if (busy) return;
    setBusy("continue");
    setError(null);
    try {
      await startContinuation(current);
    } finally {
      setBusy(null);
    }
  }

  const decidable = current.state === "pending" && current.canDecide === true && runId !== null;
  // Only the chat's latest settled answer continues; the turn a continuation
  // adds makes it older, so a started run hides Continue at once.
  const continuable = offerContinue && !live && current.canContinue === true && !continueSpent &&
    onContinue !== undefined && (busy === null || busy === "continue");
  return (
    <li className="v2-tool-approval" data-state={current.state} data-source={current.source} data-testid="mcp-approval-card"
      aria-label={`Approval for ${current.serverName} ${current.toolName}`}>
      <div className="v2-tool-approval-heading">
        <UiV2Icon name={current.state === "pending" ? "lock" : current.state === "denied" ? "close" : "check"} />
        <span>
          <small id={headingId}>{HEADINGS[current.state]}</small>
          <strong title={`${current.serverName} · ${current.toolName}`}>{current.serverName} · {current.toolName}</strong>
        </span>
        <UiV2Chip tone={TONES[current.state]}>{HEADINGS[current.state]}</UiV2Chip>
      </div>
      <p className="v2-tool-approval-text" ref={statusRef} tabIndex={-1} role={current.state === "pending" ? undefined : "status"}>
        {stateText(current, live, continuable)}
      </p>
      {current.details && runId ? (
        <McpCallDetailsV2 label="Review arguments" meta="The request the model prepared" reference={current.details}
          runId={runId} status="error" />
      ) : null}
      {error ? <p className="v2-tool-approval-error" role="alert">{error}</p> : null}
      {decidable ? (
        <div className="v2-tool-approval-actions" role="group" aria-labelledby={headingId}>
          <UiV2Button busy={busy === "deny"} disabled={live || busy !== null && busy !== "deny"} type="button"
            onClick={() => void choose("deny")}>
            Deny
          </UiV2Button>
          <UiV2Button busy={busy === "allow_server"} disabled={live || busy !== null && busy !== "allow_server"} type="button"
            onClick={() => void choose("allow_server")}>
            Always allow for this server
          </UiV2Button>
          <UiV2Button busy={busy === "allow_once"} disabled={live || busy !== null && busy !== "allow_once"} tone="primary"
            type="button" onClick={() => void choose("allow_once")}>
            Allow once
          </UiV2Button>
        </div>
      ) : null}
      {continuable ? (
        <div className="v2-tool-approval-actions" role="group" aria-labelledby={headingId}>
          <UiV2Button busy={busy === "continue"} tone="primary" type="button" onClick={() => void continueAnswer()}>
            Continue
          </UiV2Button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * MCP calls the answer's run refused for its initiator's approval: one card
 * per refused call with Allow once, Always allow for this server and Deny.
 * An Allow starts the continuation turn (`onContinue`); when that started no
 * run, the chat's latest answer offers Continue while the server still
 * accepts it (`canContinue`). A live answer's cards wait for it to finish.
 * Others see the cards read-only.
 */
export function McpApprovalCardsV2({
  cards, decide = decideMcpApproval, live = false, offerContinue = false, onContinue, runId
}: Readonly<{
  cards: readonly McpApprovalCard[];
  /** Test and gallery seam; production posts to the decision route. */
  decide?: Decide;
  live?: boolean;
  /** The cards belong to the chat's latest answer, the only one a continuation follows. */
  offerContinue?: boolean;
  onContinue?: Continue;
  runId: string | null | undefined;
}>) {
  if (cards.length === 0) return null;
  return (
    <section className="v2-tool-approvals" aria-label="Tool approvals">
      <ul>
        {cards.map((card) => (
          <McpApprovalCardV2 key={card.approvalId} card={card} decide={decide} live={live} offerContinue={offerContinue}
            onContinue={onContinue} runId={runId ?? null} />
        ))}
      </ul>
    </section>
  );
}

/** The server-written turn after an approval: a compact chip, never a speech bubble. */
export function McpApprovalContinuationTurnV2({ anchorId, content }: Readonly<{ anchorId: string; content: string }>) {
  const tool = mcpApprovalContinuationTool(content);
  return (
    <article className="v2-conversation-turn v2-system-turn" data-conversation-message-id={anchorId} data-message-id={anchorId}
      data-role="user" data-system-turn="mcp_approval_continuation" aria-label="Approval">
      <span className="v2-system-turn-chip">
        <UiV2Icon name="check" />
        <span>Allowed{tool ? <>: <code>{tool}</code></> : null}</span>
      </span>
    </article>
  );
}

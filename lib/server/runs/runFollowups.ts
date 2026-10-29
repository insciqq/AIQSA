import type { ModelRunStatus, RunFollowup as StoredRunFollowup } from "@prisma/client";
import {
  decodeRunFollowupState, RUN_FOLLOWUP_MAX_TOTAL_CHARS, type RunFollowup, type RunFollowupInput, type RunFollowupState
} from "../../contracts/runFollowups";
import { estimateApproxTokens } from "../../domain/contextBudget";
import type { ProviderRunRequest } from "../providers/types";
import type { ProviderToolBridge } from "../tools/types";
import type { RunFollowupOrigin } from "../../contracts/subagents";
import { requestHeadroomTokens } from "./requestContextBudget";

export type RunFollowupAdmission = Readonly<{
  budgetTokens: number;
  inherited?: Readonly<{ messageId: string; revision: number }>;
}>;

export type RegenerationFollowups = Readonly<{
  messageId: string;
  revision: number;
  entries: readonly RunFollowup[];
}>;

export type FollowupRunProjection = Readonly<{
  answerCompletedAt: Date | null;
  followupMode: string | null;
  followupClosedAt: Date | null;
  status: ModelRunStatus;
  followups: readonly Pick<StoredRunFollowup, "id" | "ordinal" | "text" | "authorName" | "createdAt" | "deliveredAt" | "precedingText">[];
}>;

export function projectMessageFollowups(message: {
  assistantModelRuns?: readonly FollowupRunProjection[];
  branchFollowups?: unknown;
}): RunFollowupState | null {
  const run = message.assistantModelRuns?.[0];
  if (run && (run.followupMode || run.followups?.length)) return projectRunFollowups(run);
  const copied = decodeRunFollowupState(message.branchFollowups);
  return copied ? { ...copied, available: false } : null;
}

/**
 * A run's follow-ups as the browser reads them. The rows are the user's own
 * (`runFollowupSelect`); a sub-agent's callbacks and messages share the run's
 * ordinals, so the user's are numbered by their own position from
 * `precedingUserFollowups` (the entries before the first given). The engine's
 * read keeps the stored ordinals (`renumber: false`).
 */
export function projectRunFollowups(run: FollowupRunProjection, precedingUserFollowups = 0,
  options: Readonly<{ renumber?: boolean }> = {}): RunFollowupState {
  const active = ["preparing", "queued", "streaming", "in_progress"].includes(run.status) && !run.answerCompletedAt;
  const renumber = options.renumber !== false;
  return {
    available: active && run.followupMode !== null && run.followupClosedAt === null,
    entries: run.followups.map((entry, index): RunFollowup => ({
      id: entry.id, ordinal: renumber ? precedingUserFollowups + index + 1 : entry.ordinal, text: entry.text, author: entry.authorName,
      createdAt: entry.createdAt.toISOString(),
      delivery: entry.deliveredAt ? "delivered" : active ? "accepted" : "undelivered",
      ...(entry.precedingText ? { precedingText: entry.precedingText } : {})
    }))
  };
}

/** Conservative wire-message overhead, in the same estimator as admission. */
export function followupTokenCost(text: string): number {
  return estimateApproxTokens(text) + 32;
}

/** Room left beside the request as dispatched, without the earlier turns the
 * engine compacts. An unknown window bounds clarifications by their own size. */
function followupRequestHeadroom(request: ProviderRunRequest, bridge?: ProviderToolBridge): number {
  return requestHeadroomTokens(request, bridge) ?? RUN_FOLLOWUP_MAX_TOTAL_CHARS;
}

/** Clarification budget admitted with a run, before its first dispatch: half
 * the room its request leaves, at most 8,192 tokens. */
export function followupAdmissionBudgetTokens(request: ProviderRunRequest, bridge?: ProviderToolBridge): number {
  return Math.min(8_192, Math.floor(followupRequestHeadroom(request, bridge) / 2));
}

/** A regeneration's inherited clarifications as user turns, so admission
 * measures them with its request; accepted instructions stay intact. */
export function requestWithRunFollowups(request: ProviderRunRequest, entries: readonly RunFollowup[]): ProviderRunRequest {
  if (!entries.length) return request;
  return { ...request, providerToolMessages: [...(request.providerToolMessages ?? []), ...entries.map(entry =>
    request.provider === "gemini"
      ? { type: "user_input", content: [{ type: "text", text: entry.text }] }
      : request.provider === "anthropic"
        ? { role: "user", content: [{ type: "text", text: entry.text }] }
      : { role: "user", content: entry.text })] };
}

export type AcceptRunFollowupResult =
  | Readonly<{ kind: "accepted"; entry: RunFollowup }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "closed" }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "context_full" }>;

export type RunFollowupBatch = Readonly<{
  revision: number;
  /** Every origin, in run order: the engine delivers a sub-agent's callback like a follow-up, never as the user's speech. */
  entries: readonly (RunFollowup & Readonly<{ origin?: RunFollowupOrigin }>)[];
}>;

export type RunFollowupOperations = Readonly<{
  accept(input: RunFollowupInput & { runId: string; userId: string }): Promise<AcceptRunFollowupResult>;
  load(input: { runId: string; userId: string }): Promise<RunFollowupBatch | null>;
  deliver(input: { runId: string; userId: string; revision: number; precedingText: string; budgetTokens: number }): Promise<boolean>;
  /** The final answer can settle only after this compare-and-close wins. */
  close(input: { runId: string; userId: string; revision: number }): Promise<boolean>;
}>;

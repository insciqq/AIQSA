import type { ModelRunStatus, RunFollowup as StoredRunFollowup } from "@prisma/client";
import {
  decodeRunFollowupState, RUN_FOLLOWUP_MAX_TOTAL_CHARS, type RunFollowup, type RunFollowupInput, type RunFollowupState
} from "../../contracts/runFollowups";
import { estimateApproxTokens } from "../../domain/contextBudget";
import type { ProviderRunRequest } from "../providers/types";
import type { ProviderToolBridge } from "../tools/types";
import { measureSessionContext } from "./runContextBudget";

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

export function projectRunFollowups(run: FollowupRunProjection): RunFollowupState {
  const active = ["preparing", "queued", "streaming", "in_progress"].includes(run.status) && !run.answerCompletedAt;
  return {
    available: active && run.followupMode !== null && run.followupClosedAt === null,
    entries: run.followups.map((entry): RunFollowup => ({
      id: entry.id, ordinal: entry.ordinal, text: entry.text, author: entry.authorName,
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

export function followupRequestHeadroom(request: ProviderRunRequest, bridge?: ProviderToolBridge): number {
  const context = measureSessionContext({ bridge, request });
  return context.contextWindow === null ? RUN_FOLLOWUP_MAX_TOTAL_CHARS : Math.max(0,
    context.contextWindow - context.maxOutputTokens - context.safetyMarginTokens - context.approximateInputTokens);
}

export type AcceptRunFollowupResult =
  | Readonly<{ kind: "accepted"; entry: RunFollowup }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "closed" }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "context_full" }>;

export type RunFollowupBatch = Readonly<{
  revision: number;
  entries: readonly RunFollowup[];
}>;

export type RunFollowupOperations = Readonly<{
  accept(input: RunFollowupInput & { runId: string; userId: string }): Promise<AcceptRunFollowupResult>;
  load(input: { runId: string; userId: string }): Promise<RunFollowupBatch | null>;
  deliver(input: { runId: string; userId: string; revision: number; precedingText: string; budgetTokens: number;
    /** Native input already accepted; acknowledge this prefix despite newer arrivals. */
    confirmedThrough?: boolean }): Promise<boolean>;
  /** The final answer can settle only after this compare-and-close wins. */
  close(input: { runId: string; userId: string; revision: number }): Promise<boolean>;
  /** New question, fresh review cohort; the original eight-operation ceiling remains. */
  beginKnowledge(input: { runId: string; userId: string; revision: number }): Promise<number>;
}>;

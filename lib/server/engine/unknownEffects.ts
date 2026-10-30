import { hashCanonicalMcpValue } from "../mcp/definitions";
import type { ModelToolCall } from "../tools/types";
import type { TranscriptItem, TranscriptUserItem } from "./transcript";

/**
 * Calls with external effects whose outcome is still unknown on a chat's
 * branch: a call that failed after it may have been sent, and a call a
 * stopped or interrupted run left without a result. Such an effect may have
 * happened, so an equivalent call (the same tool with the same canonical
 * arguments) is never sent again on the model's word alone, across rounds,
 * turns and approval continuations: the user decides (`toolBatch.ts`). The
 * effect stays unknown until an equivalent call completes; a definite error
 * of a later call does not settle whether the first one took effect.
 */
export type UnknownEffect = Readonly<{
  /** An exact human decision must be newer than this uncertain attempt's record. */
  after: Date;
  /** The user wrote to the chat after the effect became unknown (a message or a follow-up). */
  userSpokeSince: boolean;
}>;

export type UnknownEffects = Readonly<{
  /** The unknown effect an equivalent earlier call left, or null. */
  find(call: Pick<ModelToolCall, "arguments" | "name">): UnknownEffect | null;
  /** A call was sent (or may have been) with this outcome. */
  record(call: Pick<ModelToolCall, "arguments" | "name">, outcome: "complete" | "error" | "unknown", after?: Date): void;
  /** The user wrote into the running turn (a delivered follow-up). */
  userSpoke(): void;
}>;

/** One effect: the tool and its canonical arguments. */
export function effectKey(call: Pick<ModelToolCall, "arguments" | "name">): string {
  return `${call.name}\u0000${hashCanonicalMcpValue(call.arguments ?? {})}`;
}

function parsedArguments(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** A branch message as `withRetiredEffects` places by it. */
type BranchMessage = Readonly<{ contextTurnId?: string; id: string; purpose?: unknown; role: string }>;

/**
 * The conversation's items with the effect records of the old core's runs on
 * the branch (`TranscriptRepository.retiredRunEffects`) in their place, for
 * `unknownEffectsOf` only: each run's records follow its turn and come before
 * the branch's next user message, so the user's later words and a later
 * equivalent call that completed count after them. A run whose question is
 * not on the branch any more comes first. The model never sees these items;
 * old answers stay text.
 */
export function withRetiredEffects(items: readonly TranscriptItem[], messages: readonly BranchMessage[],
  retired: readonly Readonly<{ items: readonly TranscriptItem[]; userMessageId: string }>[]): TranscriptItem[] {
  if (retired.length === 0) return [...items];
  const itemIndex = new Map(items.map((item, index) => [item.id, index]));
  const turns = messages.filter((message) => message.role === "user" && message.purpose === undefined &&
    message.contextTurnId === undefined);
  const before = new Map<number, TranscriptItem[]>();
  for (const run of retired) {
    const turn = turns.findIndex((message) => message.id === run.userMessageId);
    let at = turn < 0 ? 0 : items.length;
    if (turn >= 0) {
      for (const next of turns.slice(turn + 1)) {
        const index = itemIndex.get(`msg-${next.id}`);
        if (index !== undefined) {
          at = index;
          break;
        }
      }
    }
    before.set(at, [...(before.get(at) ?? []), ...run.items]);
  }
  return [...items.flatMap((item, index) => [...(before.get(index) ?? []), item]), ...(before.get(items.length) ?? [])];
}

/**
 * The guard's items with the calls of runs the conversation leaves out (a
 * stopped step of an answer review recorded before the feature's removal,
 * `NativeRunBeforeTurn.reviewStep`), for `unknownEffectsOf` only: each run's
 * calls and results just before the user item that followed its answer, or
 * last when that item is not in the conversation. The model never sees them.
 */
export function withHiddenRunEffects(items: readonly TranscriptItem[],
  runs: readonly Readonly<{ beforeItemId: string; items: readonly TranscriptItem[] }>[]): TranscriptItem[] {
  if (runs.length === 0) return [...items];
  const before = new Map<string, TranscriptItem[]>();
  const last: TranscriptItem[] = [];
  const ids = new Set(items.map((item) => item.id));
  for (const run of runs) {
    const calls = run.items.filter((item) => item.kind === "tool_call" || item.kind === "tool_result");
    if (ids.has(run.beforeItemId)) before.set(run.beforeItemId, [...(before.get(run.beforeItemId) ?? []), ...calls]);
    else last.push(...calls);
  }
  return [...items.flatMap((item) => [...(before.get(item.id) ?? []), item]), ...last];
}

/**
 * One agent's fence, fed in that agent's own record order, which is linear.
 * A completion settles an earlier uncertainty only when it is strictly newer:
 * on a tie the uncertainty stays (fails closed).
 */
export function createUnknownEffects(): UnknownEffects {
  // Per effect: the user had spoken since it became unknown.
  const unknown = new Map<string, { after: Date; userSpokeSince: boolean }>();
  return {
    find(call) {
      const entry = unknown.get(effectKey(call));
      return entry ? { ...entry } : null;
    },
    // Missing historical metadata fails closed: an already-issued decision cannot authorize the retry.
    record(call, outcome, after = new Date()) {
      const key = effectKey(call);
      const timestamp = Number.isFinite(after.getTime()) ? after.getTime() : Date.now();
      if (outcome === "unknown") {
        // Never move the fence backwards when concurrent uncertain calls settle out of order.
        const latest = Math.max(unknown.get(key)?.after.getTime() ?? 0, timestamp);
        unknown.set(key, { after: new Date(latest), userSpokeSince: false });
      } else if (outcome === "complete") {
        const open = unknown.get(key);
        if (open && open.after.getTime() < timestamp) unknown.delete(key);
      }
    },
    userSpoke() {
      for (const entry of unknown.values()) entry.userSpokeSince = true;
    }
  };
}

/**
 * The fences of a run's agents (integrator decision 2026-10-30): the main
 * agent and each sub-agent thread record only into their own fence, in their
 * own linear order, so one agent's outcome never settles another's unknown
 * effect, whatever the persistence timestamps say. Each agent's view finds an
 * unknown effect any agent of the run left (the latest attempt's fence; the
 * user has spoken since only if they have since every one), and the user
 * speaking reaches every fence. An exact human approval newer than the
 * attempt still authorizes the retry (`toolBatch.ts`). Fails closed: in the
 * worst case a call asks a human once more.
 */
export type AgentUnknownEffects = Readonly<{
  /** The view of one agent: `main`, or a sub-agent's thread id. */
  agent(key: string): UnknownEffects;
}>;

export function createAgentUnknownEffects(): AgentUnknownEffects {
  const fences = new Map<string, UnknownEffects>();
  const own = (key: string) => {
    let fence = fences.get(key);
    if (!fence) {
      fence = createUnknownEffects();
      fences.set(key, fence);
    }
    return fence;
  };
  return {
    agent(key) {
      const mine = own(key);
      return {
        find(call) {
          const entries: UnknownEffect[] = [...fences.values()].flatMap((fence) => {
            const entry = fence.find(call);
            return entry ? [entry] : [];
          });
          if (entries.length === 0) return null;
          // The latest attempt's fence; the user has spoken since only if they have since every agent's attempt.
          return { after: new Date(Math.max(...entries.map((entry) => entry.after.getTime()))),
            userSpokeSince: entries.every((entry) => entry.userSpokeSince) };
        },
        record(call, outcome, after) {
          mine.record(call, outcome, after);
        },
        userSpoke() {
          for (const fence of fences.values()) fence.userSpoke();
        }
      };
    }
  };
}

/**
 * The unknown effects a branch's transcript left, in its order: a call whose
 * latest result is unknown or missing, unless an equivalent call completed
 * after it. An approved call's in-flight record (`inFlight`) opens the call
 * again: its own result settles it, a definite "not sent" included, and
 * without one the call is unknown like any call left without a result. Every
 * tool counts here, whatever this run knows of it (an Auto tool is found
 * again only when the model asks for it); the batch applies the rule only to
 * tools with external effects. Only the user's own words (`userAuthored`)
 * count as the user speaking.
 */
export function unknownEffectsOf(items: readonly TranscriptItem[],
  userAuthored: (item: TranscriptUserItem) => boolean,
  /** Records into this fence instead of a new one: a run's one fence for its main agent and sub-agents. */
  into: UnknownEffects = createUnknownEffects()): UnknownEffects {
  const effects = into;
  const calls = new Map<string, { after?: Date; arguments: Record<string, unknown>; name: string }>();
  // Calls without any result yet; a result recorded later (an approved call that then ran) still counts.
  const open = new Set<string>();
  const cutOff = () => {
    for (const callId of open) {
      const call = calls.get(callId)!;
      effects.record(call, "unknown", call.after);
    }
    open.clear();
  };
  for (const item of items) {
    if (item.kind === "tool_call") {
      const args = parsedArguments(item.arguments);
      if (args) {
        calls.set(item.callId, { after: item.recordedAt, arguments: args, name: item.name });
        open.add(item.callId);
      }
      continue;
    }
    if (item.kind === "tool_result") {
      const call = calls.get(item.callId);
      if (!call) continue;
      if (item.inFlight) {
        // A continuation is a new attempt, even though it reuses the original provider call id.
        call.after = item.recordedAt;
        open.add(item.callId);
        continue;
      }
      open.delete(item.callId);
      effects.record(call, item.outcome, item.recordedAt ?? call.after);
      continue;
    }
    if (item.kind === "user" && userAuthored(item)) {
      // A call still without a result here was cut off before it (a stopped or interrupted run).
      cutOff();
      effects.userSpoke();
    }
  }
  cutOff();
  return effects;
}

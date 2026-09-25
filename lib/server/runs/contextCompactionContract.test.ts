import { describe, expect, it } from "vitest";
import type { ContextSummary } from "../../contracts/contextCompaction";
import type { ProviderConversationMessage, ProviderRunRequest } from "../providers/types";
import {
  canonicalJsonText,
  contextCompactionCheckpoint,
  contextDigest,
  CONTEXT_SUMMARY_REFS_INCOMPLETE,
  contextSummaryReuseCandidates,
  conversationContextPolicy,
  decodeConversationContextPolicy,
  summaryBindingDigest,
  type BranchContextCheckpoint
} from "./contextCompactionContract";

const digest = (seed: string) => seed.repeat(64).slice(0, 64);

function summary(seed: string): ContextSummary {
  return { formatVersion: 1, id: `cs1_${seed.repeat(32).slice(0, 32)}`, notes: `Notes ${seed}.`,
    sourceDigest: digest(seed), sourceRefs: [] };
}

function message(id: string, role: "assistant" | "user"): ProviderConversationMessage {
  return { content: { blocks: [{ text: id, type: "text" }] }, id, role };
}

const branch = ["u1", "a1", "u2", "a2", "u3", "a3"];

function request(): ProviderRunRequest {
  const messages = branch.map((id) => message(id, id.startsWith("u") ? "user" : "assistant"));
  return {
    attachmentIds: [], attachments: [], chatId: "chat-1", content: messages.at(-1)!.content,
    context: { messages, mode: "branch_path" },
    contextCompactionPolicy: conversationContextPolicy({ leafMessageId: "a3", messages, mode: "hybrid" }),
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: { contextWindow: 4_000, nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false,
      toolCalling: true, vision: false },
    modelId: "synthetic", params: {}, prompt: { developer: null, system: "Accepted system" }, provider: "openai",
    searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto", toolObservationVersion: 1
  };
}

function checkpoint(input: Readonly<{
  answer: string;
  bought?: boolean;
  carried?: Readonly<{ coveredMessageId: string; runId: string }>;
  hybrid?: boolean;
  seed: string;
  userId?: string;
  userMessageId: string;
}>): BranchContextCheckpoint {
  const notes = summary(input.seed);
  const runId = `run-${input.answer}`;
  const userId = input.userId ?? "user-1";
  const accepted = request();
  const policy = input.hybrid === false ? { ...accepted.contextCompactionPolicy!, mode: "legacy_compatible" as const }
    : input.carried ? { ...accepted.contextCompactionPolicy!, reuse: { ...input.carried, summary: notes } }
      : accepted.contextCompactionPolicy!;
  return {
    assistantMessageId: input.answer,
    compaction: contextCompactionCheckpoint({
      ownerId: userId, request: { ...accepted, contextCompactionPolicy: policy }, runId, summary: notes,
      ...(input.bought !== false && !input.carried ? { summaryAttempts: [{ attempt: 1, bindingDigest: digest("b"),
        id: `csa1_${input.seed}`, sourceDigest: notes.sourceDigest, state: "committed" as const }] } : {})
    }),
    policy,
    runId,
    userId,
    userMessageId: input.userMessageId
  };
}

describe("carried compaction notes", () => {
  it("decodes a frozen reuse only for a hybrid policy", () => {
    const accepted = request().contextCompactionPolicy!;
    const reuse = { coveredMessageId: "u2", runId: "run-a2", summary: summary("a") };
    expect(decodeConversationContextPolicy({ ...accepted, reuse })).toEqual({ ...accepted, reuse });
    expect(decodeConversationContextPolicy({ ...accepted, mode: "legacy_compatible", reuse })).toBeNull();
    expect(decodeConversationContextPolicy({ ...accepted, reuse: { ...reuse, summary: { ...reuse.summary, notes: "" } } })).toBeNull();
    expect(decodeConversationContextPolicy({ ...accepted, reuse: { ...reuse, extra: true } })).toBeNull();
  });

  it("orders branch checkpoints newest first and bounds bought notes by their own user message", () => {
    const older = checkpoint({ answer: "a1", seed: "a", userMessageId: "u1" });
    const newer = checkpoint({ answer: "a2", seed: "b", userMessageId: "u2" });
    expect(contextSummaryReuseCandidates({ checkpoints: [older, newer], priorMessageIds: branch, userId: "user-1" }))
      .toEqual([
        { coveredMessageId: "u2", runId: "run-a2", summary: newer.compaction.summary },
        { coveredMessageId: "u1", runId: "run-a1", summary: older.compaction.summary }
      ]);
  });

  it("keeps the frozen boundary of notes a run carried from an earlier turn", () => {
    const carried = checkpoint({ answer: "a3", carried: { coveredMessageId: "u1", runId: "run-a1" }, seed: "c", userMessageId: "u3" });
    expect(contextSummaryReuseCandidates({ checkpoints: [carried], priorMessageIds: branch, userId: "user-1" }))
      .toEqual([{ coveredMessageId: "u1", runId: "run-a3", summary: carried.compaction.summary }]);
  });

  it("never carries sibling, foreign, legacy or unproven notes", () => {
    const candidates = contextSummaryReuseCandidates({
      checkpoints: [
        // An edited or regenerated sibling answer is not on this branch.
        checkpoint({ answer: "a2-sibling", seed: "d", userMessageId: "u2" }),
        checkpoint({ answer: "a2", seed: "e", userId: "user-2", userMessageId: "u2" }),
        checkpoint({ answer: "a2", hybrid: false, seed: "f", userMessageId: "u2" }),
        // Neither bought (no committed receipt) nor carried by that run.
        checkpoint({ answer: "a2", bought: false, seed: "g", userMessageId: "u2" }),
        // The boundary must precede the answer on this branch.
        checkpoint({ answer: "a1", seed: "h", userMessageId: "u3" }),
        checkpoint({ answer: "a3", carried: { coveredMessageId: "u2-sibling", runId: "run-x" }, seed: "i", userMessageId: "u3" })
      ],
      priorMessageIds: branch,
      userId: "user-1"
    });
    expect(candidates).toEqual([]);
  });

  it("never carries notes from a run accepted without the hybrid policy, such as a Knowledge run", () => {
    // A historical checkpoint may hold hybrid notes, but its run's accepted
    // policy is absent (Knowledge keeps the legacy guard) or not hybrid.
    const bought = checkpoint({ answer: "a2", seed: "b", userMessageId: "u2" });
    const withoutPolicy: BranchContextCheckpoint = { ...bought, policy: null };
    const legacy: BranchContextCheckpoint = { ...bought, policy: { ...bought.policy!, mode: "legacy_compatible" } };
    expect(contextSummaryReuseCandidates({ checkpoints: [bought], priorMessageIds: branch, userId: "user-1" }))
      .toHaveLength(1);
    expect(contextSummaryReuseCandidates({ checkpoints: [withoutPolicy, legacy], priorMessageIds: branch, userId: "user-1" }))
      .toEqual([]);
  });

  it("never carries notes whose refs could not name every retained source", () => {
    const incomplete = checkpoint({ answer: "a2", seed: "1", userMessageId: "u2" });
    const marked = { ...incomplete, compaction: { ...incomplete.compaction,
      summary: { ...incomplete.compaction.summary!, sourceRefs: ["ctxr1_revision", CONTEXT_SUMMARY_REFS_INCOMPLETE] } } };
    const older = checkpoint({ answer: "a1", seed: "2", userMessageId: "u1" });
    expect(contextSummaryReuseCandidates({ checkpoints: [older, marked], priorMessageIds: branch, userId: "user-1" }))
      .toEqual([{ coveredMessageId: "u1", runId: "run-a1", summary: older.compaction.summary }]);
  });
});

/** A jsonb-style copy: equal JSON with every object's keys in reverse order. */
function reordered<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reordered) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).reverse()
      .map((key) => [key, reordered((value as Record<string, unknown>)[key])])) as T;
  }
  return value;
}

describe("canonical compaction digests", () => {
  it("stay equal across a jsonb key reorder of the request and transcript", () => {
    const accepted: ProviderRunRequest = { ...request(), params: { reasoning: { effort: "low", summary: "auto" }, temperature: 0.2 },
      providerToolMessages: [{ arguments: "{}", call_id: "call-1", name: "read_record", type: "function_call" }] };
    const stored = reordered(accepted);
    expect(JSON.stringify(stored)).not.toBe(JSON.stringify(accepted));
    expect(canonicalJsonText(stored)).toBe(canonicalJsonText(accepted));
    expect(contextDigest(stored.context?.messages)).toBe(contextDigest(accepted.context?.messages));
    expect(contextDigest(stored.providerToolMessages)).toBe(contextDigest(accepted.providerToolMessages));
    expect(summaryBindingDigest(stored)).toBe(summaryBindingDigest(accepted));
    // Values still matter and arrays keep their order.
    expect(contextDigest({ a: [1, 2] })).not.toBe(contextDigest({ a: [2, 1] }));
    expect(canonicalJsonText({ dropped: undefined, at: new Date("2026-09-26T00:00:00.000Z") }))
      .toBe('{"at":"2026-09-26T00:00:00.000Z"}');
  });
});

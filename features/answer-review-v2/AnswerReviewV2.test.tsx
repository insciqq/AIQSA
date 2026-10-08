import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AnswerReviewCard, AnswerReviewSessionWire, AnswerReviewStepWire } from "@/lib/contracts/answerReviews";
import type { ThreadArtifactSummary, ThreadMessage } from "@/lib/contracts/chats";
import { AnswerReviewDialogV2 } from "./AnswerReviewDialogV2";
import { AnswerReviewCardV2, AnswerReviewHistoryV2, AnswerReviewStatusV2, AnswerReviewTurnV2 } from "./AnswerReviewV2";
import {
  answerReviewAuthorModelsV2,
  answerReviewAvailabilityV2,
  answerReviewGroupProgressV2,
  answerReviewReviewerCandidatesV2,
  groupAnswerReviewsV2,
  type AnswerReviewAvailabilityInput,
  type AnswerReviewCatalogModelV2,
  type AnswerReviewGroupV2
} from "./answerReviewModel";

const finding = { claim: "It opened in 2019.", id: "F1", problem: "The press release says 2021.", severity: "high" as const,
  suggestion: "Say 2021." };
const findingsCard: AnswerReviewCard = { findings: [finding], reviewer: 0, reviewerName: "GPT-5", round: 1, verdict: "changes_needed",
  version: 1 };
const cleanCard: AnswerReviewCard = { findings: [], reviewer: 0, reviewerName: "GPT-5", round: 1, verdict: "clean", version: 1 };
const artifact = (extra: Partial<ThreadArtifactSummary> = {}): ThreadArtifactSummary =>
  ({ citations: [], reasoningText: [], sources: [], ...extra });

function sessionWire(overrides: Partial<AnswerReviewSessionWire> = {}): AnswerReviewSessionWire {
  return { author: { modelId: "claude", name: "Claude Sonnet", provider: "anthropic" }, canAct: true, id: "session-1", maxRounds: null,
    mode: "manual", reviewers: [{ modelId: "gpt-5", name: "GPT-5", provider: "openai" }], round: 1,
    sourceAssistantMessageId: "v1", state: "running", stopReason: null, ...overrides };
}

function message(id: string, parentMessageId: string | null, role: ThreadMessage["role"], extra: Partial<ThreadMessage> = {}): ThreadMessage {
  return { content: { blocks: [{ text: `${id} text`, type: "text" }] }, id, parentMessageId, role, status: "complete", ...extra };
}

/** A question, its answer and the session's steps up to `stage`. */
function thread(stage: "clean" | "findings" | "revised" | "running", session = sessionWire()): ThreadMessage[] {
  const review: AnswerReviewStepWire = { kind: "review", modelName: "GPT-5", reviewer: 0, round: 1, step: 0 };
  const revision: AnswerReviewStepWire = { kind: "revision", modelName: "Claude Sonnet", round: 1, step: 1 };
  const base = [
    message("q", null, "user"),
    message("v1", "q", "assistant", { answerReview: { session } }),
    message("turn-1", "v1", "user", { answerReview: { session, step: review }, systemTurnKind: "answer_review_request" })
  ];
  if (stage === "running") {
    return [...base, message("review-1", "turn-1", "assistant", { answerReview: { session, step: review }, status: "streaming" })];
  }
  const reviewed = message("review-1", "turn-1", "assistant", { answerReview: { session, step: review },
    artifactSummary: artifact({ answerReviews: [stage === "clean" ? cleanCard : findingsCard] }) });
  if (stage !== "revised") return [...base, reviewed];
  return [...base, reviewed,
    message("turn-2", "review-1", "user", { answerReview: { session, step: revision }, systemTurnKind: "answer_revision_request" }),
    message("v2", "turn-2", "assistant", { answerReview: { session, step: revision }, artifactSummary: artifact({
      answerReviewDecisions: [{ decisions: [{ decision: "accepted", findingId: "R1.1.F1", reason: "Primary source." }], round: 1,
        version: 1 }] }) })];
}

function groupOf(messages: readonly ThreadMessage[]): AnswerReviewGroupV2 {
  const item = groupAnswerReviewsV2(messages).find((entry) => entry.kind === "review");
  if (!item || item.kind !== "review") throw new Error("no review group");
  return item.group;
}

describe("answer review grouping", () => {
  it("folds the source answer and its steps into one item whose latest version is the newest revision", () => {
    const items = groupAnswerReviewsV2(thread("revised"));
    expect(items.map((item) => item.kind)).toEqual(["message", "review"]);
    const group = groupOf(thread("revised"));
    expect(group.latest.id).toBe("v2");
    expect(group.source?.id).toBe("v1");
    expect(group.steps.map((entry) => [entry.step.kind, entry.turn?.id, entry.answer?.id]))
      .toEqual([["review", "turn-1", "review-1"], ["revision", "turn-2", "v2"]]);
  });

  it("keeps the source answer as the latest version until a revision completes", () => {
    expect(groupOf(thread("findings")).latest.id).toBe("v1");
    expect(answerReviewGroupProgressV2(groupOf(thread("findings"))).next).toMatchObject({ kind: "revision" });
    expect(answerReviewGroupProgressV2(groupOf(thread("clean")))).toMatchObject({ state: "finished", stopReason: "clean" });
  });
});

describe("answer review status line", () => {
  const status = (stage: Parameters<typeof thread>[0], props: Partial<Parameters<typeof AnswerReviewStatusV2>[0]> = {},
    session = sessionWire()) => {
    const group = groupOf(thread(stage, session));
    return render(<AnswerReviewStatusV2 actionsEnabled group={group} onContinue={vi.fn()} onRevise={vi.fn()} onStop={vi.fn()}
      progress={answerReviewGroupProgressV2(group)} {...props} />);
  };

  it("names the running step's model by its display name and offers Stop", () => {
    const onStop = vi.fn();
    status("running", { onStop });
    expect(screen.getByRole("status")).toHaveTextContent("Review · round 1 · GPT-5 is checking…");
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Revise" })).toBeNull();
  });

  it("offers Revise after findings to the initiator only", () => {
    const onRevise = vi.fn();
    const { unmount } = status("findings", { onRevise });
    expect(screen.getByRole("status")).toHaveTextContent("Review · round 1 · 1 finding to evaluate");
    fireEvent.click(screen.getByRole("button", { name: "Revise" }));
    expect(onRevise).toHaveBeenCalledOnce();
    unmount();
    status("findings", {}, sessionWire({ canAct: undefined }));
    expect(screen.queryByRole("button", { name: "Revise" })).toBeNull();
  });

  it("says No substantive issues for a clean review and offers no Revise", () => {
    status("clean", {}, sessionWire({ state: "finished", stopReason: "clean" }));
    expect(screen.getByRole("status")).toHaveTextContent("No substantive issues");
    expect(screen.queryByRole("button", { name: "Revise" })).toBeNull();
  });

  it("names a stopped session's reason and offers nothing", () => {
    status("findings", {}, sessionWire({ state: "stopped", stopReason: "budget" }));
    expect(screen.getByRole("status")).toHaveTextContent(/usage limit/u);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("shows no status line once the chat moved on or a revised round is done", () => {
    const { unmount } = status("findings", {}, sessionWire({ state: "stopped", stopReason: "superseded" }));
    expect(screen.queryByRole("status")).toBeNull();
    unmount();
    status("revised");
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("answer review history", () => {
  const renderAnswer = (answer: ThreadMessage, leading: React.ReactNode) => (
    <article aria-label={`Answer ${answer.id}`}>{leading}<p>{answer.id} body</p></article>
  );

  it("stays collapsed until opened, then lists Version 1, the review, the decisions and names the shown version", () => {
    render(<AnswerReviewHistoryV2 group={groupOf(thread("revised"))} renderAnswer={renderAnswer} />);
    const toggle = screen.getByRole("button", { name: "Review history · 1 round" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Version 1")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(screen.getByRole("article", { name: "Answer v1" })).getByText("Version 1")).toBeInTheDocument();
    const review = screen.getByRole("article", { name: "Answer review-1" });
    expect(review).toHaveTextContent("Review by GPT-5 · round 1");
    expect(within(review).getByRole("region", { name: "Review by GPT-5" })).toHaveTextContent("Accepted");
    expect(screen.getByText("Revision by Claude Sonnet · round 1")).toBeInTheDocument();
    expect(screen.getByText("Decisions: 1 accepted, 0 rejected")).toBeInTheDocument();
    expect(screen.getByText("Version 2 is the answer shown above.")).toBeInTheDocument();
    // The shown version is never rendered twice.
    expect(screen.queryByRole("article", { name: "Answer v2" })).toBeNull();
  });

  it("shows a running step's state", () => {
    render(<AnswerReviewHistoryV2 defaultOpen group={groupOf(thread("running"))} renderAnswer={renderAnswer} />);
    expect(screen.getByText(/Review by GPT-5 · round 1/u)).toHaveTextContent("Checking…");
  });
});

describe("answer review cards and turns", () => {
  it("shows a clean review without a findings list and findings with their severity", () => {
    const { unmount } = render(<AnswerReviewCardV2 card={cleanCard} />);
    expect(screen.getByRole("region", { name: "Review by GPT-5" })).toHaveTextContent("Review by GPT-5: No substantive issues");
    expect(screen.queryByRole("list")).toBeNull();
    unmount();
    render(<AnswerReviewCardV2 card={findingsCard} />);
    const item = screen.getByRole("listitem");
    expect(item).toHaveTextContent("High");
    expect(item).toHaveTextContent("ClaimIt opened in 2019.");
  });

  it("shows a server-written step turn as a quiet chip, never as speech", () => {
    render(<AnswerReviewTurnV2 anchorId="turn-2" kind="answer_revision_request" />);
    expect(screen.getByRole("article", { name: "Review step" })).toHaveTextContent("Revision request");
  });
});

describe("answer review availability", () => {
  const models: AnswerReviewCatalogModelV2[] = [
    { capabilities: { toolCalling: true }, displayName: "Claude Sonnet", modelId: "claude", provider: "anthropic-connection",
      providerFamily: "anthropic", upstreamModelId: "claude-sonnet-5" },
    { capabilities: { toolCalling: true }, displayName: "GPT-5", modelId: "gpt-5", provider: "openai-connection" },
    { capabilities: { toolCalling: false }, displayName: "Plain model", modelId: "plain", provider: "openai-connection" }
  ];
  const answer = message("a", "q", "assistant", { modelId: "claude-sonnet-5", provider: "anthropic" });
  const authors = answerReviewAuthorModelsV2(answer, models);
  const base: AnswerReviewAvailabilityInput = { activeRun: false, agentEnabled: false, answer, assistantChat: false,
    authorModels: authors, candidates: answerReviewReviewerCandidatesV2(models, authors), knowledgeEnabled: false, latest: true,
    mutationReason: null };

  it("finds the answer's own catalog model by its execution identity and offers only other tool-calling models", () => {
    expect(authors.map((model) => model.modelId)).toEqual(["claude"]);
    expect(base.candidates.map((model) => model.modelId)).toEqual(["gpt-5"]);
  });

  it("explains each unavailable case", () => {
    expect(answerReviewAvailabilityV2(base)).toEqual({ available: true });
    for (const [overrides, reason] of [
      [{ assistantChat: true }, /Assistant chats/u],
      [{ activeRun: true }, /Wait for the current answer/u],
      [{ latest: false }, /latest answer/u],
      [{ agentEnabled: true }, /Turn Agent off/u],
      [{ knowledgeEnabled: true }, /Knowledge/u],
      [{ answer: { ...answer, artifactSummary: artifact({ generatedImages: [{ attachmentId: "i", fileName: "x.png" }] as never }) } },
        /generated images/u],
      [{ candidates: [] }, /No other model/u],
      // An answer the server has not named yet: its id is still the browser's.
      [{ answer: { ...answer, id: "assistant-1760000000000" } }, /Wait for the current answer/u],
      [{ answer: { ...answer, answerReview: { session: sessionWire({ canAct: undefined }) } } }, /member who started this review/u]
    ] as const) {
      const result = answerReviewAvailabilityV2({ ...base, ...overrides } as AnswerReviewAvailabilityInput);
      expect(result.available, String(reason)).toBe(false);
      if (!result.available) expect(result.reason).toMatch(reason);
    }
  });
});

describe("answer review dialog", () => {
  const candidates: AnswerReviewCatalogModelV2[] = [
    { capabilities: { toolCalling: true }, displayName: "GPT-5", modelId: "gpt-5", provider: "openai" },
    { capabilities: { toolCalling: true }, displayName: "Gemini", modelId: "gemini", provider: "google" },
    { capabilities: { toolCalling: true }, displayName: "Grok", modelId: "grok", provider: "xai" }
  ];

  it("starts with the first candidate, takes at most two reviewers in order and starts them", () => {
    const onStart = vi.fn();
    render(<AnswerReviewDialogV2 candidates={candidates} onCancel={vi.fn()} onStart={onStart} />);
    const dialog = screen.getByRole("dialog", { name: "Review with another model" });
    expect(within(dialog).getByRole("checkbox", { name: "GPT-5" })).toBeChecked();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Gemini" }));
    expect(within(dialog).getByRole("checkbox", { name: /Grok/u })).toBeDisabled();
    expect(within(dialog).getByText("Second")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Start review" }));
    expect(onStart).toHaveBeenCalledWith([{ modelId: "gpt-5", provider: "openai" }, { modelId: "gemini", provider: "google" }]);
  });

  it("starts a later round with an earlier session's reviewers as identities only", () => {
    const onStart = vi.fn();
    // An earlier session's reviewers carry their display names; a round request names models by identity alone.
    const earlier = [{ modelId: "gemini", name: "Gemini", provider: "google" }];
    render(<AnswerReviewDialogV2 candidates={candidates} initial={earlier} onCancel={vi.fn()} onStart={onStart} />);
    const dialog = screen.getByRole("dialog", { name: "Review with another model" });
    expect(within(dialog).getByRole("checkbox", { name: "Gemini" })).toBeChecked();
    fireEvent.click(within(dialog).getByRole("button", { name: "Start review" }));
    expect(onStart).toHaveBeenCalledWith([{ modelId: "gemini", provider: "google" }]);
    expect(Object.keys(onStart.mock.calls[0]![0][0])).toEqual(["modelId", "provider"]);
  });

  it("keeps an earlier choice that is still offered and cannot start without a reviewer", () => {
    render(<AnswerReviewDialogV2 candidates={candidates} initial={[{ modelId: "grok", provider: "xai" }, { modelId: "gone", provider: "x" }]}
      onCancel={vi.fn()} onStart={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Review with another model" });
    expect(within(dialog).getByRole("checkbox", { name: "Grok" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "GPT-5" })).not.toBeChecked();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Grok" }));
    expect(within(dialog).getByRole("button", { name: "Start review" })).toBeDisabled();
  });

  it("shows a refusal and blocks closing while starting", () => {
    const onCancel = vi.fn();
    const { rerender } = render(<AnswerReviewDialogV2 candidates={candidates} error="This answer is no longer the latest one."
      onCancel={onCancel} onStart={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("no longer the latest");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
    rerender(<AnswerReviewDialogV2 busy candidates={candidates} onCancel={onCancel} onStart={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});

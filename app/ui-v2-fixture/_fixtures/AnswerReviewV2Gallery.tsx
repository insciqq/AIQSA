"use client";

import type { ReactNode } from "react";
import type { ChatNavigationSummaryWire, ThreadArtifactSummary, ThreadMessage } from "@/lib/contracts/chats";
import type {
  AnswerReviewCard,
  AnswerReviewDecisionsCard,
  AnswerReviewSessionWire,
  AnswerReviewStepWire
} from "@/lib/contracts/answerReviews";
import { NavigationSidebar, ReadingRoomShellV2 } from "@/features/navigation-v2/NavigationV2";
import { ConversationTurnV2, ConversationV2, type ConversationMessageV2 } from "@/features/conversation-v2/ConversationV2";
import { RunAnswerV2 } from "@/features/run-lifecycle-v2/RunLifecycleV2";
import { AnswerOutputsV2 } from "@/features/answer-outputs-v2/AnswerOutputsV2";
import { AnswerReviewHistoryV2, AnswerReviewStatusV2 } from "@/features/answer-review-v2/AnswerReviewV2";
import { answerReviewGroupProgressV2, groupAnswerReviewsV2 } from "@/features/answer-review-v2/answerReviewModel";

export type AnswerReviewGalleryState = "clean" | "collapsed" | "expanded" | "findings" | "running";

const navigationChats: ChatNavigationSummaryWire[] = [{
  activeRun: false,
  assistant: null,
  folderId: null,
  id: "answer-review-fixture",
  title: "Answer review",
  updatedAt: "2026-10-08T08:00:00.000Z"
}];

const emptyArtifact: ThreadArtifactSummary = { citations: [], reasoningText: [], sources: [] };

const findingsCard: AnswerReviewCard = {
  findings: [
    {
      claim: "The Berlin office opened in 2019.",
      evidence: "The company's press page dates the opening to March 2021.",
      id: "F1",
      problem: "The year contradicts the company's own announcement.",
      severity: "high",
      suggestion: "Say 2021 and name the press release as the source."
    },
    {
      claim: "Headcount doubled every year since.",
      id: "F2",
      problem: "No source in the answer supports a yearly doubling.",
      severity: "medium",
      suggestion: "Drop the claim or qualify it as an estimate."
    }
  ],
  reviewer: 0,
  reviewerName: "GPT-5",
  round: 1,
  verdict: "changes_needed",
  version: 1
};

const cleanCard: AnswerReviewCard = { findings: [], reviewer: 0, reviewerName: "GPT-5", round: 1, verdict: "clean", version: 1 };

const decisionsCard: AnswerReviewDecisionsCard = {
  decisions: [
    { decision: "accepted", findingId: "R1.1.F1", reason: "The press release is the primary source." },
    { decision: "rejected", findingId: "R1.1.F2", reason: "The answer already marks the figure as approximate." }
  ],
  round: 1,
  version: 1
};

function session(state: AnswerReviewGalleryState): AnswerReviewSessionWire {
  return {
    author: { modelId: "claude-sonnet", name: "Claude Sonnet", provider: "anthropic" },
    canAct: true,
    id: "answer-review-session",
    maxRounds: null,
    mode: "manual",
    reviewers: [{ modelId: "gpt-5", name: "GPT-5", provider: "openai" }],
    round: 1,
    sourceAssistantMessageId: "answer-review-v1",
    state: state === "clean" ? "finished" : "running",
    stopReason: state === "clean" ? "clean" : null
  };
}

function message(
  id: string,
  parentMessageId: string | null,
  role: ThreadMessage["role"],
  content: string,
  extra: Partial<ThreadMessage> = {}
): ThreadMessage {
  return { content: { blocks: [{ text: content, type: "text" }] }, id, parentMessageId, role, status: "complete", ...extra };
}

/** The chat's messages for a state: the question, the source answer and the session's steps so far. */
function threadFor(state: AnswerReviewGalleryState): ThreadMessage[] {
  const current = session(state);
  const review: AnswerReviewStepWire = { kind: "review", modelName: "GPT-5", reviewer: 0, round: 1, step: 0 };
  const revision: AnswerReviewStepWire = { kind: "revision", modelName: "Claude Sonnet", round: 1, step: 1 };
  const messages = [
    message("answer-review-question", null, "user", "When did the Berlin office open, and how has it grown?"),
    message("answer-review-v1", "answer-review-question", "assistant",
      "The Berlin office opened in 2019. Headcount doubled every year since, to about 120 people today.",
      { answerReview: { session: current }, artifactSummary: emptyArtifact, runId: "answer-review-run-1" }),
    message("answer-review-turn-1", "answer-review-v1", "user", "[Answer review request — written by AIQSA]",
      { answerReview: { session: current, step: review }, systemTurnKind: "answer_review_request" })
  ];
  if (state === "running") {
    return [...messages, message("answer-review-step-1", "answer-review-turn-1", "assistant", "",
      { answerReview: { session: current, step: review }, artifactSummary: null, runId: "answer-review-run-2", status: "streaming" })];
  }
  const reviewAnswer = message("answer-review-step-1", "answer-review-turn-1", "assistant",
    state === "clean" ? "Review submitted: no substantive issues." : "Review submitted: two findings.",
    { answerReview: { session: current, step: review }, artifactSummary: { ...emptyArtifact,
      answerReviews: [state === "clean" ? cleanCard : findingsCard] }, runId: "answer-review-run-2" });
  if (state === "clean" || state === "findings") return [...messages, reviewAnswer];
  return [
    ...messages,
    reviewAnswer,
    message("answer-review-turn-2", "answer-review-step-1", "user", "[Answer revision request — written by AIQSA]",
      { answerReview: { session: current, step: revision }, systemTurnKind: "answer_revision_request" }),
    message("answer-review-v2", "answer-review-turn-2", "assistant",
      "The Berlin office opened in March 2021, according to the company's press release. Headcount has grown to about 120 people.",
      { answerReview: { session: current, step: revision }, artifactSummary: { ...emptyArtifact, answerReviewDecisions: [decisionsCard] },
        runId: "answer-review-run-3" })
  ];
}

function messageText(value: ThreadMessage): string {
  const blocks = (value.content as { blocks?: Array<{ text?: string }> }).blocks ?? [];
  return blocks.map((block) => block.text ?? "").join("");
}

function AnswerV2({ answer, leading = null, notice = null, outputs = null, withActions }: Readonly<{
  answer: ThreadMessage;
  leading?: ReactNode;
  notice?: ReactNode;
  outputs?: ReactNode;
  withActions: boolean;
}>) {
  const settled = answer.status !== "streaming";
  return (
    <RunAnswerV2
      actions={withActions ? { onCopy: () => undefined, onMore: () => undefined, onRegenerate: () => undefined } : undefined}
      actionsSlot={<><AnswerOutputsV2 artifact={answer.artifactSummary ?? null} />{outputs}</>}
      anchorId={answer.id}
      artifact={answer.artifactSummary ?? null}
      content={messageText(answer)}
      leadingSlot={leading}
      noticeSlot={notice}
      presentation={settled
        ? { kind: "complete", runId: answer.runId ?? null }
        : { activity: { kind: "tool", label: "Checking the answer…" }, kind: "activity", runId: answer.runId ?? null }}
    />
  );
}

/**
 * A reviewed answer as the transcript groups it: the status line above the
 * latest version and the collapsed "Review history" below its outputs.
 */
export function AnswerReviewV2Gallery({ state = "collapsed" }: Readonly<{ state?: AnswerReviewGalleryState }>) {
  const items = groupAnswerReviewsV2(threadFor(state));
  const group = items.find((item) => item.kind === "review")?.group ?? null;
  const messages: ConversationMessageV2[] = items.map((item) => item.kind === "review"
    ? { content: messageText(item.group.latest), id: item.group.id, role: "assistant" }
    : { content: messageText(item.message), id: item.message.id, role: item.message.role });
  const sidebar = (onClose: () => void) => (
    <NavigationSidebar
      activeChatId="answer-review-fixture"
      chats={navigationChats}
      error={null}
      folders={[]}
      hasMore={false}
      loading={false}
      now={new Date("2026-10-08T12:00:00.000Z")}
      onClose={onClose}
      onLoadMore={() => undefined}
      onNewChat={() => undefined}
      onRetry={() => undefined}
      onSearch={() => undefined}
      onSelectChat={() => undefined}
      ready
      searchError={null}
      searchLoading={false}
      searchQuery=""
    />
  );
  return (
    <div data-state={state} data-testid="ui-v2-answer-review-gallery">
      <ReadingRoomShellV2 onNewChat={() => undefined} onSelectChat={() => undefined} sidebar={sidebar}>
        <main className="v2-conversation-gallery-main">
          <ConversationV2
            messages={messages}
            renderMessage={(entry) => {
              if (group && entry.id === group.id) {
                const progress = answerReviewGroupProgressV2(group);
                return (
                  <AnswerV2
                    answer={group.latest}
                    notice={(
                      <AnswerReviewStatusV2 actionsEnabled group={group} onContinue={() => undefined} onRevise={() => undefined}
                        onStop={() => undefined} progress={progress} />
                    )}
                    outputs={(
                      <AnswerReviewHistoryV2 defaultOpen={state === "expanded"} group={group}
                        renderAnswer={(answer, leading) => <AnswerV2 answer={answer} leading={leading} withActions={false} />} />
                    )}
                    withActions
                  />
                );
              }
              return (
                <ConversationTurnV2 actions={{ onCopy: () => undefined, onEdit: () => undefined }} anchorId={entry.id}
                  content={entry.content} role="user" />
              );
            }}
          />
        </main>
      </ReadingRoomShellV2>
    </div>
  );
}

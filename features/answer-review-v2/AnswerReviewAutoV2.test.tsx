import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AnswerReviewAutoConfig, AnswerReviewSessionWire, AnswerReviewStepWire } from "@/lib/contracts/answerReviews";
import type { ThreadMessage } from "@/lib/contracts/chats";
import { AnswerReviewSettingsDialogV2 } from "./AnswerReviewSettingsDialogV2";
import { AnswerReviewStatusV2 } from "./AnswerReviewV2";
import {
  answerReviewAutoChipV2,
  answerReviewAutoCostHintV2,
  answerReviewAutoRunningV2,
  answerReviewAutoStateV2,
  answerReviewAutoSummaryV2,
  answerReviewGroupProgressV2,
  answerReviewStatusTextV2,
  groupAnswerReviewsV2,
  type AnswerReviewCatalogModelV2,
  type AnswerReviewGroupV2
} from "./answerReviewModel";

const model = (modelId: string, displayName: string, toolCalling = true): AnswerReviewCatalogModelV2 => ({
  capabilities: { toolCalling }, displayName, modelId, provider: `connection-${modelId}`
});
const claude = model("claude", "Claude");
const gpt = model("gpt", "GPT-5");
const gemini = model("gemini", "Gemini");
const textOnly = model("text", "Text only", false);
const pick = (entry: AnswerReviewCatalogModelV2) => ({ modelId: entry.modelId, provider: entry.provider });
const config = (overrides: Partial<AnswerReviewAutoConfig> = {}): AnswerReviewAutoConfig =>
  ({ enabled: true, maxRounds: 3, reviewers: [pick(gpt)], ...overrides });

function state(overrides: Partial<Parameters<typeof answerReviewAutoStateV2>[0]> = {}) {
  return answerReviewAutoStateV2({ agentEnabled: false, assistantChat: false, authorModel: claude, config: config(),
    knowledgeEnabled: false, models: [claude, gpt, gemini, textOnly], ...overrides });
}

describe("automatic review state", () => {
  it("offers tool-calling models other than the answer's and sends the chat's review when it can run", () => {
    const ready = state();
    expect(ready.candidates.map((entry) => entry.modelId)).toEqual(["gpt", "gemini"]);
    expect(ready.send).toEqual(config());
    expect(ready.blockedReason).toBeNull();
    expect(answerReviewAutoSummaryV2(ready)).toBe("On · 1 reviewer · up to 3 rounds");
    expect(answerReviewAutoChipV2(ready)).toEqual({ count: 1, label: "Review: GPT-5, up to 3 rounds", state: "on" });
    expect(answerReviewAutoChipV2(state({ config: config({ maxRounds: 1, reviewers: [pick(gpt), pick(gemini)] }) })))
      .toEqual({ count: 2, label: "Review: GPT-5, Gemini, up to 1 round", state: "on" });
  });

  it("is blocked with its reason in Assistant chats, with Agent, with Knowledge and for a model without tools", () => {
    for (const [overrides, reason] of [
      [{ assistantChat: true }, /Assistant chats/u],
      [{ agentEnabled: true }, /Agent/u],
      [{ knowledgeEnabled: true }, /Knowledge/u],
      [{ authorModel: textOnly }, /can't use tools/u],
      [{ models: [claude, textOnly] }, /No other model/u]
    ] as const) {
      const blocked = state(overrides);
      expect(blocked.blockedReason, String(reason)).toMatch(reason);
      expect(blocked.send).toBeNull();
      expect(answerReviewAutoChipV2(blocked)).toMatchObject({ state: "unavailable" });
    }
  });

  it("never substitutes a chosen reviewer that is gone or became the answer's model", () => {
    const gone = state({ config: config({ reviewers: [pick(model("retired", "Retired"))] }) });
    expect(gone.blockedReason).toBeNull();
    expect(gone.unavailableReason).toMatch(/chosen reviewer is unavailable/u);
    expect(gone.send).toBeNull();
    expect(answerReviewAutoSummaryV2(gone)).toBe("Unavailable");
    const author = state({ authorModel: gpt });
    expect(author.send).toBeNull();
    expect(author.reviewers).toEqual([]);
  });

  it("sends nothing and shows no glyph while review is off", () => {
    const off = state({ config: config({ enabled: false }) });
    expect(off.send).toBeNull();
    expect(answerReviewAutoChipV2(off)).toBeNull();
    expect(answerReviewAutoSummaryV2(off)).toBe("Off");
  });

  it("counts what a choice can cost", () => {
    expect(answerReviewAutoCostHintV2({ maxRounds: 3, reviewers: [pick(gpt)] })).toBe("Up to 6 extra answers per question");
    expect(answerReviewAutoCostHintV2({ maxRounds: 1, reviewers: [pick(gpt), pick(gemini)] })).toBe("Up to 3 extra answers per question");
  });
});

function sessionWire(overrides: Partial<AnswerReviewSessionWire> = {}): AnswerReviewSessionWire {
  return { author: { modelId: "claude", name: "Claude", provider: "connection-claude" }, canAct: true, id: "session-1", maxRounds: 3,
    mode: "auto", reviewers: [{ modelId: "gpt", name: "GPT-5", provider: "connection-gpt" }], round: 2,
    sourceAssistantMessageId: "v1", state: "running", stopReason: null, ...overrides };
}

function message(id: string, parentMessageId: string | null, role: ThreadMessage["role"], extra: Partial<ThreadMessage> = {}): ThreadMessage {
  return { content: { blocks: [{ text: `${id} text`, type: "text" }] }, id, parentMessageId, role, status: "complete", ...extra };
}

function group(messages: readonly ThreadMessage[]): AnswerReviewGroupV2 {
  const item = groupAnswerReviewsV2(messages).find((entry) => entry.kind === "review");
  if (!item || item.kind !== "review") throw new Error("no review group");
  return item.group;
}

function autoThread(stage: "answering" | "between" | "reviewing", session = sessionWire()): ThreadMessage[] {
  if (stage === "answering") {
    return [message("q", null, "user"), message("v1", "q", "assistant", { answerReview: { session: { ...session, round: 1 } },
      status: "streaming" })];
  }
  const round1: AnswerReviewStepWire = { kind: "review", modelName: "GPT-5", reviewer: 0, round: 1, step: 0 };
  const revision1: AnswerReviewStepWire = { kind: "revision", modelName: "Claude", round: 1, step: 1 };
  const round2: AnswerReviewStepWire = { kind: "review", modelName: "GPT-5", reviewer: 0, round: 2, step: 0 };
  const card = { findings: [{ claim: "c", id: "F1", problem: "p", severity: "high" as const, suggestion: "s" }], reviewer: 0,
    reviewerName: "GPT-5", round: 1, verdict: "changes_needed" as const, version: 1 as const };
  const base = [
    message("q", null, "user"),
    message("v1", "q", "assistant", { answerReview: { session } }),
    message("t1", "v1", "user", { answerReview: { session, step: round1 }, systemTurnKind: "answer_review_request" }),
    message("r1", "t1", "assistant", { answerReview: { session, step: round1 }, artifactSummary: { answerReviews: [card], citations: [],
      reasoningText: [], sources: [] } }),
    message("t2", "r1", "user", { answerReview: { session, step: revision1 }, systemTurnKind: "answer_revision_request" }),
    message("v2", "t2", "assistant", { answerReview: { session, step: revision1 }, artifactSummary: { answerReviewDecisions: [{
      decisions: [{ decision: "accepted", findingId: "R1.1.F1", reason: "Right." }], round: 1, version: 1 }], citations: [],
      reasoningText: [], sources: [] } })
  ];
  if (stage === "between") return base;
  return [...base,
    message("t3", "v2", "user", { answerReview: { session, step: round2 }, systemTurnKind: "answer_review_request" }),
    message("r2", "t3", "assistant", { answerReview: { session, step: round2 }, status: "streaming" })];
}

describe("automatic review status line", () => {
  it("counts rounds of the session and names the step's model", () => {
    const reviewing = group(autoThread("reviewing"));
    const progress = answerReviewGroupProgressV2(reviewing);
    expect(answerReviewStatusTextV2(reviewing, progress)).toBe("Review · round 2 of 3 · GPT-5 is checking…");
    const between = group(autoThread("between"));
    expect(answerReviewStatusTextV2(between, answerReviewGroupProgressV2(between))).toBe("Review · round 2 of 3 · GPT-5 is starting…");
  });

  it("stays quiet while the answer under review is still written, and holds the composer only afterwards", () => {
    const answering = group(autoThread("answering"));
    const progress = answerReviewGroupProgressV2(answering);
    expect(progress.awaitingAnswer).toBe(true);
    expect(answerReviewStatusTextV2(answering, progress)).toBeNull();
    expect(answerReviewAutoRunningV2(answering, progress)).toBe(false);
    const between = group(autoThread("between"));
    expect(answerReviewAutoRunningV2(between, answerReviewGroupProgressV2(between))).toBe(true);
  });

  it("offers Stop between steps too, and never Revise or Continue, which the server drives", () => {
    const between = group(autoThread("between"));
    const onStopSession = vi.fn();
    render(<AnswerReviewStatusV2 actionsEnabled group={between} onContinue={vi.fn()} onRevise={vi.fn()} onStop={vi.fn()}
      onStopSession={onStopSession} progress={answerReviewGroupProgressV2(between)} />);
    const status = screen.getByTestId("answer-review-status");
    expect(status).toHaveAttribute("data-state", "running");
    fireEvent.click(within(status).getByRole("button", { name: "Stop" }));
    expect(onStopSession).toHaveBeenCalledTimes(1);
    expect(within(status).queryByRole("button", { name: /Revise|Continue/u })).toBeNull();
  });

  it("offers no Stop to another member of a Project chat", () => {
    const between = group(autoThread("between", sessionWire({ canAct: undefined })));
    render(<AnswerReviewStatusV2 actionsEnabled group={between} onStopSession={vi.fn()} progress={answerReviewGroupProgressV2(between)} />);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });
});

describe("automatic review settings", () => {
  it("saves the switch, the reviewers in order and the rounds, with the cost of the choice", () => {
    const onSave = vi.fn();
    render(<AnswerReviewSettingsDialogV2 candidates={[gpt, gemini]} initial={config({ enabled: false, reviewers: [] })} mode="chat"
      onCancel={vi.fn()} onSave={onSave} />);
    const dialog = screen.getByRole("dialog", { name: "Answer review" });
    // Without an earlier choice the first offered model is the reviewer.
    expect(within(dialog).getByRole("checkbox", { name: "GPT-5" })).toBeChecked();
    fireEvent.click(within(dialog).getByRole("switch", { name: /Review answers automatically/u }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Gemini" }));
    expect(within(dialog).getByText("Second")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("radio", { name: "Up to 2" }));
    expect(within(dialog).getByTestId("answer-review-cost-hint")).toHaveTextContent("Up to 6 extra answers per question");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ enabled: true, maxRounds: 2, reviewers: [pick(gpt), pick(gemini)] });
  });

  it("refuses to turn review on without a reviewer and keeps a reviewer that is gone out", () => {
    const onSave = vi.fn();
    render(<AnswerReviewSettingsDialogV2 candidates={[gpt]} initial={config({ reviewers: [pick(model("retired", "Retired"))] })}
      mode="chat" onCancel={vi.fn()} onSave={onSave} unavailableReason="A chosen reviewer is unavailable." />);
    expect(screen.getByRole("status")).toHaveTextContent("A chosen reviewer is unavailable.");
    expect(screen.getByRole("checkbox", { name: "GPT-5" })).not.toBeChecked();
    expect(screen.getByRole("alert")).toHaveTextContent("Choose at least one reviewer.");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("names the default for new chats", () => {
    render(<AnswerReviewSettingsDialogV2 candidates={[gpt]} initial={config({ enabled: false })} mode="defaults" onCancel={vi.fn()}
      onSave={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Answer review for new chats" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /Review answers in new chats/u })).toHaveAttribute("aria-checked", "false");
  });
});

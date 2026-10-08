import {
  ANSWER_REVIEW_MAX_REVIEWERS,
  ANSWER_REVIEW_NOT_INITIATOR_COPY,
  answerReviewExtraAnswers,
  answerReviewStopCopy,
  type AnswerReviewAutoConfig,
  type AnswerReviewCard,
  type AnswerReviewDecisionsCard,
  type AnswerReviewSessionWire,
  type AnswerReviewStepWire
} from "@/lib/contracts/answerReviews";
import type { ThreadArtifactSummary, ThreadMessage } from "@/lib/contracts/chats";
import {
  answerReviewProgress,
  type AnswerReviewProgress,
  type AnswerReviewSourceFacts,
  type AnswerReviewStepFacts
} from "@/lib/domain/answerReviewProgress";

/** One step of a group: its server-written turn (never shown as speech) and that turn's answer. */
export type AnswerReviewGroupStepV2 = Readonly<{
  answer: ThreadMessage | null;
  step: AnswerReviewStepWire;
  turn: ThreadMessage | null;
}>;

/**
 * An answer review session as the transcript shows it: one answer, the
 * group's latest version, over a history of its versions and steps.
 */
export type AnswerReviewGroupV2 = Readonly<{
  id: string;
  /** The answer shown: the newest complete revision, else the source answer. */
  latest: ThreadMessage;
  messages: readonly ThreadMessage[];
  session: AnswerReviewSessionWire;
  source: ThreadMessage | null;
  steps: readonly AnswerReviewGroupStepV2[];
}>;

export type AnswerReviewTranscriptItemV2 =
  | Readonly<{ kind: "message"; message: ThreadMessage }>
  | Readonly<{ group: AnswerReviewGroupV2; kind: "review" }>;

export const ANSWER_REVIEW_GROUP_PREFIX = "answer-review:";

function sessionOf(message: ThreadMessage): AnswerReviewSessionWire | null {
  return message.answerReview?.session ?? null;
}

/**
 * The transcript with each answer review session folded into one item: its
 * source answer and the steps that follow it on the path. A session whose
 * source lies before the loaded page still groups its steps.
 */
export function groupAnswerReviewsV2(messages: readonly ThreadMessage[]): AnswerReviewTranscriptItemV2[] {
  const items: AnswerReviewTranscriptItemV2[] = [];
  for (let index = 0; index < messages.length;) {
    const message = messages[index]!;
    const session = sessionOf(message);
    const opensGroup = Boolean(session && (session.sourceAssistantMessageId === message.id || message.answerReview?.step));
    if (!session || !opensGroup) {
      items.push({ kind: "message", message });
      index += 1;
      continue;
    }
    const members = [message];
    let next = index + 1;
    while (next < messages.length && messages[next]!.answerReview?.session.id === session.id && messages[next]!.answerReview?.step) {
      members.push(messages[next]!);
      next += 1;
    }
    items.push({ group: answerReviewGroupV2(members), kind: "review" });
    index = next;
  }
  return items;
}

function answerReviewGroupV2(members: readonly ThreadMessage[]): AnswerReviewGroupV2 {
  // The newest projection of the session wins: step messages update during a run.
  const session = [...members].reverse().map(sessionOf).find((value): value is AnswerReviewSessionWire => value !== null)!;
  const source = members[0]?.id === session.sourceAssistantMessageId ? members[0]! : null;
  const steps: AnswerReviewGroupStepV2[] = [];
  for (const message of members) {
    const step = message.answerReview?.step;
    if (!step) continue;
    const existing = steps.find((entry) => entry.step.round === step.round && entry.step.step === step.step);
    if (message.role === "user") {
      if (existing) continue;
      steps.push({ answer: null, step, turn: message });
    } else if (existing) {
      steps[steps.indexOf(existing)] = { ...existing, answer: message, step: { ...existing.step, ...step } };
    } else {
      steps.push({ answer: message, step, turn: null });
    }
  }
  const versions = steps.filter((entry) => entry.step.kind === "revision" && entry.answer?.status === "complete");
  const latest = versions.at(-1)?.answer ?? source ?? members.find((message) => message.role === "assistant") ?? members[0]!;
  return { id: `${ANSWER_REVIEW_GROUP_PREFIX}${session.id}`, latest, messages: members, session, source, steps };
}

export function answerReviewCardOf(artifact: ThreadArtifactSummary | null | undefined): AnswerReviewCard | null {
  return artifact?.answerReviews?.[0] ?? null;
}

export function answerReviewDecisionsOf(artifact: ThreadArtifactSummary | null | undefined): AnswerReviewDecisionsCard | null {
  return artifact?.answerReviewDecisions?.[0] ?? null;
}

function stepStatus(answer: ThreadMessage | null): AnswerReviewStepFacts["status"] {
  return !answer || answer.status === "streaming" ? "running" : answer.status;
}

/**
 * What one step did, from its answer as the transcript has it (a running
 * step's live summary when given): the same facts the server reads.
 */
export function answerReviewStepFactsV2(
  entry: AnswerReviewGroupStepV2,
  artifact: ThreadArtifactSummary | null = entry.answer?.artifactSummary ?? null
): AnswerReviewStepFacts {
  const review = entry.step.kind === "review" ? answerReviewCardOf(artifact) : null;
  return {
    ...(artifact?.mcpApprovals?.some((card) => card.state === "pending") ? { approvalPending: true as const } : {}),
    ...(entry.step.kind === "revision" && answerReviewDecisionsOf(artifact) ? { decisions: true as const } : {}),
    kind: entry.step.kind,
    ...(review ? { review: {
      findings: review.findings.length,
      repeats: review.findings.filter((finding) => finding.repeatsFindingId !== undefined).length,
      verdict: review.verdict
    } } : {}),
    round: entry.step.round,
    status: stepStatus(entry.answer),
    step: entry.step.step
  };
}

/** An automatic session's answer as the transcript has it: the same facts the server reads. */
function answerReviewSourceFactsV2(source: ThreadMessage, artifact: ThreadArtifactSummary | null): AnswerReviewSourceFacts {
  return {
    ...(artifact?.mcpApprovals?.some((card) => card.state === "pending") ? { approvalPending: true as const } : {}),
    ...((artifact?.generatedImages?.length ?? 0) > 0 ? { imageOutput: true as const } : {}),
    status: stepStatus(source)
  };
}

/** The group's progress as the server reads it, with a running step's live summary. */
export function answerReviewGroupProgressV2(
  group: AnswerReviewGroupV2,
  live?: Readonly<{ artifact: ThreadArtifactSummary | null; messageId: string }>
): AnswerReviewProgress {
  const artifactOf = (message: ThreadMessage | null) => live && message?.id === live.messageId
    ? live.artifact : message?.artifactSummary ?? null;
  return answerReviewProgress({
    maxRounds: group.session.maxRounds,
    mode: group.session.mode,
    reviewerCount: group.session.reviewers.length,
    round: group.session.round,
    ...(group.session.mode === "auto" && group.source
      ? { source: answerReviewSourceFactsV2(group.source, artifactOf(group.source)) } : {}),
    state: group.session.state,
    steps: group.steps.map((entry) => answerReviewStepFactsV2(entry, artifactOf(entry.answer))),
    stopReason: group.session.stopReason
  });
}

/**
 * The group's progress as the transcript shows it. A group the chat moved on
 * from (no longer the latest of the path) waits for nothing: the next run's
 * admission superseded its session on the server, whatever session this page
 * last read. It keeps its history and shows no status line or action.
 */
export function answerReviewGroupDisplayProgressV2(
  group: AnswerReviewGroupV2,
  options: Readonly<{ latest: boolean; live?: Readonly<{ artifact: ThreadArtifactSummary | null; messageId: string }> }>
): AnswerReviewProgress {
  const progress = answerReviewGroupProgressV2(group, options.live);
  if (options.latest || progress.state !== "running" || progress.running) return progress;
  return { ...progress, next: null, settle: false, state: "stopped", stopReason: "superseded" };
}

/** The display name of a step's model: its frozen snapshot, else the session's reference. */
export function answerReviewStepModelNameV2(session: AnswerReviewSessionWire, step: AnswerReviewStepWire): string {
  if (step.modelName) return step.modelName;
  return step.kind === "revision" ? session.author.name : session.reviewers[step.reviewer ?? 0]?.name ?? "Reviewer";
}

/** The rounds the history lists: the current one, or fewer when it has no steps yet. */
export function answerReviewRoundCountV2(group: AnswerReviewGroupV2): number {
  return Math.max(1, ...group.steps.map((entry) => entry.step.round));
}

/**
 * The quiet status line of a group: a running step names its model and
 * round; an ended session names how it ended; a waiting one says what is next.
 */
export function answerReviewStatusTextV2(group: AnswerReviewGroupV2, progress: AnswerReviewProgress): string | null {
  // An automatic session counts its rounds ("round 2 of 3").
  const round = (value: number) => group.session.mode === "auto" && group.session.maxRounds !== null
    ? `round ${value} of ${group.session.maxRounds}` : `round ${value}`;
  const running = progress.running;
  if (running) {
    const entry = group.steps.find((candidate) => candidate.step.round === running.round && candidate.step.step === running.step);
    const name = entry ? answerReviewStepModelNameV2(group.session, entry.step) : "A model";
    return running.kind === "review"
      ? `Review · ${round(running.round)} · ${name} is checking…`
      : `Review · ${round(running.round)} · ${name} is revising…`;
  }
  // A session the chat moved on from ended as the user chose: its history stays, no status line.
  if (progress.state !== "running") {
    return progress.stopReason && progress.stopReason !== "superseded" ? answerReviewStopCopy(progress.stopReason) : null;
  }
  // The answer itself shows its progress; its review starts when it is ready.
  if (progress.awaitingAnswer) return null;
  if (group.session.mode === "auto" && progress.next) {
    const reviewer = progress.next.kind === "review" ? group.session.reviewers[progress.next.reviewer]?.name : group.session.author.name;
    return `Review · ${round(progress.next.round)} · ${reviewer ?? "A model"} is starting…`;
  }
  if (progress.next?.kind === "revision") {
    const findings = progress.reviews.findings;
    return `Review · ${round(progress.next.round)} · ${findings} ${findings === 1 ? "finding" : "findings"} to evaluate`;
  }
  if (progress.next?.kind === "review") {
    return `Review · ${round(progress.next.round)} · ${progress.reviews.done} of ${progress.reviews.total} reviews`;
  }
  return null;
}

/** An automatic session the server still drives: its status line offers Stop, the composer waits for it. */
export function answerReviewAutoRunningV2(group: AnswerReviewGroupV2, progress: AnswerReviewProgress): boolean {
  return group.session.mode === "auto" && progress.state === "running" && !progress.awaitingAnswer;
}

/** How the chat waits for a running automatic review, by who views it. */
export type AnswerReviewAutoWaitV2 = Readonly<{
  /** Why the chat's message actions wait while a step runs. */
  actionsReason: string;
  /** The composer's line while the review runs. */
  notice: string;
  /** Null when the viewer started the review and its Stop ends it; otherwise why the composer offers no Stop. */
  stopUnavailableReason: string | null;
}>;

/**
 * The chat is busy while an automatic review runs, for every viewer. Only its
 * initiator may stop it (the server refuses anyone else): another member of a
 * Project chat waits for it, with no Stop.
 */
export function answerReviewAutoWaitV2(group: AnswerReviewGroupV2): AnswerReviewAutoWaitV2 {
  return group.session.canAct === true
    ? { actionsReason: "Stop the review first.", notice: "Review in progress — Stop to send now", stopUnavailableReason: null }
    : {
        actionsReason: "Wait for the other member's review to finish.",
        notice: "Another member's review is in progress",
        stopUnavailableReason: "Only the member who started this review can stop it."
      };
}

/** A catalog model as the review picker needs it. */
export type AnswerReviewCatalogModelV2 = Readonly<{
  capabilities: Readonly<{ toolCalling?: boolean }>;
  displayName: string;
  modelId: string;
  provider: string;
  providerFamily?: string;
  upstreamModelId?: string;
}>;

/**
 * The catalog entries of an answer's own model: a session's frozen reference,
 * or the catalog models that serve the answer's provider family and upstream
 * model (an answer names its execution model, never its catalog entry).
 */
export function answerReviewAuthorModelsV2(
  answer: Pick<ThreadMessage, "answerReview" | "modelId" | "provider">,
  models: readonly AnswerReviewCatalogModelV2[]
): AnswerReviewCatalogModelV2[] {
  const author = answer.answerReview?.session.author;
  if (author) return models.filter((model) => model.provider === author.provider && model.modelId === author.modelId);
  return models.filter((model) => Boolean(answer.modelId) && model.upstreamModelId === answer.modelId &&
    (!answer.provider || model.providerFamily === answer.provider));
}

/** Reviewer candidates: tool-calling catalog models other than the answer's own. */
export function answerReviewReviewerCandidatesV2(
  models: readonly AnswerReviewCatalogModelV2[],
  authors: readonly AnswerReviewCatalogModelV2[]
): AnswerReviewCatalogModelV2[] {
  return models.filter((model) => model.capabilities.toolCalling === true &&
    !authors.some((author) => author.provider === model.provider && author.modelId === model.modelId));
}

export type AnswerReviewAvailabilityInput = Readonly<{
  activeRun: boolean;
  agentEnabled: boolean;
  answer: ThreadMessage;
  assistantChat: boolean;
  authorModels: readonly AnswerReviewCatalogModelV2[];
  candidates: readonly AnswerReviewCatalogModelV2[];
  /** The answer is the latest of the active path (a group's latest version). */
  latest: boolean;
  knowledgeEnabled: boolean;
  mutationReason: string | null;
}>;

export type AnswerReviewAvailability = Readonly<{ available: true }> | Readonly<{ available: false; reason: string }>;

/** The id the browser gives an answer before the server's arrives (the run actions' optimistic messages). */
const OPTIMISTIC_ANSWER_ID = /^assistant-(?:regen-)?\d+$/u;

/** Whether "Review…" is offered on an answer, and why not. */
export function answerReviewAvailabilityV2(input: AnswerReviewAvailabilityInput): AnswerReviewAvailability {
  const unavailable = (reason: string): AnswerReviewAvailability => ({ available: false, reason });
  const { answer } = input;
  if (input.assistantChat) return unavailable("Review isn't available in Assistant chats yet: the Assistant fixes the model.");
  if (input.mutationReason) return unavailable(input.mutationReason);
  // A just-finished answer the server has not yet named is no answer the server can review.
  if (input.activeRun || OPTIMISTIC_ANSWER_ID.test(answer.id)) return unavailable("Wait for the current answer to finish.");
  if (!input.latest) return unavailable("Only the latest answer can be reviewed.");
  if (answer.status !== "complete") return unavailable("Only a finished answer can be reviewed.");
  if (answer.answerReview && !answer.answerReview.session.canAct) return unavailable(ANSWER_REVIEW_NOT_INITIATOR_COPY);
  if (input.agentEnabled) return unavailable("Turn Agent off to review this answer.");
  if (input.knowledgeEnabled || (answer.artifactSummary?.knowledgeCitations?.length ?? 0) > 0 || answer.artifactSummary?.knowledgeState) {
    return unavailable("Review isn't available with Knowledge: Knowledge answers stay bound to their sources.");
  }
  if ((answer.artifactSummary?.generatedImages?.length ?? 0) > 0) return unavailable("Answers with generated images can't be reviewed.");
  if (input.authorModels.length > 0 && input.authorModels.every((model) => model.capabilities.toolCalling !== true)) {
    return unavailable("This answer's model can't use tools, so it can't revise after a review.");
  }
  if (input.candidates.length === 0) return unavailable("No other model that can use tools is available to review.");
  return { available: true };
}

export const ANSWER_REVIEW_PICK_LIMIT = ANSWER_REVIEW_MAX_REVIEWERS;

/** Automatic review in this chat now: the chat's choice, who may review, and why it cannot run. */
export type AnswerReviewAutoStateV2 = Readonly<{
  /** Why review is unavailable in this chat (Agent, an Assistant, Knowledge, the model): it cannot be set here. */
  blockedReason: string | null;
  /** Tool-calling models other than the answer's: who may review. */
  candidates: readonly AnswerReviewCatalogModelV2[];
  config: AnswerReviewAutoConfig;
  /** The chosen reviewers the composer can still offer, in order. */
  reviewers: readonly AnswerReviewCatalogModelV2[];
  /** What the next send carries: the chat's review when it is on and can run; null otherwise. */
  send: AnswerReviewAutoConfig | null;
  /** Why the chosen review does not run now: the chat's block, or a chosen reviewer that is gone; null when it runs. */
  unavailableReason: string | null;
}>;

export function answerReviewAutoStateV2(input: Readonly<{
  agentEnabled: boolean;
  assistantChat: boolean;
  authorModel: AnswerReviewCatalogModelV2 | undefined;
  config: AnswerReviewAutoConfig;
  knowledgeEnabled: boolean;
  models: readonly AnswerReviewCatalogModelV2[];
}>): AnswerReviewAutoStateV2 {
  const author = input.authorModel;
  const candidates = answerReviewReviewerCandidatesV2(input.models, author ? [author] : []);
  const reviewers = input.config.reviewers.flatMap((pick) =>
    candidates.filter((model) => model.provider === pick.provider && model.modelId === pick.modelId));
  const blockedReason = input.assistantChat
    ? "Review isn't available in Assistant chats yet: the Assistant fixes the model."
    : input.agentEnabled
      ? "Review is off while Agent is on."
      : input.knowledgeEnabled
        ? "Review isn't available with Knowledge: Knowledge answers stay bound to their sources."
        : !author
          ? "Choose a model first."
          : author.capabilities.toolCalling !== true
            ? "This model can't use tools, so it can't revise after a review."
            : candidates.length === 0
              ? "No other model that can use tools is available to review."
              : null;
  // Nothing is substituted: a chosen reviewer that is gone, or is now the answer's model, stops the review here.
  const unavailableReason = blockedReason ?? (input.config.enabled && reviewers.length < input.config.reviewers.length
    ? "A chosen reviewer is unavailable or is this answer's model. Choose another one." : null);
  return {
    blockedReason,
    candidates,
    config: input.config,
    reviewers,
    send: input.config.enabled && !unavailableReason && reviewers.length > 0 ? input.config : null,
    unavailableReason
  };
}

/** "On · 2 reviewers · up to 3 rounds", "Off" or "Unavailable": the model picker's row. */
export function answerReviewAutoSummaryV2(state: AnswerReviewAutoStateV2): string {
  if (!state.config.enabled) return "Off";
  if (!state.send) return "Unavailable";
  const reviewers = state.reviewers.length;
  return `On · ${reviewers} ${reviewers === 1 ? "reviewer" : "reviewers"} · up to ${state.config.maxRounds} ` +
    `${state.config.maxRounds === 1 ? "round" : "rounds"}`;
}

/**
 * The header model chip's review glyph: shown while the chat's review is on,
 * with the reviewers' count, and its label for the tooltip and screen
 * readers ("Review: GPT-5, Claude, up to 3 rounds"); an unavailable review
 * says why. Null while review is off.
 */
export function answerReviewAutoChipV2(state: AnswerReviewAutoStateV2): Readonly<{
  count: number;
  label: string;
  state: "on" | "unavailable";
}> | null {
  if (!state.config.enabled) return null;
  if (!state.send) {
    return { count: state.reviewers.length, label: `Review on but not running: ${state.unavailableReason ?? "no reviewer"}`,
      state: "unavailable" };
  }
  const rounds = `up to ${state.config.maxRounds} ${state.config.maxRounds === 1 ? "round" : "rounds"}`;
  return { count: state.reviewers.length, label: `Review: ${state.reviewers.map((model) => model.displayName).join(", ")}, ${rounds}`,
    state: "on" };
}

/**
 * The cost hint of a review choice: each round adds the reviewers' answers
 * and a revision, so up to rounds × (reviewers + 1) extra answers.
 */
export function answerReviewAutoCostHintV2(config: Pick<AnswerReviewAutoConfig, "maxRounds" | "reviewers">): string {
  const answers = answerReviewExtraAnswers(config);
  return `Up to ${answers} extra ${answers === 1 ? "answer" : "answers"} per question`;
}

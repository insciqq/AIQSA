import { textFromThreadContent } from "@/components/app-shell/threadContent";
import { isRecord } from "@/components/app-shell/shellValues";
import type { RunEventView, ThreadMessage } from "@/components/app-shell/types";

export type PipelineStageStatus = "active" | "done" | "error" | "idle" | "skipped";

export type PipelinePhase = "cancelled" | "error" | "idle" | "running" | "settled";

export type PipelineSnapshot = {
  activity?: Readonly<{ count?: number; kind: "model" | "tools" }>;
  answer: PipelineStageStatus;
  phase: PipelinePhase;
  question: PipelineStageStatus;
  search: PipelineStageStatus;
};

export type RunActivityLabel =
  | "Answering"
  | "Run error"
  | `Running ${number} tools`
  | "Searching"
  | "Waiting for model"
  | "Working";

export type RunLifecycleAnnouncement =
  | RunActivityLabel
  | "Run complete. Message composer ready."
  | "Run stopped. Message composer ready."
  | "Run error. Message composer ready.";

export type PipelineRunState = {
  events: RunEventView[];
  searchEnabled: boolean;
  streaming: boolean;
};

const idlePipeline: PipelineSnapshot = {
  answer: "idle",
  phase: "idle",
  question: "idle",
  search: "idle"
};

/** Names only activity proven by the current run surface; silence stays generic. */
export function runActivityLabel(pipeline: PipelineSnapshot): RunActivityLabel {
  if (pipeline.phase === "error") {
    return "Run error";
  }

  if (pipeline.activity?.kind === "tools") {
    return `Running ${pipeline.activity.count ?? 0} tools`;
  }

  if (pipeline.activity?.kind === "model") {
    return "Waiting for model";
  }

  if (pipeline.answer === "active") {
    return "Answering";
  }

  if (pipeline.search === "active") {
    return "Searching";
  }

  return "Working";
}

/** Provides the single spoken copy for a current run without inventing an unobserved queue phase. */
export function runLifecycleAnnouncement(
  pipeline: PipelineSnapshot
): RunLifecycleAnnouncement | null {
  if (pipeline.phase === "running") {
    return runActivityLabel(pipeline);
  }

  if (pipeline.phase === "settled") {
    return "Run complete. Message composer ready.";
  }

  if (pipeline.phase === "cancelled") {
    return "Run stopped. Message composer ready.";
  }

  if (pipeline.phase === "error") {
    return "Run error. Message composer ready.";
  }

  return null;
}

function eventArtifactType(event: RunEventView): string | null {
  return event.type === "artifact" && isRecord(event.data) && typeof event.data.artifactType === "string"
    ? event.data.artifactType
    : null;
}

function isSearchSkipArtifact(event: RunEventView): boolean {
  if (eventArtifactType(event) !== "summary" || !isRecord(event.data)) {
    return false;
  }

  const payload = event.data.payload;
  return isRecord(payload) && payload.stage === "search" && payload.status === "skipped";
}

/**
 * Derives a compact live-run state from the active chat's event stream.
 * Stage signals only accumulate within one run (the source chat's keyed
 * surface resets on send/regenerate), so progress is monotonic and an error
 * remains attached to the phase it interrupted.
 */
export function pipelineStage(runState: PipelineRunState): PipelineSnapshot {
  let sawSearch = false;
  let sawSearchSkip = false;
  let sawAnswer = false;
  let activity: PipelineSnapshot["activity"];
  let errorStage: "answer" | "question" | "search" | null = null;
  let doneStatus: string | null = null;

  for (const event of runState.events) {
    if (event.type === "token") {
      sawAnswer = true;
      activity = undefined;
      continue;
    }

    if (event.type === "artifact") {
      const artifactType = eventArtifactType(event);
      if (artifactType === "search" || artifactType === "citation") {
        sawSearch = true;
      } else if (isSearchSkipArtifact(event)) {
        sawSearchSkip = true;
      } else if (artifactType === "summary" && isRecord(event.data)) {
        const payload = event.data.payload;
        if (isRecord(payload) && payload.stage === "model" && payload.status === "waiting") {
          activity = { kind: "model" };
        } else if (isRecord(payload) && payload.stage === "tools" && payload.status === "running") {
          activity = {
            count: typeof payload.count === "number" && Number.isFinite(payload.count)
              ? Math.max(0, Math.floor(payload.count))
              : 0,
            kind: "tools"
          };
        }
      }
      continue;
    }

    if (event.type === "error" && !errorStage) {
      errorStage = sawAnswer ? "answer" : sawSearch ? "search" : "question";
      continue;
    }

    if (event.type === "done") {
      doneStatus = isRecord(event.data) && typeof event.data.status === "string" ? event.data.status : "complete";
    }
  }

  if (!runState.streaming && runState.events.length === 0) {
    return idlePipeline;
  }

  // Observed events win over the picker flag: search artifacts mean the stage ran,
  // an explicit skip artifact means the backend declined it for this run.
  const searchParticipates = sawSearch || (runState.searchEnabled && !sawSearchSkip);

  if (errorStage) {
    return {
      answer: errorStage === "answer" ? "error" : "idle",
      phase: "error",
      question: errorStage === "question" ? "error" : "done",
      search:
        errorStage === "search"
          ? "error"
          : sawSearch
            ? "done"
            : errorStage === "question" && searchParticipates
              ? "idle"
              : "skipped"
    };
  }

  if (doneStatus === "cancelled") {
    return {
      answer: sawAnswer ? "done" : "idle",
      phase: "cancelled",
      question: "done",
      search: sawSearch ? "done" : "skipped"
    };
  }

  if (doneStatus) {
    return {
      answer: "done",
      phase: "settled",
      question: "done",
      search: sawSearch ? "done" : "skipped"
    };
  }

  if (!runState.streaming) {
    // Events without a terminal frame and no live stream: an abandoned run
    // surface. Stay calm instead of pretending the pipeline is still working.
    return idlePipeline;
  }

  return {
    ...(activity ? { activity } : {}),
    answer: sawAnswer ? "active" : "idle",
    phase: "running",
    question: sawSearch || sawAnswer ? "done" : "active",
    search: !searchParticipates
      ? "skipped"
      : sawSearch
        ? sawAnswer
          ? "done"
          : "active"
        : "idle"
  };
}

export function mergeThreadMessages(current: ThreadMessage[], updates: ThreadMessage[]): ThreadMessage[] {
  if (updates.length === 0) {
    return current;
  }

  const updatesById = new Map(updates.map((message) => [message.id, message]));
  const merged = current.map((message) => updatesById.get(message.id) ?? message);
  const currentIds = new Set(current.map((message) => message.id));
  for (const update of updates) {
    if (!currentIds.has(update.id)) {
      merged.push(update);
    }
  }

  return merged;
}

export function appendAssistantDelta(
  messages: ThreadMessage[],
  assistantMessageId: string,
  delta: string
): ThreadMessage[] {
  return messages.map((message) =>
    message.id === assistantMessageId ? { ...message, content: `${textFromThreadContent(message.content)}${delta}` } : message
  );
}

export function resetAssistantDraft(
  messages: ThreadMessage[],
  assistantMessageId: string
): ThreadMessage[] {
  return messages.map((message) =>
    message.id === assistantMessageId ? { ...message, content: "" } : message
  );
}

function numericEventField(data: unknown, key: string): number {
  if (!isRecord(data)) {
    return 0;
  }

  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function compactTokenEvent(event: RunEventView): RunEventView {
  const delta = isRecord(event.data) && typeof event.data.delta === "string" ? event.data.delta : "";
  return {
    data: {
      characterCount: numericEventField(event.data, "characterCount") || delta.length,
      chunkCount: numericEventField(event.data, "chunkCount") || 1
    },
    type: "token"
  };
}

/** Keeps the client-side event timeline bounded during long adjacent token streams. */
export function appendCompactRunEvent(current: RunEventView[], event: RunEventView): RunEventView[] {
  if (event.type !== "token") {
    return [...current, event];
  }

  const nextToken = compactTokenEvent(event);
  const previous = current.at(-1);
  if (previous?.type !== "token") {
    return [...current, nextToken];
  }

  return [
    ...current.slice(0, -1),
    {
      data: {
        characterCount:
          numericEventField(previous.data, "characterCount") +
          numericEventField(nextToken.data, "characterCount"),
        chunkCount:
          numericEventField(previous.data, "chunkCount") +
          numericEventField(nextToken.data, "chunkCount")
      },
      type: "token"
    }
  ];
}

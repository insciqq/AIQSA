import { create } from "zustand";

export type RunLifecycleSnapshot = {
  activeStreams: Record<
    string,
    {
      answerComplete?: true;
      optimisticAssistantMessageId: string | null;
      /**
       * Opaque token of the foreground stream producer that owns this record.
       * Only that producer may bind the record's run id or finish it by token;
       * a predecessor's late events and fetches carry another token (or none)
       * and can never adopt a record whose run id is still unknown.
       */
      producer?: string;
      resuming: boolean;
      runId: string | null;
      /** The resume owner passed its frequent-polling horizon and now checks rarely. */
      waitingInBackground?: true;
    }
  >;
  ambiguousFailures: Record<
    string,
    {
      assistantMessageId: string;
      runId: string | null;
    }
  >;
  cancelledRunIds: Set<string>;
  stoppingRunIds: Set<string>;
};

export type RunLifecycleTransition =
  | { chatId: string; producer?: string; runId: string; type: "ANSWER_COMPLETED" }
  | {
      assistantMessageId?: string | null;
      chatId: string;
      producer?: string;
      runId?: string | null;
      type: "STREAM_STARTED";
    }
  | {
      assistantMessageId: string;
      chatId: string;
      type: "TOKENS_APPLIED";
    }
  | {
      chatId: string;
      producer: string;
      runId: string;
      type: "RUN_ID_RECEIVED";
    }
  | {
      chatId: string;
      producer?: string;
      runId?: string | null;
      type: "STREAM_FINISHED";
    }
  | {
      chatId: string;
      runId?: string | null;
      type: "RUN_CANCELLED";
    }
  | {
      chatId: string;
      runId: string;
      type: "RESUME_STARTED";
    }
  | {
      chatId: string;
      runId: string;
      type: "RESUME_EXITED";
    }
  | {
      chatId: string;
      runId: string;
      type: "RESUME_BACKGROUNDED";
    }
  | {
      assistantMessageId: string;
      chatId: string;
      runId: string | null;
      type: "STREAM_AMBIGUOUS";
    }
  | {
      chatId: string;
      type: "AMBIGUITY_CLEARED";
    };

export type RunLifecycleStore = RunLifecycleSnapshot & {
  answerCompleted(input: { chatId: string; producer?: string; runId: string }): void;
  stopStarted(runId: string): boolean;
  stopFinished(runId: string): void;
  ambiguityCleared(input: { chatId: string }): void;
  dispatch(transition: RunLifecycleTransition): void;
  resumeBackgrounded(input: { chatId: string; runId: string }): void;
  resumeExited(input: { chatId: string; runId: string }): void;
  resumeStarted(input: { chatId: string; runId: string }): boolean;
  runCancelled(input: { chatId: string; runId?: string | null }): void;
  runIdReceived(input: { chatId: string; producer: string; runId: string }): void;
  streamFinished(input: { chatId: string; producer?: string; runId?: string | null }): void;
  streamAmbiguous(input: { assistantMessageId: string; chatId: string; runId: string | null }): void;
  streamStarted(input: {
    assistantMessageId?: string | null;
    chatId: string;
    producer?: string;
    runId?: string | null;
  }): void;
  tokensApplied(input: { assistantMessageId: string; chatId: string }): void;
};

export const initialRunLifecycleSnapshot: RunLifecycleSnapshot = {
  activeStreams: {},
  ambiguousFailures: {},
  cancelledRunIds: new Set<string>(),
  stoppingRunIds: new Set<string>()
};

function cloneSnapshot(state: RunLifecycleSnapshot): RunLifecycleSnapshot {
  return {
    activeStreams: Object.fromEntries(
      Object.entries(state.activeStreams).map(([chatId, stream]) => [chatId, { ...stream }])
    ),
    ambiguousFailures: Object.fromEntries(
      Object.entries(state.ambiguousFailures).map(([chatId, failure]) => [chatId, { ...failure }])
    ),
    cancelledRunIds: new Set(state.cancelledRunIds),
    stoppingRunIds: new Set(state.stoppingRunIds)
  };
}

export function reduceRunLifecycle(
  state: RunLifecycleSnapshot,
  transition: RunLifecycleTransition
): RunLifecycleSnapshot {
  const next = cloneSnapshot(state);

  switch (transition.type) {
    case "ANSWER_COMPLETED": {
      // A run id on a record is bound only by its own producer or resume
      // owner, so an exact run id match identifies the record; a producer
      // token, when given, must also match.
      const stream = next.activeStreams[transition.chatId];
      if (stream?.runId === transition.runId &&
        (transition.producer === undefined || stream.producer === transition.producer)) {
        stream.answerComplete = true;
      }
      return next;
    }

    case "STREAM_STARTED":
      delete next.ambiguousFailures[transition.chatId];
      next.activeStreams[transition.chatId] = {
        optimisticAssistantMessageId: transition.assistantMessageId ?? null,
        ...(transition.producer ? { producer: transition.producer } : {}),
        resuming: false,
        runId: transition.runId ?? null
      };
      return next;

    case "TOKENS_APPLIED":
      if (next.activeStreams[transition.chatId]) {
        next.activeStreams[transition.chatId].optimisticAssistantMessageId = transition.assistantMessageId;
      }
      return next;

    case "RUN_ID_RECEIVED": {
      // Binding requires the record's own producer token: a predecessor that
      // outlived its stream (late fetch after answer_complete) must never
      // hand its run id to a successor that has not received one yet.
      const stream = next.activeStreams[transition.chatId];
      if (stream?.producer !== undefined && stream.producer === transition.producer &&
        (!stream.runId || stream.runId === transition.runId)) {
        stream.runId = transition.runId;
      }
      return next;
    }

    case "STREAM_FINISHED": {
      const stream = next.activeStreams[transition.chatId];
      if (transition.producer !== undefined) {
        if (stream?.producer !== transition.producer) return state;
      } else if (transition.runId && stream?.runId !== transition.runId) {
        return state;
      }
      // Neither token nor run id: an owner-independent clear (access loss).
      delete next.activeStreams[transition.chatId];
      return next;
    }

    case "RUN_CANCELLED":
      if (transition.runId) {
        next.cancelledRunIds.add(transition.runId);
      }
      if (!transition.runId || next.activeStreams[transition.chatId]?.runId === transition.runId) delete next.activeStreams[transition.chatId];
      if (!transition.runId || next.ambiguousFailures[transition.chatId]?.runId === transition.runId) delete next.ambiguousFailures[transition.chatId];
      return next;

    case "RESUME_STARTED":
      if (next.activeStreams[transition.chatId]) {
        return next;
      }
      next.activeStreams[transition.chatId] = {
        optimisticAssistantMessageId: null,
        resuming: true,
        runId: transition.runId
      };
      delete next.ambiguousFailures[transition.chatId];
      return next;

    case "RESUME_BACKGROUNDED":
      if (
        next.activeStreams[transition.chatId]?.resuming === true &&
        next.activeStreams[transition.chatId]?.runId === transition.runId
      ) {
        next.activeStreams[transition.chatId].waitingInBackground = true;
      }
      return next;

    case "RESUME_EXITED":
      if (
        next.activeStreams[transition.chatId]?.resuming === true &&
        next.activeStreams[transition.chatId]?.runId === transition.runId
      ) {
        delete next.activeStreams[transition.chatId];
      }
      return next;

    case "STREAM_AMBIGUOUS":
      next.ambiguousFailures[transition.chatId] = {
        assistantMessageId: transition.assistantMessageId,
        runId: transition.runId
      };
      return next;

    case "AMBIGUITY_CLEARED":
      delete next.ambiguousFailures[transition.chatId];
      return next;
  }
}

export const useRunLifecycleStore = create<RunLifecycleStore>((set, get) => ({
  ...initialRunLifecycleSnapshot,
  answerCompleted(input) {
    get().dispatch({ ...input, type: "ANSWER_COMPLETED" });
  },
  stopStarted(runId) {
    if (get().stoppingRunIds.has(runId)) return false;
    set((state) => ({ stoppingRunIds: new Set([...state.stoppingRunIds, runId]) }));
    return true;
  },
  stopFinished(runId) {
    set((state) => {
      const stoppingRunIds = new Set(state.stoppingRunIds);
      stoppingRunIds.delete(runId);
      return { stoppingRunIds };
    });
  },
  ambiguityCleared(input) {
    get().dispatch({ ...input, type: "AMBIGUITY_CLEARED" });
  },
  dispatch(transition) {
    set((state) => reduceRunLifecycle(state, transition));
  },
  resumeBackgrounded(input) {
    get().dispatch({ ...input, type: "RESUME_BACKGROUNDED" });
  },
  resumeExited(input) {
    get().dispatch({ ...input, type: "RESUME_EXITED" });
  },
  resumeStarted(input) {
    const before = get();
    const alreadyActive = Boolean(before.activeStreams[input.chatId]);
    get().dispatch({ ...input, type: "RESUME_STARTED" });
    const after = get();

    return (
      !alreadyActive &&
      after.activeStreams[input.chatId]?.resuming === true &&
      after.activeStreams[input.chatId]?.runId === input.runId
    );
  },
  runCancelled(input) {
    get().dispatch({ ...input, type: "RUN_CANCELLED" });
  },
  runIdReceived(input) {
    get().dispatch({ ...input, type: "RUN_ID_RECEIVED" });
  },
  streamFinished(input) {
    get().dispatch({ ...input, type: "STREAM_FINISHED" });
  },
  streamAmbiguous(input) {
    get().dispatch({ ...input, type: "STREAM_AMBIGUOUS" });
  },
  streamStarted(input) {
    get().dispatch({ ...input, type: "STREAM_STARTED" });
  },
  tokensApplied(input) {
    get().dispatch({ ...input, type: "TOKENS_APPLIED" });
  }
}));

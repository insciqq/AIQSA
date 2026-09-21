import { appendCompactRunEvent } from "@/components/app-shell/runState";
import type { RunEventView } from "@/components/app-shell/types";
import { create } from "zustand";
import { decodeArtifactGenerationEvent } from "@/lib/contracts/artifactGeneration";
import { applyArtifactGenerationEvent, endArtifactGeneration, type ArtifactGenerationDraft } from "@/components/artifacts/artifactGenerationState";

export type RunSurfaceSnapshot = {
  /** Controls captured at send time; survives preparation and message-id reconciliation. */
  contextConfigurationKey?: string;
  contextMessageId?: string;
  artifactDrafts?: readonly ArtifactGenerationDraft[];
  /** Client clock when the current round's first answer token arrived; a round reset clears it. */
  answerStartedAt: number | null;
  events: RunEventView[];
  /** Client clock when the send began; the live "Worked for …" counts from here. */
  startedAt: number | null;
};

export type RunSurfaceStore = {
  surfacesByChatId: Record<string, RunSurfaceSnapshot>;
  appendEvent(chatId: string, event: RunEventView): void;
  endArtifactStream(chatId: string, status: "complete" | "error" | "cancelled" | "interrupted"): void;
  bindContextMessage(chatId: string, previousMessageId: string, messageId: string): void;
  removeSurface(chatId: string): void;
  resetSurface(chatId: string, contextConfigurationKey?: string, contextMessageId?: string): void;
};

export const emptyRunSurfaceSnapshot: RunSurfaceSnapshot = {
  answerStartedAt: null,
  events: [],
  startedAt: null
};
Object.freeze(emptyRunSurfaceSnapshot.events);
Object.freeze(emptyRunSurfaceSnapshot);

export function selectRunSurface(
  state: Pick<RunSurfaceStore, "surfacesByChatId">,
  chatId: string | null
): RunSurfaceSnapshot {
  return chatId
    ? state.surfacesByChatId[chatId] ?? emptyRunSurfaceSnapshot
    : emptyRunSurfaceSnapshot;
}

/**
 * Live work duration of a run: from the send to the first answer token. It is
 * a client-clock fact for the answer in flight only; the settled value comes
 * from the server's artifact summary.
 */
export function liveWorkDurationMs(surface: RunSurfaceSnapshot): number | null {
  if (surface.startedAt === null || surface.answerStartedAt === null) return null;
  const duration = surface.answerStartedAt - surface.startedAt;
  return duration >= 0 ? duration : null;
}

export const useRunSurfaceStore = create<RunSurfaceStore>((set) => ({
  surfacesByChatId: {},
  appendEvent(chatId, event) {
    set((state) => {
      const current = selectRunSurface(state, chatId);
      const now = Date.now();
      if (event.type === "artifact_generation") {
        const decoded = decodeArtifactGenerationEvent(event.data);
        if (!decoded) return state;
        const artifactDrafts = applyArtifactGenerationEvent(current.artifactDrafts ?? [], decoded);
        return { surfacesByChatId: { ...state.surfacesByChatId, [chatId]: { ...current, artifactDrafts } } };
      }
      const terminal = event.type === "error" ? "error" : event.type === "done" && event.data && typeof event.data === "object" && "status" in event.data
        ? event.data.status : null;
      return {
        surfacesByChatId: {
          ...state.surfacesByChatId,
          [chatId]: {
            ...current,
            ...(current.artifactDrafts && (terminal === "error" || terminal === "cancelled" || terminal === "complete")
              ? { artifactDrafts: endArtifactGeneration(current.artifactDrafts, terminal) } : {}),
            answerStartedAt: event.type === "message_reset"
              ? null
              : event.type === "token"
                ? current.answerStartedAt ?? now
                : current.answerStartedAt,
            events: appendCompactRunEvent(current.events, event),
            startedAt: current.startedAt ?? now
          }
        }
      };
    });
  },
  endArtifactStream(chatId, status) {
    set(state => {
      const current = selectRunSurface(state, chatId);
      if (!current.artifactDrafts?.some(draft => draft.status === "pending")) return state;
      return { surfacesByChatId: { ...state.surfacesByChatId,
        [chatId]: { ...current, artifactDrafts: endArtifactGeneration(current.artifactDrafts, status) } } };
    });
  },
  bindContextMessage(chatId, previousMessageId, messageId) {
    set((state) => {
      const current = selectRunSurface(state, chatId);
      if (current.contextMessageId !== previousMessageId) return state;
      return { surfacesByChatId: { ...state.surfacesByChatId,
        [chatId]: { ...current, contextMessageId: messageId } } };
    });
  },
  removeSurface(chatId) {
    set((state) => {
      if (!(chatId in state.surfacesByChatId)) {
        return state;
      }

      const { [chatId]: _removed, ...surfacesByChatId } = state.surfacesByChatId;
      return { surfacesByChatId };
    });
  },
  resetSurface(chatId, contextConfigurationKey, contextMessageId) {
    set((state) => ({
      surfacesByChatId: {
        ...state.surfacesByChatId,
        [chatId]: { ...emptyRunSurfaceSnapshot, startedAt: Date.now(),
          ...(contextConfigurationKey ? { contextConfigurationKey, contextMessageId } : {}) }
      }
    }));
  }
}));

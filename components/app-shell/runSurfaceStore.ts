import { appendCompactRunEvent } from "@/components/app-shell/runState";
import type { RunEventView } from "@/components/app-shell/types";
import { create } from "zustand";

export type RunSurfaceSnapshot = {
  events: RunEventView[];
};

export type RunSurfaceStore = {
  surfacesByChatId: Record<string, RunSurfaceSnapshot>;
  appendEvent(chatId: string, event: RunEventView): void;
  removeSurface(chatId: string): void;
  resetSurface(chatId: string): void;
};

export const emptyRunSurfaceSnapshot: RunSurfaceSnapshot = {
  events: []
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

export const useRunSurfaceStore = create<RunSurfaceStore>((set) => ({
  surfacesByChatId: {},
  appendEvent(chatId, event) {
    set((state) => {
      const current = selectRunSurface(state, chatId);
      return {
        surfacesByChatId: {
          ...state.surfacesByChatId,
          [chatId]: {
            ...current,
            events: appendCompactRunEvent(current.events, event)
          }
        }
      };
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
  resetSurface(chatId) {
    set((state) => ({
      surfacesByChatId: {
        ...state.surfacesByChatId,
        [chatId]: emptyRunSurfaceSnapshot
      }
    }));
  }
}));

export function resetRunSurfaceStoreForTest() {
  useRunSurfaceStore.setState({
    surfacesByChatId: {}
  });
}

import { appendCompactRunEvent } from "@/components/app-shell/runState";
import type { PersistedRun, RunEventView } from "@/components/app-shell/types";
import { create } from "zustand";

export type RunSurfaceSnapshot = {
  events: RunEventView[];
  lastRun: PersistedRun | null;
  runsById: Readonly<Record<string, PersistedRun>>;
};

type RunSurfaceReplacement = Pick<RunSurfaceSnapshot, "events" | "lastRun">;

export type RunSurfaceStore = {
  surfacesByChatId: Record<string, RunSurfaceSnapshot>;
  appendEvent(chatId: string, event: RunEventView): void;
  cacheRun(chatId: string, run: PersistedRun): void;
  removeSurface(chatId: string): void;
  replaceSurface(chatId: string, input: RunSurfaceReplacement): void;
  resetSurface(chatId: string): void;
};

export const emptyRunSurfaceSnapshot: RunSurfaceSnapshot = {
  events: [],
  lastRun: null,
  runsById: {}
};
Object.freeze(emptyRunSurfaceSnapshot.events);
Object.freeze(emptyRunSurfaceSnapshot.runsById);
Object.freeze(emptyRunSurfaceSnapshot);

function compactEvents(events: RunEventView[]): RunEventView[] {
  return events.reduce(appendCompactRunEvent, [] as RunEventView[]);
}

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
  cacheRun(chatId, run) {
    set((state) => {
      const current = selectRunSurface(state, chatId);
      if (current.runsById[run.id] === run) return state;
      return {
        surfacesByChatId: {
          ...state.surfacesByChatId,
          [chatId]: {
            ...current,
            runsById: { ...current.runsById, [run.id]: run }
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
  replaceSurface(chatId, input) {
    set((state) => {
      const current = selectRunSurface(state, chatId);
      return {
        surfacesByChatId: {
          ...state.surfacesByChatId,
          [chatId]: {
            events: compactEvents(input.events),
            lastRun: input.lastRun,
            runsById: input.lastRun
              ? { ...current.runsById, [input.lastRun.id]: input.lastRun }
              : current.runsById
          }
        }
      };
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

import {
  loadMemoryHealth,
  MemoryApiError
} from "@/components/app-shell/memoryApi";
import type { UserMemoryHealth } from "@/lib/contracts/memoryHealth";
import { create } from "zustand";

export type MemoryHealthLoadState = "error" | "idle" | "loading" | "ready";

type MemoryHealthStore = {
  accountId: string | null;
  data: UserMemoryHealth | null;
  error: string | null;
  loadState: MemoryHealthLoadState;
};

const initialState: MemoryHealthStore = {
  accountId: null,
  data: null,
  error: null,
  loadState: "idle"
};

export const useMemoryHealthStore = create<MemoryHealthStore>(() => initialState);

let generation = 0;
let controller: AbortController | null = null;
let loadPromise: Promise<UserMemoryHealth> | null = null;

function validAccountId(value: string): boolean {
  return value.trim() === value && value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u0020\u007f]/u.test(value);
}

function errorName(error: unknown): string {
  return error instanceof MemoryApiError || error instanceof Error
    ? error.message
    : "memory_health_unavailable";
}

export async function activateMemoryHealthAccount(
  accountId: string
): Promise<UserMemoryHealth> {
  if (!validAccountId(accountId)) throw new Error("memory_health_account_invalid");
  if (useMemoryHealthStore.getState().accountId !== accountId) {
    generation += 1;
    controller?.abort();
    controller = null;
    loadPromise = null;
    useMemoryHealthStore.setState({ ...initialState, accountId }, true);
  }
  return refreshMemoryHealth();
}

export function deactivateMemoryHealthAccount(accountId?: string): void {
  if (
    accountId !== undefined &&
    useMemoryHealthStore.getState().accountId !== accountId
  ) return;
  generation += 1;
  controller?.abort();
  controller = null;
  loadPromise = null;
  useMemoryHealthStore.setState(initialState, true);
}

export async function refreshMemoryHealth(): Promise<UserMemoryHealth> {
  const current = useMemoryHealthStore.getState();
  if (!current.accountId) throw new Error("memory_health_account_inactive");
  if (loadPromise) return loadPromise;
  const accountId = current.accountId;
  const requestGeneration = generation;
  controller = new AbortController();
  useMemoryHealthStore.setState({
    error: null,
    loadState: current.data ? current.loadState : "loading"
  });
  loadPromise = loadMemoryHealth(controller.signal).then(
    ({ health }) => {
      if (
        requestGeneration === generation &&
        useMemoryHealthStore.getState().accountId === accountId
      ) {
        useMemoryHealthStore.setState({
          data: health,
          error: null,
          loadState: "ready"
        });
      }
      return health;
    },
    (error: unknown) => {
      if (
        requestGeneration === generation &&
        useMemoryHealthStore.getState().accountId === accountId &&
        !(error instanceof DOMException && error.name === "AbortError")
      ) {
        useMemoryHealthStore.setState({
          error: errorName(error),
          loadState: current.data ? current.loadState : "error"
        });
      }
      throw error;
    }
  ).finally(() => {
    if (requestGeneration === generation) {
      loadPromise = null;
      controller = null;
    }
  });
  return loadPromise;
}

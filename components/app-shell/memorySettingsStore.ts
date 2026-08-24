import {
  loadMemorySettings,
  MemoryApiError,
  patchMemorySettings
} from "@/components/app-shell/memoryApi";
import {
  type MemoryConsumerSettingsPatch,
  type MemoryConsumerSettingsResponse
} from "@/lib/contracts/memoryConsumer";
import { create } from "zustand";

export type MemorySettingsLoadState = "error" | "idle" | "loading" | "ready";
export type MemorySettingsMutation =
  | "decayEnabled"
  | "learnAutomatically"
  | "referenceChatHistory"
  | "synthesisEnabled"
  | "useMemoryFacts";

type MemorySettingsStore = {
  accountId: string | null;
  busy: MemorySettingsMutation | null;
  data: MemoryConsumerSettingsResponse | null;
  error: string | null;
  loadState: MemorySettingsLoadState;
};

const initialState: MemorySettingsStore = {
  accountId: null,
  busy: null,
  data: null,
  error: null,
  loadState: "idle"
};

export const useMemorySettingsStore = create<MemorySettingsStore>(() => initialState);

let requestGeneration = 0;
let loadRequest: Readonly<{
  controller: AbortController;
  generation: number;
  promise: Promise<MemoryConsumerSettingsResponse>;
}> | null = null;

function errorName(error: unknown): string {
  return error instanceof MemoryApiError || error instanceof Error
    ? error.message
    : "memory_action_failed";
}

export async function refreshMemorySettings(
  force = false
): Promise<MemoryConsumerSettingsResponse> {
  const current = useMemorySettingsStore.getState();
  if (!force && current.loadState === "ready" && current.data) return current.data;
  if (loadRequest?.generation === requestGeneration) return loadRequest.promise;

  const accountId = current.accountId;
  const generation = requestGeneration;
  const controller = new AbortController();

  useMemorySettingsStore.setState({
    error: null,
    loadState: current.data ? current.loadState : "loading"
  });
  const promise = loadMemorySettings(controller.signal).then(
    (data) => {
      const latest = useMemorySettingsStore.getState();
      if (generation !== requestGeneration || latest.accountId !== accountId) return data;
      useMemorySettingsStore.setState({ data, error: null, loadState: "ready" });
      return data;
    },
    (error: unknown) => {
      const latest = useMemorySettingsStore.getState();
      if (generation !== requestGeneration || latest.accountId !== accountId) throw error;
      useMemorySettingsStore.setState({
        error: errorName(error),
        loadState: current.data ? current.loadState : "error"
      });
      throw error;
    }
  ).finally(() => {
    if (loadRequest?.generation === generation) loadRequest = null;
  });
  loadRequest = { controller, generation, promise };
  return promise;
}

async function mutation(
  kind: MemorySettingsMutation,
  run: (
    current: MemoryConsumerSettingsResponse
  ) => Promise<MemoryConsumerSettingsResponse>
): Promise<MemoryConsumerSettingsResponse> {
  const current = useMemorySettingsStore.getState().data ?? await refreshMemorySettings(true);
  const accountId = useMemorySettingsStore.getState().accountId;
  const generation = requestGeneration;
  useMemorySettingsStore.setState({ busy: kind, error: null });
  try {
    const data = await run(current);
    const latest = useMemorySettingsStore.getState();
    if (generation !== requestGeneration || latest.accountId !== accountId) return data;
    useMemorySettingsStore.setState({ busy: null, data, error: null, loadState: "ready" });
    return data;
  } catch (error) {
    const latest = useMemorySettingsStore.getState();
    if (generation !== requestGeneration || latest.accountId !== accountId) throw error;
    useMemorySettingsStore.setState({ busy: null, error: errorName(error) });
    if (error instanceof MemoryApiError && error.code === "memory_changed") {
      try {
        await refreshMemorySettings(true);
      } catch {
        // Preserve the actionable stale error if reconciliation also fails.
      }
    }
    throw error;
  }
}

export function activateMemorySettings(accountId: string): void {
  const current = useMemorySettingsStore.getState();
  if (current.accountId === accountId) return;
  requestGeneration += 1;
  loadRequest?.controller.abort(new Error("memory_settings_account_changed"));
  loadRequest = null;
  useMemorySettingsStore.setState({ ...initialState, accountId }, true);
}

export async function updateMemoryGate(
  key: "decayEnabled" | "learnAutomatically" | "referenceChatHistory" | "synthesisEnabled" |
    "useMemoryFacts",
  value: boolean
): Promise<MemoryConsumerSettingsResponse> {
  return mutation(key, () => {
    const body = { [key]: value } satisfies MemoryConsumerSettingsPatch;
    return patchMemorySettings(body);
  });
}

export function deactivateMemorySettings(accountId?: string): void {
  if (accountId && useMemorySettingsStore.getState().accountId !== accountId) return;
  requestGeneration += 1;
  loadRequest?.controller.abort(new Error("memory_settings_deactivated"));
  loadRequest = null;
  useMemorySettingsStore.setState(initialState, true);
}

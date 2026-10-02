import {
  loadMemorySettings,
  MemoryApiError,
  patchMemorySettings,
  retryMemoryRead
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
  | "useMemoryFacts";

/** Failures are never shown: a failed read keeps the last known settings
 * (`error` is recorded only while none exist) and a failed change keeps the
 * committed values, then reconciles them with the server. */
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

function invalidateSettingsLoad(): void {
  requestGeneration += 1;
  loadRequest?.controller.abort(new Error("memory_settings_changed"));
  loadRequest = null;
}

function errorName(error: unknown): string {
  return error instanceof MemoryApiError || error instanceof Error
    ? error.message
    : "memory_action_failed";
}

export async function refreshMemorySettings(
  force = false
): Promise<MemoryConsumerSettingsResponse> {
  const current = useMemorySettingsStore.getState();
  if (current.busy && current.data) return current.data;
  if (!force && current.loadState === "ready" && current.data && !current.error) return current.data;
  if (loadRequest?.generation === requestGeneration) return loadRequest.promise;

  const accountId = current.accountId;
  const generation = requestGeneration;
  const controller = new AbortController();

  useMemorySettingsStore.setState({
    loadState: "loading"
  });
  const promise = retryMemoryRead(() => loadMemorySettings(controller.signal), {
    current: () => generation === requestGeneration &&
      useMemorySettingsStore.getState().accountId === accountId,
    signal: controller.signal
  }).then(
    (data) => {
      const latest = useMemorySettingsStore.getState();
      if (generation !== requestGeneration || latest.accountId !== accountId) return data;
      useMemorySettingsStore.setState({ data, error: null, loadState: "ready" });
      return data;
    },
    (error: unknown) => {
      const latest = useMemorySettingsStore.getState();
      if (generation !== requestGeneration || latest.accountId !== accountId) throw error;
      useMemorySettingsStore.setState(latest.data
        ? { error: null, loadState: "ready" }
        : { error: errorName(error), loadState: "error" });
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
  const initial = useMemorySettingsStore.getState();
  if (initial.busy) throw new Error("memory_settings_confirmation_required");
  const startGeneration = requestGeneration;
  const current = initial.data ?? await refreshMemorySettings(true);
  if (startGeneration !== requestGeneration) throw new Error("memory_settings_account_changed");
  const accountId = initial.accountId;
  invalidateSettingsLoad();
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
    // The switch keeps its committed value and stays usable; an unknown or
    // stale outcome is reconciled with the server without any message.
    useMemorySettingsStore.setState({ busy: null, error: null });
    await refreshMemorySettings(true).catch(() => undefined);
    throw error;
  }
}

export function activateMemorySettings(accountId: string): void {
  const current = useMemorySettingsStore.getState();
  if (current.accountId === accountId) return;
  invalidateSettingsLoad();
  useMemorySettingsStore.setState({ ...initialState, accountId }, true);
}

/** A reset must not reuse a settings read dispatched before its acknowledgement. */
export function refreshMemorySettingsAfterReset(): Promise<MemoryConsumerSettingsResponse> {
  invalidateSettingsLoad();
  return refreshMemorySettings(true);
}

export async function updateMemoryGate(
  key: MemorySettingsMutation,
  value: boolean
): Promise<MemoryConsumerSettingsResponse> {
  return mutation(key, () => {
    const body = { [key]: value } satisfies MemoryConsumerSettingsPatch;
    return patchMemorySettings(body);
  });
}

export function deactivateMemorySettings(accountId?: string): void {
  if (accountId && useMemorySettingsStore.getState().accountId !== accountId) return;
  invalidateSettingsLoad();
  useMemorySettingsStore.setState(initialState, true);
}

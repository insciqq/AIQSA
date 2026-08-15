import {
  acceptMemoryDestinations,
  loadMemorySettings,
  MemoryApiError,
  patchMemorySettings
} from "@/components/app-shell/memoryApi";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  type MemorySettingsPatch,
  type MemorySettingsResponse
} from "@/lib/contracts/memory";
import { create } from "zustand";

export type MemorySettingsLoadState = "error" | "idle" | "loading" | "ready";
export type MemorySettingsMutation =
  | "consent"
  | "learnAutomatically"
  | "referenceChatHistory"
  | "useMemoryFacts";

type MemorySettingsStore = {
  busy: MemorySettingsMutation | null;
  data: MemorySettingsResponse | null;
  error: string | null;
  loadState: MemorySettingsLoadState;
};

const initialState: MemorySettingsStore = {
  busy: null,
  data: null,
  error: null,
  loadState: "idle"
};

export const useMemorySettingsStore = create<MemorySettingsStore>(() => initialState);

let loadPromise: Promise<MemorySettingsResponse> | null = null;

function errorName(error: unknown): string {
  return error instanceof MemoryApiError || error instanceof Error
    ? error.message
    : "memory_action_failed";
}

export async function refreshMemorySettings(force = false): Promise<MemorySettingsResponse> {
  const current = useMemorySettingsStore.getState();
  if (!force && current.loadState === "ready" && current.data) return current.data;
  if (loadPromise) return loadPromise;

  useMemorySettingsStore.setState({
    error: null,
    loadState: current.data ? current.loadState : "loading"
  });
  loadPromise = loadMemorySettings().then(
    (data) => {
      useMemorySettingsStore.setState({ data, error: null, loadState: "ready" });
      return data;
    },
    (error: unknown) => {
      useMemorySettingsStore.setState({
        error: errorName(error),
        loadState: current.data ? current.loadState : "error"
      });
      throw error;
    }
  ).finally(() => {
    loadPromise = null;
  });
  return loadPromise;
}

async function mutation(
  kind: MemorySettingsMutation,
  run: (current: MemorySettingsResponse) => Promise<MemorySettingsResponse>
): Promise<MemorySettingsResponse> {
  const current = useMemorySettingsStore.getState().data ?? await refreshMemorySettings(true);
  useMemorySettingsStore.setState({ busy: kind, error: null });
  try {
    const data = await run(current);
    useMemorySettingsStore.setState({ busy: null, data, error: null, loadState: "ready" });
    return data;
  } catch (error) {
    useMemorySettingsStore.setState({ busy: null, error: errorName(error) });
    if (error instanceof MemoryApiError && error.code === "memory_version_stale") {
      try {
        await refreshMemorySettings(true);
      } catch {
        // Preserve the actionable stale error if reconciliation also fails.
      }
    }
    throw error;
  }
}

export async function updateMemoryGate(
  key: "learnAutomatically" | "referenceChatHistory" | "useMemoryFacts",
  value: boolean
): Promise<MemorySettingsResponse> {
  return mutation(key, (current) => {
    const body = {
      expectedMemoryRevision: current.settings.memoryRevision,
      expectedSettingsRevision: current.settings.settingsRevision,
      [key]: value
    } satisfies MemorySettingsPatch;
    return patchMemorySettings(body);
  });
}

export async function acceptCurrentMemoryDestinations(): Promise<MemorySettingsResponse> {
  return mutation("consent", (current) => acceptMemoryDestinations({
    confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
    currentUtilityEgressFingerprint: current.egress.currentUtilityEgressFingerprint,
    currentUtilityPolicyVersion: current.egress.currentUtilityPolicyVersion,
    expectedMemoryConsentRevision: current.settings.memoryConsentRevision,
    expectedMemoryRevision: current.settings.memoryRevision,
    expectedSettingsRevision: current.settings.settingsRevision
  }));
}

export function deactivateMemorySettings(): void {
  loadPromise = null;
  useMemorySettingsStore.setState(initialState, true);
}

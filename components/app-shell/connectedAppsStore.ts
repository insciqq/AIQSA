import {
  loadConnectedApps,
  revokeConnectedApp,
  ConnectedAppsApiError
} from "@/components/app-shell/connectedAppsApi";
import type { MemoryMcpConnectedApp } from "@/lib/contracts/memoryMcpConnectedApps";
import { create } from "zustand";

export type ConnectedAppsLoadState = "error" | "idle" | "loading" | "ready";

type ConnectedAppsStore = {
  accountId: string | null;
  apps: MemoryMcpConnectedApp[];
  busyConnectionId: string | null;
  error: string | null;
  lastRevokedConnectionId: string | null;
  loadState: ConnectedAppsLoadState;
  clearLastRevoked(): void;
};

const initialState = {
  accountId: null,
  apps: [],
  busyConnectionId: null,
  error: null,
  lastRevokedConnectionId: null,
  loadState: "idle" as const
};

export const useConnectedAppsStore = create<ConnectedAppsStore>((set) => ({
  ...initialState,
  clearLastRevoked() {
    set({ lastRevokedConnectionId: null });
  }
}));

let generation = 0;
let loadRequest: Readonly<{
  accountId: string;
  controller: AbortController;
  generation: number;
  promise: Promise<MemoryMcpConnectedApp[]>;
}> | null = null;
let revokeController: AbortController | null = null;

function errorName(error: unknown): string {
  return error instanceof ConnectedAppsApiError || error instanceof Error
    ? error.message
    : "connected_apps_request_failed";
}

export function activateConnectedApps(accountId: string): void {
  const current = useConnectedAppsStore.getState();
  if (current.accountId === accountId) return;
  generation += 1;
  loadRequest?.controller.abort(new Error("connected_apps_account_changed"));
  revokeController?.abort(new Error("connected_apps_account_changed"));
  loadRequest = null;
  revokeController = null;
  useConnectedAppsStore.setState({ ...initialState, accountId });
}

export async function refreshConnectedApps(
  force = false
): Promise<MemoryMcpConnectedApp[]> {
  const current = useConnectedAppsStore.getState();
  const accountId = current.accountId;
  if (!accountId) throw new Error("connected_apps_account_unavailable");
  if (!force && current.loadState === "ready") return current.apps;
  if (loadRequest?.accountId === accountId && loadRequest.generation === generation) {
    return loadRequest.promise;
  }

  const requestGeneration = generation;
  const controller = new AbortController();
  useConnectedAppsStore.setState({
    error: null,
    loadState: current.apps.length ? current.loadState : "loading"
  });
  const promise = loadConnectedApps(controller.signal).then(
    (apps) => {
      const latest = useConnectedAppsStore.getState();
      if (requestGeneration === generation && latest.accountId === accountId) {
        useConnectedAppsStore.setState({ apps, error: null, loadState: "ready" });
      }
      return apps;
    },
    (error: unknown) => {
      const latest = useConnectedAppsStore.getState();
      if (requestGeneration === generation && latest.accountId === accountId) {
        useConnectedAppsStore.setState({
          error: errorName(error),
          loadState: current.apps.length ? current.loadState : "error"
        });
      }
      throw error;
    }
  ).finally(() => {
    if (loadRequest?.generation === requestGeneration) loadRequest = null;
  });
  loadRequest = { accountId, controller, generation: requestGeneration, promise };
  return promise;
}

export async function revokeConnectedAppAccess(
  connectionId: string
): Promise<MemoryMcpConnectedApp> {
  const current = useConnectedAppsStore.getState();
  const accountId = current.accountId;
  if (!accountId || current.busyConnectionId) {
    throw new Error("connected_apps_mutation_unavailable");
  }
  generation += 1;
  const mutationGeneration = generation;
  loadRequest?.controller.abort(new Error("connected_apps_mutation_started"));
  loadRequest = null;
  const controller = new AbortController();
  revokeController = controller;
  useConnectedAppsStore.setState({
    busyConnectionId: connectionId,
    error: null,
    lastRevokedConnectionId: null
  });
  try {
    const app = await revokeConnectedApp(connectionId, controller.signal);
    const latest = useConnectedAppsStore.getState();
    if (mutationGeneration === generation && latest.accountId === accountId) {
      useConnectedAppsStore.setState({
        apps: latest.apps.map((candidate) =>
          candidate.connectionId === app.connectionId ? app : candidate
        ),
        busyConnectionId: null,
        error: null,
        lastRevokedConnectionId: app.connectionId,
        loadState: "ready"
      });
    }
    return app;
  } catch (error) {
    const latest = useConnectedAppsStore.getState();
    if (mutationGeneration === generation && latest.accountId === accountId) {
      useConnectedAppsStore.setState({
        busyConnectionId: null,
        error: errorName(error)
      });
    }
    throw error;
  } finally {
    if (revokeController === controller) revokeController = null;
  }
}

export function deactivateConnectedApps(accountId?: string): void {
  if (accountId && useConnectedAppsStore.getState().accountId !== accountId) return;
  generation += 1;
  loadRequest?.controller.abort(new Error("connected_apps_deactivated"));
  revokeController?.abort(new Error("connected_apps_deactivated"));
  loadRequest = null;
  revokeController = null;
  useConnectedAppsStore.setState(initialState);
}

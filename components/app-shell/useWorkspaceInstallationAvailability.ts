import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatWorkspaceState } from "@/lib/contracts/workspace";
import type { WorkspaceInstallationAvailability } from "@/components/app-shell/messageRunActions";
import { useRefreshOnReturn, WORKSPACE_AVAILABILITY_RETURN_INTERVAL_MS } from "@/components/app-shell/useRefreshOnReturn";
import { loadWorkspaceAvailability } from "@/components/app-shell/workspaceClient";

/** A failed availability read is retried after these delays, then waits for the next return to the tab. */
export const WORKSPACE_AVAILABILITY_RETRY_DELAYS_MS = Object.freeze([2_000, 5_000, 15_000] as const);

/**
 * The installation's Workspace availability (`GET /api/workspace`), read on
 * mount, per account and on return to the tab. The latest read wins: a send
 * refused for Workspace reads it again, so the next send goes without a
 * Workspace that went away. A failed read is not "unavailable": a waking
 * network after a file dialog sent messages without Workspace (production
 * audit 2026-11-11). It keeps the last confirmed value, or unknown, and
 * retries a few times while the tab is visible.
 */
export function useWorkspaceInstallationAvailability(accountId: string): Readonly<{
  /** The last successful read; null until one succeeds. */
  installation: ChatWorkspaceState | null;
  read(): void;
  /** For sends at dispatch: `off` only from a successful read. */
  resolve(): WorkspaceInstallationAvailability;
}> {
  const [installation, setInstallation] = useState<ChatWorkspaceState | null>(null);
  // Sends read availability at dispatch; the reader keeps this beside the state.
  const installationRef = useRef<ChatWorkspaceState | null>(null);
  const readRef = useRef(0);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRetry = useCallback(() => {
    if (retryRef.current !== null) clearTimeout(retryRef.current);
    retryRef.current = null;
  }, []);

  const read = useCallback(() => {
    const current = ++readRef.current;
    clearRetry();
    const attempt = (failures: number) => {
      void loadWorkspaceAvailability().then((workspace) => {
        if (readRef.current !== current) return;
        installationRef.current = workspace;
        setInstallation(workspace);
      }, () => {
        if (readRef.current !== current || failures >= WORKSPACE_AVAILABILITY_RETRY_DELAYS_MS.length) return;
        retryRef.current = setTimeout(() => {
          retryRef.current = null;
          // A hidden tab stops retrying; returning to it reads again.
          if (readRef.current !== current || document.visibilityState === "hidden") return;
          attempt(failures + 1);
        }, WORKSPACE_AVAILABILITY_RETRY_DELAYS_MS[failures]);
      });
    };
    attempt(0);
  }, [clearRetry]);

  useEffect(() => {
    read();
    return () => {
      readRef.current += 1;
      clearRetry();
    };
  }, [accountId, clearRetry, read]);
  // A runner that recovered or went away shows without a reload.
  useRefreshOnReturn(read, WORKSPACE_AVAILABILITY_RETURN_INTERVAL_MS);

  const resolve = useCallback((): WorkspaceInstallationAvailability => {
    const current = installationRef.current;
    return current === null ? "unknown" : current.available ? "available" : "off";
  }, []);

  return { installation, read, resolve };
}

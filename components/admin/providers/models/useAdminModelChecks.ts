"use client";

import { getAdminProviderCheckRun } from "@/components/admin/adminProvidersApi";
import type { AdminProvidersController } from "@/components/admin/useAdminProvidersController";
import type { AdminProviderCheckRun, AdminProviderConnection } from "@/lib/contracts/adminProviders";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const POLL_INTERVAL_MS = 1_200;

type Interrupted = Readonly<{
  credentialId: string;
  id: string;
  /** The catalog run in place when the loss was noticed; a newer run hides the notice. */
  seenRunId: string | null;
}>;

export type AdminModelCheckState = Readonly<{
  /** A run this page was following that the server no longer knows (restart). */
  interrupted: Readonly<{ credentialId: string; id: string }> | null;
  dismissInterrupted(): void;
  restart(): Promise<boolean>;
  run: AdminProviderCheckRun | null;
  stop(): Promise<boolean>;
}>;

/**
 * Follows the connection's background capability check (PRD B3): polls the
 * catalog quietly while a run is in progress so rows update as results
 * arrive, reports the end once, and recognises a run that vanished with
 * a process restart so it can be started again from the banner.
 */
export function useAdminModelChecks(input: Readonly<{
  connection: AdminProviderConnection;
  controller: Pick<AdminProvidersController, "actions">;
  onNotice(message: string): void;
}>): AdminModelCheckState {
  const { connection, controller, onNotice } = input;
  const run = connection.checkRun ?? null;
  const running = run?.state === "running";
  const trackedRef = useRef<AdminProviderCheckRun | null>(null);
  const [lost, setLost] = useState<Interrupted | null>(null);
  const runId = run?.id ?? null;
  const interrupted = useMemo(
    () => lost && !running && runId === lost.seenRunId
      ? { credentialId: lost.credentialId, id: lost.id }
      : null,
    [lost, runId, running]
  );
  const noticeRef = useRef(onNotice);
  useEffect(() => {
    noticeRef.current = onNotice;
  }, [onNotice]);

  useEffect(() => {
    if (running && run) {
      trackedRef.current = run;
      return;
    }
    const tracked = trackedRef.current;
    if (!tracked) return;
    trackedRef.current = null;
    if (run && run.id === tracked.id) {
      if (run.reason === "model") return;
      if (run.state === "completed") {
        noticeRef.current(run.total === 0
          ? "No enabled models were available to check. Add a supported model or check your key’s access."
          : run.setup?.state === "partial"
          ? "Models checked. Some automatic setup steps need a retry."
          : run.skipped?.length
          ? `${run.skipped.length} models changed during checking. Run Check models again.`
          : run.failed.length
          ? `Checked ${run.total} ${run.total === 1 ? "model" : "models"} · ${run.failed.length} hit a temporary failure — use Retry.`
          : `All ${run.total} ${run.total === 1 ? "model" : "models"} checked.`);
      } else if (run.state === "cancelled") {
        noticeRef.current("Checking stopped.");
      }
      return;
    }
    let cancelled = false;
    const seenRunId = run?.id ?? null;
    void getAdminProviderCheckRun(connection.id, tracked.id).then((result) => {
      if (cancelled || !result.ok || result.data.state !== "interrupted") return;
      setLost({ credentialId: tracked.credentialId, id: tracked.id, seenRunId });
    });
    return () => {
      cancelled = true;
    };
  }, [connection.id, run, running]);

  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      if (cancelled) return;
      if (typeof document === "undefined" || document.visibilityState !== "hidden") {
        await controller.actions.refreshQuietly();
      }
      if (!cancelled) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [controller.actions, running]);

  const stop = useCallback(async () => {
    if (!run || run.state !== "running") return false;
    return controller.actions.cancelModelChecks(connection.id, run.id);
  }, [connection.id, controller.actions, run]);

  const restart = useCallback(async () => {
    const credentialId = interrupted?.credentialId ?? run?.credentialId ?? connection.defaultCredentialId;
    if (!credentialId) return false;
    setLost(null);
    const result = await controller.actions.startModelChecks(connection.id, credentialId);
    return result.ok;
  }, [connection.defaultCredentialId, connection.id, controller.actions, interrupted, run?.credentialId]);

  return {
    dismissInterrupted: () => setLost(null),
    interrupted,
    restart,
    run,
    stop
  };
}
